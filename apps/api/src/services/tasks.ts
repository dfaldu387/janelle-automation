import {
  DEFAULT_SLA, SEATS, SEAT_KEYS, TASK_HYGIENE_SEAT, TASK_KIND_LABELS, TASK_KIND_ROLE, TASK_KINDS,
  TASK_CATEGORIES, defaultTaskCategory, dueDateFor, seatPeople,
  type Seat, type SlaSettings, type TaskKind, type UserRole,
} from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn, hasSubtasks, hasTaskCategory, hasTaskCompletion } from '../lib/columns.js';
import { extractTask, type TaskExtraction } from './extract.js';
import { loadStudioNames } from '../lib/studioNames.js';
import { STUDIO_TEAM, isAutomatedAddress, isStudioAddress, isStudioMailbox } from '../lib/studioTeam.js';
import { matchProjectId } from './promote.js';
import { matchPerson } from './proposals.js';
import { gmailFor, readSentMail, type ParsedEmail } from './gmail.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { bodyColumnsReady, readStoredText } from '../lib/emailStore.js';
import { extractJson, isAiReady } from './anthropic.js';

/**
 * An email whose "does this need a task?" has already been answered NO.
 *
 * Without it every scan asked the question again of every email that had
 * not raised a task — the studio's whole inbox, one Claude call each, on
 * every press of the button, to get the same "no" as last time. Kept in
 * `extracted_json` under an underscore key, the convention `emailStore`
 * already uses for data stored beside the model's own output, so it needs
 * no migration. Only a definite no is remembered: a call that failed is
 * worth asking again.
 */
const TASK_CHECKED_KEY = '_task_checked';

export async function markTaskChecked(emailId: string): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const { data } = await supabaseAdmin.from('emails').select('extracted_json').eq('id', emailId).maybeSingle();
    const current = (data as { extracted_json: Record<string, unknown> | null } | null)?.extracted_json ?? {};
    await supabaseAdmin
      .from('emails')
      .update({ extracted_json: { ...current, [TASK_CHECKED_KEY]: new Date().toISOString() } })
      .eq('id', emailId);
  } catch {
    // A missed mark costs one more question on the next scan, nothing more.
  }
}

/**
 * Classes that never imply internal work.
 *
 * Only Houzz's own automated notifications are excluded. "general" is NOT:
 * the studio delegates by email, so internal messages like "Task in houzz —
 * can you see if you can get Yael to send elevations" classify as general
 * and are exactly the work this system exists to capture. Filtering noise is
 * the extraction prompt's job, via needs_task.
 */
const IGNORED_CLASSES = ['houzz_notification'];

/** Statuses that still count against someone's workload. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * The studio's SLA, briefly cached.
 *
 * Every task raised needs it to work out a due date, and a reading pass
 * raises them in a loop — without this that is one extra query per email.
 */
const SLA_TTL_MS = 60_000;
const slaCache = new Map<string, { at: number; value: SlaSettings }>();

async function readSla(orgId: string): Promise<SlaSettings> {
  const hit = slaCache.get(orgId);
  if (hit && Date.now() - hit.at < SLA_TTL_MS) return hit.value;
  if (!supabaseAdmin) return DEFAULT_SLA;

  try {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .maybeSingle();
    const settings = ((data as { settings?: Partial<SlaSettings> } | null)?.settings ?? {}) as Partial<SlaSettings>;
    const value: SlaSettings = { ...DEFAULT_SLA, ...settings };
    slaCache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[tasks] SLA unreadable, using defaults:', (err as Error).message);
    return DEFAULT_SLA;
  }
}

/**
 * Resolve a name or address the sender used ("Joanna", "get Yael to...")
 * against the team. Matches on full name, either part of it, or the local
 * part of the email address, so a first name is enough.
 */
async function resolveNamedPerson(orgId: string, hint: string | null): Promise<string | null> {
  if (!supabaseAdmin || !hint) return null;
  const needle = hint.trim().toLowerCase();
  if (needle.length < 2) return null;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const accounts = (data ?? []) as { id: string; full_name: string | null; email: string | null }[];

  // The part of an address before the @ names its owner: "carissa" is
  // carissa@. Never a shared inbox's — "systems" is nobody.
  const byLocalPart = accounts.find(
    (p) => p.email && !isStudioMailbox(p.email) && !needle.includes('@') && p.email.split('@')[0].toLowerCase() === needle,
  );
  if (byLocalPart) return byLocalPart.id;

  // An address is exact or it is nobody; a name goes through the same matcher
  // Jenny uses: whole name, every word, the start of a name, a spelling one
  // or two letters out, every other spelling the studio lists — and never a
  // pick between two equally good answers. The substring test this replaced
  // gave any task that mentioned "an" to Brianna.
  const named = accounts.filter((p) => p.full_name) as { id: string; full_name: string; email: string | null }[];
  const match = matchPerson(hint, named);
  // Work nobody reads is not assigned: a shared inbox is never the owner.
  return match.status === 'found' && !isStudioMailbox(match.row.email) ? match.row.id : null;
}

/**
 * Whoever holds a seat: the account given that seat on Team & roles, then
 * the people the roles document names for it — by their address on the
 * studio's list, then by name. Null for the vacant COO seat, and for a seat
 * whose people have no account yet.
 */
async function resolveSeatHolder(orgId: string, seat: Seat): Promise<string | null> {
  if (!supabaseAdmin) return null;

  if (await hasSeatColumn()) {
    // A shared mailbox can end up holding a seat on Team & roles by
    // misconfiguration (e.g. the studio's own admin/automation account). It
    // still must not receive tasks: nobody reads work given to it, same as
    // every other resolver here excludes it.
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('org_id', orgId)
      .eq('seat', seat)
      .order('created_at', { ascending: true });
    const holder = ((data ?? []) as { id: string; email: string | null }[]).find(
      (p) => !isStudioMailbox(p.email),
    );
    if (holder) return holder.id;
  }

  // "Brianna Johnson / Amanda Neubecker" share the design seat; each in turn.
  // An account made with only a first name still counts, unless that first
  // name is shared.
  for (const name of seatPeople(seat)) {
    const email = STUDIO_TEAM.find((p) => p.name === name)?.email;
    for (const said of [email, name, name.split(' ')[0]]) {
      const id = said ? await resolveNamedPerson(orgId, said) : null;
      if (id) return id;
    }
  }
  return null;
}

/** Route to whoever holds the seat that owns this outcome. */
async function resolveBySeat(orgId: string, seat: Seat | null): Promise<string | null> {
  if (!seat || !SEAT_KEYS.includes(seat)) return null;
  return resolveSeatHolder(orgId, seat);
}

/**
 * Work out who owns a task from the email chain itself.
 *
 * The sender is delegating, so the person being written TO is the owner —
 * not the person writing. Skips the sender, and prefers the first teammate
 * on the To: line, falling back to Cc.
 *
 * A recipient that is the connected mailbox is not itself a person — but
 * mail routinely reaches it addressed to whoever reads it today, "Denish
 * Faldu <systems@...>". Discarding that line entirely threw away the one
 * signal the sender actually gave, so a shared-inbox recipient still gets a
 * chance: by the name on it, against the real team, once no recipient
 * resolved by address alone.
 */
