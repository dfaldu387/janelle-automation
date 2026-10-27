import { hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { deliveryAddressFor, isStudioMailbox } from '../lib/studioTeam.js';
import { pacificDate } from '../lib/pacificTime.js';
import { gmailFor, sendMessage, sentActivity } from './gmail.js';
import { teamActivityEmail } from './emailTemplate.js';
import { env } from '../env.js';

/**
 * The weekly per-person activity digest.
 *
 * The studio's first concern is where team time actually goes: people billing
 * hours the work does not seem to account for (Carissa walkthrough follow-up,
 * 2026-10-27). We cannot clock anyone — and we are blind to Drive, which needs
 * a broader Google scope than the studio has granted — but two real signals we
 * already hold say a lot when set side by side with a person's reported hours:
 *
 *   - how much they actually sent from their own mailbox this week, and
 *   - how their task load moved — completed, still open, overdue.
 *
 * So this is a reconciliation sheet, not a time clock: it surfaces the mismatch
 * ("billed the week, sent 4 emails, closed nothing") for a human to question,
 * and is explicit in the email that these are activity signals, not hours.
 * Owner-only, by design — it is staff-performance data.
 */

const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];
export const TEAM_ACTIVITY_ACTION = 'team_activity.sent';

export interface TeamActivityPerson {
  id: string;
  name: string;
  email: string;
  /** Whether their Gmail is connected — email signals are blank when it is not. */
  connected: boolean;
  /** Messages sent this window, or null when the mailbox is not connected. */
  emailsSent: number | null;
  /** True when the real number is higher than the cap we read. */
  emailsCapped: boolean;
  /** Distinct threads they sent into. */
  threads: number | null;
  /** When they last sent, ISO, or null. */
  lastSentAt: string | null;
  tasksCompleted: number;
  tasksOpen: number;
  tasksOverdue: number;
}

export interface TeamActivity {
  generatedAt: string;
  days: number;
  people: TeamActivityPerson[];
  /** Standing caveats shown with the report — kept honest about what it is not. */
  notes: string[];
}

export interface TeamActivityResult {
  ok: boolean;
  reason?: string;
  /** Owner addresses the digest was emailed to. */
  ownersSent: number;
  people: number;
}

/**
 * Compute the week's per-person activity. Reads Gmail live for each connected
 * teammate, so it is the slow part of the weekly job; safe to call on demand.
 */
