import { hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { disabledUserIds } from '../lib/userStatus.js';
import { pacificDate } from '../lib/pacificTime.js';

/**
 * Board hygiene — why the open count climbs, and how to bring it back down.
 *
 * The auto-closer (reviewOpenTasks) only ever closes a task when an *email*
 * proves it is done. That is right for work the studio delegates by email, but
 * it leaves three kinds of task open for ever, which is how a board reaches 167
 * (Janelle, 2026-10-27):
 *
 *   - work finished in Houzz or in person, where no email ever says "done",
 *   - manually-raised or Houzz-imported tasks with no source email to track,
 *   - old tasks nobody touched again, which no rule has ever swept.
 *
 * This finds those by plain rules (no AI, no email read — fast and cheap) and
 * lets a manager clear them in one pass. Nothing here is destructive: a cleared
 * task is set to `cancelled`, kept, logged, and can be reopened one by one from
 * the board if it mattered after all.
 */

const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];
export const CLEANUP_ACTION = 'tasks.cleanup_closed';

/** Untouched for this long counts as stale — a quarter of a year of silence. */
export const STALE_DAYS = 45;

export type HygieneReason = 'assignee_gone' | 'stale';

export interface HygieneTask {
  id: string;
  title: string;
  assignee: string | null;
  project: string | null;
  dueDate: string | null;
  /** Days since it last changed (or was created). */
  ageDays: number;
  reason: HygieneReason;
}

export interface TaskHygiene {
  /** Every open task, for the headline ("167 open"). */
  total: number;
  /** The ones a cleanup would clear, newest-reason-first. */
  candidates: HygieneTask[];
  counts: Record<HygieneReason, number>;
  staleDays: number;
}

function ageInDays(iso: string | null, today: Date): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((today.getTime() - then) / (24 * 3600_000)));
}

/**
 * Classify the open board by plain rules. No AI and no mail read, so it is safe
 * to call on demand from the board.
 */
export async function reviewTaskHygiene(orgId: string): Promise<TaskHygiene> {
  const empty: TaskHygiene = { total: 0, candidates: [], counts: { assignee_gone: 0, stale: 0 }, staleDays: STALE_DAYS };
  if (!supabaseAdmin) return empty;

  type Row = {
    id: string;
    title: string;
    assigned_to: string | null;
    due_date: string | null;
    created_at: string;
    updated_at: string | null;
    profiles: { full_name: string | null } | null;
    projects: { name: string | null } | null;
  };

  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabaseAdmin
      .from('tasks')
      .select('id, title, assigned_to, due_date, created_at, updated_at, profiles(full_name), projects(name)')
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .range(from, from + PAGE - 1);
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  if (!rows.length) return empty;

  // Who has left: a task assigned to a switched-off account will never be done
  // by them, so it is the safest thing to clear.
  const assigneeIds = [...new Set(rows.map((r) => r.assigned_to).filter((id): id is string => !!id))];
  const gone = await disabledUserIds(assigneeIds);

  const today = new Date();
  const staleBefore = new Date(today.getTime() - STALE_DAYS * 24 * 3600_000).toISOString();

  const candidates: HygieneTask[] = [];
  const counts: Record<HygieneReason, number> = { assignee_gone: 0, stale: 0 };

  for (const r of rows) {
    const lastTouched = r.updated_at ?? r.created_at;
    let reason: HygieneReason | null = null;
    // Assignee gone takes priority — it is true regardless of age.
    if (r.assigned_to && gone.has(r.assigned_to)) reason = 'assignee_gone';
    else if (lastTouched < staleBefore) reason = 'stale';
    if (!reason) continue;

    counts[reason]++;
    candidates.push({
      id: r.id,
      title: r.title,
      assignee: r.profiles?.full_name ?? null,
      project: r.projects?.name ?? null,
      dueDate: r.due_date,
      ageDays: ageInDays(lastTouched, today),
      reason,
    });
  }

  // Oldest first within the list — the most obviously clearable at the top.
  candidates.sort((a, b) => b.ageDays - a.ageDays);

  return { total: rows.length, candidates, counts, staleDays: STALE_DAYS };
}

export interface CleanupResult {
  ok: boolean;
  reason?: string;
  closed: number;
}

/**
 * Clear the given tasks — set them to `cancelled`, not deleted, so the board
 * count drops but nothing is lost. Reversible from the board (task.reopen).
 * Only ever touches tasks that are still live, so a race with someone finishing
 * one by hand cannot undo their work.
 */
export async function closeStaleTasks(orgId: string, ids: string[], note = 'Cleared in board cleanup'): Promise<CleanupResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', closed: 0 };
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  if (!unique.length) return { ok: true, closed: 0 };

  const patch: Record<string, unknown> = { status: 'cancelled' };
  if (await hasTaskCompletion()) patch.completion_note = `${note} — ${pacificDate(0)}`;

  const { data, error } = await supabaseAdmin
    .from('tasks')
    .update(patch)
    .eq('org_id', orgId)
    .in('id', unique)
    .in('status', LIVE_STATUSES)
    .select('id');
  if (error) return { ok: false, reason: error.message, closed: 0 };

  const closed = data?.length ?? 0;
  if (closed) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: CLEANUP_ACTION,
      entity: 'tasks',
      meta: { closed, note },
    });
  }
  return { ok: true, closed };
}