async function resolveFromChain(
  orgId: string,
  parsed: { from?: string; to?: string; cc?: string | string[] },
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  // Gmail gives Cc as one header line, "A <a@x>, b@y"; older callers passed a
  // list. Treating the line as a list threw, and every task from a message
  // failed with it.
  const parties = (raw: string | string[] | undefined) =>
    (Array.isArray(raw) ? raw.join(',') : raw ?? '')
      .split(',')
      .map((part) => {
        const m = part.match(/<([^>]+)>/);
        const email = (m ? m[1] : part).trim().toLowerCase();
        const name = m ? part.slice(0, m.index).replace(/"/g, '').trim() : '';
        return { name: name || null, email };
      })
      .filter((p) => p.email.includes('@'));

  const senderAddrs = new Set(parties(parsed.from).map((p) => p.email));
  const recipients = [...parties(parsed.to), ...parties(parsed.cc)].filter((p) => !senderAddrs.has(p.email));
  if (recipients.length === 0) return null;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const profiles = (data ?? []) as { id: string; full_name: string | null; email: string | null }[];

  const byEmail = new Map<string, string>();
  for (const p of profiles) if (p.email) byEmail.set(p.email.toLowerCase(), p.id);

  // Pass 1: a recipient's own personal address — the strongest signal.
  // Order matters: To: before Cc:, first named first.
  for (const r of recipients) {
    if (isStudioMailbox(r.email)) continue;
    const id = byEmail.get(r.email);
    if (id) return id;
  }

  // Pass 2: only the shared mailbox was reachable, but a name rode along
  // with it. Weaker than a personal address, so it runs second, and never
  // matches a shared mailbox's own profile — nobody reads work given to it.
  const named = profiles.filter(
    (p): p is { id: string; full_name: string; email: string | null } => !!p.full_name && !isStudioMailbox(p.email),
  );
  for (const r of recipients) {
    if (!isStudioMailbox(r.email) || !r.name) continue;
    // The whole name first; a bare first name second — mail headers give
    // "Denish Faldu" where an account may only ever have been named "Denish".
    for (const said of [r.name, r.name.split(' ')[0]]) {
      const match = matchPerson(said, named);
      if (match.status === 'found') return match.row.id;
    }
  }

  return null;
}

/**
 * Pick the person who should own a task of this kind: whoever holds the
 * mapped role and currently carries the fewest live tasks, oldest profile
 * winning a tie. Returns null when nobody holds the role — the task is
 * then created unassigned and surfaced in the UI for a human to claim.
 */
async function resolveAssignee(
  orgId: string,
  role: UserRole,
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const { data: candidates } = await supabaseAdmin
    .from('profiles')
    .select('id, email')
    .eq('org_id', orgId)
    .eq('role', role)
    .order('created_at', { ascending: true });

  // A shared inbox holds a role so it can sign in; nobody reads work given to it.
  const ids = ((candidates ?? []) as { id: string; email: string | null }[])
    .filter((p) => !isStudioMailbox(p.email))
    .map((p) => p.id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  // Count live tasks per candidate and take the lightest load.
  const { data: load } = await supabaseAdmin
    .from('tasks')
    .select('assigned_to')
    .eq('org_id', orgId)
    .in('assigned_to', ids)
    .in('status', LIVE_STATUSES);

  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const row of load ?? []) {
    const id = (row as { assigned_to: string | null }).assigned_to;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // `ids` is already oldest-first, so the first minimum wins the tie.
  return ids.reduce((best, id) => ((counts.get(id) ?? 0) < (counts.get(best) ?? 0) ? id : best), ids[0]);
}

/**
 * Whoever runs the task board, as a last resort before leaving work ownerless.
 *
 * A studio only half-onboarded has nobody in most roles, so routing by kind
 * finds no one and the task lands unassigned — which in practice means
 * nobody ever sees it. The roles document already names who that is: the PM
 * support seat owns "chasing overdue and unassigned tasks", so triage is
 * genuinely that seat's work rather than a dumping ground.
 *
 * Deliberately NOT the principal. She is the bottleneck this system exists
 * to relieve, and quietly defaulting everything to her would rebuild the
 * problem in software.
 */
async function resolveTriage(orgId: string): Promise<string | null> {
  return resolveSeatHolder(orgId, TASK_HYGIENE_SEAT);
}

// ── Deduplication ───────────────────────────────────────────

/**
 * Compare titles without caring about case, punctuation or spacing.
 *
 * Claude writes the title fresh for each email, so the same ask arriving
 * twice comes back as "Tell Denish which Slack workspace to use (existing
 * or new)" both times — but a stray comma or a trailing full stop would
 * defeat a plain string comparison.
 */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Grammatical filler — articles, prepositions, conjunctions — that Claude
 * swaps freely when it re-words the same ask ("quote FROM Evelyn FOR Fred" vs
 * "Evelyn TO quote … FOR Fred"). Dropped before any overlap is measured so a
 * reorder of the same nouns and verbs reads as the same work. Deliberately NO
 * action verbs (order/return/install/measure): those are what tell two tasks
 * apart, so stripping them would merge "Order rug" with "Return rug".
 */
const TITLE_STOPWORDS = new Set(
  'a an and the to for of from on in into with by at as or this that your our'.split(' '),
);

/**
 * The distinct meaningful words of a title: titleKey's normalisation with
 * grammatical filler removed, so word order and swapped prepositions stop
 * splitting one reworded ask into two. See TITLE_STOPWORDS.
 */
function titleWords(title: string): Set<string> {
  return new Set(titleKey(title).split(' ').filter((w) => w && !TITLE_STOPWORDS.has(w)));
}

/**
 * How alike two tasks are to each other, 0..1, by the share of words they
 * have in common (Jaccard). An exact match scores 1.
 *
 * titleKey only flattens case, punctuation and spacing, so it sees one
 * reworded ask as two: Claude writes the title fresh for every email, and
 * "Send countertop and toilets quotes to Deb and Steve Lemon for approval"
 * came back a day later as "Send countertop SLAB and toilets quotes…" — one
 * piece of work, two rows on the board, neither dedup layer the wiser.
 */
function titleSimilarity(a: string, b: string): number {
  const sa = titleWords(a);
  const sb = titleWords(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  const union = sa.size + sb.size - shared;
  return union ? shared / union : 0;
}

/**
 * How many meaningful words two titles have in common (see titleWords).
 * Unlike titleSimilarity this is an absolute count, not a ratio, so two long
 * reworded titles that share the client and the item — "countertop" + "Lemon"
 * — register even when their Jaccard overlap sits below the fuzzy floor.
 */
function sharedContentWords(a: string, b: string): number {
  const wb = titleWords(b);
  let shared = 0;
  for (const w of titleWords(a)) if (wb.has(w)) shared++;
  return shared;
}

/** Below this many distinct words a title is too thin to fuzzy-match safely. */
const MIN_FUZZY_WORDS = 6;
/** At or above this overlap, two long-enough titles are the same work. */
const TITLE_SIM_THRESHOLD = 0.85;

/**
 * Whether two titles name the same piece of work.
 *
 * An exact normalised match always counts. Otherwise both titles must be
 * long enough to carry meaning, and overlap heavily: a single added
 * descriptor ("countertop" → "countertop slab", one extra word) clears the
 * bar, while a swapped noun ("countertop" → "flooring", a word lost AND a
 * word gained) falls below it and stays two tasks. Short titles — "Order
 * rug" vs "Order lamp" — never fuzzy-match, where one word is the whole
 * difference and a wrong merge would be worse than a repeat.
 */
function sameWork(a: string, b: string): boolean {
  if (titleKey(a) === titleKey(b)) return true;
  if (titleWords(a).size < MIN_FUZZY_WORDS || titleWords(b).size < MIN_FUZZY_WORDS) return false;
  return titleSimilarity(a, b) >= TITLE_SIM_THRESHOLD;
}

/**
 * The proportional band where a reworded repeat hides — alike enough to
 * suspect, too reworded for the word bar — and the model is asked. At or above
 * TITLE_SIM_THRESHOLD sameWork already merges them; below AMBIGUOUS_MIN the
 * ratio is too thin ON ITS OWN. But a ratio misses the new-thread case the
 * studio kept hitting: Janelle opens a fresh thread and rewords the ask, so two
 * long titles share only the client and the item and their Jaccard falls under
 * this floor though the work is plainly the same. So the model is ALSO asked
 * whenever a same-job task shares at least SHARED_WORDS_MIN meaningful words,
 * whatever the ratio. See the candidate build in createTaskFromEmail.
 */
const AMBIGUOUS_MIN = 0.4;
/**
 * Enough shared meaningful words to send a same-job pair to the model
 * regardless of ratio. Two — the client and the item, or a two-word item like
 * "roller shade" — is the reworded-same-work signal; one (just the client name,
 * shared by most tasks on a job) would drag in unrelated work.
 */
const SHARED_WORDS_MIN = 2;
/** At most this many borderline titles go to the model in one question. */
const MAX_SEMANTIC_CANDIDATES = 6;

const SEMANTIC_DEDUP_SYSTEM = `You keep an interior-design studio's task board free of reworded duplicates.

Claude writes each task's title fresh from a different email, so the SAME piece of work can appear twice in very different words. Decide whether a new task is a reworded duplicate of one already on the board.

SAME work = the same action, on the same thing, for the same job — regardless of wording, word order, or which details each title happens to mention:
- "Arrange Evelyn to measure and quote roller shade for Fred Keeler - Hitching Post" and "Arrange roller shade measure and quote for Fred Keeler kitchen" — SAME.

DIFFERENT work, however similar the words:
- a different action ("measure & quote" vs "install"), a different item ("dining table" vs "side table"), or a different job/client — NOT a duplicate.

Reply with ONLY {"match": <number>} giving the existing task that is the same work as the new one, or {"match": null} if none is.`;

/**
 * Which existing task (if any) is the same work as `title`, decided by the
 * model — the layer that catches reworded repeats word-overlap can't, like the
 * lean "Arrange roller shade measure and quote for Fred Keeler kitchen" against
 * a board already carrying the fuller "Arrange Evelyn to measure and quote
 * roller shade for Fred Keeler - Hitching Post". Returns the index into
 * `candidates`, or -1 for none. One cheap yes/no, asked only for the handful of
 * borderline titles the caller has already narrowed to.
 */
async function semanticDuplicate(orgId: string, title: string, candidates: string[]): Promise<number> {
  if (!candidates.length || !(await isAiReady(orgId))) return -1;
  const list = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
  try {
    const answer = await extractJson<{ match: number | null }>(
      SEMANTIC_DEDUP_SYSTEM,
      `New task: "${title}"\n\nExisting tasks:\n${list}`,
      { feature: 'task.extract', orgId },
      15_000,
    );
    const n = answer?.match;
    return typeof n === 'number' && n >= 1 && n <= candidates.length ? n - 1 : -1;
  } catch (err) {
    // A failed read is not a verdict: let the task through rather than lose it.
    console.error('[tasks] semantic dedup failed:', (err as Error).message);
    return -1;
  }
}

/**
 * Document numbers a task names — a quote, order or PO reference such as
 * EX00043246. Claude words each task fresh, so "Follow up on updated quote
 * EX00043246", "Receive and review updated quote EX00043246" and "Review
 * updated quote EX00043246" are three titles for one piece of work that a
 * title comparison never sees as the same.
 */
function refsOf(...texts: (string | null | undefined)[]): string[] {
  const found = texts.join(' ').toUpperCase().match(/\b[A-Z]{1,4}-?\d{5,}\b|\b\d{7,}\b/g) ?? [];
  return [...new Set(found.map((r) => r.replace('-', '')))];
}

interface DuplicateTaskRow {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
  assigned_to: string | null;
  next_step: string | null;
  due_date: string | null;
  detail: string | null;
  created_at: string;
}

/** Fields that make one copy of a task more useful than another. */
const TASK_FIELDS = ['assigned_to', 'next_step', 'due_date', 'detail'] as const;

function filled(t: DuplicateTaskRow): number {
  return TASK_FIELDS.filter((f) => t[f] !== null && t[f] !== undefined && t[f] !== '').length;
}

export interface TaskDedupe {
  ok: boolean;
  reason?: string;
  /** Task rows deleted. */
  removed: number;
  /** One entry per group folded together. */
  merged: { kept: string; removed: number }[];
}

/**
 * Remove tasks that are the same piece of work raised more than once.
 *
 * Creating a task now refuses a live duplicate, but the board already holds
 * the ones raised before that guard existed. Only LIVE work is considered:
 * a finished task and a new one with the same title are usually the job
 * genuinely coming round again, not a mistake.
 *
 * The survivor keeps whatever the copies knew that it did not — an owner, a
 * next step, a due date — so folding them together never loses detail.
 */
export async function mergeDuplicateTasks(orgId: string): Promise<TaskDedupe> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', removed: 0, merged: [] };

  const { data } = await supabaseAdmin
    .from('tasks')
    .select('id, title, status, project_id, assigned_to, next_step, due_date, detail, created_at, source_email_id')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: true });

  const tasks = (data ?? []) as DuplicateTaskRow[];

  // Same work AND same project. Two jobs may each need "Chase the vendor for
  // a quote", and those are two real tasks — so the project must match. Within
  // a project, titles are clustered by sameWork, not an exact key: the board
  // already holds reworded copies ("countertop" / "countertop slab") that an
  // exact-string group would leave side by side. Clustering is greedy against
  // the oldest member of each cluster (tasks arrive oldest-first); a handful of
  // live tasks per job makes the pairwise pass cheap.
  const clusters: DuplicateTaskRow[][] = [];
  for (const t of tasks) {
    const home = clusters.find(
      (c) => (c[0].project_id ?? null) === (t.project_id ?? null) && sameWork(c[0].title, t.title),
    );
    if (home) home.push(t);
    else clusters.push([t]);
  }

  const result: TaskDedupe = { ok: true, removed: 0, merged: [] };
  const deleted = new Set<string>();

  for (const group of clusters) {
    if (group.length < 2) continue;

    // The most complete copy survives; the oldest breaks a tie, being the
    // one people have already seen on the board.
    const keep = [...group].sort(
      (a, b) => filled(b) - filled(a) || a.created_at.localeCompare(b.created_at),
    )[0];
    const losers = group.filter((t) => t.id !== keep.id);

    try {
      const patch: Record<string, unknown> = {};
      for (const field of TASK_FIELDS) {
        if (keep[field] === null || keep[field] === undefined || keep[field] === '') {
          const donor = losers.find((l) => l[field] !== null && l[field] !== undefined && l[field] !== '');
          if (donor) patch[field] = donor[field];
        }
      }
      if (Object.keys(patch).length) {
        await supabaseAdmin.from('tasks').update(patch).eq('id', keep.id).eq('org_id', orgId);
      }

      // follow_ups.task_id cascades, so a reminder raised against a copy
      // goes with it rather than dangling.
      const { error } = await supabaseAdmin
        .from('tasks')
        .delete()
        .eq('org_id', orgId)
        .in('id', losers.map((l) => l.id));
      if (error) throw new Error(error.message);
      for (const l of losers) deleted.add(l.id);

      // The emails the removed copies came from must not raise them again on the next scan.
      for (const l of losers) {
        const src = (l as DuplicateTaskRow & { source_email_id?: string | null }).source_email_id;
        if (src) await markTaskChecked(src);
      }

      result.removed += losers.length;
      result.merged.push({ kept: keep.title, removed: losers.length });
    } catch (err) {
      // Leave this group alone rather than half-merged; the rest still run.
      console.error('[tasks] dedupe failed for', keep.title, (err as Error).message);
    }
  }

  // A live task raised in the same moment the SAME work was closed. The email
  // that finished a task can also ask for it, and before creation checked for
  // recently finished work one pass closed a copy and opened another — a done
  // card beside an identical open one. Only the same title on the same job,
  // created within minutes of the close: a job that genuinely comes round
  // again arrives days later, not seconds.
  const { data: finishedRows } = await supabaseAdmin
    .from('tasks')
    .select('title, project_id, completed_at')
    .eq('org_id', orgId)
    .eq('status', 'done')
    .not('completed_at', 'is', null);
  const closedAt = new Map<string, number[]>();
  for (const f of (finishedRows ?? []) as { title: string; project_id: string | null; completed_at: string }[]) {
    const key = `${f.project_id ?? 'none'}::${titleKey(f.title)}`;
    closedAt.set(key, [...(closedAt.get(key) ?? []), new Date(f.completed_at).getTime()]);
  }
  const SAME_MOMENT_MS = 10 * 60_000;
  const copies = tasks.filter((t) => {
    if (deleted.has(t.id)) return false;
    const stamps = closedAt.get(`${t.project_id ?? 'none'}::${titleKey(t.title)}`) ?? [];
    const made = new Date(t.created_at).getTime();
    return stamps.some((c) => Math.abs(made - c) <= SAME_MOMENT_MS);
  });
  if (copies.length) {
    const { error } = await supabaseAdmin
      .from('tasks')
      .delete()
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .in('id', copies.map((t) => t.id));
    if (error) {
      console.error('[tasks] could not drop copies of finished work:', error.message);
    } else {
      for (const t of copies) {
        const src = (t as DuplicateTaskRow & { source_email_id?: string | null }).source_email_id;
        if (src) await markTaskChecked(src);
      }
      result.removed += copies.length;
      result.merged.push(...copies.map((t) => ({ kept: `${t.title} (already finished)`, removed: 1 })));
    }
  }

  if (result.removed) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'tasks.deduped',
      entity: 'tasks',
      meta: { removed: result.removed, groups: result.merged },
    });
  }

  return result;
}