export async function buildTeamActivity(orgId: string, days = 7): Promise<TeamActivity> {
  const notes = [
    'These are activity signals — emails sent and how task load moved — not a measure of hours worked.',
    'Google Drive edits are not included: seeing them needs a broader Google permission than the studio has granted.',
    'A blank email count means that person has not connected their Gmail, so their sent mail cannot be read.',
  ];
  if (!supabaseAdmin) return { generatedAt: new Date().toISOString(), days, people: [], notes };

  // The roster: real people with a sign-in address. A shared studio mailbox is
  // not a person whose time we are reconciling.
  const { data: profileRows } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const profiles = ((profileRows ?? []) as { id: string; full_name: string | null; email: string | null }[]).filter(
    (p) => p.email && p.email.includes('@') && !isStudioMailbox(p.email) && p.full_name,
  );
  if (!profiles.length) return { generatedAt: new Date().toISOString(), days, people: [], notes };

  const ids = profiles.map((p) => p.id);

  // Who can have their sent mail read.
  const connected = new Set<string>();
  const { data: integrations } = await supabaseAdmin
    .from('integrations')
    .select('user_id, status')
    .eq('provider', 'google')
    .in('user_id', ids);
  for (const row of (integrations ?? []) as { user_id: string; status: string }[]) {
    if (row.status === 'connected') connected.add(row.user_id);
  }

  // Task load. Live work, paged the way the board and the reminders page it, so
  // a studio over 1000 live tasks is not silently truncated.
  const today = pacificDate(0);
  const open = new Map<string, number>();
  const overdue = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabaseAdmin
      .from('tasks')
      .select('assigned_to, due_date')
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .range(from, from + PAGE - 1);
    const batch = (data ?? []) as { assigned_to: string | null; due_date: string | null }[];
    for (const t of batch) {
      if (!t.assigned_to) continue;
      open.set(t.assigned_to, (open.get(t.assigned_to) ?? 0) + 1);
      if (t.due_date && t.due_date < today) overdue.set(t.assigned_to, (overdue.get(t.assigned_to) ?? 0) + 1);
    }
    if (batch.length < PAGE) break;
  }

  // Finished inside the window. completed_at exists only once migration 0015 is
  // applied; before it, fall back to when the task last changed.
  const completion = await hasTaskCompletion();
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const done = new Map<string, number>();
  {
    const { data } = await supabaseAdmin
      .from('tasks')
      .select('assigned_to')
      .eq('org_id', orgId)
      .eq('status', 'done')
      .gte(completion ? 'completed_at' : 'updated_at', since);
    for (const t of (data ?? []) as { assigned_to: string | null }[]) {
      if (t.assigned_to) done.set(t.assigned_to, (done.get(t.assigned_to) ?? 0) + 1);
    }
  }

  const people: TeamActivityPerson[] = [];
  for (const p of profiles) {
    let emailsSent: number | null = null;
    let emailsCapped = false;
    let threads: number | null = null;
    let lastSentAt: string | null = null;
    if (connected.has(p.id)) {
      try {
        const gmail = await gmailFor(p.id);
        const act = gmail ? await sentActivity(gmail, days) : null;
        if (!act) throw new Error('no mailbox handle');
        emailsSent = act.sent;
        emailsCapped = act.capped;
        threads = act.threads;
        lastSentAt = act.lastSentAt;
      } catch (err) {
        // A mailbox we cannot read this run reads as "connected, unknown" — the
        // count stays null rather than a misleading zero.
        console.error(`[team-activity] sent read failed for ${p.email}:`, (err as Error).message);
      }
    }
    people.push({
      id: p.id,
      name: p.full_name as string,
      email: p.email as string,
      connected: connected.has(p.id),
      emailsSent,
      emailsCapped,
      threads,
      lastSentAt,
      tasksCompleted: done.get(p.id) ?? 0,
      tasksOpen: open.get(p.id) ?? 0,
      tasksOverdue: overdue.get(p.id) ?? 0,
    });
  }

  // Most open work first — the owner reads top-down, and the people carrying
  // the most are who the mismatch matters most for.
  people.sort((a, b) => b.tasksOpen - a.tasksOpen || b.tasksOverdue - a.tasksOverdue);

  return { generatedAt: new Date().toISOString(), days, people, notes };
}

/**
 * Build the week's digest and email it privately to the studio owner(s). Sent,
 * not drafted — it goes to the principal's own inbox, the same exception the
 * daily owner summary makes (see middayReminder). Silent when there is no one
 * to report on.
 */
export async function runTeamActivityDigest(orgId: string, days = 7): Promise<TeamActivityResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', ownersSent: 0, people: 0 };

  const report = await buildTeamActivity(orgId, days);
  if (!report.people.length) return { ok: true, ownersSent: 0, people: 0 };

  // Only a real person in the owner's seat, never the shared mailbox that can
  // hold it by mistake (see resolveSeatHolder / middayReminder).
  const { data: principalRows } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email')
    .eq('org_id', orgId)
    .eq('role', 'principal');
  const owners = ((principalRows ?? []) as { full_name: string | null; email: string | null }[]).filter(
    (p) => p.full_name && p.email && !isStudioMailbox(p.email),
  );
  if (!owners.length) return { ok: true, reason: 'no_owner', ownersSent: 0, people: report.people.length };

  const sender = await orgSourceUserId(orgId);
  const gmail = sender ? await gmailFor(sender) : null;
  if (!gmail) return { ok: false, reason: 'no_source_mailbox', ownersSent: 0, people: report.people.length };

  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/team` : undefined;

  let ownersSent = 0;
  for (const owner of owners) {
    const mail = teamActivityEmail({ name: owner.full_name as string, report, boardUrl });
    try {
      await sendMessage(gmail, {
        to: deliveryAddressFor(owner.email as string),
        subject: mail.subject,
        body: mail.text,
        html: mail.html,
      });
      ownersSent++;
    } catch (err) {
      console.error('[team-activity] owner digest failed:', (err as Error).message);
    }
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: TEAM_ACTIVITY_ACTION,
    entity: 'profiles',
    meta: { days, people: report.people.length, owners_sent: ownersSent },
  });

  return { ok: true, ownersSent, people: report.people.length };
}
