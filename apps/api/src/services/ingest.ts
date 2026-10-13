import { supabaseAdmin } from '../lib/supabase.js';
import { connectedMailboxUserIds, isGoogleAuthFailure, orgSourceUserId } from '../lib/tokens.js';
import {
  gmailFor, getEmail, listMessageIds, listAllMessageIds, downloadAttachment, addressOf, addressesOf, type PdfAttachment,
  getProfileEmail, ignoredSenderQuery, noiseQuery, isIgnoredSender, isBulkMail, linksIn, studioOnlyQuery,
  createDraft, updateDraft, type DraftContent,
} from './gmail.js';
import { advanceIngestCursor, gmailAfter, gmailBefore, readIngestWindow } from '../lib/ingestCursor.js';
import { driveFor, listPdfs, downloadFile, type DriveFile } from './drive.js';
import { listProjectPdfs, loadDriveProjects, syncProjectStatusDoc, syncProjectsFromDrive, type ProjectFolder } from './driveProjects.js';
import {
  classifyEmail, extractPdf, MAX_PDF_BYTES,
  type AttachmentEvidence, type DocumentExtraction,
} from './extract.js';
import { draftReply, REPLYABLE } from './reply.js';
import {
  autoMergeDuplicates, cleanProjectName, matchClientProjectId, matchProjectId, namesAProject,
  promoteDocument, promoteEmail, removeVendorProjects,
} from './promote.js';
import { loadStudioNames, type StudioNames } from '../lib/studioNames.js';
import { STUDIO_MAILBOXES, STUDIO_TEAM, isStudioAddress, isStudioMailbox } from '../lib/studioTeam.js';
import { createTaskFromEmail, mergeDuplicateTasks } from './tasks.js';
import { isCheckinReply, recordCheckinReply } from './checkin.js';
import { isAiReady, sweepStaleUploads } from './anthropic.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { bodyColumnsReady, bodyFields, readStoredText } from '../lib/emailStore.js';
import { hasEmailOwner, hasMessageId, hasDraftGmailMessage } from '../lib/columns.js';

export interface IngestResult {
  ok: boolean;
  reason?: string;
  emails: number;
  documents: number;
  replies: number;
  tasks: number;
  /** Machine mail dropped before it cost anything — see isIgnoredSender. */
  skipped: number;
  /** False when the time budget ran out before the queue was empty. */
  done: boolean;
  /** Best-effort count of what was left untouched when the budget ran out. */
  remaining: number;
  /**
   * Date-range sync only: everything in the range delivered before this
   * moment has been dealt with, so the next pass may start here. Absent when
   * that cannot be said — see `range` in IngestOptions.
   */
  resumeFrom?: string;
}

export interface IngestOptions {
  emailQuery?: string;
  folderId?: string;
  /**
   * How long this pass may run before it stops and reports what is left.
   * Defaults to DEFAULT_BUDGET_MS.
   */
  budgetMs?: number;
  /**
   * Read only this member's mailbox, rather than every connected one.
   * Used to sync somebody the moment they connect their Google, without
   * making them wait on the whole studio being read first.
   */
  onlyUserId?: string;
  /**
   * Read the mail delivered in this window instead of everything since the
   * watermark — a person asking to sync a particular day, week or month.
   * Like a caller-supplied query it never moves the watermark, and it reads
   * mail only: the Drive pass belongs to the scheduled reading.
   */
  range?: { since: Date; until: Date };
  /**
   * Internal: the studio's Drive project folders, read once for the whole
   * pass by `runIngest` rather than again inside every mailbox's slice.
   */
  prefetched?: {
    driveProjects: Awaited<ReturnType<typeof loadDriveProjects>>;
    folderProjects: Map<string, string>;
  };
}

/** Which mailbox goes first next pass — see the rotation in runIngest. */
let rotation = 0;

/**
 * The studio's project folders, read once per pass.
 *
 * They are the studio's, not any one mailbox's, but they used to be read
 * inside every mailbox's slice of the pass. At ~4s a read plus the sync
 * behind it, that consumed the whole slice of a four-mailbox pass before a
 * single email was looked at: a newly connected mailbox waited forever
 * with its messages listed as "remaining". Read here, once, through the
 * first connected account that can see Drive.
 */
async function prefetchDriveProjects(orgId: string, userIds: string[]): Promise<IngestOptions['prefetched']> {
  for (const userId of userIds) {
    try {
      const drive = await driveFor(userId);
      if (!drive) continue;
      const driveProjects = await loadDriveProjects(orgId, drive);
      if (!driveProjects) continue;
      const folderProjects = (await syncProjectsFromDrive(orgId, driveProjects)).map;
      try {
        await syncProjectStatusDoc(orgId, drive, driveProjects, folderProjects);
      } catch (err) {
        console.error('[ingest] project status document unread:', (err as Error).message);
      }
      return { driveProjects, folderProjects };
    } catch (err) {
      console.error('[ingest] project folders unreadable:', isGoogleAuthFailure(err) ? 'Google needs reconnecting' : (err as Error).message);
    }
  }
  return { driveProjects: null, folderProjects: new Map() };
}

/**
 * How long one pass runs before it hands back a partial result.
 *
 * Reading one email costs up to three Claude calls (classify, raise a task,
 * draft a reply) plus one per PDF attachment, so a full 25-message batch
 * takes minutes. On Vercel the function is killed at `maxDuration` (60s in
 * vercel.json) with a 504 FUNCTION_INVOCATION_TIMEOUT and the caller gets
 * nothing back — not even the emails already written. Stopping a little
 * short of that turns the timeout into a partial, resumable success: the
 * dedupe checks below skip whatever the previous pass stored, so the next
 * call picks up exactly where this one left off.
 *
 * Kept well under the function's maxDuration (60s) rather than close to it,
 * for two reasons: the deadline is only checked between items, so the item
 * in flight still has to finish; and a request held open for most of a
 * minute is the one an intermediary drops in transit, which reaches the
 * browser as a bare "Failed to fetch" with no status at all. Short passes
 * answer quickly and the caller simply asks again.
 */
const DEFAULT_BUDGET_MS = Number(process.env.INGEST_BUDGET_MS || 20_000);

/**
 * How much of a message body to keep.
 *
 * Gmail's own fetch already truncates at 12k; this is the storage cap. Long
 * enough to hold a real message and its quoted thread, short enough that a
 * studio's inbox does not become the largest thing in the database.
 */
const MAX_BODY_CHARS = 12_000;