/**
 * Raise tasks from email already stored in the system.
 *
 * Ingestion skips messages it has seen before, so mail that arrived before
 * the tasks table existed would never produce work. This walks the stored
 * emails that have no task yet and runs the same extraction over them,
 * using the snippet and the summary Claude wrote at ingest time in place
 * of the original body.
 *
 * Safe to run repeatedly: emails that already have a task are skipped, and
 * the unique index is the backstop.
 */
// ────────────────────────────────────────────────────────────
//  Open → In progress, from the conversation itself
//
//  Every task on the board sat in Open, because the only thing that ever
//  moved one was a person changing the dropdown. A task is raised from an
//  email; the moment anybody writes on that thread again — the studio
//  answering it, or the vendor coming back — the work has started, and the
//  board should say so rather than waiting to be told.
//
//  Deliberately one-way and only out of `open`: blocked, done and cancelled
//  are judgements a person made, and a stray reply must not undo them.
// ────────────────────────────────────────────────────────────

/**
 * Move tasks whose source thread has moved to `in_progress`.
 *
 * Returns how many were advanced. Never throws: this runs behind ingestion
 * and must not be able to fail it.
 */
/**
 * Close a live task whose document number belongs to a task the system
 * already closed automatically — same quote or order, same project. Three
 * tasks were raised for one quote (chase it, receive it, review it); the mail
 * that finished two of them left the third open. Never touches a task a
 * person reopened (it has its own auto-close on record), and never one with
 * no project on either side to tie the two together.
 */
export async function closeRepeatsOfFinishedQuotes(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  const cols = 'id, title, detail, project_id';
  const [{ data: liveRows }, { data: doneRows }] = await Promise.all([
    supabaseAdmin.from('tasks').select(cols).eq('org_id', orgId).in('status', LIVE_STATUSES).not('project_id', 'is', null),
    supabaseAdmin.from('tasks').select(cols).eq('org_id', orgId).eq('status', 'done').not('project_id', 'is', null),
  ]);
  type Row = { id: string; title: string; detail: string | null; project_id: string };
  const live = ((liveRows ?? []) as Row[]).map((t) => ({ ...t, refs: refsOf(t.title, t.detail) })).filter((t) => t.refs.length);
  if (!live.length) return 0;
  const done = ((doneRows ?? []) as Row[]).map((t) => ({ ...t, refs: refsOf(t.title, t.detail) })).filter((t) => t.refs.length);
  if (!done.length) return 0;

  // Only work the system itself closed counts as proof; a person's own
  // completion says nothing about a different task.
  const { data: autoRows } = await supabaseAdmin
    .from('activity_log')
    .select('entity_id')
    .eq('org_id', orgId)
    .eq('action', 'task.auto_complete')
    .in('entity_id', [...done.map((t) => t.id), ...live.map((t) => t.id)]);
  const auto = new Set(((autoRows ?? []) as { entity_id: string }[]).map((r) => r.entity_id));

  const withNote = await hasTaskCompletion();
  let closed = 0;
  for (const t of live) {
    if (auto.has(t.id)) continue; // reopened by a person
    const twin = done.find(
      (d) => auto.has(d.id) && d.project_id === t.project_id && d.refs.some((r) => t.refs.includes(r)),
    );
    if (!twin) continue;
    const patch: Record<string, unknown> = { status: 'done' };
    if (withNote) patch.completion_note = `Closed automatically — the same quote was already closed as "${twin.title}".`;
    const { data } = await supabaseAdmin
      .from('tasks')
      .update(patch)
      .eq('id', t.id)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .select('id');
    if (!data?.length) continue;
    closed++;
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'task.auto_complete',
      entity: 'tasks',
      entity_id: t.id,
      meta: { title: t.title, evidence: `same document as closed task "${twin.title}"`, repeat_of: twin.id },
    });
  }
  return closed;
}

