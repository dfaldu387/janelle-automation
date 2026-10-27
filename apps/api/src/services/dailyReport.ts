import { hasColumn, hasSubtasks, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { pacificDate, pacificDayStart } from '../lib/pacificTime.js';
import { gmailFor, sentActivity } from './gmail.js';

/**
 * The daily report, in the layout Janelle asked for (2026-10-27):
 *
 *   1. Fires and blockers first — what is on fire across the whole studio:
 *      blocked work, overdue work, and follow-ups waiting on someone.
 *   2. Then a run-down per person: what they completed today, what is still
 *      pending, and a read on how active they were — set against reported hours,
 *      never presented as hours (we cannot clock anyone; see teamActivity).
 *
 * Every task that came from an email carries a link straight to that Gmail
 * thread, so "I don't know where to track this down" has an answer. The Houzz
 * reference is the project name — searchable in Houzz Pro — until a true invoice
 * number is extracted (a separate piece of work; many of ours are quotes).
 */

const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/** A Gmail web link to the thread a task was raised from. */
function gmailThreadUrl(threadId: string | null): string | null {
  return threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
}

export interface DailyItem {
  id: string;
  title: string;
  project: string | null;
  assignee: string | null;
  due: string | null;
  overdue: boolean;
  blocked: boolean;
  /** Link to the originating Gmail thread, when the task came from one. */
  emailUrl: string | null;
}

export interface DailyFollowUp {
  type: string;
  reason: string | null;
  project: string | null;
  vendor: string | null;
}

export interface DailyActivity {
  connected: boolean;
  /** Emails sent in roughly the last day, or null when the mailbox is not readable. */
  emailsSent: number | null;
  lastSentAt: string | null;
}

export interface DailyPerson {
  id: string;
  name: string;
  completedToday: DailyItem[];
  pending: DailyItem[];
  activity: DailyActivity;
}

export interface DailyReport {
  date: string;
  generatedAt: string;
  fires: { blocked: DailyItem[]; overdue: DailyItem[]; followUps: DailyFollowUp[] };
  people: DailyPerson[];
  unassignedPending: DailyItem[];
  notes: string[];
}

type TaskRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  assigned_to: string | null;
  source_email_id: string | null;
  projects: { name: string | null } | null;
  profiles: { full_name: string | null } | null;
};