/**
 * The project and vendor an extraction names, as rows the studio already has.
 *
 * This used to be a substring test in both directions, so "Oak" filed mail
 * under "Oak Kitchen" and "Oakwood" alike, and a client's name was only
 * consulted when it happened to contain the project's. The same matcher the
 * rest of the system uses decides now, and a client with exactly one project
 * finds that project even when the email never names the job.
 */
function resolveFiling(
  names: StudioNames,
  hint: { project?: string | null; client?: string | null; vendor?: string | null },
): { projectId: string | null; vendorId: string | null } {
  let projectId: string | null = null;
  if (hint.project) projectId = matchProjectId(names.projects, cleanProjectName(hint.project));
  if (!projectId && hint.client) projectId = matchClientProjectId(names.projects, hint.client);
  const vendorId = hint.vendor ? matchProjectId(names.vendors, hint.vendor) : null;
  return { projectId, vendorId };
}

/**
 * How many of an email's PDFs are read before it is filed. Enough for the
 * cover sheet, the quote and the drawings; a message carrying a dozen PDFs is
 * usually a document dump, and past this they are known by name.
 */
const MAX_PDFS_PER_EMAIL = 4;

/** A PDF read for an email: what it said, and whether it is already stored. */
interface ReadAttachment {
  att: PdfAttachment;
  ref: string;
  parsed: DocumentExtraction | null;
  /** The documents row, when an earlier pass already read and stored it. */
  storedId: string | null;
}

/**
 * The project the first attachment that names one points to, or null.
 *
 * Used only when the email itself matched nothing on file: a vendor quote
 * whose sidemark is the client, or a proposal whose cover names the job,
 * files an email that never said either.
 */
function projectFromDocuments(names: StudioNames, documents: (DocumentExtraction | null)[]): string | null {
  for (const p of documents) {
    if (!p) continue;
    // A template names the job it was built from, not the one it is being
    // sent about — attaching the studio's Canva master to a mail about any
    // other client would otherwise file that mail under Lemon Residence.
    if (p.is_template) continue;
    const { projectId } = resolveFiling(names, {
      project: namesAProject(p.project_hint, p.vendor) ? p.project_hint : null,
      client: p.client,
    });
    if (projectId) return projectId;
  }
  return null;
}

/**
 * File email that has no project, using what its attachments already said.
 *
 * Mail read before attachments informed the filing is sitting in the system
 * under no project, while the quote or proposal that came with it — read and
 * stored at the time — names the job plainly. This joins them up: the email,
 * its documents and the task it raised all move to that project.
 *
 * Costs no Claude calls; everything it needs was extracted already. Matches
 * only projects the studio has, and never opens a new one — old mail is not
 * the place to start inventing jobs.
 */
export async function refileFromAttachments(orgId: string, limit = 200): Promise<{ refiled: number }> {
  if (!supabaseAdmin) return { refiled: 0 };

  const { data: emails } = await supabaseAdmin
    .from('emails')
    .select('id, gmail_id')
    .eq('org_id', orgId)
    .is('project_id', null)
    .not('gmail_id', 'is', null)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  const unfiled = (emails ?? []) as { id: string; gmail_id: string }[];
  if (!unfiled.length) return { refiled: 0 };

  // Every stored attachment in one read, grouped by the message it came on.
  const { data: docs } = await supabaseAdmin
    .from('documents')
    .select('parsed_json, drive_file_id')
    .eq('org_id', orgId)
    .like('drive_file_id', 'gmail:%')
    .not('parsed_json', 'is', null)
    .limit(2000);
  const byMessage = new Map<string, DocumentExtraction[]>();
  for (const d of (docs ?? []) as { parsed_json: DocumentExtraction; drive_file_id: string }[]) {
    const messageId = d.drive_file_id.slice('gmail:'.length).split(':')[0];
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), d.parsed_json]);
  }

  const names = await loadStudioNames(orgId);
  let refiled = 0;
  for (const e of unfiled) {
    const parsed = byMessage.get(e.gmail_id);
    if (!parsed?.length) continue;
    const projectId = projectFromDocuments(names, parsed);
    if (!projectId) continue;

    await supabaseAdmin.from('emails').update({ project_id: projectId }).eq('id', e.id).is('project_id', null);
    await supabaseAdmin
      .from('documents')
      .update({ project_id: projectId })
      .eq('org_id', orgId)
      .like('drive_file_id', `gmail:${e.gmail_id}:%`)
      .is('project_id', null);
    await supabaseAdmin
      .from('tasks')
      .update({ project_id: projectId })
      .eq('org_id', orgId)
      .eq('source_email_id', e.id)
      .is('project_id', null);
    refiled++;
  }
  return { refiled };
}

/**
 * Ingest recent Gmail + Drive activity for an org into Supabase.
 * Requires the org's source user to have Google connected, and the
 * Claude API configured. Safe to call repeatedly (dedupes by id), and
 * safe to stop early — see DEFAULT_BUDGET_MS.
 */
// Process-wide lock: only one ingestion runs at a time, whether it was
// triggered by the scheduler or a manual "Read Gmail & Drive" click. This
// prevents concurrent runs from double-processing and creating duplicate
// drafts in the user's Gmail.
//
// Held as a start time rather than a boolean because a serverless instance
// killed mid-run never reaches the `finally`. A boolean would leave that
// instance answering "busy" to every later request that landed on it; a
// timestamp lets the lock expire.
const LOCK_TTL_MS = 5 * 60_000;
let ingestStartedAt = 0;

/** A result that carries nothing but the reason it did nothing. */
function nothing(reason: string): IngestResult {
  return { ok: false, reason, emails: 0, documents: 0, replies: 0, tasks: 0, skipped: 0, done: false, remaining: 0 };
}

/**
 * The most message ids one pass will hold in memory.
 *
 * A studio reading thirty days of mail for the first time can list
 * thousands. The cap bounds the pass, and because the watermark only moves
 * when a pass finishes everything it listed, a capped pass simply means the
 * next one starts where this one stopped. Nothing is skipped by capping.
 */
const MAX_IDS_PER_PASS = 500;

/**
 * Which of these Gmail ids the studio has not stored yet.
 *
 * One question per batch rather than one per message. On a catch-up pass
 * most of the listing is already stored, and asking the database about each
 * id in turn was the slowest part of a pass that had no work to do.
 */
async function unstoredIds(orgId: string, ids: string[]): Promise<string[]> {
  if (!supabaseAdmin || ids.length === 0) return [];
  const known = new Set<string>();
  // `in` is a URL query parameter, so the list is chunked to keep it short.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await supabaseAdmin
      .from('emails')
      .select('gmail_id')
      .eq('org_id', orgId)
      .in('gmail_id', chunk);
    for (const row of data ?? []) known.add((row as { gmail_id: string }).gmail_id);
  }
  return ids.filter((id) => !known.has(id));
}