/**
 * Close live copies of work somebody has already finished.
 *
 * The same task can sit on the board more than once — raised from two emails,
 * or handed to two people — and when ONE copy is done the others are no longer
 * work. Same job and same wording, and the finished copy was completed after
 * the live one was raised: the live copy was waiting while the other got done.
 * A copy raised AFTER the finish is the job coming round again and is left
 * alone (a few minutes of slack covers the pass that closes one and raises the
 * next). Closed with a note saying who did it, so the board explains itself.
 * Returns how many were closed.
 */
export async function closeCopiesOfFinishedTasks(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  const withCompletion = await hasTaskCompletion();
  const cols = `id, title, project_id, created_at, assigned_to, updated_at${withCompletion ? ', completed_at' : ''}`;
  const [{ data: liveRows }, { data: doneRows }] = await Promise.all([
    supabaseAdmin.from('tasks').select(cols).eq('org_id', orgId).in('status', LIVE_STATUSES),
    supabaseAdmin.from('tasks').select(`${cols}, profiles(full_name)`).eq('org_id', orgId).eq('status', 'done'),
  ]);
  type Row = {
    id: string; title: string; project_id: string | null; created_at: string; assigned_to: string | null;
    updated_at: string | null; completed_at?: string | null; profiles?: { full_name: string | null } | null;
  };
  const live = (liveRows ?? []) as unknown as Row[];
  const done = (doneRows ?? []) as unknown as Row[];
  if (!live.length || !done.length) return 0;

  const SLACK_MS = 10 * 60_000;
  let closed = 0;
  for (const t of live) {
    const key = titleKey(t.title);
    const made = new Date(t.created_at).getTime();
    const twin = done.find((d) => {
      if (d.id === t.id || titleKey(d.title) !== key) return false;
      if (d.project_id !== t.project_id) return false;
      const finished = new Date(d.completed_at ?? d.updated_at ?? 0).getTime();
      return finished >= made - SLACK_MS;
    });
    if (!twin) continue;

    const who = twin.profiles?.full_name || 'a teammate';
    const day = new Date(twin.completed_at ?? twin.updated_at ?? Date.now()).toISOString().slice(0, 10);
    const patch: Record<string, unknown> = { status: 'done' };
    if (withCompletion) patch.completion_note = `Closed automatically — the same task was already completed by ${who} on ${day}.`;
    const { data } = await supabaseAdmin
      .from('tasks')
      .update(patch)
      .eq('id', t.id)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .select('id');
    if (!data?.length) continue;
    closed++;
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'task.auto_complete',
      entity: 'tasks',
      entity_id: t.id,
      meta: { title: t.title, evidence: `same task already completed by ${who}`, repeat_of: twin.id },
    });
  }
  return closed;
}

/**
 * Give a live task with no project the job its own wording names.
 *
 * Deliberately narrow: a project counts only when its whole name appears in
 * the title or detail as a run of words, and only one project (the longest,
 * when one name contains another) qualifies. A wrong project on a task is
 * worse than none, so anything less clear is left for a person.
 */
