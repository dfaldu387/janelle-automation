import {
  ASSISTANT_NAME,
  CHECKIN_PROMPT,
  DIGEST_PROMPT,
  canManageTasks,
  canSupervise,
  type AssistantAnswer,
  type AssistantItem,
} from '@janelle/shared';
import { taskRow, type AssistantContext } from './assistant.js';
import { pacificDate } from '../lib/pacificTime.js';

/**
 * The briefing Jenny opens with: what needs THIS person, today.
 *
 * A personal assistant does not wait to be asked what is on fire. So when
 * someone opens her, the first thing on screen is theirs — their overdue
 * work, what is due today, and whatever their seat exists to catch — before
 * they have typed a word.
 *
 * Built straight from the database with no model call. It is shown on every
 * first open of the day, and a briefing that took eight seconds and cost a
 * Claude call each time would be one nobody waited for. It is also exactly
 * the kind of answer that must never be paraphrased: counts and dates.
 *
 * Everything runs on the caller's own client, so it counts only what row-level
 * security lets them see.
 */

const LIVE = ['open', 'in_progress', 'blocked'];

/** How many rows of one kind the briefing shows before counting the rest. */
const SHOW = { overdue: 5, dueToday: 3, latePos: 4, unassigned: 5, inProgress: 4, open: 4 };

