import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssistantAnswer, AssistantItem } from '@janelle/shared';
import { hasTaskComments, hasTaskCompletedBy, hasTaskCompletion } from '../lib/columns.js';
import { pacificDate, pacificDayStart } from '../lib/pacificTime.js';
import { addressOf, isStudioAddress, isStudioMailbox, namesFor, studioPerson } from '../lib/studioTeam.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { resolveFollowUpsForTask } from './followups.js';
import { closeCopiesOfFinishedTasks } from './tasks.js';

/**
 * The end-of-day check-in: what each person says about their day, and where
 * it is written down.
 *
 * The owner asked for a follow-up at the end of every day "to identify any
 * blockers and ensure we stay on track for the next day". The 5pm email asks
 * the question; this is where the answers land, whichever way they arrive:
 *
 *   Jenny    the person opens her after four and gets the same list with a
 *            button per task — Done, Blocked (and why), Tomorrow
 *   email    they reply to the check-in email in their own words, and the
 *            ingest hands the reply here instead of raising a task from it
 *   board    they mark the task Blocked themselves; nothing to do here
 *
 * Every answer becomes the same three things: the task's status, a comment
 * on the task saying why (so the morning plan can show it), and a line in
 * the activity log so "who answered their check-in" has an answer too.
 */

export type CheckinOutcome = 'done' | 'blocked' | 'tomorrow';
export type CheckinVia = 'jenny' | 'email' | 'slack';

/** What the person's check-in shows for one task, and what they can say about it. */
export interface CheckinTask {
  id: string;
  title: string;
  project: string | null;
  due: string | null;
  status: string;
  /** open: still to do, due today or earlier. The rest are what they sound like. */
  bucket: 'open' | 'blocked' | 'done' | 'tomorrow';
  /** The last "Blocked: …" comment, for a task that already is. */
  note: string | null;
}

export interface Checkin {
  answer: AssistantAnswer;
  tasks: CheckinTask[];
}

export interface CheckinSaved {
  id: string;
  title: string;
  outcome: CheckinOutcome;
  status: string;
  due_date: string | null;
}

export class CheckinError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** The comment a check-in leaves, found again by its first word. */
const BLOCKED_PREFIX = 'Blocked:';
const ROLLED_PREFIX = 'Rolled to tomorrow:';

const LIVE = ['open', 'in_progress', 'blocked'];

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assigned_to: string | null;
  projects: { name: string } | null;
};

/** "2026-10-13" → "Oct 13". */
function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The latest "Blocked: …" comment on each of these tasks, without the
 * prefix. What the morning plan shows under a blocked task, so the owner
 * reads the reason rather than just the word.
 */
