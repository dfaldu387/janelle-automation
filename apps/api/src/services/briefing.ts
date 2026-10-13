import {
  ASSISTANT_NAME,
  CHECKIN_PROMPT,
  canManageTasks,
  canSupervise,
  type AssistantAnswer,
  type AssistantItem,
} from '@janelle/shared';
import { purchaseOrderRow, taskRow, type AssistantContext } from './assistant.js';

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

type Db = AssistantContext['db'];

/** A count query that reports null rather than throwing — a briefing degrades, it does not fail. */
async function count(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count: n, error } = await build();
    return error ? 0 : (n ?? 0);
  } catch {
    return 0;
  }
}

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

/** A line that stands for a count and opens the screen that holds the rows. */
function summaryRow(kind: AssistantItem['kind'], title: string, tone: AssistantItem['tone']): AssistantItem {
  return { kind, title, tone };
}

interface BriefingOptions {
  /** The person's local hour, 0–23, for the greeting. The server does not know their timezone. */
  hour?: number | null;
}

export async function buildBriefing(ctx: AssistantContext, opts: BriefingOptions = {}): Promise<AssistantAnswer> {
  const { db, userId, role } = ctx;
  const seat = ctx.seat ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const first = ctx.name.split(/[\s@]/)[0] || ctx.name;

  // What each seat exists to catch. The rest of the studio's troubles belong
  // to someone else, and a briefing that lists everything is a dashboard.
  const runsBoard = canManageTasks(role, seat);
  const supervises = canSupervise(role);
  const watchesOrders = role === 'procurement' || role === 'coordinator';
  const watchesSpecs = role === 'designer';
  const chasesHygiene = runsBoard || seat === 'pm_support';

  const head = (table: string) => (db as Db).from(table).select('*', { count: 'exact', head: true });

  type TaskRowData = {
    id: string; title: string; status: string; due_date: string | null;
    projects: { name: string } | null;
  };
  type PoRowData = {
    id: string; po_number: string | null; status: string; amount: number | null; eta: string | null;
    vendors: { name: string } | null; projects: { name: string } | null;
  };

  type BoardRowData = TaskRowData & {
    kind: string;
    next_step: string | null;
    profiles: { full_name: string | null } | null;
  };

  const [mine, board, noNextStep, drafts, escalations, clientsWaiting, latePos, specGaps] = await Promise.all([
    rowsOf<TaskRowData>(() =>
      db
        .from('tasks')
        .select('id, title, status, due_date, projects(name)')
        .eq('assigned_to', userId)
        .in('status', LIVE)
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(60),
    ),
    // The live board, not just this person's own row of it.
    //
    // A principal owns almost nothing on the board — the work is assigned to
    // the people who do it — so a briefing built only from `assigned_to = me`
    // told whoever runs the studio that nothing needed them, while eleven
    // live tasks sat there and one of them had no owner at all. Whoever runs
    // the board is briefed on the board.
    runsBoard
      ? rowsOf<BoardRowData>(() =>
          db
            .from('tasks')
            .select('id, title, kind, status, due_date, next_step, projects(name), profiles(full_name)')
            .in('status', LIVE)
            .order('due_date', { ascending: true, nullsFirst: false })
            .limit(80),
        )
      : Promise.resolve([] as BoardRowData[]),
    chasesHygiene
      ? rowsOf<{ next_step: string | null }>(() => db.from('tasks').select('next_step').in('status', LIVE)).then(
          (r) => r.filter((t) => !(t.next_step ?? '').trim()).length,
        )
      : Promise.resolve(0),
    supervises ? count(() => head('drafts')) : Promise.resolve(0),
    supervises
      ? count(() => head('follow_ups').eq('type', 'task_escalation').in('status', ['open', 'drafted']))
      : Promise.resolve(0),
    role === 'principal'
      ? count(() =>
          head('follow_ups').in('type', ['client_approval_overdue', 'client_waiting']).in('status', ['open', 'drafted']),
        )
      : Promise.resolve(0),
    watchesOrders
      ? rowsOf<PoRowData>(() =>
          db
            .from('purchase_orders')
            .select('id, po_number, status, amount, eta, vendors(name), projects(name)')
            .lt('eta', today)
            .not('status', 'in', '("received","cancelled")')
            .order('eta', { ascending: true })
            .limit(20),
        )
      : Promise.resolve([] as PoRowData[]),
    watchesSpecs ? count(() => head('spec_gaps').eq('resolved', false)) : Promise.resolve(0),
  ]);

  const overdue = mine.filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked');
  const dueToday = mine.filter((t) => t.due_date === today && t.status !== 'blocked');

  // The board, split the way the board is read. Anything already listed as
  // this person's own is left out rather than said twice.
  const alreadyShown = new Set([...overdue.slice(0, SHOW.overdue), ...dueToday.slice(0, SHOW.dueToday)].map((t) => t.id));
  const boardRest = board.filter((t) => !alreadyShown.has(t.id));
  const unassigned = boardRest.filter((t) => !t.profiles?.full_name);
  const inProgress = boardRest.filter((t) => t.status === 'in_progress' && t.profiles?.full_name);
  const openTasks = boardRest.filter((t) => t.status === 'open' && t.profiles?.full_name);

  /** A board row, with the owner named and the next step spelled out. */
  const asBoardTask = (t: BoardRowData): AssistantItem => {
    const row = taskRow({
      id: t.id,
      title: t.title,
      status: t.status,
      due_date: t.due_date,
      owner: t.profiles?.full_name ?? 'Nobody yet',
      project: t.projects?.name ?? null,
    });
    // The studio's SOP says a task names its next action, and that is the
    // useful line — it is what the person would otherwise open the task to
    // find. Always present, even when empty: the renderer only lays these
    // out as a table when every row carries the same columns, and an em
    // dash is dropped from the card view anyway.
    const next = (t.next_step ?? '').trim();
    return {
      ...row,
      fields: [...(row.fields ?? []), { label: 'Next', value: next || '—' }],
    };
  };

  // Every one of these is theirs, so an Owner column would repeat their own
  // name down the whole list.
  const asTask = (t: TaskRowData) => {
    const row = taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: ctx.name, project: t.projects?.name ?? null });
    return { ...row, fields: row.fields?.filter((f) => f.label !== 'Owner') };
  };

  const items: AssistantItem[] = [
    ...overdue.slice(0, SHOW.overdue).map(asTask),
    ...dueToday.slice(0, SHOW.dueToday).map((t) => ({ ...asTask(t), meta: 'due today', tone: 'warn' as const })),
    ...latePos.slice(0, SHOW.latePos).map((p) =>
      purchaseOrderRow({
        id: p.id,
        po: p.po_number,
        vendor: p.vendors?.name ?? 'Unknown vendor',
        project: p.projects?.name ?? 'Unassigned',
        amount: p.amount,
        expected: p.eta,
        status: p.status,
        late: true,
      }),
    ),
  ];

  // Counts that stand for a whole screen. Worst first: people waiting on
  // the studio, then work that has stalled, then the routine.
  if (clientsWaiting) items.push(summaryRow('follow_up', `${plural(clientsWaiting, 'client is', 'clients are')} waiting on the studio`, 'crit'));
  if (escalations) items.push(summaryRow('follow_up', `${plural(escalations, 'escalation', 'escalations')} to look at`, 'crit'));

  // Needing an owner comes before anything in flight: it is the only one
  // where nothing at all is happening until this person acts.
  items.push(
    ...unassigned.slice(0, SHOW.unassigned).map((t) => ({ ...asBoardTask(t), meta: 'needs an owner', tone: 'warn' as const })),
    ...inProgress.slice(0, SHOW.inProgress).map((t) => ({ ...asBoardTask(t), meta: 'in progress' })),
    ...openTasks.slice(0, SHOW.open).map((t) => ({ ...asBoardTask(t), meta: 'open' })),
  );
  if (noNextStep) items.push(summaryRow('task', `${plural(noNextStep, 'task is', 'tasks are')} missing a next step`, 'neutral'));
  if (specGaps) items.push(summaryRow('project', `${plural(specGaps, 'spec gap is', 'spec gaps are')} still open`, 'warn'));
  if (drafts) items.push(summaryRow('draft', `${plural(drafts, 'draft is', 'drafts are')} ready to review and send`, 'neutral'));

  const hidden =
    Math.max(0, overdue.length - SHOW.overdue) +
    Math.max(0, dueToday.length - SHOW.dueToday) +
    Math.max(0, latePos.length - SHOW.latePos) +
    Math.max(0, unassigned.length - SHOW.unassigned) +
    Math.max(0, inProgress.length - SHOW.inProgress) +
    Math.max(0, openTasks.length - SHOW.open);

  // "Things", counted as a person would: each late task is one, each
  // count row is one — five drafts waiting is one thing to go and do.
  //
  // Work in flight is not counted. It is listed because whoever runs the
  // board should see it, but a task someone else is already doing is not a
  // thing that needs this person today, and counting it would turn a
  // truthful "two things" into an alarming and meaningless thirteen.
  const things =
    overdue.length + dueToday.length + latePos.length + unassigned.length + items.filter((i) => !i.id).length;
  const hello = `${greeting(opts.hour ?? null)}, ${first}.`;

  let lead: string;
  let speech: string;
  if (things === 0) {
    lead = `${hello} Nothing needs you right now.`;
    speech = `${hello} Nothing needs you right now.`;
  } else {
    const worst = overdue[0];
    const lateBy = worst?.due_date && worst.due_date < today ? `, ${plural(daysLate(worst.due_date), 'day', 'days')} late` : '';
    const pressing = worst
      ? ` The most pressing is “${worst.title}”${worst.status === 'blocked' ? ', which is blocked' : lateBy}.`
      : latePos[0]
        ? ` The most pressing is ${latePos[0].po_number ?? 'an order'} from ${latePos[0].vendors?.name ?? 'a vendor'}, past its delivery date.`
        : unassigned.length
          ? ` ${plural(unassigned.length, 'task has', 'tasks have')} nobody on ${unassigned.length === 1 ? 'it' : 'them'} — “${unassigned[0].title}” first.`
          : '';
    lead = `${hello} ${spoken(things)} ${things === 1 ? 'thing needs' : 'things need'} you today.${pressing}`;
    speech = lead.replace(/[“”]/g, '');
  }

  const suggestions: string[] = [];
  // After four, the day's question is not what to start but what got done.
  // The chip is answered by the browser (AssistantContext) with the
  // check-in itself, not sent to the model.
  if ((opts.hour ?? -1) >= 16 && (overdue.length || dueToday.length)) suggestions.push(CHECKIN_PROMPT);
  if (overdue.length || dueToday.length) suggestions.push('What should I tackle first?');
  if (role === 'principal') suggestions.push('What are clients waiting on?');
  if (supervises) suggestions.push("Read me this morning's digest");
  if (watchesOrders) suggestions.push('Which orders are late, and who do I chase?');
  if (watchesSpecs) suggestions.push('Which spec gaps are blocking orders?');
  if (unassigned.length) suggestions.push('Who should take the unassigned tasks?');
  if (inProgress.length) suggestions.push("What's in progress right now?");
  if (chasesHygiene && noNextStep) suggestions.push('Which tasks are missing a next step?');
  suggestions.push("What's on my plate this week?");

  return {
    lead,
    items,
    more: hidden,
    caveat: null,
    speech,
    sources: [
      'your tasks',
      ...(board.length ? ['the task board'] : []),
      ...(latePos.length ? ['purchase orders'] : []),
      ...(drafts ? ['drafts'] : []),
    ],
    suggestions: [...new Set(suggestions)].slice(0, 3),
  };
}

/** Said when there is no studio to brief on — before setup, or signed in without a profile. */
export function emptyBriefing(name: string, hour: number | null): AssistantAnswer {
  const first = name.split(/[\s@]/)[0] || name;
  const lead = `${greeting(hour)}, ${first}. I'm ${ASSISTANT_NAME} — ask me about any project, task, order or email.`;
  return { lead, items: [], more: 0, caveat: null, speech: lead, sources: [], suggestions: ['List our projects', 'What is overdue?'] };
}