async function rowsOf<T>(build: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await build();
    return error || !Array.isArray(data) ? [] : (data as T[]);
  } catch {
    return [];
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const spoken = (n: number) => NUMBER_WORDS[n] ?? String(n);

function greeting(hour: number | null): string {
  if (hour === null) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const daysLate = (isoDay: string) =>
  Math.max(1, Math.floor((Date.now() - new Date(`${isoDay}T12:00:00Z`).getTime()) / 86400_000));

interface BriefingOptions {
  /** The person's local hour, 0–23, for the greeting. The server does not know their timezone. */
  hour?: number | null;
}

export async function buildBriefing(ctx: AssistantContext, opts: BriefingOptions = {}): Promise<AssistantAnswer> {
  const { db, userId, role } = ctx;
  const seat = ctx.seat ?? null;
  // The studio's own calendar day, not the server's UTC one.
  const today = pacificDate();
  const first = ctx.name.split(/[\s@]/)[0] || ctx.name;

  // What each seat exists to catch. The rest of the studio's troubles belong
  // to someone else, and a briefing that lists everything is a dashboard.
  const runsBoard = canManageTasks(role, seat);
  const supervises = canSupervise(role);
  const watchesOrders = role === 'procurement' || role === 'coordinator';
  const watchesSpecs = role === 'designer';

  type Row = {
    id: string; title: string; status: string; due_date: string | null;
    next_step: string | null;
    projects: { name: string } | null;
    profiles: { full_name: string | null } | null;
  };

  // The pool a briefing is drawn from: the whole live board for whoever runs
  // it (a principal owns almost nothing themselves), otherwise this person's
  // own live tasks. Ordered earliest-due first, so the overdue list already
  // runs most-late first.
  const pool = await rowsOf<Row>(() => {
    const q = db
      .from('tasks')
      .select('id, title, status, due_date, next_step, projects(name), profiles(full_name)')
      .in('status', LIVE);
    return (runsBoard ? q : q.eq('assigned_to', userId))
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(200);
  });

  const overdue = pool.filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked');
  const dueToday = pool.filter((t) => t.due_date === today && t.status !== 'blocked');
  // The one thing carried over from before — "yesterday's top priority".
  const topPriority = overdue[0] ?? null;

  // A task tile: the owner named for a board-runner, dropped for one's own
  // list (it would just repeat their name), and the next step always carried
  // so the renderer can line the cards up.
  const asTile = (t: Row, meta?: string, tone?: AssistantItem['tone']): AssistantItem => {
    const row = taskRow({
      id: t.id,
      title: t.title,
      status: t.status,
      due_date: t.due_date,
      owner: runsBoard ? t.profiles?.full_name ?? 'Nobody yet' : ctx.name,
      project: t.projects?.name ?? null,
    });
    const base = runsBoard
      ? [...(row.fields ?? []), { label: 'Next', value: (t.next_step ?? '').trim() || '—' }]
      : (row.fields ?? []).filter((f) => f.label !== 'Owner');
    return { ...row, fields: base, ...(meta ? { meta } : {}), ...(tone ? { tone } : {}) };
  };

  // Yesterday's top priority, then today's tasks — and nothing else. The
  // briefing is a short list of what today needs, not the backlog; capped so
  // it stays a glance.
  const MAX_TILES = 5;
  const picked: Row[] = [];
  const add = (t: Row | null) => {
    if (t && !picked.some((x) => x.id === t.id) && picked.length < MAX_TILES) picked.push(t);
  };
  add(topPriority);
  dueToday.forEach(add);

  const items: AssistantItem[] = picked.map((t) => {
    const late = t.due_date && t.due_date < today ? `${daysLate(t.due_date)}d late` : null;
    if (t.id === topPriority?.id) return asTile(t, late ?? (t.status === 'blocked' ? 'blocked' : 'top priority'), 'crit');
    if (t.due_date === today) return asTile(t, 'due today', 'warn');
    return asTile(t, late ?? undefined);
  });

  const hidden = Math.max(0, dueToday.length + overdue.length - picked.length);
  const hello = `${greeting(opts.hour ?? null)}, ${first}.`;

  let lead: string;
  if (!dueToday.length && !topPriority) {
    lead = `${hello} Nothing needs you today.`;
  } else {
    const todayBit = dueToday.length
      ? `${spoken(dueToday.length)} ${dueToday.length === 1 ? 'task is' : 'tasks are'} due today.`
      : 'Nothing new is due today.';
    const priorityBit = topPriority
      ? ` Your top priority is still “${topPriority.title}”${
          topPriority.status === 'blocked'
            ? ', blocked'
            : topPriority.due_date && topPriority.due_date < today
              ? `, ${plural(daysLate(topPriority.due_date), 'day', 'days')} late`
              : ''
        }.`
      : '';
    lead = `${hello} ${todayBit}${priorityBit}`;
  }
  const speech = lead.replace(/[“”]/g, '');

  const suggestions: string[] = [];
  // After four, the day's question is not what to start but what got done.
  if ((opts.hour ?? -1) >= 16 && (dueToday.length || topPriority)) suggestions.push(CHECKIN_PROMPT);
  if (dueToday.length || topPriority) suggestions.push('What should I tackle first?');
  if (role === 'principal') suggestions.push('What are clients waiting on?');
  if (supervises) suggestions.push(DIGEST_PROMPT);
  if (watchesOrders) suggestions.push('Which orders are late, and who do I chase?');
  if (watchesSpecs) suggestions.push('Which spec gaps are blocking orders?');
  suggestions.push("What's on my plate this week?");

  return {
    lead,
    items,
    more: hidden,
    caveat: null,
    speech,
    sources: ['today’s tasks', ...(items.length ? ['the task board'] : [])],
    suggestions: [...new Set(suggestions)].slice(0, 3),
  };
}

/**
 * The morning digest, read straight back from where it was stored at 7am.
 *
 * "Read me the digest" used to go the long way round — a whole Claude turn
 * (system prompt, the full tool block, the digest text) spent only to recite
 * a narrative that was already written and sitting in `digests`. This returns
 * it with no model call: the stored narrative as the lead, and the tasks
 * behind it as real, clickable rows, exactly as the tool path would have
 * rendered them. Everything runs on the caller's own client, so RLS scopes it.
 */
export async function buildDigest(ctx: AssistantContext): Promise<AssistantAnswer> {
  const { db } = ctx;
  // The studio's own day, not the server's: in Pacific "today" rolls over at
  // local midnight, where UTC would already be on tomorrow by late afternoon.
  const today = pacificDate();

  // Today's tasks only — the digest is a view of what is on for today, not the
  // backlog. Overdue, blocked and stale work still drive the Slack reports, the
  // owner emails and the principal's escalations; here it is deliberately left
  // out so Jenny opens on today and nothing older.
  type LiveTask = {
    id: string; title: string; status: string; due_date: string | null; assigned_to: string | null;
    profiles: { full_name: string | null } | null; projects: { name: string } | null;
  };
  const live = await rowsOf<LiveTask>(() =>
    db
      .from('tasks')
      .select('id, title, status, due_date, assigned_to, profiles(full_name), projects(name)')
      .in('status', LIVE)
      .eq('due_date', today)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(200),
  );

  const ownerOf = (t: LiveTask) => t.profiles?.full_name ?? 'Unassigned';
  const dueToday = live;
  const unassigned = dueToday.filter((t) => !t.assigned_to);

  const items: AssistantItem[] = dueToday.slice(0, SHOW.dueToday + SHOW.unassigned).map((t) =>
    t.assigned_to
      ? taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: ownerOf(t), project: t.projects?.name ?? null })
      : {
          ...taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: 'Nobody yet', project: t.projects?.name ?? null }),
          meta: 'needs an owner',
          tone: 'warn' as const,
        },
  );

  const lead = dueToday.length
    ? `${plural(dueToday.length, 'task is', 'tasks are')} due today${
        unassigned.length ? `, ${unassigned.length} with no owner yet` : ''
      }.`
    : 'Nothing due today.';

  const hidden = Math.max(0, dueToday.length - (SHOW.dueToday + SHOW.unassigned));

  return {
    lead,
    items,
    more: hidden,
    caveat: null,
    speech: lead.replace(/[“”]/g, ''),
    sources: ['today’s tasks', ...(items.length ? ['the task board'] : [])],
    suggestions: [],
  };
}

/** Said when there is no studio to brief on — before setup, or signed in without a profile. */
export function emptyBriefing(name: string, hour: number | null): AssistantAnswer {
  const first = name.split(/[\s@]/)[0] || name;
  const lead = `${greeting(hour)}, ${first}. I'm ${ASSISTANT_NAME} — ask me about any project, task, order or email.`;
  return { lead, items: [], more: 0, caveat: null, speech: lead, sources: [], suggestions: ['List our projects', 'What is overdue?'] };
}