export async function linkUnfiledTasks(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;
  const { data } = await supabaseAdmin
    .from('tasks')
    .select('id, title, detail')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES)
    .is('project_id', null);
  const unfiled = (data ?? []) as { id: string; title: string; detail: string | null }[];
  if (!unfiled.length) return 0;

  const words = (s: string) =>
    ` ${s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;
  const { projects } = await loadStudioNames(orgId);
  const candidates = projects
    .filter((p) => !p.archived)
    .map((p) => ({ id: p.id, key: words(p.name) }))
    .filter((p) => p.key.trim().length >= 5);

  let linked = 0;
  for (const t of unfiled) {
    const text = words(`${t.title} ${t.detail ?? ''}`);
    const hits = candidates.filter((p) => text.includes(p.key)).sort((a, b) => b.key.length - a.key.length);
    if (!hits.length) continue;
    // Two different jobs named, neither containing the other: not safe to pick.
    if (hits.slice(1).some((h) => !hits[0].key.includes(h.key))) continue;
    const { error } = await supabaseAdmin.from('tasks').update({ project_id: hits[0].id }).eq('id', t.id);
    if (!error) linked++;
  }
  return linked;
}

export async function advanceActiveTasks(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  try {
    await closeRepeatsOfFinishedQuotes(orgId);
  } catch (err) {
    console.error('[tasks] closing repeats of finished quotes failed:', (err as Error).message);
  }

  try {
    await closeCopiesOfFinishedTasks(orgId);
  } catch (err) {
    console.error('[tasks] closing copies of finished tasks failed:', (err as Error).message);
  }

  try {
    await linkUnfiledTasks(orgId);
  } catch (err) {
    console.error('[tasks] linking unfiled tasks failed:', (err as Error).message);
  }

  try {
    const { data: openTasks } = await supabaseAdmin
      .from('tasks')
      .select('id, title, source_email_id, created_at, project_id, vendor_id')
      .eq('org_id', orgId)
      .eq('status', 'open');

    const tasks = (openTasks ?? []) as unknown as {
      id: string; title: string; source_email_id: string | null; created_at: string;
      project_id: string | null; vendor_id: string | null;
    }[];
    if (!tasks.length) return 0;

    // The thread each task came out of.
    const sourceIds = tasks.map((t) => t.source_email_id).filter((id): id is string => !!id);
    const { data: sources } = sourceIds.length
      ? await supabaseAdmin.from('emails').select('id, thread_id').in('id', sourceIds)
      : { data: [] };
    const threadOf = new Map(
      ((sources ?? []) as { id: string; thread_id: string | null }[])
        .filter((e) => e.thread_id)
        .map((e) => [e.id, e.thread_id as string]),
    );

    // Everything the studio has read since the oldest open task was raised —
    // not only mail on those threads.
    //
    // A conversation does not stay in its thread. Somebody drops out of it
    // and writes a fresh email about the same job a week later, and to a
    // thread-scoped check that is silence: the task sat at Open and aged
    // into overdue while the work was visibly moving. What identifies the
    // conversation is the job and the supplier, not the thread id.
    const oldest = tasks.reduce((min, t) => (t.created_at < min ? t.created_at : min), tasks[0].created_at);
    const { data: later } = await supabaseAdmin
      .from('emails')
      .select('thread_id, received_at, project_id, vendor_id')
      .eq('org_id', orgId)
      .gte('received_at', oldest)
      .order('received_at', { ascending: false })
      .limit(1000);

    const lastInbound = new Map<string, string>();
    /** Latest mail per supplier, and per supplier-on-a-job. */
    const lastByVendor = new Map<string, string>();
    const lastByVendorJob = new Map<string, string>();
    const keep = (map: Map<string, string>, key: string, at: string) => {
      const seen = map.get(key);
      if (!seen || seen < at) map.set(key, at);
    };
    for (const row of (later ?? []) as {
      thread_id: string | null; received_at: string | null; project_id: string | null; vendor_id: string | null;
    }[]) {
      if (!row.received_at) continue;
      if (row.thread_id) keep(lastInbound, row.thread_id, row.received_at);
      if (row.vendor_id) {
        keep(lastByVendor, row.vendor_id, row.received_at);
        if (row.project_id) keep(lastByVendorJob, `${row.vendor_id}|${row.project_id}`, row.received_at);
      }
    }

    // The addresses each supplier is reached at, so "we wrote to them" can
    // be recognised on a thread this system has never seen.
    const { data: vendorRows } = await supabaseAdmin
      .from('vendors')
      .select('id, contacts')
      .eq('org_id', orgId);
    const vendorAddresses = new Map<string, string[]>();
    for (const v of (vendorRows ?? []) as { id: string; contacts: { email?: string }[] | null }[]) {
      const list = (Array.isArray(v.contacts) ? v.contacts : [])
        .map((c) => (c.email ?? '').trim().toLowerCase())
        .filter(Boolean);
      if (list.length) vendorAddresses.set(v.id, list);
    }

    // And the half ingestion cannot see: the studio replying from Gmail,
    // which is the most direct evidence there is that someone picked the
    // task up.
    let sentOnThread = new Map<string, string>();
    let sentToAddress = new Map<string, string>();
    try {
      const days = Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400_000) + 1;
      const userId = await orgSourceUserId(orgId);
      const gmail = userId ? await gmailFor(userId) : null;
      if (gmail) {
        const sent = await readSentMail(gmail, Math.min(days, 30));
        sentOnThread = sent.byThread;
        sentToAddress = sent.byAddress;
      }
    } catch (err) {
      console.error('[tasks] sent-mail check failed', (err as Error).message);
    }

    /**
     * Why this task is moving, or null if nothing says it is.
     *
     * Three kinds of evidence, strongest first. Each one is deliberately
     * narrow: "in progress" has to keep meaning something, so a busy job is
     * not allowed to advance every task attached to it. The supplier is
     * what ties the evidence to the work — mail about the same job from
     * somebody unrelated proves nothing about this particular task.
     */
    const movedBy = (t: (typeof tasks)[number]): string | null => {
      const after = (at: string | undefined) => !!at && at > t.created_at;

      const thread = t.source_email_id ? threadOf.get(t.source_email_id) : undefined;
      if (thread && (after(sentOnThread.get(thread)) || after(lastInbound.get(thread)))) {
        return 'a message on its own thread';
      }

      if (!t.vendor_id) return null;

      // The studio wrote to this supplier — on any thread, including one
      // composed fresh. The most direct evidence there is that a person
      // picked the task up, and the case a thread check cannot see at all.
      const addresses = vendorAddresses.get(t.vendor_id) ?? [];
      if (addresses.some((a) => after(sentToAddress.get(a)))) return 'the studio wrote to the supplier';

      // The supplier wrote back. Tied to the job where the task names one,
      // so an unrelated order with the same vendor does not count.
      const key = t.project_id ? `${t.vendor_id}|${t.project_id}` : null;
      if (key ? after(lastByVendorJob.get(key)) : after(lastByVendor.get(t.vendor_id))) {
        return 'the supplier wrote about this job';
      }

      return null;
    };

    const moving = tasks
      .map((t) => ({ task: t, why: movedBy(t) }))
      .filter((m): m is { task: (typeof tasks)[number]; why: string } => m.why !== null);
    if (!moving.length) return 0;

    await supabaseAdmin
      .from('tasks')
      .update({ status: 'in_progress' })
      .in('id', moving.map((m) => m.task.id));

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'tasks.advanced',
      entity: 'tasks',
      // What moved each one, so a status nobody set can be accounted for.
      meta: {
        count: moving.length,
        moved: moving.slice(0, 8).map((m) => ({ title: m.task.title, why: m.why })),
      },
    });

    return moving.length;
  } catch (err) {
    console.error('[tasks] advancing failed', (err as Error).message);
    return 0;
  }
}

// ────────────────────────────────────────────────────────────
//  Closing work the mail shows is finished
//
//  advanceActiveTasks says a task has started. Nothing said it had ended:
//  a task whose work was done early — the vendor sent the quote, the client
//  approved — stayed on the board until somebody dragged it to Done, and
//  once its date passed the nightly engine chased its owner for work that
//  was already finished.
//
//  The email that finishes a task is read anyway, by the same Claude call
//  that decides whether it raises one, so that call is also shown the open
//  tasks it could plausibly finish and asked which it does. No extra call,
//  and a close has to quote the words in the email that prove it.
// ────────────────────────────────────────────────────────────

/** At most this many open tasks are put to the model per email. */
const MAX_CLOSABLE = 8;

export interface LiveTask {
  id: string;
  title: string;
  kind: TaskKind;
  next_step: string | null;
  due_date: string | null;
  created_at: string;
  project_id: string | null;
  vendor_id: string | null;
  source_email_id: string | null;
  projects?: { name: string } | null;
  vendors?: { name: string } | null;
}

/** The email being read, as stored. */
export interface EmailFacts {
  id: string;
  thread_id: string | null;
  received_at: string | null;
  project_id: string | null;
  vendor_id: string | null;
  subject: string | null;
  from_addr: string | null;
}

export interface ClosableTask {
  ref: string;
  task: LiveTask;
  /** One line for the prompt: the task, its job and supplier, and why it was picked. */
  line: string;
}

const LIVE_TASK_COLUMNS =
  'id, title, kind, next_step, due_date, created_at, project_id, vendor_id, source_email_id, projects(name), vendors(name)';

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * The live tasks one email could plausibly finish, closest first.
 *
 * Related means the same thread, or the same job, or the same supplier on a
 * job that does not contradict it — a quote from a vendor for one job must
 * not close the chase for the same vendor's quote on another. And the email
 * has to come AFTER the ask: mail from before a task existed cannot be its
 * answer, which matters when an older email is read late.
 *
 * Pure, so the ranking can be checked without a database.
 */
export function rankClosable(
  email: EmailFacts,
  tasks: LiveTask[],
  sources: Map<string, { thread_id: string | null; received_at: string | null }>,
): { task: LiveTask; why: string }[] {
  const at = Number.isNaN(ms(email.received_at)) ? Date.now() : ms(email.received_at);
  const scored: { task: LiveTask; why: string; score: number }[] = [];

  for (const t of tasks) {
    if (t.source_email_id === email.id) continue;
    const source = t.source_email_id ? sources.get(t.source_email_id) : undefined;
    const since = Number.isNaN(ms(source?.received_at)) ? ms(t.created_at) : ms(source?.received_at);
    if (!Number.isNaN(since) && at <= since) continue;

    const sameThread = !!email.thread_id && source?.thread_id === email.thread_id;
    const sameProject = !!email.project_id && t.project_id === email.project_id;
    const sameVendor = !!email.vendor_id && t.vendor_id === email.vendor_id;
    const otherJob = !!email.project_id && !!t.project_id && t.project_id !== email.project_id;

    if (!sameThread && otherJob) continue;
    const score = sameThread ? 3 : sameProject && sameVendor ? 2 : sameProject || sameVendor ? 1 : 0;
    if (!score) continue;

    const why = sameThread ? 'same email thread' : sameProject && sameVendor ? 'same job and supplier' : sameProject ? 'same job' : 'same supplier';
    scored.push({ task: t, why, score });
  }

  // Closest relation first, then the newest ask: a thread's latest request is
  // the one a reply is most likely answering.
  scored.sort((a, b) => b.score - a.score || ms(b.task.created_at) - ms(a.task.created_at));
  return scored.map(({ task, why }) => ({ task, why }));
}

function closableLine(t: LiveTask, why: string): string {
  return [
    `${t.title} (${TASK_KIND_LABELS[t.kind] ?? t.kind})`,
    t.projects?.name ? `job: ${t.projects.name}` : null,
    t.vendors?.name ? `supplier: ${t.vendors.name}` : null,
    t.next_step ? `next step: ${t.next_step}` : null,
    `raised ${t.created_at.slice(0, 10)}`,
    why,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The open tasks to show the model for this email, with refs.
 *
 * Two kinds are left out on purpose: a task a person reopened after the
 * system had closed it (they have said it is not finished, and the next
 * reply on the thread would only close it again), and a parent whose
 * subtasks are still live (its steps are the record of what is left).
 * Never throws — without it, the email still raises its task.
 */
async function loadClosable(orgId: string, email: EmailFacts): Promise<ClosableTask[]> {
  if (!supabaseAdmin) return [];
  try {
    const { data: rows } = await supabaseAdmin
      .from('tasks')
      .select(LIVE_TASK_COLUMNS)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES);
    const live = (rows ?? []) as unknown as LiveTask[];
    if (!live.length) return [];

    const sourceIds = [...new Set(live.map((t) => t.source_email_id).filter((id): id is string => !!id))];
    const { data: sourceRows } = sourceIds.length
      ? await supabaseAdmin.from('emails').select('id, thread_id, received_at').in('id', sourceIds)
      : { data: [] };
    const sources = new Map(
      ((sourceRows ?? []) as { id: string; thread_id: string | null; received_at: string | null }[]).map((e) => [e.id, e]),
    );

    const ranked = rankClosable(email, live, sources);
    if (!ranked.length) return [];
    const ids = ranked.map((r) => r.task.id);

    const { data: reopened } = await supabaseAdmin
      .from('activity_log')
      .select('entity_id')
      .eq('org_id', orgId)
      .eq('action', 'task.auto_complete')
      .in('entity_id', ids);
    const skip = new Set(((reopened ?? []) as { entity_id: string }[]).map((r) => r.entity_id));

    if (await hasSubtasks()) {
      const { data: kids } = await supabaseAdmin
        .from('tasks')
        .select('parent_task_id')
        .in('parent_task_id', ids)
        .in('status', LIVE_STATUSES);
      for (const k of (kids ?? []) as { parent_task_id: string }[]) skip.add(k.parent_task_id);
    }

    return ranked
      .filter((r) => !skip.has(r.task.id))
      .slice(0, MAX_CLOSABLE)
      .map((r, i) => ({ ref: `T${i + 1}`, task: r.task, line: closableLine(r.task, r.why) }));
  } catch (err) {
    console.error('[tasks] finding closable tasks failed:', (err as Error).message);
    return [];
  }
}

/** "Acme Sales" from `"Acme Sales" <sales@acme.com>`; the address when there is no name. */
/**
 * Where a stored message's text lives, which depends on whether migration
 * 0010 has been applied — before it, the body was tucked inside
 * `extracted_json`. `readStoredText` reads either shape.
 */
async function bodyFieldNames(): Promise<string[]> {
  return (await bodyColumnsReady()) ? ['body_text', 'links', 'extracted_json'] : ['extracted_json'];
}

/** How many earlier messages of a thread are worth the tokens. */
const THREAD_CONTEXT = 4;

/** How much of each one — enough to carry the ask, not the whole history. */
const THREAD_CHARS = 1500;

/**
 * What was said before this message, oldest first.
 *
 * The work an email implies is usually not in the email. A thread opens with
 * the ask and closes with "approved, go ahead" — and the closing message,
 * read on its own, was all the task extractor ever saw. It could not name
 * the job, the supplier or the work, so it raised nothing, or raised a task
 * whose title was the word "Approved".
 *
 * Bounded on purpose: the last few messages carry the ask, and a long thread
 * would otherwise cost more in tokens than the task is worth. Never throws —
 * a task read from one message is worse than one read from the conversation,
 * but far better than no task at all.
 */
async function loadThreadContext(
  orgId: string,
  threadId: string | null,
  exceptEmailId: string,
): Promise<{ from: string; date: string; text: string }[]> {
  if (!supabaseAdmin || !threadId) return [];
  try {
    const { data } = await supabaseAdmin
      .from('emails')
      .select(`id, from_addr, subject, snippet, received_at, ${(await bodyFieldNames()).join(', ')}`)
      .eq('org_id', orgId)
      .eq('thread_id', threadId)
      .neq('id', exceptEmailId)
      .order('received_at', { ascending: false })
      .limit(THREAD_CONTEXT);

    // A column list built at runtime cannot be parsed by the typed client.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return rows
      .reverse() // oldest first: a conversation only reads forwards
      .map((row) => {
        const text = readStoredText(row as Parameters<typeof readStoredText>[0]).body
          ?? (row.snippet as string | null)
          ?? '';
        return {
          from: (row.from_addr as string | null) ?? 'unknown',
          date: ((row.received_at as string | null) ?? '').slice(0, 10) || 'undated',
          text: text.trim().slice(0, THREAD_CHARS),
        };
      })
      .filter((m) => m.text.length > 0);
  } catch (err) {
    console.error('[tasks] thread context unreadable:', (err as Error).message);
    return [];
  }
}

function senderName(from: string | null): string {
  const raw = (from ?? '').trim();
  const name = raw.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return name || raw.replace(/[<>]/g, '') || 'an unknown sender';
}

/**
 * Close the tasks the model says this email finished.
 *
 * Only refs it was shown, only with evidence, and only while the task is
 * still live — a person may have closed or reopened it while the email was
 * being read. Each close is logged with the words that justified it, and
 * the note on the task (migration 0015) says the same on the board.
 * Returns the ids closed.
 */
async function closeFinished(
  orgId: string,
  email: EmailFacts,
  closable: ClosableTask[],
  completes: TaskExtraction['completes'],
): Promise<string[]> {
  if (!supabaseAdmin || !closable.length || !Array.isArray(completes)) return [];

  const byRef = new Map(closable.map((c) => [c.ref, c.task]));
  const withNote = await hasTaskCompletion();
  const day = (email.received_at ?? new Date().toISOString()).slice(0, 10);
  const closed: string[] = [];

  for (const c of completes) {
    const task = byRef.get(String(c?.ref ?? '').trim().toUpperCase());
    const evidence = String(c?.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // No proof, no close: an invented ref or an empty reason is not an answer.
    if (!task || !evidence || closed.includes(task.id)) continue;

    const patch: Record<string, unknown> = { status: 'done' };
    if (withNote) {
      patch.completion_note =
        `Closed automatically — "${email.subject?.trim() || '(no subject)'}" from ${senderName(email.from_addr)}, ${day}: "${evidence}"`;
    }
    const { data } = await supabaseAdmin
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .select('id');
    if (!data?.length) continue;
    closed.push(task.id);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'task.auto_complete',
      entity: 'tasks',
      entity_id: task.id,
      meta: {
        title: task.title,
        email_id: email.id,
        evidence,
        due_date: task.due_date,
        // What the studio asked for: whether finished work was early.
        finished: !task.due_date ? null : day < task.due_date ? 'early' : day === task.due_date ? 'on_time' : 'late',
      },
    });
  }
  return closed;
}

// ────────────────────────────────────────────────────────────
//  The hourly look over the board
//
//  closeFinished runs as each email is read, and sees that one email beside
//  up to eight tasks. That misses a task whose answer came in pieces over
//  several messages, mail that raised no task of its own (so never reached
//  the check), and a task that ranked ninth for the email that finished it.
//  Once an hour every live task is put beside everything said about it since
//  it was raised, and closed when that shows the work is done.
//
//  Only a task with mail it has not been checked against costs a Claude
//  call, so a quiet hour costs nothing.
// ────────────────────────────────────────────────────────────

/** Per task, the newest email it has been checked against. */
const REVIEW_FIELD = 'task_reviewed_at';

/** Most tasks put to the model in one sweep; the rest wait an hour. */
const MAX_REVIEWS_PER_SWEEP = 20;

/** Of each task's related mail, the latest this many go in the prompt. */
const REVIEW_EMAILS = 6;
const REVIEW_CHARS = 1500;

const REVIEW_SYSTEM = `You check whether one task on an interior design studio's board is finished,
from the emails about it that arrived after it was raised.

