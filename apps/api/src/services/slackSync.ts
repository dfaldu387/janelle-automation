import { TASK_CATEGORY_LABELS, defaultTaskCategory, type TaskCategory } from '@janelle/shared';
import { hasColumn, hasSubtasks, hasTaskCategory, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { resolveSlack, readSlackSyncState, saveSlackSyncState, type ResolvedSlack } from '../lib/slackSettings.js';
import {
  SlackError,
  describeTaskChange,
  followUpMessage,
  followUpStatusLabel,
  postMessage,
  taskMessage,
  updateMessage,
  type FollowUpCard,
  type TaskCard,
  type TaskState,
} from './slack.js';
import { pacificDate } from '../lib/pacificTime.js';
import { logV1Skipped, remindersV1Enabled } from '../lib/remindersV1.js';
import { ROUTE_FALLBACK_CODES, channelFor, joinIfNeeded, loadDirectory, type ChannelDirectory, type ProjectRef } from './slackRouting.js';

/**
 * Keep Slack in step with the board.
 *
 * A sweep rather than a call from every place a task changes: tasks are
 * raised by the mail reader, closed by the reviewer, advanced by the ingest
 * pass, edited from the board and by Jenny — a hook in each would miss the
 * next one someone adds. This reads what changed since its last run
 * (updated_at past a cursor) and brings Slack up to date, so every route is
 * covered, AI or manual.
 *
 * One message per task, in the channel. It is rewritten in place when the
 * task changes and a short reply is added under it saying what changed, so a
 * task is one thread with its history in it, not a stream of new messages.
 * Follow-ups the AI raises appear under the task they belong to, or on their
 * own when they belong to a project or vendor instead.
 *
 * Work finished before Slack was connected is not announced — the channel
 * starts with what happens from then on, not a backlog.
 *
 * Only what is current is ANNOUNCED: a task due yesterday, today or tomorrow
 * (Pacific), and a follow-up about such a task. A follow-up's own due_date is
 * only the day it was raised, so it says nothing about what is current — and
 * most are reminders about tasks long overdue, the very noise this removes.
 * Announcing every task the mail reader raised put a hundred-odd messages a
 * day in the channel, most of them long overdue. A task enters the channel
 * when its date comes into the window — a separate pass looks for those, since
 * time passing does not touch updated_at — and once it has a message there,
 * every change to it is still kept in step, whatever its date.
 */

/** Messages and edits per run. Slack allows about one a second per channel. */
const MAX_CALLS_PER_RUN = 30;
const PAUSE_MS = 1_100;
/** A row left with no message_ts this long is a send that died; free it to be retried. */
const STALE_CLAIM_MS = 10 * 60_000;
/** Re-read this much before the cursor: handling a task twice is harmless, missing one is not. */
const OVERLAP_MS = 60_000;

/** Yesterday, today and tomorrow in the studio's time zone, as YYYY-MM-DD bounds. */
function dueWindow(): { from: string; to: string } {
  return { from: pacificDate(-1), to: pacificDate(1) };
}
const inWindow = (date: string | null | undefined, w = dueWindow()) => Boolean(date && date >= w.from && date <= w.to);
const CLOSED_TASK = ['done', 'cancelled'];
const OPEN_FOLLOW_UP = ['open', 'drafted'];

export interface SlackSyncResult {
  ok: boolean;
  skipped?: 'not_connected' | 'paused';
  posted: number;
  updated: number;
  error?: string;
}

interface PostRow {
  id: string;
  entity: 'task' | 'follow_up';
  entity_id: string;
  channel: string;
  message_ts: string | null;
  thread_ts: string | null;
  last_state: Record<string, unknown>;
}

/** Stops the run cleanly: out of time or calls, or Slack asked us to wait. */
class StopRun extends Error {}

interface Ctx {
  orgId: string;
  token: string;
  channel: string;
  enabledAt: string | null;
  deadline: number;
  calls: number;
  lastCallAt: number;
  posted: number;
  updated: number;
  /** The projects table has slack_channel (migration 0029). */
  projectChannels: boolean;
  /** Read once, and only when something is actually about to be posted. */
  directory?: Promise<ChannelDirectory>;
  /** Things an admin should fix in Slack — a project whose channel the bot cannot post in. */
  warnings: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The project embed for a select — with its channel once migration 0029 is in. */
const projectColumns = (ctx: Ctx) => (ctx.projectChannels ? 'projects(name, slack_channel)' : 'projects(name)');

function directoryOf(ctx: Ctx): Promise<ChannelDirectory> {
  ctx.directory ??= loadDirectory(ctx.token).then((dir) => {
    if (dir.missingScope) {
      ctx.warnings.push('Add the channels:read and groups:read permissions to the Slack app so projects can be matched to their channels, then reinstall it.');
    }
    return dir;
  });
  return ctx.directory;
}

/** Where a project's update goes: its own channel when there is one, the default otherwise. */
async function routeTo(ctx: Ctx, project: ProjectRef | null): Promise<string> {
  return channelFor(project, await directoryOf(ctx), ctx.channel);
}

/**
 * Post to the routed channel; if Slack will not take it there (the bot was
 * never invited, the channel is archived), post to the default channel
 * instead and say so — an update in the wrong place beats one nobody sees.
 */
async function sendRouted(
  ctx: Ctx,
  channel: string,
  message: Parameters<typeof postMessage>[2],
  threadTs?: string,
): Promise<{ ts: string; channel: string }> {
  try {
    return await slackCall(ctx, () => postMessage(ctx.token, channel, message, threadTs));
  } catch (err) {
    if (channel === ctx.channel || threadTs || !(err instanceof SlackError) || !ROUTE_FALLBACK_CODES.includes(err.code)) throw err;
    // A public channel the bot is not in: join it and try once more before giving up on it.
    if (err.code === 'not_in_channel' && (await joinIfNeeded(ctx.token, channel, await directoryOf(ctx))) === 'joined') {
      return slackCall(ctx, () => postMessage(ctx.token, channel, message));
    }
    ctx.warnings.push(`The bot could not post in the channel for a project (${channel}) — its updates went to the default channel. In Slack, run /invite on that channel.`);
    return slackCall(ctx, () => postMessage(ctx.token, ctx.channel, message));
  }
}

/** Every Slack call goes through here: counts it, paces it, and stops the run when it must. */
async function slackCall<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  if (ctx.calls >= MAX_CALLS_PER_RUN || Date.now() + PAUSE_MS > ctx.deadline) throw new StopRun();
  const wait = ctx.lastCallAt + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  ctx.calls++;
  try {
    return await fn();
  } finally {
    ctx.lastCallAt = Date.now();
  }
}

function admin() {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  return supabaseAdmin;
}

/**
 * Claim the right to announce an entity before sending anything. The unique
 * key makes a cron run and a "Sync now" click that overlap safe: one of them
 * gets the row, the other gets null and moves on.
 */
async function claim(ctx: Ctx, entity: PostRow['entity'], id: string, state: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await admin()
    .from('slack_posts')
    .insert({ org_id: ctx.orgId, entity, entity_id: id, channel: ctx.channel, last_state: state })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return null;
    throw new Error(error.message);
  }
  return (data as { id: string } | null)?.id ?? null;
}