/**
 * The mail domains of suppliers the studio already works with.
 *
 * Used to spare a known vendor from the bulk-mail filter. Some suppliers
 * genuinely send quotes and order confirmations through a mailing platform,
 * and dropping those would cost the studio real work to save it an advert.
 */
async function knownVendorDomains(orgId: string): Promise<Set<string>> {
  const domains = new Set<string>();
  if (!supabaseAdmin) return domains;
  try {
    const { data } = await supabaseAdmin.from('vendors').select('contacts').eq('org_id', orgId);
    for (const row of data ?? []) {
      const contacts = (row as { contacts: { email?: string }[] | null }).contacts;
      for (const c of Array.isArray(contacts) ? contacts : []) {
        const at = (c.email ?? '').lastIndexOf('@');
        if (at > 0) domains.add(c.email!.slice(at + 1).toLowerCase());
      }
    }
  } catch (err) {
    console.error('[ingest] vendor domains unreadable:', (err as Error).message);
  }
  return domains;
}

/**
 * The people this studio actually corresponds with, as Gmail search terms.
 *
 * Its own addresses, and the mail domains of every vendor and client on
 * file. Used to narrow a PERSONAL mailbox so nothing outside the studio's
 * own correspondence is ever fetched — see `studioOnlyQuery`.
 */
async function studioScopeFor(orgId: string): Promise<string> {
  const addresses = [...STUDIO_MAILBOXES, ...STUDIO_TEAM.map((p) => p.email)].filter(Boolean);
  const domains = new Set<string>();
  for (const d of await knownVendorDomains(orgId)) domains.add(d);
  if (supabaseAdmin) {
    // Who the studio has actually corresponded with about a job. A client's
    // address is nowhere on the project record, but it is on every message
    // already filed against one — which is a better list than a field
    // somebody has to remember to fill in.
    const { data } = await supabaseAdmin
      .from('emails')
      .select('from_addr')
      .eq('org_id', orgId)
      .not('project_id', 'is', null)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(400);
    for (const row of data ?? []) {
      const domain = senderDomain((row as { from_addr: string | null }).from_addr ?? '');
      if (domain && !isIgnoredSender(`x@${domain}`) && !isStudioAddress(`x@${domain}`)) domains.add(domain);
    }
  }
  return studioOnlyQuery([...domains], addresses);
}

function senderDomain(from: string): string {
  const address = addressOf(from || '');
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

export async function runIngest(
  orgId: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  if (!supabaseAdmin) return nothing('supabase_not_configured');

  // Reading email without Claude is a supported mode — the mail still
  // lands in the Inbox, it just arrives unclassified and raises nothing.
  // Only refuse when the studio wants AI and has not configured it.
  const { useAi } = await readIngestSettings(orgId);
  if (useAi && !(await isAiReady())) return nothing('anthropic_not_configured');
  if (ingestStartedAt && Date.now() - ingestStartedAt < LOCK_TTL_MS) return nothing('busy');

  // Every connected mailbox, not just the studio's own. A team member who
  // connects their Google used to change nothing: the pass looked up one
  // source user — the first connected principal — and read that alone.
  const mailboxes = opts.onlyUserId ? [opts.onlyUserId] : await connectedMailboxUserIds(orgId);
  if (!mailboxes.length) {
    const fallback = await orgSourceUserId(orgId);
    if (!fallback) return nothing('no_source_user');
    mailboxes.push(fallback);
  }

  ingestStartedAt = Date.now();
  try {
    // The budget is the whole pass, shared out, so adding a fifth mailbox
    // makes each pass shallower rather than making the request time out.
    const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
    const totals: IngestResult = {
      ok: true, emails: 0, documents: 0, replies: 0, tasks: 0, skipped: 0, done: true, remaining: 0,
    };
    let anyRan = false;
    /** Why the last mailbox did not run — reported when it was the only one. */
    let lastReason: string | undefined;

    // Take turns at going first. Always walking the list in the same order
    // meant the last mailbox only ever got what the others left over — for
    // a newly connected one with a backlog, that was nothing.
    if (mailboxes.length > 1) {
      const start = rotation++ % mailboxes.length;
      mailboxes.push(...mailboxes.splice(0, start));
    }

    // The studio's project folders, once for the whole pass — not once per
    // mailbox, which used up each mailbox's slice before its first email.
    const prefetched =
      useAi && !opts.folderId && !opts.range ? await prefetchDriveProjects(orgId, mailboxes) : undefined;

    for (const [index, userId] of mailboxes.entries()) {
      // What is left, shared among the mailboxes still to go: time one
      // mailbox did not need rolls on to the next instead of being lost.
      const budgetEach = Math.max(4_000, Math.floor((deadline - Date.now()) / (mailboxes.length - index)));
      let result: IngestResult;
      try {
        result = await ingestInternal(orgId, userId, { ...opts, budgetMs: budgetEach, prefetched }, useAi);
      } catch (err) {
        // One member's expired grant must not stop the studio's own mail
        // being read, nor anybody else's.
        console.error(`[ingest] mailbox ${userId} failed:`, (err as Error).message);
        lastReason = 'mailbox_failed';
        continue;
      }
      if (!result.ok) {
        // A member who has not finished connecting is not an error for the
        // pass — only every mailbox failing is.
        console.warn(`[ingest] mailbox ${userId} skipped: ${result.reason}`);
        lastReason = result.reason;
        continue;
      }
      anyRan = true;
      totals.emails += result.emails;
      totals.documents += result.documents;
      totals.replies += result.replies;
      totals.tasks += result.tasks;
      totals.skipped += result.skipped;
      totals.remaining += result.remaining;
      if (result.done === false) totals.done = false;
      // Only meaningful for one mailbox, which is the only way a range runs.
      if (mailboxes.length === 1 && result.resumeFrom) totals.resumeFrom = result.resumeFrom;
    }

    // With one mailbox, why it did not run IS why the pass did not — "no
    // source user" over an expired Google grant sent people looking in the
    // wrong place.
    if (anyRan) return totals;
    return nothing(mailboxes.length === 1 && lastReason ? lastReason : 'no_source_user');
  } finally {
    ingestStartedAt = 0;
  }
}

/**
 * Fetch the body and links for mail that was read before they were stored.
 *
 * Costs nothing but Gmail calls — no Claude, no re-classification, no new
 * tasks or drafts. Every message already in the system keeps its
 * classification and its links; all that changes is that the text of what
 * was written is there to be read.
 *
 * Budgeted and resumable like a reading pass, because an inbox of several
 * hundred stored messages is more Gmail calls than one request should hold.
 */
export async function backfillEmailBodies(
  orgId: string,
  opts: { budgetMs?: number; limit?: number } = {},
): Promise<{ ok: boolean; reason?: string; filled: number; remaining: number; done: boolean }> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', filled: 0, remaining: 0, done: false };

  const userId = await orgSourceUserId(orgId);
  if (!userId) return { ok: false, reason: 'no_source_user', filled: 0, remaining: 0, done: false };

  let gmail: Awaited<ReturnType<typeof gmailFor>> = null;
  try {
    gmail = await gmailFor(userId);
  } catch (err) {
    if (isGoogleAuthFailure(err)) return { ok: false, reason: 'google_auth_failed', filled: 0, remaining: 0, done: false };
    throw err;
  }
  if (!gmail) return { ok: false, reason: 'gmail_not_connected', filled: 0, remaining: 0, done: false };

  const { data, error } = await supabaseAdmin
    .from('emails')
    .select(`id, gmail_id, extracted_json${(await bodyColumnsReady()) ? ', body_text' : ''}`)
    .eq('org_id', orgId)
    .not('gmail_id', 'is', null)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(opts.limit ?? 200);
  if (error) return { ok: false, reason: error.message, filled: 0, remaining: 0, done: false };

  // Filtered here rather than in the query: where the body lives depends on
  // whether 0010 has been applied, and `is null` cannot ask about both.
  const pending = ((data ?? []) as unknown as {
    id: string; gmail_id: string;
    body_text?: string | null; extracted_json?: Record<string, unknown> | null;
  }[]).filter((row) => !readStoredText(row).body);
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  let filled = 0;
  let index = 0;
  for (; index < pending.length; index++) {
    if (Date.now() >= deadline) break;
    const row = pending[index];
    try {
      const email = await getEmail(gmail, row.gmail_id);
      // The error MUST be checked. Without it a write rejected by Postgres
      // still counted as filled, and the run reported forty-eight bodies
      // stored when it had stored none — a report that is wrong is worse
      // than one that fails, because nobody goes looking.
      const { error: writeError } = await supabaseAdmin
        .from('emails')
        .update(
          await bodyFields(
            (email.body || email.snippet || '').slice(0, MAX_BODY_CHARS),
            linksIn(email.body || ''),
            row.extracted_json ?? null,
          ),
        )
        .eq('id', row.id);
      if (writeError) throw new Error(writeError.message);
      filled++;
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        return { ok: false, reason: 'google_auth_failed', filled, remaining: pending.length - index, done: false };
      }
      // A message deleted from Gmail since is not worth failing the run for.
      console.error('[backfill] body failed', row.gmail_id, (err as Error).message);
    }
  }

  return { ok: true, filled, remaining: pending.length - index, done: index >= pending.length };
}