Return {"done": true|false, "email": "E1", "evidence": "the few words of that email that prove it"}.

The task is done when an email shows the thing it was waiting for has happened: the vendor sent the
quote or drawing it was chasing, the client gave the approval it asked for, the order is confirmed,
the delivery is booked, or a teammate says they have done it. It is NOT done on a promise ("I'll
send it Friday"), an acknowledgement ("got it, looking into it"), a question back, a partial answer,
or an email about a different item on the same job. When in doubt, answer done=false: a task closed
wrongly disappears from the board, while one left open costs a click.

When done is false, email and evidence are null.`;

interface ReviewEmail extends EmailFacts {
  snippet: string | null;
  body_text?: string | null;
  extracted_json?: Record<string, unknown> | null;
}

export interface TaskReview {
  ok: boolean;
  reason?: string;
  /** Tasks put to the model. */
  reviewed: number;
  /** Of those, closed as done. */
  closed: number;
  /** Tasks with new mail left for the next sweep, on the cap or the clock. */
  waiting: number;
}

async function readOrgSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}

async function readReviewMarks(orgId: string): Promise<Record<string, string>> {
  const marks = (await readOrgSettings(orgId))[REVIEW_FIELD];
  return marks && typeof marks === 'object' ? { ...(marks as Record<string, string>) } : {};
}

/**
 * Merged into settings by Postgres in one UPDATE (`merge_org_settings`,
 * migration 0023), not read-modify-written here: this field lives beside
 * ingest's own cron-slot and per-mailbox watermarks in the same JSONB blob,
 * and a plain read-then-write let whichever of them wrote last erase the
 * others — a race, not "a setting saved meanwhile", so reading first no
 * longer helps.
 */
async function saveReviewMarks(orgId: string, marks: Record<string, string>): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc('merge_org_settings', {
    p_org_id: orgId,
    p_patch: { [REVIEW_FIELD]: marks },
  });
  // Losing the marks costs a re-check next hour, never a wrong close.
  if (error) console.error('[tasks] review marks not saved:', error.message);
}

/**
 * Close every live task that the mail since it was raised shows is done.
 *
 * Never throws: it runs on a timer, and one studio's failure must not stop
 * the next one's. Budgeted, so a hosted cron answers before its timeout.
 */
export async function reviewOpenTasks(orgId: string, opts: { budgetMs?: number } = {}): Promise<TaskReview> {
  const none = (reason: string): TaskReview => ({ ok: false, reason, reviewed: 0, closed: 0, waiting: 0 });
  if (!supabaseAdmin) return none('supabase_not_configured');
  if (!(await isAiReady(orgId))) return none('anthropic_not_configured');

  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  let reviewed = 0;
  let closed = 0;

  try {
    const { data: rows } = await supabaseAdmin
      .from('tasks')
      .select(LIVE_TASK_COLUMNS)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES);
    let live = (rows ?? []) as unknown as LiveTask[];
    const marks = await readReviewMarks(orgId);

    // Forget tasks that are no longer live, so the map does not grow forever.
    const liveIds = new Set(live.map((t) => t.id));
    for (const id of Object.keys(marks)) if (!liveIds.has(id)) delete marks[id];

    // The same two exclusions as the per-email check: a task a person
    // reopened after the system closed it, and a parent with live steps.
    if (live.length) {
      const ids = live.map((t) => t.id);
      const { data: reopened } = await supabaseAdmin
        .from('activity_log')
        .select('entity_id')
        .eq('org_id', orgId)
        .eq('action', 'task.auto_complete')
        .in('entity_id', ids);
      const skip = new Set(((reopened ?? []) as { entity_id: string }[]).map((r) => r.entity_id));
      if (await hasSubtasks()) {
        const { data: kids } = await supabaseAdmin
          .from('tasks')
          .select('parent_task_id')
          .in('parent_task_id', ids)
          .in('status', LIVE_STATUSES);
        for (const k of (kids ?? []) as { parent_task_id: string }[]) skip.add(k.parent_task_id);
      }
      live = live.filter((t) => !skip.has(t.id));
    }
    if (!live.length) {
      await saveReviewMarks(orgId, marks);
      return { ok: true, reviewed: 0, closed: 0, waiting: 0 };
    }

    // Every email since the oldest live task was raised, newest first.
    const oldest = live.reduce((min, t) => (t.created_at < min ? t.created_at : min), live[0].created_at);
    const { data: mailRows } = await supabaseAdmin
      .from('emails')
      .select(`id, thread_id, received_at, project_id, vendor_id, subject, from_addr, snippet, ${(await bodyFieldNames()).join(', ')}`)
      .eq('org_id', orgId)
      .gte('received_at', oldest)
      .order('received_at', { ascending: false })
      .limit(1000);
    const mail = (mailRows ?? []) as unknown as ReviewEmail[];

    const sourceIds = [...new Set(live.map((t) => t.source_email_id).filter((id): id is string => !!id))];
    const { data: sourceRows } = sourceIds.length
      ? await supabaseAdmin.from('emails').select('id, thread_id, received_at').in('id', sourceIds)
      : { data: [] };
    const sources = new Map(
      ((sourceRows ?? []) as { id: string; thread_id: string | null; received_at: string | null }[]).map((e) => [e.id, e]),
    );

    // Each task's related mail — by the same test the per-email check uses —
    // and only when some of it is newer than the last time it was checked.
    const due: { task: LiveTask; related: ReviewEmail[]; newest: string }[] = [];
    for (const task of live) {
      const related = mail.filter((e) => !!e.received_at && rankClosable(e, [task], sources).length > 0);
      if (!related.length) continue;
      const newest = related[0].received_at!;
      const mark = marks[task.id];
      if (mark && newest <= mark) continue;
      due.push({ task, related, newest });
    }
    // Freshest news first: the likeliest to have just been finished.
    due.sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0));

    let index = 0;
    for (; index < due.length && reviewed < MAX_REVIEWS_PER_SWEEP; index++) {
      // One call takes a few seconds; stop while there is still room for it.
      if (deadline - Date.now() < 8_000) break;
      const { task, related, newest } = due[index];
      const shown = related.slice(0, REVIEW_EMAILS).reverse(); // oldest first
      const refs = new Map(shown.map((e, i) => [`E${i + 1}`, e]));

      const user = [
        `Today's date: ${new Date().toISOString().slice(0, 10)}`,
        '',
        `THE TASK: ${closableLine(task, task.due_date ? `due ${task.due_date}` : 'no due date')}`,
        '',
        'EMAILS ABOUT IT SINCE IT WAS RAISED (oldest first):',
        ...shown.map((e, i) => {
          const text = (readStoredText(e as Parameters<typeof readStoredText>[0]).body ?? e.snippet ?? '')
            .trim()
            .slice(0, REVIEW_CHARS);
          return `\n[E${i + 1}] ${(e.received_at ?? '').slice(0, 10)} · from ${e.from_addr ?? 'unknown'} · ${e.subject ?? '(no subject)'}\n${text}`;
        }),
      ].join('\n');

      let answer: { done?: boolean; email?: string | null; evidence?: string | null } | null;
      try {
        answer = await extractJson(REVIEW_SYSTEM, user, { feature: 'task.extract', orgId, entity: 'tasks', entityId: task.id });
      } catch (err) {
        // Not marked: a failed call is asked again next hour.
        console.error('[tasks] review failed for', task.id, (err as Error).message);
        continue;
      }
      // Unusable JSON is not an answer either — left to be asked again.
      if (!answer) continue;
      reviewed++;
      marks[task.id] = newest;

      const proof = answer.done === true ? refs.get(String(answer.email ?? '').trim().toUpperCase()) : undefined;
      if (!proof) continue;
      try {
        const done = await closeFinished(orgId, proof, [{ ref: 'T1', task, line: '' }], [
          { ref: 'T1', evidence: String(answer.evidence ?? '') },
        ]);
        closed += done.length;
      } catch (err) {
        console.error('[tasks] closing a reviewed task failed:', (err as Error).message);
      }
    }

    await saveReviewMarks(orgId, marks);
    const waiting = due.length - index;
    if (reviewed) {
      await supabaseAdmin.from('activity_log').insert({
        org_id: orgId,
        action: 'tasks.reviewed',
        entity: 'tasks',
        meta: { reviewed, closed, waiting },
      });
    }
    return { ok: true, reviewed, closed, waiting };
  } catch (err) {
    console.error('[tasks] hourly review failed:', (err as Error).message);
    return { ok: false, reason: (err as Error).message, reviewed, closed, waiting: 0 };
  }
}

