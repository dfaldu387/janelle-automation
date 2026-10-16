import { supabaseAdmin } from '../lib/supabase.js';
import { driveCanWrite } from '../lib/google.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { hasEmailOwner } from '../lib/columns.js';
import { readDriveFilingSettings, senderAllowed, type DriveFilingSettings } from '../lib/driveFilingSettings.js';
import { driveFor, ensureFolderPath, findFiledByRef, uploadPdf } from './drive.js';
import { downloadAttachment, gmailForReply } from './gmail.js';

/**
 * The document organiser — Jenny as a filing clerk.
 *
 * Every PDF parsed from an email attachment already sits in `documents`, keyed
 * by `gmail:<messageId>:<attachmentId>` with the vendor, PO and total the
 * extractor read off it. This files those into a Drive tree the app owns:
 *
 *   <root> / Purchasing / <project> /   quotes, POs, order confirmations
 *   <root> / Accounting / <project> /   invoices, receipts
 *
 * Only attachments from the people the studio named (Adeleigh, Carissa by
 * default) are filed, and only on the `drive.file` grant — which reaches
 * nothing but the folders this created. The pass is idempotent: each upload
 * carries its origin ref, so a re-run files only what is new.
 *
 * Deliberately NOT included (the studio's choice): writing to the existing
 * trackers, or notifying anyone. This files and names; nothing more.
 */

/** The top of the organiser's own tree, under the studio account's My Drive. */
const ROOT_FOLDER = 'Janelle Interiors — Filed Documents';

/** Parsed document types that belong on the purchasing side. */
const PURCHASING_TYPES = new Set(['quote', 'purchase_order', 'order_confirmation']);
/** What marks a document as an accounting one, where the type does not say so. */
const ACCOUNTING_RE = /invoice|receipt|remittance|statement|\bbill\b/i;

const LANE = { purchasing: 'Purchasing', accounting: 'Accounting' } as const;

export interface FilingResult {
  filed: number;
  skipped: number;
  /** Why nothing ran, when nothing did. */
  reason?: 'not_configured' | 'disabled' | 'no_google' | 'needs_write_consent' | 'drive_unavailable';
}

interface DocRow {
  id: string;
  type: string;
  parsed_json: Record<string, unknown> | null;
  drive_file_id: string;
  project_id: string | null;
}

/** Which lane a document belongs in, or null when it is neither. */
function laneFor(type: string, parsed: Record<string, unknown>): 'Purchasing' | 'Accounting' | null {
  if (PURCHASING_TYPES.has(type)) return LANE.purchasing;
  // Invoices and receipts are not a distinct extracted type yet, so they land
  // as `other`; a keyword on what was parsed catches the ones that are plainly
  // accounting, and leaves the rest unfiled rather than guessing.
  if (ACCOUNTING_RE.test(JSON.stringify(parsed))) return LANE.accounting;
  return null;
}