export async function buildDailyReport(orgId: string): Promise<DailyReport> {
  const today = pacificDate(0);
  const notes = [
    'Each task from an email links straight to its Gmail thread.',
    'Houzz reference is the project name — search it in Houzz Pro. (A true invoice number needs extraction we have not built yet.)',
    'The activity read — emails sent, when last active — is an engagement signal, not a measure of hours.',
  ];
  const empty: DailyReport = {
    date: today,
    generatedAt: new Date().toISOString(),
    fires: { blocked: [], overdue: [], followUps: [] },
    people: [],
    unassignedPending: [],
    notes,
  };
  if (!supabaseAdmin) return empty;

  const subtasks = await hasSubtasks();
  const completion = await hasTaskCompletion();
  const cols = 'id, title, status, due_date, assigned_to, source_email_id, projects(name), profiles(full_name)';

  // Live work, paged so a big board is not truncated (PostgREST caps at 1000).
  const live: TaskRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin
      .from('tasks')
      .select(cols)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .range(from, from + PAGE - 1);
    if (subtasks) q = q.is('parent_task_id', null);
    const { data } = await q;
    const batch = (data ?? []) as unknown as TaskRow[];
    live.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Finished today, in the studio's own day.
  const { data: doneRows } = await supabaseAdmin
    .from('tasks')
    .select(cols)
    .eq('org_id', orgId)
    .eq('status', 'done')
    .gte(completion ? 'completed_at' : 'updated_at', pacificDayStart().toISOString());
  const doneToday = (doneRows ?? []) as unknown as TaskRow[];

  // One lookup of source emails → thread ids, for the "open in Gmail" links.
  const sourceIds = [...new Set([...live, ...doneToday].map((t) => t.source_email_id).filter((id): id is string => !!id))];
  const threads = new Map<string, string>();
  if (sourceIds.length) {
    const { data: emailRows } = await supabaseAdmin.from('emails').select('id, thread_id').in('id', sourceIds);
    for (const e of (emailRows ?? []) as { id: string; thread_id: string | null }[]) {
      if (e.thread_id) threads.set(e.id, e.thread_id);
    }
  }

  const toItem = (t: TaskRow): DailyItem => ({
    id: t.id,
    title: t.title,
    project: t.projects?.name ?? null,
    assignee: t.profiles?.full_name ?? null,
    due: t.due_date,
    overdue: !!t.due_date && t.due_date < today,
    blocked: t.status === 'blocked',
    emailUrl: gmailThreadUrl(t.source_email_id ? threads.get(t.source_email_id) ?? null : null),
  });

  const liveItems = live.map(toItem);

  // ── Fires first ──────────────────────────────────────────────
  const blocked = liveItems.filter((i) => i.blocked);
  const overdue = liveItems
    .filter((i) => i.overdue && !i.blocked)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));

  // Follow-ups still waiting on someone.
  const snoozable = await hasColumn('follow_ups', 'snoozed_until');
  let fq = supabaseAdmin
    .from('follow_ups')
    .select('type, reason, projects(name), vendors(name)')
    .eq('org_id', orgId)
    .in('status', ['open', 'drafted']);
  if (snoozable) fq = fq.or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`);
  const { data: fuRows } = await fq;
  const followUps = ((fuRows ?? []) as unknown as {
    type: string; reason: string | null; projects: { name: string | null } | null; vendors: { name: string | null } | null;
  }[]).map((f) => ({ type: f.type, reason: f.reason, project: f.projects?.name ?? null, vendor: f.vendors?.name ?? null }));

  // ── Then the per-person run-down ─────────────────────────────
  type Bucket = { id: string; name: string; pending: DailyItem[]; completedToday: DailyItem[] };
  const byPerson = new Map<string, Bucket>();
  const bucket = (id: string, name: string): Bucket => {
    const b = byPerson.get(id) ?? { id, name, pending: [], completedToday: [] };
    byPerson.set(id, b);
    return b;
  };
  const unassignedPending: DailyItem[] = [];

  for (const t of live) {
    const item = toItem(t);
    if (t.assigned_to && t.profiles?.full_name) bucket(t.assigned_to, t.profiles.full_name).pending.push(item);
    else unassignedPending.push(item);
  }
  for (const t of doneToday) {
    if (!t.assigned_to || !t.profiles?.full_name) continue;
    bucket(t.assigned_to, t.profiles.full_name).completedToday.push(toItem(t));
  }

  // Who among them can have their sent mail read, for the activity line.
  const ids = [...byPerson.keys()];
  const connected = new Set<string>();
  if (ids.length) {
    const { data: integrations } = await supabaseAdmin
      .from('integrations')
      .select('user_id, status')
      .eq('provider', 'google')
      .in('user_id', ids);
    for (const row of (integrations ?? []) as { user_id: string; status: string }[]) {
      if (row.status === 'connected') connected.add(row.user_id);
    }
  }

  const people: DailyPerson[] = [];
  for (const b of byPerson.values()) {
    let activity: DailyActivity = { connected: connected.has(b.id), emailsSent: null, lastSentAt: null };
    if (connected.has(b.id)) {
      try {
        const gmail = await gmailFor(b.id);
        const act = gmail ? await sentActivity(gmail, 1) : null;
        if (act) activity = { connected: true, emailsSent: act.sent, lastSentAt: act.lastSentAt };
      } catch (err) {
        console.error(`[daily-report] sent read failed for ${b.name}:`, (err as Error).message);
      }
    }
    const sortDue = (a: DailyItem, b2: DailyItem) => (a.due ?? '~').localeCompare(b2.due ?? '~');
    people.push({
      id: b.id,
      name: b.name,
      completedToday: b.completedToday,
      pending: b.pending.sort(sortDue),
      activity,
    });
  }

  // Most still-pending first — the person carrying the most leads the list.
  people.sort((a, b) => b.pending.length - a.pending.length || b.completedToday.length - a.completedToday.length);

  return {
    date: today,
    generatedAt: new Date().toISOString(),
    fires: { blocked, overdue, followUps },
    people,
    unassignedPending,
    notes,
  };
}
