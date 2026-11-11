import { hasSubtasks, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { resolveSlack, type ReportChannels } from '../lib/slackSettings.js';
import { pacificDate, pacificDayStart, pacificHourNow } from '../lib/pacificTime.js';
import { env } from '../env.js';
import { SlackError, postMessage, type SlackMessage } from './slack.js';
import { joinIfNeeded, loadDirectory, type ChannelDirectory } from './slackRouting.js';
import { logV1Skipped, remindersV1Enabled } from '../lib/remindersV1.js';

/**
 * The task report, one message per channel, three times a day (9am, midday
 * and 5pm Pacific):
 *
 *   completed  what was finished yesterday and today
 *   pending    what is still open and due today or tomorrow
 *   overdue    what is still open and past its date
 *
 * This replaced announcing every task as its own message, which put a
 * hundred-odd posts a day into one channel, most of them long overdue. A
 * report that has nothing in it is not posted — three "nothing to say"
 * messages a day teach people to stop reading the channel.
 */

const LIVE = ['open', 'in_progress', 'blocked'];
/** Rows per report before "+N more"; Slack caps a section's text at 3000 characters. */
const SHOW = 25;

export type ReportKind = keyof ReportChannels;

interface ReportTask {
  title: string;
  due: string | null;
  status: string;
  project: string | null;
  assignee: string | null;
  completedAt: string | null;
}

export interface SlackReportResult {
  ok: boolean;
  skipped?: 'not_connected' | 'paused' | 'no_channels' | 'v1_reminders_disabled';
  /** Tasks in each report, and whether it was posted. */
  reports: { kind: ReportKind; channel: string; tasks: number; posted: boolean; error?: string }[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** "3 days", "1 day" — how far past its date an overdue task is. */
function daysLate(due: string, today: string): string {
  const n = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86_400_000);
  return `${n} day${n === 1 ? '' : 's'}`;
}

function slotName(hour = pacificHourNow()): string {
  if (hour < 11) return 'Morning';
  if (hour < 15) return 'Midday';
  return 'End of day';
}

function line(t: ReportTask, lead: string): string {
  const who = [t.project, t.assignee ?? 'Unassigned'].filter(Boolean).map((s) => esc(s as string)).join(' · ');
  return `• ${lead ? `*${lead}*  ` : ''}${esc(clip(t.title, 90))} — ${who}`;
}

function message(kind: ReportKind, rows: ReportTask[], today: string, boardUrl: string | null): SlackMessage {
  const heading = {
    completed: `✅ Completed yesterday & today — ${rows.length}`,
    pending: `🕒 Due today & tomorrow — ${rows.length}`,
    overdue: `⚠️ Overdue — ${rows.length}`,
  }[kind];
  const lead = (t: ReportTask) =>
    kind === 'overdue' ? daysLate(t.due as string, today)
      : kind === 'pending' ? (t.due === today ? 'Today' : 'Tomorrow')
      : '';
  const shown = rows.slice(0, SHOW).map((t) => line(t, lead(t)));
  if (rows.length > SHOW) shown.push(`_+${rows.length - SHOW} more in Janelle_`);

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: shown.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${slotName()} report · ${today}` }] },
  ];
  if (boardUrl) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the task board' }, url: boardUrl }] });
  }
  return { text: heading, blocks };
}

async function readTasks(orgId: string): Promise<Record<ReportKind, ReportTask[]>> {
  const db = supabaseAdmin!;
  const today = pacificDate();
  const tomorrow = pacificDate(1);
  const [subtasks, completion] = await Promise.all([hasSubtasks(), hasTaskCompletion()]);
  // Midnight Pacific yesterday: "completed yesterday and today".
  const since = new Date(pacificDayStart().getTime() - 86_400_000).toISOString();
  const completedField = completion ? 'completed_at' : 'updated_at';
  const cols = `title, due_date, status, ${completedField}, projects(name), profiles(full_name)`;

  let doneQ = db.from('tasks').select(cols).eq('org_id', orgId).eq('status', 'done').gte(completedField, since);
  let liveQ = db.from('tasks').select(cols).eq('org_id', orgId).in('status', LIVE).not('due_date', 'is', null).lte('due_date', tomorrow);
  // A subtask is a step inside its parent, not a line of its own.
  if (subtasks) {
    doneQ = doneQ.is('parent_task_id', null);
    liveQ = liveQ.is('parent_task_id', null);
  }
  const [done, live] = await Promise.all([doneQ, liveQ]);
  if (done.error || live.error) throw new Error((done.error ?? live.error)!.message);

  const map = (r: Record<string, unknown>): ReportTask => ({
    title: String(r.title ?? ''),
    due: (r.due_date as string | null) ?? null,
    status: String(r.status),
    project: (r.projects as { name: string } | null)?.name ?? null,
    assignee: (r.profiles as { full_name: string | null } | null)?.full_name ?? null,
    completedAt: (r[completedField] as string | null) ?? null,
  });
  const doneRows = ((done.data ?? []) as unknown as Record<string, unknown>[]).map(map)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const liveRows = ((live.data ?? []) as unknown as Record<string, unknown>[]).map(map);

  return {
    completed: doneRows,
    // Today before tomorrow.
    pending: liveRows.filter((t) => (t.due as string) >= today).sort((a, b) => (a.due as string).localeCompare(b.due as string)),
    // Most recently due first: what slipped yesterday is the one still worth chasing today.
    overdue: liveRows.filter((t) => (t.due as string) < today).sort((a, b) => (b.due as string).localeCompare(a.due as string)),
  };
}

/** Post the three reports to their channels. A channel left blank in Settings is skipped. */
export async function runSlackReport(orgId: string): Promise<SlackReportResult> {
  if (!supabaseAdmin) return { ok: false, reports: [] };
  // Every report here is a task list, so the whole job stands down.
  if (!(await remindersV1Enabled(orgId))) {
    logV1Skipped('slackReport');
    return { ok: true, skipped: 'v1_reminders_disabled', reports: [] };
  }

  const slack = await resolveSlack(orgId);
  if (!slack.token) return { ok: true, skipped: 'not_connected', reports: [] };
  if (!slack.config.enabled) return { ok: true, skipped: 'paused', reports: [] };
  const channels = slack.config.reportChannels;
  const kinds = (['completed', 'pending', 'overdue'] as const).filter((k) => channels[k]);
  if (!kinds.length) return { ok: true, skipped: 'no_channels', reports: [] };

  const tasks = await readTasks(orgId);
  const today = pacificDate();
  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : null;

  let dir: ChannelDirectory | undefined;
  const reports: SlackReportResult['reports'] = [];
  for (const kind of kinds) {
    const channel = channels[kind];
    const rows = tasks[kind];
    if (!rows.length) {
      reports.push({ kind, channel, tasks: 0, posted: false });
      continue;
    }
    const msg = message(kind, rows, today, boardUrl);
    try {
      try {
        await postMessage(slack.token, channel, msg);
      } catch (err) {
        // A public channel the bot was never added to: join it and try once more.
        if (!(err instanceof SlackError) || err.code !== 'not_in_channel') throw err;
        dir ??= await loadDirectory(slack.token);
        if ((await joinIfNeeded(slack.token, channel, dir)) !== 'joined') throw err;
        await postMessage(slack.token, channel, msg);
      }
      reports.push({ kind, channel, tasks: rows.length, posted: true });
    } catch (err) {
      const error = err instanceof SlackError ? err.message : (err as Error).message;
      console.error(`[slack] ${kind} report to #${channel} failed:`, error);
      reports.push({ kind, channel, tasks: rows.length, posted: false, error });
    }
    await new Promise((r) => setTimeout(r, 1100)); // about one post a second
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'slack_report.sent',
    entity: 'tasks',
    meta: { reports: reports.map((r) => ({ kind: r.kind, tasks: r.tasks, posted: r.posted })) },
  });
  return { ok: reports.every((r) => !r.error), reports };
}