/** A Drive-safe path segment — no slashes, trimmed, never empty. */
function segment(raw: string | null | undefined, fallback: string): string {
  const clean = String(raw ?? '').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

/** The filed name: what it is, who it is from, its number and date. */
function fileName(type: string, parsed: Record<string, unknown>): string {
  const label =
    type === 'purchase_order' ? 'PO'
    : type === 'order_confirmation' ? 'Order confirmation'
    : type === 'quote' ? 'Quote'
    : 'Document';
  const vendor = typeof parsed.vendor === 'string' ? parsed.vendor : null;
  const po = typeof parsed.po_number === 'string' ? parsed.po_number : null;
  const date = typeof parsed.date === 'string' ? parsed.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const stem = [label, vendor, po, date].filter(Boolean).join(' — ');
  return `${segment(stem, label)}.pdf`;
}

async function studioScopes(userId: string): Promise<string> {
  if (!supabaseAdmin) return '';
  const { data } = await supabaseAdmin
    .from('integrations')
    .select('scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();
  return (data as { scopes?: string | null } | null)?.scopes ?? '';
}

async function emailByGmailId(
  orgId: string,
  gmailId: string,
  withOwner: boolean,
): Promise<{ from_addr: string | null; owner_id: string | null } | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('emails')
    .select(withOwner ? 'from_addr, owner_id' : 'from_addr')
    .eq('org_id', orgId)
    .eq('gmail_id', gmailId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { from_addr?: string | null; owner_id?: string | null };
  return { from_addr: row.from_addr ?? null, owner_id: row.owner_id ?? null };
}

async function projectName(orgId: string, projectId: string | null): Promise<string> {
  if (!projectId || !supabaseAdmin) return 'Unfiled';
  const { data } = await supabaseAdmin.from('projects').select('name').eq('id', projectId).maybeSingle();
  return segment((data as { name?: string | null } | null)?.name, 'Unfiled');
}

/**
 * File every not-yet-filed attachment the studio asked for into Drive.
 *
 * Safe to call on every ingest and by hand: it skips what it has filed, what
 * is not from an allowed sender, and what is neither purchasing nor accounting.
 */
export async function fileDocumentsToDrive(orgId: string): Promise<FilingResult> {
  if (!supabaseAdmin) return { filed: 0, skipped: 0, reason: 'not_configured' };

  // Filing is automatic: it runs whenever the studio account can write to Drive
  // (checked below) and there is at least one named sender to file from. There
  // is no on/off switch — nobody to file from is the only "off".
  const settings: DriveFilingSettings = await readDriveFilingSettings(orgId);
  if (!settings.senders.length) return { filed: 0, skipped: 0, reason: 'disabled' };

  // The studio account owns the filing tree; attachment bytes are fetched with
  // the mailbox owner's own token below.
  const studioUser = await orgSourceUserId(orgId);
  if (!studioUser) return { filed: 0, skipped: 0, reason: 'no_google' };
  if (!driveCanWrite(await studioScopes(studioUser))) return { filed: 0, skipped: 0, reason: 'needs_write_consent' };
  const drive = await driveFor(studioUser);
  if (!drive) return { filed: 0, skipped: 0, reason: 'drive_unavailable' };

  const withOwner = await hasEmailOwner();
  const { data: docs } = await supabaseAdmin
    .from('documents')
    .select('id, type, parsed_json, drive_file_id, project_id')
    .eq('org_id', orgId)
    .like('drive_file_id', 'gmail:%')
    .order('created_at', { ascending: false })
    .limit(200);

  let filed = 0;
  let skipped = 0;
  for (const row of (docs ?? []) as DocRow[]) {
    const parsed = (row.parsed_json ?? {}) as Record<string, unknown>;
    if (parsed._drive_filed_at) continue; // already filed, by an earlier pass

    const lane = laneFor(row.type, parsed);
    if (!lane) continue; // neither purchasing nor accounting — leave it be

    const m = row.drive_file_id.match(/^gmail:([^:]+):(.+)$/);
    if (!m) { skipped++; continue; }
    const [, gmailId, attachmentId] = m;

    const email = await emailByGmailId(orgId, gmailId, withOwner);
    if (!email) { skipped++; continue; }
    if (!senderAllowed(settings, email.from_addr)) continue; // not someone we file for

    const gmail = await gmailForReply(orgId, email.owner_id);
    if (!gmail) { skipped++; continue; }

    let bytes: Buffer;
    try {
      bytes = await downloadAttachment(gmail, gmailId, attachmentId);
    } catch (err) {
      // A rotated/stale attachment id or a message since removed — the
      // original is still in Gmail, so this is a skip, not a failure.
      console.error('[drive-filing] attachment unreadable', row.drive_file_id, (err as Error).message);
      skipped++;
      continue;
    }

    try {
      const folderId = await ensureFolderPath(drive, [ROOT_FOLDER, lane, await projectName(orgId, row.project_id)]);
      const existing = await findFiledByRef(drive, row.drive_file_id);
      const file = existing ?? (await uploadPdf(drive, { folderId, name: fileName(row.type, parsed), bytes, sourceRef: row.drive_file_id }));
      await supabaseAdmin
        .from('documents')
        .update({
          parsed_json: {
            ...parsed,
            _drive_filed_at: new Date().toISOString(),
            _drive_file: { id: file.id, link: file.webViewLink, lane },
          },
        })
        .eq('id', row.id);
      filed++;
    } catch (err) {
      console.error('[drive-filing] filing failed', row.drive_file_id, (err as Error).message);
      skipped++;
    }
  }

  return { filed, skipped };
}
