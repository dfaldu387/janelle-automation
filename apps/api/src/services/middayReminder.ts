import { TASK_CATEGORY_LABELS, defaultTaskCategory, type TaskCategory } from '@janelle/shared';
import { hasTaskCategory, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { isStudioMailbox } from '../lib/studioTeam.js';
import { pacificDate, pacificDayStart, pacificHourNow } from '../lib/pacificTime.js';
import { gmailFor, sendMessage } from './gmail.js';
import {
  middayOwnerEmail,
  middayPersonalEmail,
  type MiddayPlan,
  type MiddaySection,
  type MiddayTaskRow,
  type ReminderSlot,
} from './emailTemplate.js';
import { env } from '../env.js';
import { latestBlockerNotes, unmatchedCheckinNotes } from './checkin.js';
import { sendSlackReminders, type SlackReminderPerson, type SlackReminderResult } from './slackReminder.js';

export type { ReminderSlot };

/** Statuses that mean the work is still outstanding. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * Which of the day's two emails this moment calls for: the morning plan up to
 * early afternoon, the evening wrap-up after it. The scheduler only fires at 9am
 * and 5pm Pacific, so for a real send this is exact; for a manual "send now" it
 * picks whichever is nearer.
 */
export function reminderSlotNow(): ReminderSlot {
  return pacificHourNow() < 13 ? 'morning' : 'evening';
}

export interface Task {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  project: string | null;
  category: TaskCategory;
  /** Finished today — only ever true in the evening wrap-up. */
  done: boolean;
  assignedTo: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  /** Why it is blocked, from the person's check-in (services/checkin.ts). */
  note: string | null;
}

/** "2026-09-17" → "Sep 17": the date as a person says it. */
function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The two dates the emails are about, in the studio's own calendar. */
export interface Window {
  today: string;
  tomorrow: string;
}

/**
 * What goes in each email.
 *
 *   morning  Not finished, and due today or before. Everything due later is
 *            left to its own day — a reminder is not an inventory, and the full
 *            list is on the task board every email links to.
 *   evening  What was finished today, what is still pending from today and
 *            earlier, and what is due tomorrow. The first two say how the day
 *            went; the last starts tomorrow's list tonight.
 *
 * A task with no date appears in neither: with no date there is nothing to
 * remind anyone of.
 */
export function belongsIn(t: Task, slot: ReminderSlot, w: Window): boolean {
  if (slot === 'morning') return !t.done && t.due_date !== null && t.due_date <= w.today;
  return t.done || (t.due_date !== null && t.due_date <= w.tomorrow);
}

/** One task, phrased for the time of day it is read — what the email template renders. */
function toRow(t: Task, w: Window, slot: ReminderSlot): MiddayTaskRow {
  const base = {
    title: t.title,
    project: t.project,
    category: TASK_CATEGORY_LABELS[t.category],
    blocked: t.status === 'blocked',
    note: t.status === 'blocked' && !t.done ? t.note : null,
  };
  if (t.done) return { ...base, dueText: 'completed today', tone: 'good', blocked: false };

  const due = t.due_date as string;
  const late = slot === 'morning' ? 'overdue' : 'still pending';
  if (due < w.today) return { ...base, dueText: `${late}, was due ${shortDate(due)}`, tone: 'crit' };
  if (due === w.today) return { ...base, dueText: slot === 'morning' ? 'due today' : 'still pending, due today', tone: 'warn' };
  return { ...base, dueText: 'due tomorrow', tone: 'neutral' };
}

/**
 * How many tasks each list in an email shows before it turns into a count.
 *
 * The owner asked for each person's *top* priorities, after a version that
 * listed everything (hundreds of overdue tasks a day) and was read by nobody.
 * Five is a day's work; the rest stays on the board, which every email links
 * to. The owner's per-person cards are tighter still, so the whole studio
 * fits on one screen.
 */
export interface PlanCaps {
  /** Open work due today or earlier, most overdue first. */
  priorities: number;
  blocked: number;
  /** Evening only: finished today, and due tomorrow. */
  done: number;
  tomorrow: number;
}
export const PERSONAL_CAPS: PlanCaps = { priorities: 5, blocked: 3, done: 5, tomorrow: 3 };
export const OWNER_CAPS: PlanCaps = { priorities: 3, blocked: 3, done: 0, tomorrow: 0 };

/**
 * One person's plan: their open work ranked most urgent first and cut at
 * `caps`, what is blocked, and — in the evening — what got done and what is
 * due tomorrow. Blocked tasks are kept out of the priorities: they are not
 * something the person can do today, and letting them fill the top five would
 * hide the work that is. They get their own short list instead, and the
 * evening email asks what is in the way.
 */
export function toPlan(rows: Task[], w: Window, slot: ReminderSlot, caps: PlanCaps): MiddayPlan {
  const byDue = (a: Task, b: Task) =>
    (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.title.localeCompare(b.title);
  const dueByToday = (t: Task) => !t.done && t.due_date !== null && t.due_date <= w.today;

  const priorities = rows.filter((t) => dueByToday(t) && t.status !== 'blocked').sort(byDue);
  const blocked = rows.filter((t) => dueByToday(t) && t.status === 'blocked').sort(byDue);
  const done = rows.filter((t) => t.done).sort(byDue);
  const tomorrow = rows.filter((t) => !t.done && t.due_date === w.tomorrow).sort(byDue);

  const counts = {
    overdue: priorities.filter((t) => (t.due_date as string) < w.today).length,
    today: priorities.length - priorities.filter((t) => (t.due_date as string) < w.today).length,
    blocked: blocked.length,
    done: done.length,
    tomorrow: tomorrow.length,
  };

  const section = (
    label: string,
    list: Task[],
    cap: number,
    extra: Partial<Pick<MiddaySection, 'hint' | 'numbered'>> = {},
  ): MiddaySection => ({
    label,
    rows: list.slice(0, cap).map((t) => toRow(t, w, slot)),
    total: list.length,
    ...extra,
  });

  const sections: MiddaySection[] =
    slot === 'morning'
      ? [
          section('Top priorities', priorities, caps.priorities, { numbered: true }),
          section('Blocked', blocked, caps.blocked, { hint: 'Waiting on someone else — chase it, or flag who.' }),
        ]
      : [
          section('Finished today', done, caps.done),
          section('Still open — rolls to tomorrow', priorities, caps.priorities, { numbered: true }),
          section('Blocked', blocked, caps.blocked, { hint: 'What is in the way? Say so in a reply.' }),
          section('Due tomorrow', tomorrow, caps.tomorrow),
        ];

  return { sections: sections.filter((s) => s.total > 0), counts };
}

export interface MiddayReminderResult {
  ok: boolean;
  reason?: string;
  slot: ReminderSlot;
  /** Personal reminders composed, one per teammate with something to be told. */
  personal: number;
  ownerSent: boolean;
  /** The same reminders as Slack DMs (services/slackReminder.ts); null when Slack is not set up. */
  slack: SlackReminderResult | null;
}

/**
 * Send the day's task email: one per teammate naming their own tasks, and one
 * to the owner breaking down the whole studio by person. At 9am it is the plan
 * for the day; at 5pm it is the wrap-up (see ops.ts / scheduler.ts).
 *
 * Real sends, not drafts — the one deliberate exception besides account
 * invitations (see sendMessage). Each teammate and the owner get their own
 * email at their own address.
 */
export async function runMiddayReminder(orgId: string, slot: ReminderSlot = reminderSlotNow()): Promise<MiddayReminderResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', slot, personal: 0, ownerSent: false, slack: null };

  // Category and completion time exist only once migrations 0026 and 0015 are
  // applied; until then category is worked out from the kind and the seat, and
  // "finished today" falls back to when the task last changed.
  const [categorised, completion] = await Promise.all([hasTaskCategory(), hasTaskCompletion()]);
  const columns = `id, title, due_date, status, assigned_to, kind, seat${categorised ? ', category' : ''}, projects(name), profiles(full_name, email)`;

  type Raw = {
    id: string; title: string; due_date: string | null; status: string; assigned_to: string | null;
    kind: Parameters<typeof defaultTaskCategory>[0]; seat: string | null; category?: TaskCategory | null;
    projects: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  const shape = (rows: unknown, done: boolean): Task[] =>
    ((rows ?? []) as Raw[]).map((t) => ({
      id: t.id,
      title: t.title,
      due_date: t.due_date,
      status: t.status,
      done,
      note: null,
      category: t.category ?? defaultTaskCategory(t.kind, t.seat),
      project: t.projects?.name ?? null,
      assignedTo: t.assigned_to,
      assigneeName: t.profiles?.full_name ?? null,
      assigneeEmail: t.profiles?.email ?? null,
    }));

  const { data: live } = await supabaseAdmin.from('tasks').select(columns).eq('org_id', orgId).in('status', LIVE_STATUSES);
  let tasks = shape(live, false);

  if (slot === 'evening') {
    const { data: finished } = await supabaseAdmin
      .from('tasks')
      .select(columns)
      .eq('org_id', orgId)
      .eq('status', 'done')
      .gte(completion ? 'completed_at' : 'updated_at', pacificDayStart().toISOString());
    tasks = [...tasks, ...shape(finished, true)];
  }

  // A reminder with nothing to say teaches people to stop reading it, same
  // reasoning as the in-app popup's silence.
  const window: Window = { today: pacificDate(0), tomorrow: pacificDate(1) };
  const relevant = tasks.filter((t) => belongsIn(t, slot, window));
  if (!relevant.length) return { ok: true, slot, personal: 0, ownerSent: false, slack: null };

  const sender = await orgSourceUserId(orgId);
  const gmail = sender ? await gmailFor(sender) : null;
  if (!gmail) return { ok: false, reason: 'no_source_mailbox', slot, personal: 0, ownerSent: false, slack: null };

  // Why each blocked task is blocked, in the person's own words from their
  // check-in — so the morning plan carries the reason, not just the word —
  // and whatever they said last night that fitted no task in particular.
  // Both go under their name, in their own email and in the owner's.
  const blockerNotes = await latestBlockerNotes(
    orgId,
    relevant.filter((t) => !t.done && t.status === 'blocked').map((t) => t.id),
  );
  for (const t of relevant) t.note = blockerNotes.get(t.id) ?? null;
  const said =
    slot === 'morning'
      ? await unmatchedCheckinNotes(orgId, new Date(Date.now() - 24 * 3600_000).toISOString())
      : new Map<string, string[]>();
  const withNotes = (personId: string, plan: MiddayPlan): MiddayPlan => {
    const notes = said.get(personId);
    return notes?.length ? { ...plan, notes } : plan;
  };

  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : undefined;
  const checkinUrl = appUrl ? `${appUrl}/assistant?checkin=1` : undefined;

  // One group per teammate who owns any of it. A shared mailbox is not a
  // person to remind, same rule as everywhere else tasks are assigned.
  const byPerson = new Map<string, { name: string; email: string | null; rows: Task[] }>();
  for (const t of relevant) {
    if (!t.assignedTo || !t.assigneeName || isStudioMailbox(t.assigneeEmail)) continue;
    const entry = byPerson.get(t.assignedTo) ?? { name: t.assigneeName, email: t.assigneeEmail, rows: [] };
    entry.rows.push(t);
    byPerson.set(t.assignedTo, entry);
  }

  let personal = 0;
  const people: SlackReminderPerson[] = [];
  for (const [personId, { name, email, rows }] of byPerson) {
    const plan = withNotes(personId, toPlan(rows, window, slot, PERSONAL_CAPS));
    people.push({ name, email, plan });
    if (!email) {
      console.error('[midday] personal reminder skipped for', name, '(no email on file)');
      continue;
    }
    const mail = middayPersonalEmail({ name, slot, plan, boardUrl, checkinUrl });
    try {
      await sendMessage(gmail, { to: email, subject: mail.subject, body: mail.text, html: mail.html });
      personal++;
    } catch (err) {
      console.error('[midday] personal reminder failed for', name, (err as Error).message);
    }
  }

  // One team-wide breakdown to whoever actually holds the owner's seat —
  // never the shared mailbox, which can hold it in Team & roles by mistake
  // (see resolveSeatHolder) and is not a person who reads a reminder.
  const { data: principalRows } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email')
    .eq('org_id', orgId)
    .eq('role', 'principal');
  const owners = ((principalRows ?? []) as { full_name: string | null; email: string | null }[]).filter(
    (p) => p.full_name && p.email && !isStudioMailbox(p.email),
  );

  // The people with the most still open come first: that is who the owner
  // wants to see at a glance.
  const stillOpen = (p: MiddayPlan) => p.counts.overdue + p.counts.today + p.counts.blocked;
  const team = [...byPerson]
    .map(([personId, p]) => ({ name: p.name, plan: withNotes(personId, toPlan(p.rows, window, slot, OWNER_CAPS)) }))
    .sort((a, b) => stillOpen(b.plan) - stillOpen(a.plan));
  const unassigned = toPlan(
    relevant.filter((t) => !t.assignedTo),
    window,
    slot,
    OWNER_CAPS,
  );

  let ownerSent = false;
  for (const owner of owners) {
    const mail = middayOwnerEmail({
      name: owner.full_name as string,
      slot,
      people: team,
      unassigned,
      boardUrl,
    });
    try {
      await sendMessage(gmail, {
        to: owner.email as string,
        subject: mail.subject,
        body: mail.text,
        html: mail.html,
      });
      ownerSent = true;
    } catch (err) {
      console.error('[midday] owner summary failed:', (err as Error).message);
    }
  }

  // The same plans as Slack DMs, for whoever reads Slack before email. The
  // email has already gone, so a Slack failure costs nobody their plan.
  let slack: SlackReminderResult | null = null;
  try {
    slack = await sendSlackReminders(orgId, {
      slot,
      people,
      owners: owners.map((o) => ({ name: o.full_name as string, email: o.email })),
      team,
      unassigned,
    });
  } catch (err) {
    console.error('[midday] slack reminders failed:', (err as Error).message);
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'midday_reminder.sent',
    entity: 'tasks',
    meta: {
      slot,
      personal,
      owner_sent: ownerSent,
      included: relevant.length,
      completed: relevant.filter((t) => t.done).length,
      slack_sent: slack?.sent ?? 0,
      slack_skipped: slack?.skipped ?? null,
      slack_not_on_slack: slack?.notOnSlack ?? [],
    },
  });

  return { ok: true, slot, personal, ownerSent, slack };
}