async function release(rowId: string): Promise<void> {
  await admin().from('slack_posts').delete().eq('id', rowId);
}

// ── Tasks ───────────────────────────────────────────────────

type RawTask = {
  id: string; title: string; detail: string | null; kind: Parameters<typeof defaultTaskCategory>[0];
  seat: string | null; status: string; due_date: string | null; next_step: string | null;
  source_email_id: string | null; created_at: string; updated_at: string;
  category?: TaskCategory | null; completion_note?: string | null;
  projects: ProjectRef | null; profiles: { full_name: string | null } | null;
};

function toCard(t: RawTask): TaskCard {
  const category = t.category ?? defaultTaskCategory(t.kind, t.seat);
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    status: t.status,
    assignee: t.profiles?.full_name ?? null,
    due: t.due_date,
    nextStep: t.next_step,
    project: t.projects?.name ?? null,
    category: TASK_CATEGORY_LABELS[category],
    fromEmail: Boolean(t.source_email_id),
    completionNote: t.completion_note ?? null,
  };
}

const stateOf = (c: TaskState): TaskState => ({ status: c.status, assignee: c.assignee, due: c.due, nextStep: c.nextStep });

async function syncTask(ctx: Ctx, raw: RawTask, row: PostRow | undefined): Promise<void> {
  const card = toCard(raw);
  const now = stateOf(card);

  if (!row) {
    // Only what is due yesterday, today or tomorrow is news; a closed task never is.
    if (CLOSED_TASK.includes(card.status) || !inWindow(raw.due_date)) return;
    const rowId = await claim(ctx, 'task', card.id, { ...now });
    if (!rowId) return;
    try {
      const channel = await routeTo(ctx, raw.projects);
      const sent = await sendRouted(ctx, channel, taskMessage(card));
      await admin().from('slack_posts').update({ message_ts: sent.ts, channel: sent.channel }).eq('id', rowId);
      ctx.posted++;
    } catch (err) {
      await release(rowId);
      throw err;
    }
    return;
  }

  if (!row.message_ts) return; // another run is mid-send

  const before = row.last_state as Partial<TaskState>;
  const lines = describeTaskChange(before, card);
  const changed = (Object.keys(now) as (keyof TaskState)[]).some((k) => before[k] !== now[k]);
  if (!changed) return;

  try {
    await slackCall(ctx, () => updateMessage(ctx.token, row.channel, row.message_ts!, taskMessage(card)));
  } catch (err) {
    // Someone deleted the message in Slack: announce the task afresh.
    if (err instanceof SlackError && ['message_not_found', 'cant_update_message'].includes(err.code)) {
      await release(row.id);
      return syncTask(ctx, raw, undefined);
    }
    throw err;
  }
  if (lines.length) {
    await slackCall(ctx, () =>
      postMessage(ctx.token, row.channel, { text: lines.join('\n') }, row.message_ts!),
    );
  }
  await admin().from('slack_posts').update({ last_state: now }).eq('id', row.id);
  ctx.updated++;
}