export async function latestBlockerNotes(orgId: string, taskIds: string[]): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (!supabaseAdmin || !taskIds.length || !(await hasTaskComments())) return notes;
  const { data } = await supabaseAdmin
    .from('task_comments')
    .select('task_id, body, created_at')
    .eq('org_id', orgId)
    .in('task_id', taskIds)
    .ilike('body', `${BLOCKED_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(taskIds.length * 4);
  for (const row of (data ?? []) as { task_id: string; body: string }[]) {
    if (notes.has(row.task_id)) continue;
    const note = row.body.slice(BLOCKED_PREFIX.length).trim();
    if (note) notes.set(row.task_id, note);
  }
  return notes;
}

// ── Building the check-in ───────────────────────────────────

interface CheckinContext {
  /** The caller's own client, so row security decides what they see. */
  db: SupabaseClient;
  userId: string;
  orgId: string | null;
  name: string;
}

function greeting(hour: number | null): string {
  if (hour === null || hour >= 17) return 'Good evening';
  if (hour >= 12) return 'Good afternoon';
  return 'Good morning';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * This person's day, as the evening email tells it, with each task ready to
 * be answered. Null when there is nothing to check in about — a check-in
 * with nothing in it would teach people to dismiss it.
 */
export async function buildCheckin(ctx: CheckinContext, opts: { hour?: number | null } = {}): Promise<Checkin | null> {
  const today = pacificDate(0);
  const tomorrow = pacificDate(1);
  const completion = await hasTaskCompletion();

  const [liveRes, doneRes] = await Promise.all([
    ctx.db
      .from('tasks')
      .select('id, title, status, due_date, assigned_to, projects(name)')
      .eq('assigned_to', ctx.userId)
      .in('status', LIVE)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(80),
    ctx.db
      .from('tasks')
      .select('id, title, status, due_date, assigned_to, projects(name)')
      .eq('assigned_to', ctx.userId)
      .eq('status', 'done')
      .gte(completion ? 'completed_at' : 'updated_at', pacificDayStart().toISOString())
      .limit(40),
  ]);
  const live = ((liveRes.data ?? []) as unknown as TaskRow[]).filter((t) => t.due_date !== null && t.due_date <= tomorrow);
  const done = (doneRes.data ?? []) as unknown as TaskRow[];

  const byDue = (a: TaskRow, b: TaskRow) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.title.localeCompare(b.title);
  const open = live.filter((t) => t.status !== 'blocked' && (t.due_date as string) <= today).sort(byDue);
  const blocked = live.filter((t) => t.status === 'blocked' && (t.due_date as string) <= today).sort(byDue);
  const dueTomorrow = live.filter((t) => t.due_date === tomorrow).sort(byDue);
  if (!open.length && !blocked.length && !done.length && !dueTomorrow.length) return null;

  const notes = ctx.orgId ? await latestBlockerNotes(ctx.orgId, blocked.map((t) => t.id)) : new Map<string, string>();

  const shape = (t: TaskRow, bucket: CheckinTask['bucket']): CheckinTask => ({
    id: t.id,
    title: t.title,
    project: t.projects?.name ?? null,
    due: t.due_date,
    status: t.status,
    bucket,
    note: notes.get(t.id) ?? null,
  });
  const tasks: CheckinTask[] = [
    ...open.map((t) => shape(t, 'open')),
    ...blocked.map((t) => shape(t, 'blocked')),
    ...dueTomorrow.map((t) => shape(t, 'tomorrow')),
    ...done.map((t) => shape(t, 'done')),
  ];

  // The same rows as records, so the conversation's plain-text history and
  // Copy have something to say.
  const items: AssistantItem[] = tasks.map((t) => ({
    kind: 'task',
    id: t.id,
    title: t.title,
    detail: [t.project, t.due ? `due ${shortDate(t.due)}` : null].filter(Boolean).join(' · ') || null,
    meta:
      t.bucket === 'done' ? 'finished today' : t.bucket === 'blocked' ? 'blocked' : t.bucket === 'tomorrow' ? 'due tomorrow' : 'still open',
    tone: t.bucket === 'done' ? 'good' : t.bucket === 'blocked' ? 'crit' : t.bucket === 'open' ? 'warn' : 'neutral',
  }));

  const first = ctx.name.split(/[\s@]/)[0] || ctx.name;
  const hello = `${greeting(opts.hour ?? null)}, ${first}.`;
  const counts = [
    done.length ? `${done.length} finished today` : '',
    open.length ? `${open.length} still open` : '',
    blocked.length ? `${plural(blocked.length, 'is', 'are')} blocked`.replace(/^(\d+) (is|are)/, '$1 $2') : '',
    dueTomorrow.length ? `${dueTomorrow.length} due tomorrow` : '',
  ].filter(Boolean);
  const summary = counts.length ? `${counts.join(', ')}.` : '';
  const ask = open.length || blocked.length
    ? ' Tick off what got done, say what is in the way, and anything left rolls to tomorrow.'
    : ' Nothing is waiting on you — have a good evening.';
  const lead = `${hello} ${summary}${ask}`.replace(/\s+/g, ' ').trim();

  return {
    answer: {
      lead,
      items,
      more: 0,
      caveat: null,
      speech: lead,
      sources: ['your tasks'],
      suggestions: open.length ? ['What should I start with tomorrow?'] : [],
    },
    tasks,
  };
}

// ── Recording an answer ─────────────────────────────────────

interface Actor {
  db: SupabaseClient;
  orgId: string;
  userId: string;
  /** Runs the task board, so may answer for someone else's task. */
  manages: boolean;
}

export interface CheckinInput {
  taskId: string;
  outcome: CheckinOutcome;
  note?: string | null;
}

/**
 * Write one answer down. Done closes the task the way the board does;
 * Blocked sets the status and keeps the reason as a comment; Tomorrow moves
 * the date so it heads tomorrow's list instead of sitting in overdue.
 */
export async function recordCheckin(actor: Actor, input: CheckinInput, via: CheckinVia): Promise<CheckinSaved> {
  const { db, orgId, userId } = actor;
  const { data: row } = await db
    .from('tasks')
    .select('id, title, status, due_date, assigned_to')
    .eq('id', input.taskId)
    .maybeSingle();
  const task = row as { id: string; title: string; status: string; due_date: string | null; assigned_to: string | null } | null;
  if (!task) throw new CheckinError('That task is no longer on the board.', 404);
  if (!actor.manages && task.assigned_to !== userId) {
    throw new CheckinError("That task is someone else's; only whoever runs the board can answer for it.", 403);
  }

  const note = (input.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const patch: Record<string, unknown> = {};
  let comment: string | null = null;

  switch (input.outcome) {
    case 'done':
      if (task.status !== 'done') {
        patch.status = 'done';
        if (await hasTaskCompletedBy()) patch.completed_by = userId;
      }
      if (note) comment = `Done: ${note}`;
      break;
    case 'blocked':
      if (task.status !== 'blocked') patch.status = 'blocked';
      // The reason is the point. Without one the board still shows Blocked,
      // and the morning plan asks again.
      if (note) comment = `${BLOCKED_PREFIX} ${note}`;
      break;
    case 'tomorrow': {
      const tomorrow = pacificDate(1);
      if (!task.due_date || task.due_date < tomorrow) patch.due_date = tomorrow;
      if (task.status === 'done') patch.status = 'open';
      if (note) comment = `${ROLLED_PREFIX} ${note}`;
      break;
    }
    default:
      throw new CheckinError('An answer is Done, Blocked or Tomorrow.');
  }

  if (Object.keys(patch).length) {
    const { error } = await db.from('tasks').update(patch).eq('id', task.id);
    if (error) throw new Error(error.message);
  }

  if (comment && (await hasTaskComments())) {
    const { error } = await db
      .from('task_comments')
      .insert({ org_id: orgId, task_id: task.id, author: userId, body: comment });
    if (error) console.error('[checkin] comment not saved:', error.message);
  }

  if (patch.status === 'done') {
    await closeCopiesOfFinishedTasks(orgId).catch((err) => console.error('[checkin] closing copies failed:', (err as Error).message));
    await resolveFollowUpsForTask(orgId, task.id).catch((err) => console.error('[checkin] clearing follow-ups failed:', (err as Error).message));
  }

  await db.from('activity_log').insert({
    org_id: orgId,
    actor: userId,
    action: 'task.checkin',
    entity: 'tasks',
    entity_id: task.id,
    meta: { title: task.title, outcome: input.outcome, note: note || null, via, from: task.status },
  });

  return {
    id: task.id,
    title: task.title,
    outcome: input.outcome,
    status: (patch.status as string | undefined) ?? task.status,
    due_date: (patch.due_date as string | undefined) ?? task.due_date,
  };
}

// ── Replies to the check-in email ───────────────────────────

/**
 * The two subjects the reminder emails go out under (emailTemplate.ts), as a
 * reply quotes them. A teammate answering in Gmail is the only kind of mail
 * that starts this way and comes from a studio address.
 */
const CHECKIN_SUBJECT = /^\s*(?:(?:re|aw|fwd?|fw)\s*:\s*)+(?:end-of-day check-in|your priorities today)\b/i;

export function isCheckinReply(email: { subject: string; from: string }): boolean {
  return CHECKIN_SUBJECT.test(email.subject) && isStudioAddress(email.from) && !isStudioMailbox(email.from);
}

/** The person's own words: everything above the quoted reminder. */
export function ownWords(body: string): string {
  const text = body
    .replace(/\r/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const cut = text.search(/\n\s*On .{10,160}wrote:|\n\s*From: .{3,120}\n|\n\s*-{3,}\s*Original Message|\n>/);
  return (cut > 0 ? text.slice(0, cut) : text).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Glue, and the verbs every task title starts with. "Provide", "create" and
 * "confirm" are in half the titles on the board and in none of the replies,
 * which say "done" and "stuck" instead — so they would only lower the score
 * of a sentence that plainly names the task.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'about', 'your', 'our', 'their',
  'send', 'sent', 'get', 'confirm', 'check', 'review', 'follow', 'up', 'task', 'tasks', 'please', 'need',
  'needs', 'all', 'any', 'are', 'was', 'were', 'have', 'has', 'had', 'will', 'can', 'not', 'but', 'you',
  'out', 'new', 'per', 'via', 'its', 'then', 'than', 'them', 'they', 'what', 'when', 'where', 'which',
  'provide', 'create', 'prepare', 'update', 'finalize', 'finalise', 'schedule', 'request', 'make', 'ensure',
  'chase', 'share', 'respond', 'reply', 'ask', 'tell', 'let', 'know',
]);

/**
 * A word reduced to what its plural and its singular share: "quantities" and
 * "quantity" become the same, as do "estimates" and "estimate", "POs" and
 * "PO". Crude on purpose — both sides go through it, so only agreement matters.
 */
function stem(word: string): string {
  return word.replace(/ies$/, 'i').replace(/y$/, 'i').replace(/e?s$/, '').replace(/e$/, '');
}

/** The words of a text, stemmed; hyphens and slashes split, so "yellow-highlighted" is two words. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2).map(stem);
}

/** The words of a title worth matching on: three letters or more, not glue, stemmed. */
function keywords(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9&]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map(stem),
    ),
  ];
}

const DONE_WORDS = /\b(done|finished|completed?|complete|sent (it|them|over|out)|submitted|delivered|closed|wrapped up|took care of|handled)\b/i;
const BLOCKED_WORDS =
  /\b(blocked|blocker|stuck|waiting (on|for)|held up|hold|on hold|can'?t|cannot|couldn'?t|unable|no (reply|response|answer)|haven'?t (heard|received|got)|need(s|ed)? .* (from|before)|pending (from|on)|still waiting)\b/i;
const TOMORROW_WORDS = /\b(tomorrow|next (day|week)|roll(ing|ed)? (it |this |that )?(over|to)|push(ing|ed)? (it |this |that )?(to|back)|will (do|finish|pick up) (it |this |that )?(tomorrow|next)|first thing)\b/i;

/** Sentences, as a person types them in an email: full stops, line breaks, bullets. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|\s+[-•*]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

export interface CheckinReplyMatch {
  task_id: string;
  title: string;
  outcome: CheckinOutcome;
  note: string;
}

export interface CheckinReplyResult {
  person: { id: string; name: string } | null;
  matched: CheckinReplyMatch[];
  /** The reply, when no task in it could be told apart — kept for the morning plan. */
  unmatched: string | null;
}

function toneOf(text: string): CheckinOutcome | null {
  return BLOCKED_WORDS.test(text) ? 'blocked' : DONE_WORDS.test(text) ? 'done' : TOMORROW_WORDS.test(text) ? 'tomorrow' : null;
}

/**
 * Which of the person's tasks a reply is about, and what it says of each.
 *
 * Sentence by sentence: a sentence that says done, stuck or tomorrow is
 * pinned to the task whose title it shares the most words with, and enough
 * of them to be sure. A reply about one thing, with the task named somewhere
 * other than the sentence that gives its state — "Oak yellow quantities.
 * Still waiting on Carissa's spreadsheet." — is matched whole, once, if no
 * sentence matched on its own. Pure, so it can be tried without a database.
 */
export function matchReply(words: string, mine: { id: string; title: string }[]): CheckinReplyMatch[] {
  const matched: CheckinReplyMatch[] = [];
  const pick = (text: string, strict: boolean): { id: string; title: string } | null => {
    const said = new Set(tokens(text));
    const lower = text.toLowerCase();
    let best: { task: { id: string; title: string }; score: number } | null = null;
    for (const task of mine) {
      if (matched.some((m) => m.task_id === task.id)) continue;
      const keys = keywords(task.title);
      if (!keys.length) continue;
      const hits = keys.filter((k) => said.has(k)).length;
      const whole = lower.includes(task.title.toLowerCase());
      const score = whole ? 1 : hits / keys.length;
      // Enough of the title to be sure: half its words, or three of them
      // whatever the length; a single long, distinctive word will do for
      // one sentence, not for a whole reply.
      const sure =
        whole ||
        (hits >= 2 && score >= 0.5) ||
        hits >= 3 ||
        (!strict && keys.length === 1 && hits === 1 && keys[0].length >= 6);
      if (sure && (!best || score > best.score)) best = { task, score };
    }
    return best?.task ?? null;
  };

  for (const sentence of sentences(words)) {
    const outcome = toneOf(sentence);
    if (!outcome) continue;
    const task = pick(sentence, false);
    if (task) matched.push({ task_id: task.id, title: task.title, outcome, note: sentence.slice(0, 500) });
  }

  if (!matched.length) {
    const tone = toneOf(words);
    const task = tone ? pick(words, true) : null;
    if (tone && task) matched.push({ task_id: task.id, title: task.title, outcome: tone, note: words.slice(0, 500) });
  }
  return matched;
}

/**
 * Read a reply to the check-in email and write down what it says.
 *
 * No model call: a teammate's reply names their own tasks in their own
 * words, and the words of a task's title are enough to tell which one each
 * sentence is about. A sentence that names a task and says it is done,
 * stuck or moving to tomorrow is recorded against it. A reply that says it
 * is stuck without naming a task is kept whole, and the morning plan shows
 * it under the person's name so the owner still sees it.
 */
export async function recordCheckinReply(
  orgId: string,
  email: { from: string; body: string; subject: string },
  emailId: string | null,
): Promise<CheckinReplyResult> {
  const result: CheckinReplyResult = { person: null, matched: [], unmatched: null };
  if (!supabaseAdmin) return result;

  // Whose reply: the address on file first, then the team list's other
  // spellings of them — Victoria answers from Gmail, not from victoria@.
  const address = addressOf(email.from);
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const team = ((profiles ?? []) as { id: string; full_name: string | null; email: string | null }[]).filter((p) => p.full_name);
  const known = studioPerson({ email: address });
  const person =
    team.find((p) => (p.email ?? '').toLowerCase() === address) ??
    (known ? team.find((p) => namesFor({ full_name: p.full_name as string, email: p.email }).some((n) => n.toLowerCase() === known.name.toLowerCase())) : undefined) ??
    null;

  const words = ownWords(email.body);
  if (!person) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'checkin.reply',
      entity: 'emails',
      entity_id: emailId,
      meta: { from: email.from, person_id: null, matched: [], text: words.slice(0, 1000) },
    });
    return result;
  }
  result.person = { id: person.id, name: person.full_name as string };

  const { data: rows } = await supabaseAdmin
    .from('tasks')
    .select('id, title, status, due_date, assigned_to')
    .eq('org_id', orgId)
    .eq('assigned_to', person.id)
    .in('status', LIVE);
  const mine = (rows ?? []) as { id: string; title: string }[];
  result.matched = matchReply(words, mine);

  for (const m of result.matched) {
    try {
      await recordCheckin(
        { db: supabaseAdmin, orgId, userId: person.id, manages: true },
        { taskId: m.task_id, outcome: m.outcome, note: m.note },
        'email',
      );
    } catch (err) {
      console.error('[checkin] reply not recorded for', m.title, (err as Error).message);
    }
  }
  if (!result.matched.length && words) result.unmatched = words.slice(0, 1000);

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    actor: person.id,
    action: 'checkin.reply',
    entity: 'emails',
    entity_id: emailId,
    meta: {
      from: email.from,
      person_id: person.id,
      name: person.full_name,
      matched: result.matched.map((m) => ({ task_id: m.task_id, outcome: m.outcome })),
      text: words.slice(0, 1000),
    },
  });
  return result;
}

/**
 * What people said in check-in replies since yesterday evening that could
 * not be pinned to a task, by person — shown under their name in the
 * morning plan so a blocker typed in a hurry is not lost.
 */
export async function unmatchedCheckinNotes(orgId: string, sinceIso: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!supabaseAdmin) return out;
  const { data } = await supabaseAdmin
    .from('activity_log')
    .select('meta')
    .eq('org_id', orgId)
    .eq('action', 'checkin.reply')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(100);
  for (const row of (data ?? []) as { meta: { person_id?: string | null; matched?: unknown[]; text?: string } | null }[]) {
    const m = row.meta;
    if (!m?.person_id || (m.matched ?? []).length || !m.text?.trim()) continue;
    const list = out.get(m.person_id) ?? [];
    list.push(m.text.trim());
    out.set(m.person_id, list);
  }
  return out;
}
