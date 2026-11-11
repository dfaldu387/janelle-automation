import { hasColumn, hasSubtasks } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { resolveSlack } from '../lib/slackSettings.js';
import { env } from '../env.js';
import { SlackError, postMessage, type SlackMessage } from './slack.js';
import { resolveFollowUps } from './followups.js';
import { JOIN_SCOPE_HINT, ROUTE_FALLBACK_CODES, channelFor, joinIfNeeded, loadDirectory, type ProjectRef } from './slackRouting.js';
import { logV1Skipped, remindersV1Enabled } from '../lib/remindersV1.js';

/**
 * The daily reminder, posted to the Slack channel.
 *
 * What the midday email does for each person, done once for the whole
 * studio where everyone can see it: what is overdue, what is due today,
 * what is blocked, who is carrying what, and which follow-ups are waiting
 * on someone. One message, led by the numbers, so it reads in a few seconds.
 *
 * Silent when there is nothing to say — a reminder that is always posted
 * teaches people to stop reading it (same reasoning as the email).
 */

const LIVE = ['open', 'in_progress', 'blocked'];
/** Rows shown per list before "+N more"; Slack caps a block's text at 3000 characters. */
const SHOW = 8;

/** Today's date in the studio's time zone — UTC would roll over mid-afternoon in California. */
function pacificToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

interface DigestTask {
  title: string;
  due: string | null;
  status: string;
  project: string | null;
  assignee: string | null;
  channel?: string | null;
}

interface DigestFollowUp {
  type: string;
  status: string;
  reason: string | null;
  project: string | null;
  vendor: string | null;
  channel?: string | null;
}

const FOLLOW_UP_TYPE: Record<string, string> = {
  vendor_silence: 'Vendor quiet',
  client_approval_overdue: 'Client approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
};

/** A bulleted list capped at SHOW rows, so a long backlog does not become a wall of text. */
function list(rows: string[]): string {
  const shown = rows.slice(0, SHOW).map((r) => `• ${r}`);
  if (rows.length > SHOW) shown.push(`_+${rows.length - SHOW} more in Janelle_`);
  return shown.join('\n');
}

function taskLine(t: DigestTask, today: string, withDue: boolean): string {
  const bits = [t.project, t.assignee ?? 'Unassigned'].filter(Boolean).map((s) => esc(s as string));
  const due = withDue && t.due ? ` (was due ${t.due < today ? t.due : 'today'})` : '';
  return `${esc(clip(t.title, 90))}${due} — ${bits.join(' · ')}`;
}

export function buildDigest(tasks: DigestTask[], followUps: DigestFollowUp[], today: string, boardUrl: string | null, heading = 'Daily task & follow-up reminder'): SlackMessage | null {
  if (!tasks.length && !followUps.length) return null;

  const overdue = tasks.filter((t) => t.due && t.due < today).sort((a, b) => (a.due as string).localeCompare(b.due as string));
  const dueToday = tasks.filter((t) => t.due === today);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const undated = tasks.filter((t) => !t.due);

  const byPerson = new Map<string, number>();
  for (const t of tasks) byPerson.set(t.assignee ?? 'Unassigned', (byPerson.get(t.assignee ?? 'Unassigned') ?? 0) + 1);
  const people = [...byPerson.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${esc(name)} ${n}`)
    .join('  ·  ');

  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: heading } },
    section(
      `:red_circle: *${overdue.length}* overdue   :large_orange_circle: *${dueToday.length}* due today   ` +
        `:no_entry_sign: *${blocked.length}* blocked   :bell: *${followUps.length}* follow-ups waiting   ` +
        `:white_circle: ${undated.length} with no date`,
    ),
  ];
  if (overdue.length) blocks.push(section(`*Overdue*\n${list(overdue.map((t) => taskLine(t, today, true)))}`));
  if (dueToday.length) blocks.push(section(`*Due today*\n${list(dueToday.map((t) => taskLine(t, today, false)))}`));
  if (blocked.length) blocks.push(section(`*Blocked*\n${list(blocked.map((t) => taskLine(t, today, false)))}`));
  if (followUps.length) {
    blocks.push(
      section(
        `*Follow-ups waiting*\n${list(
          followUps.map((f) => {
            const who = [f.vendor, f.project].filter(Boolean).map((s) => esc(s as string)).join(' · ');
            const what = f.reason ? clip(f.reason, 90) : FOLLOW_UP_TYPE[f.type] ?? 'Follow-up';
            return `${esc(what)}${who ? ` — ${who}` : ''}${f.status === 'drafted' ? ' _(draft ready)_' : ''}`;
          }),
        )}`,
      ),
    );
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*Open work by person:* ${people}` }] });
  if (boardUrl) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the task board' }, url: boardUrl }],
    });
  }

  return {
    text: `${heading}: ${overdue.length} overdue, ${dueToday.length} due today, ${followUps.length} follow-ups waiting`,
    blocks,
  };
}

export interface SlackDigestResult {
  ok: boolean;
  /** Projects whose own channel also got a reminder. */
  projectPosts?: number;
  warnings?: string[];
  skipped?: 'not_connected' | 'paused' | 'off' | 'nothing_to_report';
  tasks: number;
  followUps: number;
  error?: string;
}