/** How far a pass got, kept outside it so a pass cut short still reports its progress. */
interface Progress { cursor: string }

async function syncTasks(ctx: Ctx, progress: Progress): Promise<void> {
  const since = progress.cursor;
  const db = admin();
  const [categorised, completion, subtasks] = await Promise.all([hasTaskCategory(), hasTaskCompletion(), hasSubtasks()]);

  let q = db
    .from('tasks')
    .select(taskColumns(ctx, categorised, completion))
    .eq('org_id', ctx.orgId)
    .gte('updated_at', since)
    .order('updated_at', { ascending: true })
    .limit(100);
  // A subtask is a step inside its parent, not a card of its own.
  if (subtasks) q = q.is('parent_task_id', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const tasks = (data ?? []) as unknown as RawTask[];
  if (!tasks.length) return;

  const { data: rows } = await db
    .from('slack_posts')
    .select('id, entity, entity_id, channel, message_ts, thread_ts, last_state')
    .eq('org_id', ctx.orgId)
    .eq('entity', 'task')
    .in('entity_id', tasks.map((t) => t.id));
  const byId = new Map(((rows ?? []) as PostRow[]).map((r) => [r.entity_id, r]));

  // The cursor only moves past tasks that were fully handled, so stopping
  // part-way (out of time, rate-limited, an error) loses nothing.
  for (const t of tasks) {
    await syncTask(ctx, t, byId.get(t.id));
    progress.cursor = t.updated_at;
  }
}

const taskColumns = (ctx: Ctx, categorised: boolean, completion: boolean) =>
  `id, title, detail, kind, seat, status, due_date, next_step, source_email_id, created_at, updated_at${categorised ? ', category' : ''}${completion ? ', completion_note' : ''}, ${projectColumns(ctx)}, profiles(full_name)`;

/** Ids of the given entities that already have a message in Slack. */
async function postedIds(ctx: Ctx, entity: PostRow['entity'], ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data } = await admin()
    .from('slack_posts')
    .select('entity_id')
    .eq('org_id', ctx.orgId)
    .eq('entity', entity)
    .in('entity_id', ids);
  return new Set(((data ?? []) as { entity_id: string }[]).map((r) => r.entity_id));
}