/**
 * Raise tasks from email already in the system.
 *
 * Bounded by a clock, because a person is watching: it used to read every
 * taskless email in one request, one Claude call apiece, which on a
 * studio's inbox ran two or three minutes behind a button that said
 * "Reading email…" — and on the host, where a request dies at 60s, would
 * never have finished at all. Now it stops starting new emails once the
 * budget is spent and says how many are left, so each press answers in
 * seconds and the next press carries on where it stopped.
 */
export async function backfillTasks(
  orgId: string,
  opts: { limit?: number; budgetMs?: number } = {},
): Promise<{ ok: boolean; reason?: string; scanned: number; created: number; remaining: number }> {
  const limit = opts.limit ?? 50;
  const deadline = Date.now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', scanned: 0, created: 0, remaining: 0 };

  const { data: existing, error: exErr } = await supabaseAdmin
    .from('tasks')
    .select('source_email_id')
    .eq('org_id', orgId)
    .not('source_email_id', 'is', null);
  if (exErr) return { ok: false, reason: exErr.message, scanned: 0, created: 0, remaining: 0 };
  const done = new Set((existing ?? []).map((r) => (r as { source_email_id: string }).source_email_id));

  // The body has its own column once migration 0010 is in; before that it
  // lives inside extracted_json, which readStoredText unpacks either way.
  const withBody = await bodyColumnsReady();
  const { data: emails, error } = await supabaseAdmin
    .from('emails')
    .select(`id, class, subject, from_addr, to_addr, snippet, extracted_json${withBody ? ', body_text' : ''}`)
    .eq('org_id', orgId)
    .not('class', 'in', `(${IGNORED_CLASSES.map((c) => `"${c}"`).join(',')})`)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return { ok: false, reason: error.message, scanned: 0, created: 0, remaining: 0 };

  type Row = {
    id: string; class: string; subject: string | null;
    from_addr: string | null; to_addr: string | null; snippet: string | null;
    body_text?: string | null;
    extracted_json: ({ summary?: string } & Record<string, unknown>) | null;
  };
  // Only what has never been asked: no task yet, and no "no" on record.
  const todo = ((emails ?? []) as unknown as Row[]).filter(
    (e) => !done.has(e.id) && !e.extracted_json?.[TASK_CHECKED_KEY],
  );

  let scanned = 0;
  let created = 0;
  let remaining = todo.length;
  for (const e of todo) {
    if (Date.now() > deadline) break;
    remaining--;
    scanned++;
    try {
      // The email as it was sent, where the studio has kept it — the same
      // text the reading pass decided on. The summary and snippet are the
      // fallback for mail stored before bodies were kept at all.
      const stored = readStoredText(e).body;
      const body = stored || [e.extracted_json?.summary, e.snippet].filter(Boolean).join('\n\n');
      const made = await createTaskFromEmail(orgId, e.id, e.class, {
        gmailId: '',
        threadId: '',
        from: e.from_addr ?? '',
        to: e.to_addr ?? '',
        replyTo: '',
        subject: e.subject ?? '',
        snippet: e.snippet ?? '',
        body,
        receivedAt: null,
        attachments: [],
      } as unknown as ParsedEmail);
      if (made) created++;
    } catch (err) {
      console.error('[backfill] task from email failed:', (err as Error).message);
    }
  }
  return { ok: true, scanned, created, remaining };
}

/**
 * Read one classified email, decide whether it implies work, and if so
 * create a task assigned by role. Idempotent: the unique index on
 * (org_id, source_email_id) means a re-promoted email is a no-op.
 */