async function ingestInternal(
  orgId: string,
  userId: string,
  opts: IngestOptions,
  useAi: boolean,
): Promise<IngestResult> {
  if (!supabaseAdmin) return nothing('not_configured');

  // Everything below stops at this deadline rather than at the platform's,
  // so the caller always gets a result instead of a 504.
  const budgetMs = Math.max(0, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const timeLeft = () => deadline - Date.now();

  // Items can only be stopped between them, so the deadline alone is not
  // enough: starting a 20s email at second 44 of a 45s budget still runs
  // the function past its limit. Keep how long the slowest item of each
  // kind took and stop once that no longer fits in what is left. Emails
  // and PDFs are measured apart because they cost very different amounts.
  const slowest = { email: 0, doc: 0 };
  const roomFor = (kind: 'email' | 'doc') => timeLeft() > slowest[kind];
  const timed = (kind: 'email' | 'doc', startedAt: number) => {
    slowest[kind] = Math.max(slowest[kind], Date.now() - startedAt);
  };

  let done = true;
  let remaining = 0;
  // Range sync: the receivedAt of the last message dealt with, in order.
  let resumeFrom: string | undefined;

  // Set once the mailbox's own address is known — see the Gmail block below.
  let ownerId: string | null = null;
  let ownerColumn = false;
  let messageColumn = false;

  let emailCount = 0;
  let docCount = 0;
  let replyCount = 0;
  let taskCount = 0;
  let skippedCount = 0;

  // ── The studio's projects, from its Drive folders ─────────
  // First, before any mail: an email can only be filed against a project the
  // studio has, and the folder list is where the studio says what it has.
  let drive: Awaited<ReturnType<typeof driveFor>> = null;
  let driveProjects: Awaited<ReturnType<typeof loadDriveProjects>> = null;
  let folderProjects = new Map<string, string>();
  if (opts.prefetched) {
    // Read once for the whole pass — see prefetchDriveProjects.
    driveProjects = opts.prefetched.driveProjects;
    folderProjects = opts.prefetched.folderProjects;
  } else if (useAi && !opts.folderId && !opts.range) {
    try {
      drive = await driveFor(userId);
      driveProjects = drive ? await loadDriveProjects(orgId, drive) : null;
      if (drive && driveProjects) {
        folderProjects = (await syncProjectsFromDrive(orgId, driveProjects)).map;
        try {
          await syncProjectStatusDoc(orgId, drive, driveProjects, folderProjects);
        } catch (err) {
          console.error('[ingest] project status document unread:', (err as Error).message);
        }
      }
    } catch (err) {
      // Mail is still worth reading without the folder list.
      console.error('[ingest] project folders unreadable:', isGoogleAuthFailure(err) ? 'Google needs reconnecting' : (err as Error).message);
      driveProjects = null;
    }
  }

  // ── Emails ────────────────────────────────────────────────
  // Everything from here to the first message sits OUTSIDE the per-email
  // guard below, so a dead Google grant threw straight out of the request
  // and the studio saw nothing but "Server error". A revoked or rotated
  // OAuth client is not a server fault — it needs somebody to reconnect
  // Google — so it is reported as a reason, like every other precondition.
  let gmail: Awaited<ReturnType<typeof gmailFor>> = null;
  let selfEmail = '';
  try {
    gmail = await gmailFor(userId);
    if (gmail) selfEmail = await getProfileEmail(gmail);
  } catch (err) {
    if (isGoogleAuthFailure(err)) return nothing('google_auth_failed');
    throw err;
  }

  if (gmail) {
    // Read state is deliberately absent from this query. The studio reads
    // its mail in Gmail long before the system gets to it, so anything
    // scoped to `is:unread` would miss most of the work; what stops a
    // message being read twice is the gmail_id check below, not its being
    // marked read. A caller-supplied query is used exactly as given.
    // Whose mailbox this is decides both what may be read out of it and who
    // may read it afterwards.
    //
    // Every mailbox has an owner now, the studio's shared address included
    // (0020). It is still read WHOLE — everything in systems@ is studio
    // business, so there is nothing to narrow — but its mail belongs to that
    // account rather than to everybody, so somebody invited today is not
    // shown months of correspondence they had no part in.
    const shared = isStudioMailbox(selfEmail);
    ownerId = userId;
    ownerColumn = await hasEmailOwner();
    messageColumn = await hasMessageId();

    // A caller-supplied query is a manual scan — a person asking for a
    // specific search — and never moves the watermark, which belongs to the
    // automatic reading alone.
    const manual = Boolean(opts.emailQuery);
    // A date range reads a fixed window, so it neither reads the watermark
    // nor — below — moves it.
    const range = manual ? undefined : opts.range;
    const window = manual || range ? null : await readIngestWindow(orgId, userId);
    const scope = shared ? '' : await studioScopeFor(orgId);
    const period = range ? `${gmailAfter(range.since)} ${gmailBefore(range.until)}` : window ? gmailAfter(window.since) : '';
    const query = opts.emailQuery ?? `${period} -in:sent ${noiseQuery()} ${scope}`.trim();

    let listed: { ids: string[]; capped: boolean };
    try {
      listed = manual
        ? { ids: await listMessageIds(gmail, query, 25), capped: false }
        : await listAllMessageIds(gmail, query, MAX_IDS_PER_PASS);
    } catch (err) {
      if (isGoogleAuthFailure(err)) return nothing('google_auth_failed');
      throw err;
    }

    // More than one pass can carry: the rest is not lost, it is next.
    if (listed.capped) done = false;

    // Oldest first, and only what is not already stored. Both matter for the
    // watermark: the pass walks forward through the mail in the order it
    // arrived, so wherever it stops, everything behind it is finished.
    const ids = await unstoredIds(orgId, listed.ids);
    // Where a range pass may resume. Mail that is skipped rather than stored
    // (adverts, machinery, a colleague's copy) is never in the database, so
    // without this every later pass would fetch it all again before reaching
    // anything new. Only when the listing was complete: a capped listing is
    // the NEWEST of the range, and resuming past it would skip older mail.
    const trackResume = Boolean(range) && !listed.capped;
    const vendorDomains = ids.length ? await knownVendorDomains(orgId) : new Set<string>();

    for (const [index, id] of ids.entries()) {
      // Between messages is the only safe place to stop: the one in flight
      // may already have written an email row and a reply draft.
      if (!roomFor('email')) {
        done = false;
        remaining += ids.length - index;
        break;
      }
      const emailStarted = Date.now();
      try {
        const email = await getEmail(gmail, id);
        // Set before anything can `continue`: a skipped message is dealt with
        // too. Should this one throw below it is logged and passed over, the
        // same as a scheduled pass would.
        const resumedBefore = resumeFrom;
        if (trackResume && email.receivedAt) resumeFrom = email.receivedAt;

        // Machinery, not studio work — a Slack invite, a bot's comment on a
        // pull request, a Dropbox sign-in notice. Dropped before the first
        // Claude call and never stored, so it costs nothing and never shows
        // up in the Inbox beside real vendor mail. The query above already
        // excludes these senders; this catches a custom query and anything
        // Gmail's own matching let through.
        if (isIgnoredSender(email.from)) {
          skippedCount++;
          continue;
        }

        // Advertising. Gmail's own Promotions category is excluded in the
        // query above; this catches the mailers it did not categorise —
        // anything addressed to a list rather than to a person. A supplier
        // the studio already works with is never dropped this way: some of
        // them really do send quotes through a mailing platform, and losing
        // one of those to save an advert is the wrong trade.
        if (isBulkMail(email) && !vendorDomains.has(senderDomain(email.from))) {
          skippedCount++;
          continue;
        }

        // The same message in a second mailbox.
        //
        // `gmail_id` is Gmail's id for a message in ONE mailbox, so a vendor
        // who writes to systems@ and copies Brianna arrives twice with two
        // different ids. The RFC Message-ID is the same in both, and this is
        // the last moment before the expensive part — checked here, the
        // duplicate costs one query instead of three Claude calls, a second
        // Inbox row and a second copy of the same task.
        //
        // Only against copies this mailbox's owner could actually see: a
        // colleague's private copy is invisible to them (0018), so skipping
        // on it would lose them the message entirely.
        if (messageColumn && email.messageIdHeader) {
          let seen = supabaseAdmin
            .from('emails')
            .select('id')
            .eq('org_id', orgId)
            .eq('message_id', email.messageIdHeader);
          seen = ownerId ? seen.or(`owner_id.is.null,owner_id.eq.${ownerId}`) : seen.is('owner_id', null);
          const { data: already } = await seen.limit(1);
          if (already?.length) {
            skippedCount++;
            continue;
          }
        }

        // A teammate answering the end-of-day check-in email. Their reply
        // is about their own tasks — "done", "stuck on the vendor" — and
        // reading it as new work raised a task from every answer. It is
        // kept as an email and handed to the check-in (services/checkin.ts)
        // to be written onto the tasks it names, with no Claude call.
        if (isCheckinReply(email)) {
          let replyRowId: string | null = null;
          try {
            const { data: replyRow } = await supabaseAdmin
              .from('emails')
              .insert({
                org_id: orgId,
                gmail_id: email.gmailId,
                thread_id: email.threadId,
                from_addr: email.from,
                to_addr: email.to,
                subject: email.subject,
                snippet: email.snippet,
                ...(await bodyFields((email.body || email.snippet || '').slice(0, MAX_BODY_CHARS), linksIn(email.body || ''), null)),
                received_at: email.receivedAt,
                ...(ownerColumn ? { owner_id: ownerId } : {}),
                ...(messageColumn ? { message_id: email.messageIdHeader || null } : {}),
                class: 'general',
              })
              .select('id')
              .maybeSingle();
            replyRowId = (replyRow as { id: string } | null)?.id ?? null;
            emailCount++;
          } catch (err) {
            console.error('[ingest] check-in reply not stored:', (err as Error).message);
          }
          try {
            await recordCheckinReply(orgId, email, replyRowId);
          } catch (err) {
            console.error('[ingest] check-in reply not recorded:', (err as Error).message);
          }
          continue;
        }

        const names = useAi ? await loadStudioNames(orgId) : null;

        // ── Attachments first ────────────────────────────────
        // What is attached often names the job more plainly than the body
        // does — a proposal's cover page, a drawing's title block, a vendor
        // quote's sidemark. The PDFs were always read, but only AFTER the
        // email had been classified and filed, when what they said could no
        // longer change which project it went to, what the project was
        // called, who the client was, or what the task was titled. Now they
        // are read first, and the email is filed on the evidence of both.
        // No extra Claude calls: the same PDFs, read earlier.
        for (const att of useAi ? email.attachments : []) {
          if (att.size > MAX_PDF_BYTES) console.warn('[ingest] attachment too large to read', att.filename, att.size);
        }
        const readable = useAi
          ? email.attachments.filter((att) => att.size <= MAX_PDF_BYTES).slice(0, MAX_PDFS_PER_EMAIL)
          : [];

        // An email whose attachments will not fit in what is left of this
        // pass waits for the next one, rather than being filed without them
        // and never looked at again. Not when nothing has been read yet: one
        // slow attachment must not keep its email out of the system forever.
        if (readable.length && !roomFor('doc') && emailCount > 0) {
          // Not dealt with after all — the next pass must start before it.
          resumeFrom = resumedBefore;
          done = false;
          remaining += ids.length - index;
          break;
        }

        const read: ReadAttachment[] = [];
        for (const att of readable) {
          // Past the budget, the rest of this email's files are known by
          // name only — still evidence, just less of it.
          if (read.length && !roomFor('doc')) break;
          const attStarted = Date.now();
          try {
            const ref = `gmail:${email.gmailId}:${att.attachmentId}`;
            const { data: seen } = await supabaseAdmin
              .from('documents')
              .select('id, parsed_json')
              .eq('org_id', orgId)
              .eq('drive_file_id', ref)
              .maybeSingle();
            if (seen) {
              const stored = seen as { id: string; parsed_json: DocumentExtraction | null };
              read.push({ att, ref, parsed: stored.parsed_json, storedId: stored.id });
              continue;
            }
            const pdf = await downloadAttachment(gmail, email.gmailId, att.attachmentId);
            const parsed = await extractPdf(pdf, att.filename, { orgId }, names);
            read.push({ att, ref, parsed, storedId: null });
          } catch (err) {
            console.error('[ingest] attachment failed', att.filename, (err as Error).message);
          } finally {
            timed('doc', attStarted);
          }
        }

        // Every attachment is evidence: the ones read, by what they say; the
        // rest — images, spreadsheets, anything unread — by their names.
        const evidence: AttachmentEvidence[] = (email.files ?? []).map((f) => ({
          filename: f.filename,
          mimeType: f.mimeType,
          read: read.find((r) => r.att.attachmentId === f.attachmentId)?.parsed ?? null,
        }));
        for (const r of read) {
          if (!evidence.some((e) => e.filename === r.att.filename)) {
            evidence.push({ filename: r.att.filename, mimeType: 'application/pdf', read: r.parsed });
          }
        }

        // Every one of these is a Claude call. With reading turned off the
        // message is still stored, just unclassified and unlinked.
        //
        // Read against the studio's own names, so "Lemon's" comes back as the
        // Lemon Residence already on file rather than as a new project. Loaded
        // per email because the email before may have just created one.
        const extracted = useAi ? await classifyEmail(email, { orgId }, names, evidence) : null;
        // Only look for a project when the hint actually names one. A hint
        // like "Samples" matches almost any project name and filed mail
        // that had nothing to do with the job against it.
        const projectHint = namesAProject(extracted?.project_hint, extracted?.vendor_hint)
          ? extracted?.project_hint ?? null
          : null;
        const filing = names
          ? resolveFiling(names, { project: projectHint, client: extracted?.client_name, vendor: extracted?.vendor_hint })
          : { projectId: null, vendorId: null };
        let projectId = filing.projectId;
        const vendorId = filing.vendorId;
        // The email found no job on file, but an attachment may name one the
        // email never mentioned — a quote whose sidemark is the client.
        if (names && !projectId) projectId = projectFromDocuments(names, read.map((r) => r.parsed));

        const { data: emailRow } = await supabaseAdmin
          .from('emails')
          .insert({
            org_id: orgId,
            gmail_id: email.gmailId,
            thread_id: email.threadId,
            from_addr: email.from,
            to_addr: email.to,
            subject: email.subject,
            snippet: email.snippet,
            // Keep what was actually written. Without it the only record of
            // a message is Gmail's one-line preview plus whatever the
            // extraction happened to name, so a link or a number mentioned
            // in passing is lost the moment the pass finishes.
            ...(await bodyFields(
              (email.body || email.snippet || '').slice(0, MAX_BODY_CHARS),
              linksIn(email.body || ''),
              (extracted ?? null) as Record<string, unknown> | null,
            )),
            received_at: email.receivedAt,
            // Null for the studio's shared address, so its history stays the
            // studio's; the connecting member's id for a personal mailbox,
            // which is what row security reads to keep it theirs — 0018.
            ...(ownerColumn ? { owner_id: ownerId } : {}),
            // The sender's own id for this message, identical in every
            // mailbox it reached — how a second copy is recognised (0019).
            ...(messageColumn ? { message_id: email.messageIdHeader || null } : {}),
            project_id: projectId,
            vendor_id: vendorId,
            class: extracted?.class ?? 'unclassified',
            confidence: extracted?.confidence ?? null,
          })
          .select('id')
          .maybeSingle();
        emailCount++;

        // Promote the email into vendor/project records where identifiable.
        if (emailRow) {
          await promoteEmail(orgId, {
            id: emailRow.id,
            class: extracted?.class ?? 'unclassified',
            vendor_id: vendorId,
            project_id: projectId,
            extracted_json: extracted ?? null,
          });
        }

        // The project the email ended up on — promotion may just have opened
        // it — is the one its attachments are filed under too.
        let filedProjectId = projectId;
        if (emailRow) {
          const { data: filed } = await supabaseAdmin.from('emails').select('project_id').eq('id', emailRow.id).maybeSingle();
          filedProjectId = (filed as { project_id: string | null } | null)?.project_id ?? projectId;
        }
        for (const r of read) {
          try {
            if (r.storedId) {
              // Read on an earlier pass and filed nowhere: file it now.
              if (filedProjectId) {
                await supabaseAdmin.from('documents').update({ project_id: filedProjectId }).eq('id', r.storedId).is('project_id', null);
              }
              continue;
            }
            const { data: docRow } = await supabaseAdmin
              .from('documents')
              .insert({
                org_id: orgId,
                drive_file_id: r.ref,
                project_id: filedProjectId,
                type: r.parsed?.type ?? 'other',
                parsed_json: r.parsed ?? null,
                confidence: r.parsed?.confidence ?? null,
              })
              .select('id')
              .maybeSingle();
            docCount++;
            if (docRow) {
              await promoteDocument(orgId, {
                id: docRow.id,
                type: r.parsed?.type ?? 'other',
                parsed_json: r.parsed ?? null,
                project_id: filedProjectId,
              });
            }
          } catch (err) {
            console.error('[ingest] storing attachment failed', r.att.filename, (err as Error).message);
          }
        }

        // Raise an internal task when the email implies work, assigned by
        // role. Isolated so an extraction failure never loses the email.
        if (emailRow && useAi) {
          try {
            const made = await createTaskFromEmail(
              orgId,
              emailRow.id,
              extracted?.class ?? 'unclassified',
              email,
            );
            if (made) taskCount++;
          } catch (err) {
            console.error('[ingest] task creation failed:', (err as Error).message);
          }
        }

        // Auto-draft a reply tailored to the email's type and content,
        // addressed to the real correspondent (not the forwarder) with CCs.
        if (emailRow && extracted && REPLYABLE.includes(extracted.class)) {
          try {
            // Exclude the connected account and — when this is a forward —
            // the forwarder's own address, so we never reply to ourselves.
            const isForward = /^(re:\s*)*(fwd:|fw:)/i.test(email.subject.trim());
            const forwarder = isForward ? addressOf(email.from || '') : '';
            const isMine = (a: string) => !a || a === selfEmail || a === forwarder;

            // The studio writes from eight addresses, three of them personal
            // Gmail, and only the connected one was ruled out here — which is
            // how a thread between colleagues produced a reply draft
            // addressed to janelle@ and cc'd to the rest of the team. A reply
            // goes to someone outside the studio or it is not a reply.
            const isOurs = (a: string) => isMine(a) || isStudioAddress(a);

            // Who to reply to: prefer the extracted counterparty, then the
            // Reply-To / From headers — skipping our own addresses.
            const toCandidates = [
              (extracted.reply_to_email ?? '').toLowerCase(),
              addressOf(email.replyTo || ''),
              addressOf(email.from || ''),
            ];
            const to = toCandidates.find((a) => a.includes('@') && !isOurs(a));

            if (!to) {
              console.warn('[ingest] no external recipient for reply on', email.gmailId);
            } else {
              // Kept in the system AND pushed to the real Gmail thread it
              // answers, so the studio can find, edit and send it from
              // Gmail — not just review it here. Dedupe by subject so
              // re-ingests don't create a second copy.
              const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;
              const withGmailMessage = await hasDraftGmailMessage();
              const { data: existingDraft } = await supabaseAdmin
                .from('drafts')
                .select('id, created_at, gmail_draft_id')
                .eq('org_id', orgId)
                .eq('subject', subject)
                .limit(1)
                .maybeSingle();

              // A thread's draft used to be written once, from whichever
              // message happened to be read first, then left alone however
              // far the conversation moved on — which is how an answer to a
              // superseded quote was still sitting in Drafts days later.
              // Still one draft per thread, but it answers the newest
              // message in it.
              const stale =
                !!existingDraft &&
                !!email.receivedAt &&
                new Date(email.receivedAt) > new Date(existingDraft.created_at as string);

              if (!existingDraft || stale) {
                // CCs: everyone else on the correspondence, minus self and the recipient.
                const cc = [...new Set([...(extracted.cc_emails ?? []).map((c) => c.toLowerCase()), ...addressesOf(email.cc)])]
                  .filter((a) => a.includes('@') && !isMine(a) && a !== to);

                const reply = await draftReply(email, extracted.class);
                if (reply) {
                  const ccLine = cc.length ? `\nCc: ${cc.join(', ')}` : '';
                  const composed = `To: ${to}${ccLine}\n\n${reply.body}`;
                  const priorDraftId = (existingDraft as { gmail_draft_id?: string | null } | null)?.gmail_draft_id;

                  // A failed Gmail push (an expired token, a quota error)
                  // must not lose the reply itself — the row above is
                  // still written either way, just without a live Gmail
                  // counterpart to open.
                  let pushed: { draftId: string; messageId: string } | null = null;
                  try {
                    const content: DraftContent = {
                      to, cc: cc.length ? cc.join(', ') : undefined,
                      subject: reply.subject, body: reply.body,
                      threadId: email.threadId || undefined,
                      inReplyTo: email.messageIdHeader || undefined,
                    };
                    pushed = priorDraftId
                      ? await updateDraft(gmail, priorDraftId, content)
                      : await createDraft(gmail, content);
                  } catch (err) {
                    console.error('[ingest] gmail draft push failed', email.gmailId, (err as Error).message);
                  }

                  if (existingDraft) {
                    // created_at moves with the message it answers, so the
                    // age shown in Drafts is the age of the answer.
                    await supabaseAdmin
                      .from('drafts')
                      .update({
                        body_preview: composed,
                        created_at: email.receivedAt ?? new Date().toISOString(),
                        ...(pushed ? { gmail_draft_id: pushed.draftId } : {}),
                        ...(pushed && withGmailMessage ? { gmail_message_id: pushed.messageId } : {}),
                      })
                      .eq('id', existingDraft.id as string);
                  } else {
                    await supabaseAdmin.from('drafts').insert({
                      org_id: orgId,
                      subject: reply.subject,
                      body_preview: composed,
                      // A reply quotes the thread it answers, so it inherits
                      // that mail's privacy — otherwise the draft would hand
                      // over the very words owner_id exists to protect.
                      ...(ownerColumn ? { owner_id: ownerId } : {}),
                      ...(pushed ? { gmail_draft_id: pushed.draftId } : {}),
                      ...(pushed && withGmailMessage ? { gmail_message_id: pushed.messageId } : {}),
                    });
                  }
                  replyCount++;
                }
              }
            }
          } catch (err) {
            console.error('[ingest] reply draft failed', email.gmailId, (err as Error).message);
          }
        }

      } catch (err) {
        console.error('[ingest] email failed', id, (err as Error).message);
      } finally {
        timed('email', emailStarted);
      }
    }
  }

  // ── Drive documents (PDF quotes / confirmations) ──────────
  // Skipped entirely when the mail already used the budget; the next pass
  // finds the same files, minus whatever got stored.
  if (useAi && !opts.range && !roomFor('doc')) done = false;
  try {
    if (!(useAi && !opts.range && roomFor('doc'))) drive = null;
    else drive ??= await driveFor(userId);
  } catch (err) {
    // The mail is already written; losing Drive as well would be worse than
    // reporting an incomplete pass.
    if (!isGoogleAuthFailure(err)) throw err;
    console.error('[ingest] Drive unavailable — Google needs reconnecting');
    done = false;
  }
  if (drive) {
    // The studio's project folders, when it keeps them: projects from the
    // folder list, and only PDFs filed inside a project folder, each already
    // knowing its project. Without them, Drive is read as it always was.
    let files: DriveFile[] = [];
    const folderOf = new Map<string, { folder: ProjectFolder; projectId: string | null }>();
    let fromFolders = false;
    try {
      const dp = driveProjects;
      const map = folderProjects;
      if (dp) {
        fromFolders = true;
        const candidates = await listProjectPdfs(drive, dp);
        // Skip what is already read before taking a batch, or the newest
        // fifteen — all stored — would stand in front of everything older.
        const stored = new Set<string>();
        for (let i = 0; i < candidates.length; i += 200) {
          const { data } = await supabaseAdmin
            .from('documents')
            .select('drive_file_id')
            .eq('org_id', orgId)
            .in('drive_file_id', candidates.slice(i, i + 200).map((c) => c.file.id));
          for (const row of data ?? []) stored.add((row as { drive_file_id: string }).drive_file_id);
        }
        for (const c of candidates.filter((x) => !stored.has(x.file.id)).slice(0, 15)) {
          files.push(c.file);
          folderOf.set(c.file.id, { folder: c.folder, projectId: map.get(c.folder.folderId) ?? null });
        }
      }
    } catch (err) {
      if (isGoogleAuthFailure(err)) throw err;
      console.error('[ingest] project folders unreadable, reading Drive as before:', (err as Error).message);
    }
    if (!fromFolders) files = await listPdfs(drive, { folderId: opts.folderId, max: 15 });

    for (const [index, file] of files.entries()) {
      if (!roomFor('doc')) {
        done = false;
        remaining += files.length - index;
        break;
      }
      if (file.size > MAX_PDF_BYTES) {
        console.warn('[ingest] Drive file too large to read', file.name, file.size);
        continue;
      }
      const fileStarted = Date.now();
      try {
        const { data: existing } = await supabaseAdmin
          .from('documents')
          .select('id')
          .eq('org_id', orgId)
          .eq('drive_file_id', file.id)
          .maybeSingle();
        if (existing) continue;

        const bytes = await downloadFile(drive, file.id);
        const driveNames = await loadStudioNames(orgId);
        const filedIn = folderOf.get(file.id);
        const extracted = await extractPdf(bytes, filedIn ? `${filedIn.folder.folderName}/${file.name}` : file.name, { orgId }, driveNames);
        // Where the studio filed it decides the project; what it says only
        // decides for a file outside the project folders.
        //
        // A template is the exception: the studio's Canva master carries a
        // real past job as its worked example, so reading its reference
        // plans filed the blank master under Lemon Residence. A copy still
        // holding its placeholders would do the same for whoever it is now
        // for. It keeps the folder it sits in and nothing more — its own
        // contents are a sample, not this job's facts.
        const isTemplate = extracted?.is_template === true;
        const projectId = isTemplate
          ? filedIn?.projectId ?? null
          : filedIn?.projectId ??
            resolveFiling(driveNames, {
              project: namesAProject(extracted?.project_hint, extracted?.vendor) ? extracted?.project_hint ?? null : null,
              client: extracted?.client,
            }).projectId;

        const { data: docRow } = await supabaseAdmin
          .from('documents')
          .insert({
            org_id: orgId,
            drive_file_id: file.id,
            project_id: projectId,
            type: extracted?.type ?? 'other',
            parsed_json: extracted ?? null,
            confidence: extracted?.confidence ?? null,
          })
          .select('id')
          .maybeSingle();
        docCount++;
        // Promotion is what turns a document into vendors, projects and
        // purchase orders. A template has none of those to give — only the
        // example job it was built from.
        if (docRow && !isTemplate) {
          await promoteDocument(orgId, { id: docRow.id, type: extracted?.type ?? 'other', parsed_json: extracted ?? null, project_id: projectId });
        }
      } catch (err) {
        console.error('[ingest] document failed', file.id, (err as Error).message);
      } finally {
        timed('doc', fileStarted);
      }
    }
  }

  // Fold any projects this pass split in two before anyone sees them.
  // Only once the queue is clear: a half-read inbox is the worst moment to
  // decide two names are the same job, and the next pass will do it anyway.
  // Never fatal — the mail is already stored, and a tidy-up that failed
  // must not turn a good pass into an error.
  // The watermark moves only here, and only on a pass that finished
  // everything Gmail offered it. An interrupted pass leaves the mark where
  // it was and the next one re-lists the same window — re-listing is cheap
  // and everything already stored is dropped without a Claude call, whereas
  // advancing past unread mail would lose it for good.
  //
  // `now`, not the last message's own date: a message delivered while the
  // pass was running is covered by the overlap the cursor reads back with.
  if (done && !opts.emailQuery && !opts.range) await advanceIngestCursor(orgId, userId);

  let mergedProjects = 0;
  let mergedTasks = 0;
  let refiled = 0;
  if (done) {
    try {
      // Older mail sitting under no project, whose attachments name one.
      refiled = (await refileFromAttachments(orgId)).refiled;
    } catch (err) {
      console.error('[ingest] re-filing from attachments failed:', (err as Error).message);
    }
    try {
      mergedProjects = (await autoMergeDuplicates(orgId)).removed;
    } catch (err) {
      console.error('[ingest] merging duplicate projects failed:', (err as Error).message);
    }
    try {
      mergedTasks = (await mergeDuplicateTasks(orgId)).removed;
    } catch (err) {
      console.error('[ingest] merging duplicate tasks failed:', (err as Error).message);
    }
    try {
      // A vendor filed as a project too, from before the hint was gated.
      await removeVendorProjects(orgId);
    } catch (err) {
      console.error('[ingest] removing vendor-projects failed:', (err as Error).message);
    }
  }

  // Uploads from a pass that did not get to delete its own. Cheap — file
  // operations are free — and it keeps a killed run from leaving 20MB
  // documents in the studio's storage indefinitely.
  await sweepStaleUploads(orgId);

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'ingest.run',
    entity: 'ingest',
    meta: {
      emails: emailCount,
      documents: docCount,
      replies: replyCount,
      tasks: taskCount,
      skipped: skippedCount,
      done,
      remaining,
      mergedProjects,
      mergedTasks,
      refiled,
    },
  });

  return {
    ok: true,
    emails: emailCount,
    documents: docCount,
    replies: replyCount,
    tasks: taskCount,
    skipped: skippedCount,
    done,
    remaining,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}