/**
 * Announce what has come INTO the window since it was last looked at — a task
 * due tomorrow that was raised last week has not changed, so the cursor pass
 * never sees it. Only tasks and follow-ups not yet in Slack.
 */
async function announceDue(ctx: Ctx, slack: ResolvedSlack): Promise<void> {
  const db = admin();
  const w = dueWindow();
  const [categorised, completion, subtasks] = await Promise.all([hasTaskCategory(), hasTaskCompletion(), hasSubtasks()]);

  let q = db
    .from('tasks')
    .select(taskColumns(ctx, categorised, completion))
    .eq('org_id', ctx.orgId)
    .gte('due_date', w.from)
    .lte('due_date', w.to)
    .not('status', 'in', `(${CLOSED_TASK.join(',')})`)
    .order('due_date', { ascending: true })
    .limit(100);
  if (subtasks) q = q.is('parent_task_id', null);
  const { data: taskData, error } = await q;
  if (error) throw new Error(error.message);
  const tasks = (taskData ?? []) as unknown as RawTask[];

  if (slack.config.tasks) {
    const posted = await postedIds(ctx, 'task', tasks.map((t) => t.id));
    for (const t of tasks) if (!posted.has(t.id)) await syncTask(ctx, t, undefined);
  }

  const taskIds = tasks.map((t) => t.id);
  if (slack.config.followUps && taskIds.length) {
    const { data: viaTask } = await db.from('follow_ups').select(followUpColumns(ctx)).eq('org_id', ctx.orgId)
      .in('status', OPEN_FOLLOW_UP).in('task_id', taskIds).limit(100);
    const items = (viaTask ?? []) as unknown as RawFollowUp[];
    const posted = await postedIds(ctx, 'follow_up', items.map((f) => f.id));
    await handleFollowUps(ctx, items.filter((f) => !posted.has(f.id)));
  }
}

// ── Follow-ups ──────────────────────────────────────────────

type RawFollowUp = {
  id: string; type: string; status: string; reason: string | null; target: string | null;
  task_id: string | null; created_at: string; updated_at: string;
  projects: ProjectRef | null; vendors: { name: string } | null;
  tasks: { due_date: string | null } | null;
};

async function syncFollowUp(ctx: Ctx, f: RawFollowUp, row: PostRow | undefined, card: FollowUpCard, taskPost: PostRow | undefined): Promise<void> {
  const state = { status: f.status };

  if (!row) {
    // Only an open one about a task due yesterday, today or tomorrow.
    if (!OPEN_FOLLOW_UP.includes(f.status) || !inWindow(f.tasks?.due_date)) return;
    const rowId = await claim(ctx, 'follow_up', f.id, state);
    if (!rowId) return;
    // Under its task when that has a thread, so the task's history reads in one place.
    const threadTs = taskPost?.message_ts ?? undefined;
    try {
      // In the task's own channel when it has a thread; otherwise the project's.
      const channel = taskPost?.channel ?? (await routeTo(ctx, f.projects));
      const sent = await sendRouted(ctx, channel, followUpMessage(card), threadTs);
      await admin()
        .from('slack_posts')
        .update({ message_ts: sent.ts, channel: sent.channel, thread_ts: threadTs ?? null })
        .eq('id', rowId);
      ctx.posted++;
    } catch (err) {
      await release(rowId);
      throw err;
    }
    return;
  }

  if (!row.message_ts || (row.last_state as { status?: string }).status === f.status) return;

  try {
    await slackCall(ctx, () => updateMessage(ctx.token, row.channel, row.message_ts!, followUpMessage(card, true)));
  } catch (err) {
    if (err instanceof SlackError && ['message_not_found', 'cant_update_message'].includes(err.code)) {
      await release(row.id);
      return;
    }
    throw err;
  }
  // A follow-up on its own gets a reply too, so the change is a notification
  // and not only a quiet edit; one inside a task's thread is just updated.
  if (!row.thread_ts) {
    await slackCall(ctx, () =>
      postMessage(ctx.token, row.channel, { text: `:bell: ${followUpStatusLabel(f.status)}` }, row.message_ts!),
    );
  }
  await admin().from('slack_posts').update({ last_state: state }).eq('id', row.id);
  ctx.updated++;
}