export async function createTaskFromEmail(
  orgId: string,
  emailId: string,
  emailClass: string,
  parsed: ParsedEmail,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (IGNORED_CLASSES.includes(emailClass)) return false;

  // Cheap guard before the Claude call — avoids re-extracting on a backfill.
  const { data: existing } = await supabaseAdmin
    .from('tasks')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_email_id', emailId)
    .maybeSingle();
  if (existing) return false;

  // promoteEmail may have re-linked this email to a project/vendor, so read
  // the row back rather than trusting the ids the caller started with.
  //
  // Read BEFORE the task is written, not after: the title names the job,
  // and naming it from the email's own wording is how the board filled with
  // "Finalize furniture proposal for Lemon's Project" while the project on
  // file was Lemon Residence.
  const { data: email } = await supabaseAdmin
    .from('emails')
    .select('project_id, vendor_id, thread_id, received_at, subject, from_addr, projects(name, client_name), vendors(name)')
    .eq('id', emailId)
    .maybeSingle();
  const filed = email as {
    projects?: { name: string; client_name: string | null } | null;
    vendors?: { name: string } | null;
  } | null;
  const filedUnder = filed?.projects ?? null;

  // The open work this email might be the answer to, read from the stored
  // row rather than `parsed` — a backfill passes no thread id.
  const facts = { id: emailId, ...(email as Omit<EmailFacts, 'id'> | null) } as EmailFacts;
  const closable = email ? await loadClosable(orgId, facts) : [];

  const names = await loadStudioNames(orgId);
  // The conversation, not just the message: see loadThreadContext.
  const thread = await loadThreadContext(
    orgId,
    (email as { thread_id: string | null } | null)?.thread_id ?? parsed.threadId ?? null,
    emailId,
  );
  const extracted = await extractTask(parsed, { orgId }, {
    project: filedUnder?.name ?? null,
    client: filedUnder?.client_name ?? null,
    vendor: filed?.vendors?.name ?? null,
    names,
    openTasks: closable.map(({ ref, line }) => ({ ref, line })),
    thread,
  });
  // Unusable JSON is not an answer — leave it to be asked again.
  if (!extracted) return false;

  // Before the needs_task gate: the email that finishes work usually raises
  // none of its own.
  try {
    await closeFinished(orgId, facts, closable, extracted.completes);
  } catch (err) {
    console.error('[tasks] closing finished tasks failed:', (err as Error).message);
  }

  if (!extracted.needs_task) {
    await markTaskChecked(emailId);
    return false;
  }

  const title = String(extracted.title ?? '').trim().slice(0, 200);
  if (!title) return false;

  // The supplier the work is about: the email's own, else the one the task
  // names, when the studio has it on file. Most studio mail about a supplier
  // is not a quote, so the email itself often has no vendor.
  const vendorId =
    (email as { vendor_id: string | null } | null)?.vendor_id ??
    (extracted.vendor ? matchProjectId(names.vendors, extracted.vendor) : null);

  // The job the task is about: the one the email is filed under, else the
  // one the task itself names. A request from a contact at a hotel is often
  // not filed anywhere ("Chase Cari for Casa Elar Roman shade specs"), and
  // the task then showed no project on the board.
  const projectId =
    (email as { project_id: string | null } | null)?.project_id ??
    (extracted.project_hint ? matchProjectId(names.projects, extracted.project_hint) : null);

  // Who to reach, so whoever picks the task up does not have to open the
  // thread to find out. Never a studio address or a no-reply sender.
  const contactEmail = extracted.contact_email?.trim() || null;
  const contact =
    contactEmail && contactEmail.includes('@') && !isStudioAddress(contactEmail) && !isAutomatedAddress(contactEmail)
      ? `${extracted.contact_name?.trim() ? `${extracted.contact_name.trim()} ` : ''}<${contactEmail}>`
      : null;
  const detail = [extracted.detail?.trim() || null, contact ? `Contact: ${contact}` : null].filter(Boolean).join('\n\n') || null;

  const kind: TaskKind = TASK_KINDS.includes(extracted.kind) ? extracted.kind : 'admin';
  const role = TASK_KIND_ROLE[kind];

  // The unique index keys on the SOURCE EMAIL, so a thread where two
  // messages both ask for the same thing raised the same task twice — the
  // studio saw "Tell Denish which Slack workspace to use" on the board
  // twice over. One live task per piece of work: if the same title is
  // already open on the same project, the follow-up mail is a repeat of the
  // ask, not new work.
  //
  // Scoped to the project, not the whole studio: "Chase the vendor for a
  // quote" is one task per job, and org-wide matching would silently drop
  // the second job's.
  // Work finished (or dropped) in the last fortnight counts as well: a rescan
  // of the thread, or a later reply repeating the ask, would otherwise raise
  // the task again the moment the first one was ticked off.
  const finishedSince = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const { data: liveSame } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id')
    .eq('org_id', orgId)
    .or(`status.in.(${LIVE_STATUSES.join(',')}),and(status.in.(done,cancelled),updated_at.gte.${finishedSince})`);

  const projectOf = projectId;
  // Same work on the same job — or on a job and on nothing. A reply that
  // arrives before the project exists files the first copy nowhere, and
  // requiring the projects to be equal let the second one in beside it.
  // Two DIFFERENT projects are still two jobs. Titles are compared by
  // sameWork, not an exact key, so Claude rewording the ask on the next
  // email ("countertop" → "countertop slab") no longer raises a second card.
  const sameProject = (p: string | null) => p === projectOf || p === null || projectOf === null;
  const already = (liveSame ?? []).some((row) => {
    const r = row as { title: string; project_id: string | null };
    if (!sameWork(r.title, title)) return false;
    return sameProject(r.project_id);
  });
  if (already) return false;

  // Reworded repeat the word bar is too strict to catch: same job, alike
  // enough to suspect but under sameWork's threshold. A candidate qualifies
  // two ways — a high-enough overlap RATIO (AMBIGUOUS_MIN), or enough shared
  // meaningful WORDS (SHARED_WORDS_MIN) whatever the ratio, which is what
  // catches the reworded ask Janelle sends in a brand-new thread. The model
  // settles only these — a clear duplicate was dropped just above, a clear
  // mismatch never reaches the band — so the call fires on at most a handful of
  // titles, the closest first. A yes marks the source email checked, so the
  // verdict is not re-bought on the next scan.
  const borderline = (liveSame ?? [])
    .map((row) => row as { title: string; project_id: string | null })
    .filter((r) => sameProject(r.project_id))
    .map((r) => ({ title: r.title, sim: titleSimilarity(r.title, title) }))
    .filter(
      (c) =>
        c.sim < TITLE_SIM_THRESHOLD &&
        (c.sim >= AMBIGUOUS_MIN || sharedContentWords(c.title, title) >= SHARED_WORDS_MIN),
    )
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_SEMANTIC_CANDIDATES);
  if (borderline.length) {
    const hit = await semanticDuplicate(orgId, title, borderline.map((c) => c.title));
    if (hit >= 0) {
      await markTaskChecked(emailId);
      return false;
    }
  }

  // The same document already has a task — open, or finished in the last few
  // days. A quote that arrives closes the chase for it; the mail that follows
  // about the same quote is the same piece of work, not a new one.
  const refs = refsOf(title, extracted.detail);
  if (refs.length) {
    const since = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const { data: sameRef } = await supabaseAdmin
      .from('tasks')
      .select('title, detail, project_id, status, updated_at')
      .eq('org_id', orgId)
      .or(`status.in.(${LIVE_STATUSES.join(',')}),and(status.eq.done,updated_at.gte.${since})`);
    const repeat = (sameRef ?? []).some((row) => {
      const r = row as { title: string; detail: string | null; project_id: string | null };
      if (!(r.project_id === projectId || r.project_id === null || projectId === null)) return false;
      return refsOf(r.title, r.detail).some((ref) => refs.includes(ref));
    });
    if (repeat) return false;
  }

  // Four ways to decide the owner, most specific first. Each step is a
  // weaker signal than the one above it:
  //   1. a person named in the body — the sender already decided
  //   2. whoever the mail was addressed to — the chain says who was asked
  //   3. the seat that owns this outcome, per the studio's roles document
  //   4. the role that owns this kind of work
  //   5. whoever runs the board, so nothing is created ownerless
  const seat = (extracted.seat && SEAT_KEYS.includes(extracted.seat) ? extracted.seat : null) as Seat | null;
  const assignedTo =
    (await resolveNamedPerson(orgId, extracted.assignee_hint ?? null)) ??
    (await resolveFromChain(orgId, parsed)) ??
    (await resolveBySeat(orgId, seat)) ??
    (await resolveAssignee(orgId, role)) ??
    (await resolveTriage(orgId));

  const { error } = await supabaseAdmin.from('tasks').insert({
    org_id: orgId,
    title,
    detail,
    kind,
    // The AI's call, or the seat/kind fallback; only once migration 0026 is in.
    ...((await hasTaskCategory())
      ? { category: extracted.category && TASK_CATEGORIES.includes(extracted.category) ? extracted.category : defaultTaskCategory(kind, seat) }
      : {}),
    assigned_to: assignedTo,
    assigned_role: seat ? SEATS[seat].role : role,
    seat,
    next_step: extracted.next_step ?? null,
    project_id: projectId,
    vendor_id: vendorId,
    source_email_id: emailId,
    // The email's own date when it gave one; otherwise the studio's SLA for
    // this kind of work. A task with no date cannot be chased for being
    // late, so "none" is the one answer that helps nobody.
    due_date: extracted.due_date ?? dueDateFor(kind, await readSla(orgId)),
  });

  // A concurrent ingest may have won the race; the unique index makes that safe.
  if (error) {
    if (error.code === '23505') return false;
    throw new Error(error.message);
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'task.create',
    entity: 'tasks',
    entity_id: emailId,
    meta: {
      title,
      kind,
      assigned_role: role,
      assigned: Boolean(assignedTo),
      // Worth recording which dates the studio actually committed to.
      due_from: extracted.due_date ? 'email' : 'sla',
    },
  });

  return true;
}