export async function runSlackDigest(orgId: string): Promise<SlackDigestResult> {
  if (!supabaseAdmin) return { ok: false, tasks: 0, followUps: 0, error: 'supabase_not_configured' };

  const slack = await resolveSlack(orgId);
  if (!slack.connected || !slack.token) return { ok: true, skipped: 'not_connected', tasks: 0, followUps: 0 };
  if (!slack.config.enabled) return { ok: true, skipped: 'paused', tasks: 0, followUps: 0 };
  if (!slack.config.dailyDigest) return { ok: true, skipped: 'off', tasks: 0, followUps: 0 };

  // Close what has already been dealt with before listing what is waiting —
  // a task finished, a vendor who replied, a nudge sent by hand — so the
  // reminder never chases something that is done. The nightly scan does this
  // too, but a reminder at 9am should not rely on last night's.
  try {
    await resolveFollowUps(orgId);
  } catch (err) {
    console.error('[slack] follow-up clean-up before the reminder failed:', (err as Error).message);
  }

  const db = supabaseAdmin;
  const [subtasks, snoozable] = await Promise.all([hasSubtasks(), hasColumn('follow_ups', 'snoozed_until')]);

  const projectChannels = await hasColumn('projects', 'slack_channel');
  const proj = projectChannels ? 'projects(name, slack_channel)' : 'projects(name)';

  let tq = db
    .from('tasks')
    .select(`title, due_date, status, ${proj}, profiles(full_name)`)
    .eq('org_id', orgId)
    .in('status', LIVE);
  // A subtask is a step inside its parent, not a line of its own.
  if (subtasks) tq = tq.is('parent_task_id', null);

  let fq = db
    .from('follow_ups')
    .select(`type, status, reason, ${proj}, vendors(name)`)
    .eq('org_id', orgId)
    .in('status', ['open', 'drafted']);
  // Snoozed on purpose: not waiting on anyone until it wakes.
  if (snoozable) fq = fq.or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`);

  const [{ data: taskRows, error: te }, { data: fuRows, error: fe }] = await Promise.all([tq, fq]);
  if (te || fe) throw new Error((te ?? fe)!.message);

  // v2: with v1 reminders off, the briefing keeps its follow-ups and drops
  // the task lists (overdue, due today, blocked, who is carrying what).
  const v1On = await remindersV1Enabled(orgId);
  if (!v1On) logV1Skipped('slackDigest task lists');
  const tasks = ((v1On ? taskRows ?? [] : []) as unknown as {
    title: string; due_date: string | null; status: string;
    projects: { name: string; slack_channel?: string | null } | null; profiles: { full_name: string | null } | null;
  }[]).map((t) => ({
    title: t.title, due: t.due_date, status: t.status,
    project: t.projects?.name ?? null, assignee: t.profiles?.full_name ?? null,
    channel: t.projects?.slack_channel ?? null,
  }));
  const followUps = ((fuRows ?? []) as unknown as {
    type: string; status: string; reason: string | null;
    projects: { name: string; slack_channel?: string | null } | null; vendors: { name: string } | null;
  }[]).map((f) => ({
    type: f.type, status: f.status, reason: f.reason,
    project: f.projects?.name ?? null, vendor: f.vendors?.name ?? null,
    channel: f.projects?.slack_channel ?? null,
  }));

  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const message = buildDigest(tasks, followUps, pacificToday(), appUrl ? `${appUrl}/tasks` : null);
  if (!message) return { ok: true, skipped: 'nothing_to_report', tasks: 0, followUps: 0 };

  try {
    await postMessage(slack.token, slack.config.channel, message);
  } catch (err) {
    const msg = err instanceof SlackError ? err.message : (err as Error).message;
    console.error('[slack] daily digest failed:', msg);
    return { ok: false, tasks: tasks.length, followUps: followUps.length, error: msg };
  }

  // Each project's own slice, to its own channel. Best effort: the studio-wide
  // message above has already gone out, so a failure here is reported, not fatal.
  const warnings: string[] = [];
  let projectPosts = 0;
  try {
    const names = new Set([...tasks, ...followUps].map((x) => x.project).filter((n): n is string => !!n));
    if (names.size) {
      const dir = await loadDirectory(slack.token);
      if (dir.missingScope) warnings.push('Add channels:read and groups:read to the Slack app so projects can be matched to their channels.');
      for (const name of names) {
        const pt = tasks.filter((t) => t.project === name);
        const pf = followUps.filter((f) => f.project === name);
        const ref: ProjectRef = { name, slack_channel: pt[0]?.channel ?? pf[0]?.channel ?? null };
        const channel = channelFor(ref, dir, slack.config.channel);
        // Already in the default channel's studio-wide message.
        if (channel === slack.config.channel) continue;
        const msg = buildDigest(pt, pf, pacificToday(), appUrl ? `${appUrl}/tasks` : null, `${name} — daily reminder`);
        if (!msg) continue;
        try {
          const joined = await joinIfNeeded(slack.token, channel, dir);
          if (joined === 'missing_scope' && !warnings.includes(JOIN_SCOPE_HINT)) warnings.push(JOIN_SCOPE_HINT);
          await postMessage(slack.token, channel, msg);
          projectPosts++;
        } catch (err) {
          if (err instanceof SlackError && ROUTE_FALLBACK_CODES.includes(err.code)) {
            warnings.push(`The bot could not post in the channel for ${name} (${channel}). In Slack, run /invite on that channel.`);
          } else {
            warnings.push(`${name}: ${(err as Error).message}`);
          }
        }
        await new Promise((r) => setTimeout(r, 1100)); // Slack allows about one post a second per channel
      }
    }
  } catch (err) {
    warnings.push((err as Error).message);
  }
  if (warnings.length) console.error('[slack] project reminders:', warnings.join(' | '));

  await db.from('activity_log').insert({
    org_id: orgId,
    action: 'slack_digest.sent',
    entity: 'tasks',
    meta: { tasks: tasks.length, follow_ups: followUps.length, project_posts: projectPosts },
  });
  return { ok: true, tasks: tasks.length, followUps: followUps.length, projectPosts, warnings };
}