async function syncFollowUps(ctx: Ctx, progress: Progress): Promise<void> {
  const since = progress.cursor;
  const db = admin();
  const { data, error } = await db
    .from('follow_ups')
    .select(followUpColumns(ctx))
    .eq('org_id', ctx.orgId)
    .gte('updated_at', since)
    .order('updated_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  await handleFollowUps(ctx, (data ?? []) as unknown as RawFollowUp[], progress);
}

const followUpColumns = (ctx: Ctx) =>
  `id, type, status, reason, target, task_id, created_at, updated_at, ${projectColumns(ctx)}, vendors(name), tasks(due_date)`;

/** Bring a batch of follow-ups up to date in Slack. `progress` is moved past each one handled, when given. */
async function handleFollowUps(ctx: Ctx, items: RawFollowUp[], progress?: Progress): Promise<void> {
  if (!items.length) return;
  const db = admin();

  const ids = items.map((f) => f.id);
  const taskIds = [...new Set(items.map((f) => f.task_id).filter((x): x is string => Boolean(x)))];

  const [{ data: ownRows }, { data: taskRows }, { data: drafts }] = await Promise.all([
    db.from('slack_posts').select('id, entity, entity_id, channel, message_ts, thread_ts, last_state')
      .eq('org_id', ctx.orgId).eq('entity', 'follow_up').in('entity_id', ids),
    taskIds.length
      ? db.from('slack_posts').select('id, entity, entity_id, channel, message_ts, thread_ts, last_state')
          .eq('org_id', ctx.orgId).eq('entity', 'task').in('entity_id', taskIds)
      : Promise.resolve({ data: [] as PostRow[] }),
    db.from('drafts').select('follow_up_id, subject, created_at').in('follow_up_id', ids).order('created_at', { ascending: false }),
  ]);
  const own = new Map(((ownRows ?? []) as PostRow[]).map((r) => [r.entity_id, r]));
  const taskPosts = new Map(((taskRows ?? []) as PostRow[]).map((r) => [r.entity_id, r]));
  const subjects = new Map<string, string | null>();
  for (const d of (drafts ?? []) as { follow_up_id: string; subject: string | null }[]) {
    if (!subjects.has(d.follow_up_id)) subjects.set(d.follow_up_id, d.subject);
  }

  for (const f of items) {
    const card: FollowUpCard = {
      type: f.type,
      status: f.status,
      reason: f.reason,
      project: f.projects?.name ?? null,
      vendor: f.vendors?.name ?? null,
      target: f.target,
      draftSubject: subjects.get(f.id) ?? null,
    };
    await syncFollowUp(ctx, f, own.get(f.id), card, f.task_id ? taskPosts.get(f.task_id) : undefined);
    if (progress) progress.cursor = f.updated_at;
  }
}

// ── The run ─────────────────────────────────────────────────

/** `since` for a pass: just before the cursor, or the moment Slack was switched on. */
function startOf(cursor: string | null, enabledAt: string | null): string | null {
  if (cursor) return new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
  return enabledAt;
}

export async function runSlackSync(orgId: string, opts: { budgetMs?: number } = {}): Promise<SlackSyncResult> {
  if (!supabaseAdmin) return { ok: false, posted: 0, updated: 0, error: 'supabase_not_configured' };

  const slack: ResolvedSlack = await resolveSlack(orgId);
  if (!slack.connected || !slack.token) return { ok: true, skipped: 'not_connected', posted: 0, updated: 0 };
  if (!slack.config.enabled) return { ok: true, skipped: 'paused', posted: 0, updated: 0 };

  const state = await readSlackSyncState(orgId);
  const now = new Date().toISOString();

  // Connected through the environment, never saved from Settings: there is no
  // switch-on moment to measure from, so start from now rather than the backlog.
  const enabledAt = slack.config.enabledAt;
  if (!state.taskCursor && !state.followUpCursor && !enabledAt) {
    await saveSlackSyncState(orgId, { ...state, taskCursor: now, followUpCursor: now, lastRunAt: now, lastError: null });
    return { ok: true, posted: 0, updated: 0 };
  }

  await supabaseAdmin
    .from('slack_posts')
    .delete()
    .eq('org_id', orgId)
    .is('message_ts', null)
    .lt('created_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());

  const ctx: Ctx = {
    orgId,
    token: slack.token,
    channel: slack.config.channel,
    enabledAt,
    deadline: Date.now() + (opts.budgetMs ?? 40_000),
    calls: 0,
    lastCallAt: 0,
    posted: 0,
    updated: 0,
    projectChannels: await hasColumn('projects', 'slack_channel'),
    warnings: [],
  };

  let taskCursor = state.taskCursor;
  let followUpCursor = state.followUpCursor;
  let lastError: string | null = null;

  // Each pass keeps the cursor it reached, whatever stops it.
  const pass = async (
    on: boolean,
    cursor: string | null,
    run: (progress: Progress) => Promise<void>,
    save: (c: string) => void,
  ) => {
    if (!on) return;
    const progress: Progress = { cursor: startOf(cursor, enabledAt) ?? now };
    try {
      await run(progress);
    } catch (err) {
      if (!(err instanceof StopRun)) throw err;
    } finally {
      // The overlap on the next read makes re-handling the boundary row safe.
      save(progress.cursor);
    }
  };

  try {
    // Tasks first, so a follow-up raised on one finds its thread.
    await pass(slack.config.tasks, taskCursor, (p) => syncTasks(ctx, p), (c) => { taskCursor = c; });
    await pass(slack.config.followUps, followUpCursor, (p) => syncFollowUps(ctx, p), (c) => { followUpCursor = c; });
    // Then whatever has come into the yesterday–tomorrow window without changing.
    // v2: these "now due" posts are a v1 reminder, so they follow the off-switch.
    try {
      if (await remindersV1Enabled(orgId)) await announceDue(ctx, slack);
      else logV1Skipped('slackSync announceDue');
    } catch (err) {
      if (!(err instanceof StopRun)) throw err;
    }
  } catch (err) {
    if (err instanceof SlackError) {
      // Rate-limited or briefly unreachable: quiet, the next run carries on.
      // Anything else is something an admin has to fix, so it is shown in Settings.
      if (err.needsAttention) lastError = err.message;
      else console.error('[slack] sync paused:', err.message);
    } else {
      console.error('[slack] sync failed:', (err as Error).message);
      lastError = 'The sync hit an unexpected error — see the server log.';
    }
  }

  // A channel the bot cannot post in is not a failed run — the update still
  // went out, to the default channel — but an admin has to fix it, so it is
  // shown in Settings like an error would be.
  const hardError = lastError;
  const notice = hardError ?? ([...new Set(ctx.warnings)].join(' ') || null);

  await saveSlackSyncState(orgId, {
    taskCursor,
    followUpCursor,
    lastRunAt: new Date().toISOString(),
    lastPosted: ctx.posted + ctx.updated,
    lastError: notice,
  });

  return { ok: !hardError, posted: ctx.posted, updated: ctx.updated, error: notice ?? undefined };
}
