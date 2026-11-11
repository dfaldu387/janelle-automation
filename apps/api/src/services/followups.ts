import { DEFAULT_SLA, TASK_HYGIENE_SEAT, type FollowUpType, type SlaSettings } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn, hasDraftGmailMessage, hasDraftOwner, hasEmailOwner } from '../lib/columns.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { generate, isAiReady } from './anthropic.js';
import { createDraft, gmailFor, gmailForReply, readSentMail, type DraftContent } from './gmail.js';
import { isStudioAddress } from '../lib/studioTeam.js';
import { logV1Skipped, remindersV1Enabled } from '../lib/remindersV1.js';

/**
 * The nudges that are chasing a person for a response, and are therefore
 * answered by one arriving.
 *
 * The internal ones are not here on purpose: a reminder that Joanna's task
 * is overdue is not settled by Joanna sending an email, only by the work
 * being done — and `causeIsGone` already closes those with their task.
 */
const REPLYABLE_TYPES: FollowUpType[] = [
  'vendor_silence',
  'date_slipping',
  'quote_overdue',
  'client_approval_overdue',
];

export interface FollowUpResult {
  ok: boolean;
  reason?: string;
  raised: number;
  drafted: number;
  /** Follow-ups the engine closed before raising anything new. */
  resolved?: number;
}

interface Trigger {
  type: FollowUpType;
  projectId: string | null;
  vendorId: string | null;
  target: string | null;
  reason: string;
  context: string;
  /** Set for the internal reminders, so one task raises one nudge. */
  taskId?: string;
  /**
   * Whether this counts as having reminded the owner about the deadline.
   *
   * Hygiene nudges do not: being told a task has no next step is not the
   * same as having been chased for being late, and escalation keys off the
   * reminder count. Without this a single "add a due date" note would make
   * the next genuine miss escalate straight to the principal.
   */
  countsAsReminder?: boolean;
}

/**
 * The things every task must answer before it is a task at all.
 *
 * The studio's Tasks SOP requires one owner, a due date and a next step;
 * the PM support seat owns "pushing tasks so each has ONE owner, a due date
 * and a next step". Until now the follow-up engine only chased work that
 * was LATE, so a task that was never properly formed sat there indefinitely
 * — it cannot be late when it has no date.
 */
const HYGIENE: { type: FollowUpType; missing: string }[] = [
  { type: 'task_unowned', missing: 'nobody owns it' },
  { type: 'task_no_next_step', missing: 'it has no next step' },
  { type: 'task_no_due_date', missing: 'it has no due date' },
];

/** Every follow-up type that goes to a colleague rather than out of the studio. */
const INTERNAL_TYPES: FollowUpType[] = [
  'task_overdue', 'task_escalation', 'task_unowned', 'task_no_next_step', 'task_no_due_date',
];

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Compose a nudge body via Claude, with a plain-text fallback. */
async function draftBody(t: Trigger): Promise<{ subject: string; body: string }> {
  const SUBJECTS: Partial<Record<FollowUpType, string>> = {
    client_approval_overdue: 'Quick follow-up on your approval',
    vendor_silence: 'Following up on our order',
    // Proactive, not apologetic: the client should hear from us first.
    quote_overdue: 'An update on your quote',
    client_waiting: 'An update on your request',
    task_overdue: 'A reminder on something assigned to you',
    task_escalation: 'Still open after a reminder',
    task_unowned: 'This task needs an owner',
    task_no_next_step: 'This task needs a next step',
    task_no_due_date: 'This task needs a due date',
  };
  const subject = SUBJECTS[t.type] ?? 'Checking in on timing';

  if (!(await isAiReady())) {
    return {
      subject,
      body: `Hi,\n\nJust following up regarding ${t.context}. ${t.reason} Could you share an update when you have a moment?\n\nThank you,\nJanelle Interiors`,
    };
  }
  // A teammate gets a colleague's nudge, not a client-facing letter.
  const internal = INTERNAL_TYPES.includes(t.type);
  const body = await generate(
    internal
      ? 'You write brief internal reminders between colleagues at a small interior design studio. One short paragraph, plain and matter-of-fact, never scolding — the point is to unblock the work, not to tell someone off. Ask if anything is in the way. No placeholders, sign off as "Janelle Interiors".'
      : 'You write short, warm, professional follow-up emails for an interior design studio. 2 short paragraphs, no placeholders, sign off as "Janelle Interiors".',
    `Write a follow-up email. Situation: ${t.reason} Context: ${t.context}`,
    { feature: 'followup.draft' },
    800,
  );
  return { subject, body };
}

interface Recipient {
  to: string;
  cc: string[];
  threadId: string | null;
  subject: string | null;
  /** Whose personal mailbox this thread lives in, when it is not the shared one. */
  ownerId: string | null;
}

/**
 * Resolve the best recipient + thread for a follow-up from the most
 * recent ingested email for a vendor or project — reusing the same
 * extracted correspondent + CC data the auto-reply drafts use.
 */
async function resolveRecipient(
  orgId: string,
  key: { vendorId?: string | null; projectId?: string | null; preferClass?: string },
): Promise<Recipient | null> {
  if (!supabaseAdmin) return null;
  const withOwner = await hasEmailOwner();
  let q = supabaseAdmin
    .from('emails')
    .select(`thread_id, subject, extracted_json${withOwner ? ', owner_id' : ''}`)
    .eq('org_id', orgId)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(1);
  if (key.vendorId) q = q.eq('vendor_id', key.vendorId);
  else if (key.projectId) q = q.eq('project_id', key.projectId);
  else return null;
  if (key.preferClass) q = q.eq('class', key.preferClass);

  const { data } = await q;
  const e = data?.[0] as
    | {
        thread_id: string | null; subject: string | null; owner_id?: string | null;
        extracted_json: { reply_to_email?: string; cc_emails?: string[] } | null;
      }
    | undefined;
  const ex = e?.extracted_json ?? {};
  const to = (ex.reply_to_email ?? '').toLowerCase();
  if (!to.includes('@')) return null;
  const cc = (ex.cc_emails ?? []).map((c) => c.toLowerCase()).filter((a) => a.includes('@') && a !== to);
  return { to, cc, threadId: e?.thread_id ?? null, subject: e?.subject ?? null, ownerId: e?.owner_id ?? null };
}

// ────────────────────────────────────────────────────────────
//  Closing what has already been answered
//
//  The page tells you to review the draft, edit it in Gmail and send it —
//  and then nothing watched Gmail, so the only way a follow-up ever left the
//  queue was somebody pressing Done. A nudge sent by hand, a vendor who
//  replied, a PO that arrived, a task someone finished: all of it left the
//  row sitting under "Awaiting your review" with a draft nobody needed any
//  more. Every one of those is a fact the system already holds, or can read.
// ────────────────────────────────────────────────────────────

interface OpenFollowUp {
  id: string;
  type: FollowUpType;
  target: string | null;
  project_id: string | null;
  vendor_id: string | null;
  task_id: string | null;
  draft_id: string | null;
  created_at: string;
}

/** Ids of the given set whose linked row says the reason is gone. */
async function causeIsGone(orgId: string, rows: OpenFollowUp[]): Promise<Set<string>> {
  const done = new Set<string>();
  if (!supabaseAdmin) return done;

  // A task-linked nudge dies with its task: nothing to chase once it is
  // closed, and the queue was keeping the reminder alive past the work.
  const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
  if (taskIds.length) {
    const { data: closed } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .in('id', taskIds)
      .in('status', ['done', 'cancelled']);
    const closedIds = new Set((closed ?? []).map((t) => (t as { id: string }).id));
    for (const r of rows) if (r.task_id && closedIds.has(r.task_id)) done.add(r.id);
  }

  // A chase about an order stops when the order lands or is called off, and
  // when a slipped date has been moved to a date still ahead of us.
  const poRows = rows.filter((r) => r.type === 'vendor_silence' || r.type === 'date_slipping');
  if (poRows.length) {
    const today = todayIso();
    for (const r of poRows) {
      let q = supabaseAdmin
        .from('purchase_orders')
        .select('id, status, eta')
        .eq('org_id', orgId);
      if (r.vendor_id) q = q.eq('vendor_id', r.vendor_id);
      if (r.project_id) q = q.eq('project_id', r.project_id);
      const { data: pos } = await q;
      const live = (pos ?? []) as { status: string; eta: string | null }[];
      if (!live.length) continue;
      const stillWaiting = live.some((p) =>
        r.type === 'vendor_silence'
          ? p.status === 'placed'
          : !['received', 'cancelled'].includes(p.status) && !!p.eta && p.eta < today,
      );
      if (!stillWaiting) done.add(r.id);
    }
  }

  // They answered.
  //
  // Everything above asks whether the STATE has changed — the order landed,
  // the gap was filled, the stage moved on. None of that happens the moment
  // a supplier writes back, so a vendor who replied on Tuesday with "the
  // quote is coming Friday" kept being chased for silence all week, and the
  // studio learned to ignore the queue. A reply is the answer the nudge was
  // asking for, whatever the paperwork says afterwards.
  //
  // Inbound only, and only after the nudge was raised: the studio's own
  // outgoing mail is not the vendor answering, and mail that arrived before
  // the nudge is what the nudge was raised in spite of.
  const chasing = rows.filter(
    (r) => REPLYABLE_TYPES.includes(r.type) && (r.vendor_id || r.project_id),
  );
  for (const r of chasing) {
    if (done.has(r.id)) continue;
    try {
      let q = supabaseAdmin
        .from('emails')
        .select('id, from_addr')
        .eq('org_id', orgId)
        .gt('received_at', r.created_at)
        .limit(20);
      // A vendor nudge is answered by that vendor; a client one by anybody
      // writing about that job, since the approval can come from any of them.
      if (r.vendor_id) q = q.eq('vendor_id', r.vendor_id);
      else if (r.project_id) q = q.eq('project_id', r.project_id);
      const { data: replies } = await q;
      const answered = ((replies ?? []) as { from_addr: string | null }[]).some(
        (e) => e.from_addr && !isStudioAddress(e.from_addr),
      );
      if (answered) done.add(r.id);
    } catch (err) {
      // Never let this turn a working scan into a failed one: the worst case
      // is a nudge that stays open one more night.
      console.error('[followups] reply check failed:', (err as Error).message);
    }
  }

  // A spec gap that has been filled in, and a project that has moved on from
  // waiting for the client.
  for (const r of rows) {
    if (r.type === 'spec_gap' && r.project_id) {
      const { data: gaps } = await supabaseAdmin
        .from('spec_gaps')
        .select('id')
        .eq('project_id', r.project_id)
        .eq('resolved', false)
        .limit(1);
      if (!gaps?.length) done.add(r.id);
    }
    if (r.type === 'client_approval_overdue' && r.project_id) {
      const { data: project } = await supabaseAdmin
        .from('projects')
        .select('stage')
        .eq('id', r.project_id)
        .maybeSingle();
      if (project && (project as { stage: string }).stage !== 'approval') done.add(r.id);
    }
  }

  return done;
}

/**
 * Close the follow-ups that have already been answered, and drop the drafts
 * they were waiting on. Runs before the engine raises anything, so a nudge
 * is never re-drafted for something that has since been dealt with.
 */
export async function resolveFollowUps(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  const { data } = await supabaseAdmin
    .from('follow_ups')
    .select('id, type, target, project_id, vendor_id, task_id, draft_id, created_at')
    .eq('org_id', orgId)
    .in('status', ['open', 'drafted']);
  const rows = (data ?? []) as unknown as OpenFollowUp[];
  if (!rows.length) return 0;

  const done = await causeIsGone(orgId, rows);

  // Someone outside the studio wrote back after we raised it.
  //
  // Matched two ways, because a vendor rarely replies from the address on
  // the quote: the exact address we nudged closes any follow-up, and for
  // vendor_silence — where the claim is literally "they have gone quiet" —
  // any mail at all from that vendor is enough to disprove it.
  const oldest = rows.reduce((min, r) => (r.created_at < min ? r.created_at : min), rows[0].created_at);
  const { data: replies } = await supabaseAdmin
    .from('emails')
    .select('from_addr, vendor_id, received_at')
    .eq('org_id', orgId)
    .gte('received_at', oldest);
  for (const row of (replies ?? []) as { from_addr: string | null; vendor_id: string | null; received_at: string | null }[]) {
    if (!row.received_at) continue;
    const from = (row.from_addr ?? '').toLowerCase();
    for (const r of rows) {
      if (row.received_at <= r.created_at) continue;
      const sameAddress = !!from && r.target?.toLowerCase() === from;
      const sameVendor = r.type === 'vendor_silence' && !!r.vendor_id && row.vendor_id === r.vendor_id;
      if (sameAddress || sameVendor) done.add(r.id);
    }
  }

  // And the case this whole pass exists for: the studio sent the nudge from
  // Gmail instead of pressing Done. Only worth a round trip when something
  // is still open and addressed to somebody.
  const sent = new Set<string>();
  const stillOpen = rows.filter((r) => !done.has(r.id) && r.target);
  if (stillOpen.length) {
    try {
      const userId = await orgSourceUserId(orgId);
      const gmail = userId ? await gmailFor(userId) : null;
      if (gmail) {
        const oldest = stillOpen.reduce((min, r) => (r.created_at < min ? r.created_at : min), stillOpen[0].created_at);
        const days = Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400_000) + 1;
        const { byAddress: writtenTo } = await readSentMail(gmail, Math.min(days, 30));
        for (const r of stillOpen) {
          const when = writtenTo.get((r.target ?? '').toLowerCase());
          if (when && when > r.created_at) sent.add(r.id);
        }
      }
    } catch (err) {
      // No Google connection, an expired token, a rate limit: the rest of
      // the resolution still stands.
      console.error('[followups] sent-mail check failed', (err as Error).message);
    }
  }

  const changes: { ids: string[]; status: 'done' | 'sent' }[] = [
    { ids: [...done], status: 'done' },
    { ids: [...sent], status: 'sent' },
  ];
  let resolved = 0;
  for (const { ids, status } of changes) {
    if (!ids.length) continue;
    await supabaseAdmin.from('follow_ups').update({ status }).in('id', ids);
    resolved += ids.length;

    // The draft was a suggestion for a message that has now been sent, or is
    // no longer needed. Leaving it in Drafts is how that page filled with
    // answers to conversations that had already moved on.
    const draftIds = rows
      .filter((r) => ids.includes(r.id) && r.draft_id)
      .map((r) => r.draft_id as string);
    if (draftIds.length) await supabaseAdmin.from('drafts').delete().in('id', draftIds);
  }

  if (resolved) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'followups.resolved',
      entity: 'follow_ups',
      meta: { done: done.size, sent: sent.size },
    });
  }
  return resolved;
}

/**
 * Close the nudges about one task, the moment that task is finished.
 *
 * `resolveFollowUps` already knows a task-linked nudge dies with its task,
 * but it is a whole-org sweep — every open follow-up, plus a read of the
 * mailbox — and it only runs on the ingest and task-review passes. So
 * ticking a task off left its escalation sitting on Top Priority Actions
 * for up to an hour, still saying the work was "still open". The studio
 * reasonably read that as the page being wrong, because it was.
 *
 * This is the same rule applied to one task and nothing else: two queries,
 * cheap enough to run on every completion, including the thirty in a row
 * somebody files on a Monday morning. The sweep stays as it is and remains
 * the thing that catches everything else.
 */
export async function resolveFollowUpsForTask(orgId: string, taskId: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  const { data } = await supabaseAdmin
    .from('follow_ups')
    .select('id, draft_id')
    .eq('org_id', orgId)
    .eq('task_id', taskId)
    .in('status', ['open', 'drafted']);
  const rows = (data ?? []) as { id: string; draft_id: string | null }[];
  if (!rows.length) return 0;

  await supabaseAdmin
    .from('follow_ups')
    .update({ status: 'done' })
    .in('id', rows.map((r) => r.id));

  // Same reasoning as the sweep: a drafted chase about finished work is an
  // answer to a conversation that has moved on, and Drafts fills up with
  // them if they are left behind.
  const draftIds = rows.map((r) => r.draft_id).filter((id): id is string => !!id);
  if (draftIds.length) await supabaseAdmin.from('drafts').delete().in('id', draftIds);

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'followups.resolved',
    entity: 'follow_ups',
    meta: { done: rows.length, sent: 0, task_id: taskId, reason: 'task closed' },
  });
  return rows.length;
}

/**
 * Scan an org for overdue/quiet items, raise follow-ups (deduped), and
 * draft Gmail messages where a recipient is known. Nothing is sent.
 */
export async function runFollowUps(orgId: string): Promise<FollowUpResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', raised: 0, drafted: 0 };

  // Clear the answered ones first: the dedupe below skips a trigger that
  // already has an open follow-up, so a stale row would otherwise suppress
  // the fresh nudge the studio actually needs.
  const resolved = await resolveFollowUps(orgId);

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  const settings = (org?.settings ?? {}) as Partial<SlaSettings>;
  const sla: SlaSettings = { ...DEFAULT_SLA, ...settings };
  const vendorDays = sla.vendor_silence_days;
  const clientDays = sla.client_approval_days;

  const triggers: Trigger[] = [];

  // v2: sections 0, 0b and 0c raise follow-ups from TASKS (quote overdue,
  // client waiting, overdue/escalation/hygiene nudges) — v1 reminders, behind
  // the off-switch. Sections 1–4 come from POs and projects and keep running.
  const v1On = await remindersV1Enabled(orgId);
  if (!v1On) logV1Skipped('followups task-based triggers (sections 0, 0b, 0c)');

  // 0. Quote SLA — the studio's sharpest pain point: a quote request that
  //    sits too long, where the client is left guessing. The rule is to tell
  //    the client something before they have to ask.
  const { data: staleQuotes } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id, vendor_id, created_at, projects(name, client_name)')
    .eq('org_id', orgId)
    .eq('kind', 'quote_request')
    .in('status', ['open', 'in_progress', 'blocked'])
    .lt('created_at', daysAgoIso(sla.quote_response_days));
  for (const t of v1On ? staleQuotes ?? [] : []) {
    const proj = (t as { projects?: { name?: string; client_name?: string } }).projects;
    triggers.push({
      type: 'quote_overdue',
      projectId: (t as { project_id: string | null }).project_id,
      vendorId: (t as { vendor_id: string | null }).vendor_id,
      target: null,
      reason: `A quote request has been open more than ${sla.quote_response_days} days; the client should be told where it stands.`,
      context: `${(t as { title: string }).title}${proj?.client_name ? ` — ${proj.client_name}` : ''}`,
    });
  }

  // 0b. Client waiting — someone owes the client a reply. Internal nudge only.
  const waitingCutoff = new Date(Date.now() - sla.client_waiting_hours * 3600_000).toISOString();
  const { data: waiting } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id, created_at, projects(name, client_name)')
    .eq('org_id', orgId)
    .eq('kind', 'client_approval')
    .in('status', ['open', 'in_progress', 'blocked'])
    .lt('created_at', waitingCutoff);
  for (const t of v1On ? waiting ?? [] : []) {
    const proj = (t as { projects?: { name?: string; client_name?: string } }).projects;
    triggers.push({
      type: 'client_waiting',
      projectId: (t as { project_id: string | null }).project_id,
      vendorId: null,
      target: null,
      reason: `The client has been waiting over ${sla.client_waiting_hours} hours for a response.`,
      context: `${(t as { title: string }).title}${proj?.client_name ? ` — ${proj.client_name}` : ''}`,
    });
  }

  // Whoever holds the seat that owns task hygiene, so a malformed task has
  // somewhere to go even when nobody owns the task itself. Resolved once per
  // run rather than per task.
  let hygieneEmail: string | null = null;
  if (await hasSeatColumn()) {
    const { data: hygieneHolder } = await supabaseAdmin
      .from('profiles')
      .select('full_name, email')
      .eq('org_id', orgId)
      .eq('seat', TASK_HYGIENE_SEAT)
      .limit(1)
      .maybeSingle();
    hygieneEmail = (hygieneHolder as { email?: string | null } | null)?.email ?? null;
  }

  // 0c. Internal reminders — the studio's own people, not vendors or clients.
  //     A task that has gone past its due date gets its owner nudged; if the
  //     nudge has already been sent and the task is still sitting there, the
  //     principal is told instead. Repeats on a cadence rather than nightly.
  const today = todayIso();
  const { data: liveTasks } = await supabaseAdmin
    .from('tasks')
    .select('id, title, kind, status, due_date, next_step, created_at, reminded_at, reminder_count, assigned_to, project_id, vendor_id, projects(name), profiles(full_name, email)')
    .eq('org_id', orgId)
    .in('status', ['open', 'in_progress', 'blocked']);

  for (const row of v1On ? liveTasks ?? [] : []) {
    const t = row as unknown as {
      id: string; title: string; status: string; due_date: string | null; next_step: string | null; created_at: string;
      reminded_at: string | null; reminder_count: number; assigned_to: string | null;
      project_id: string | null; vendor_id: string | null;
      projects: { name: string } | null;
      profiles: { full_name: string | null; email: string | null } | null;
    };

    // "Overdue" means past a stated due date, or blocked, or simply old with
    // no date on it at all — otherwise a task with no deadline never surfaces.
    const ageDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / 86400_000);
    const overdue =
      (t.due_date !== null && t.due_date < today) ||
      t.status === 'blocked' ||
      (t.due_date === null && ageDays >= sla.task_reminder_days + sla.quote_response_days);
    // Respect the cadence for hygiene too, so nothing is nudged nightly.
    const withinCadence = (() => {
      if (!t.reminded_at) return true;
      const sinceDays = Math.floor((Date.now() - new Date(t.reminded_at).getTime()) / 86400_000);
      return sinceDays >= sla.reminder_repeat_days;
    })();

    if (!overdue) {
      // Not late — but is it even a task? The SOP wants one owner, a due
      // date and a next step. Give the ingest a day to fill them in before
      // chasing, or every message would nudge the moment it arrived.
      if (!withinCadence) continue;
      if (ageDays < sla.task_reminder_days) continue;

      const gaps = HYGIENE.filter(({ type }) =>
        type === 'task_unowned'
          ? !t.assigned_to
          : type === 'task_no_next_step'
            ? !(t.next_step ?? '').trim()
            : !t.due_date,
      );
      if (!gaps.length) continue;

      // One nudge naming everything missing, not one per gap: the seat owns
      // "pushing tasks so each has ONE owner, a due date and a next step",
      // which is a single push. The most important gap names the type.
      const missing = gaps.map((g) => g.missing);
      const where = t.projects?.name ? ` on ${t.projects.name}` : '';
      triggers.push({
        type: gaps[0].type,
        projectId: t.project_id,
        vendorId: t.vendor_id,
        // The owner if there is one; otherwise the seat that owns hygiene.
        target: t.profiles?.email ?? hygieneEmail,
        reason:
          missing.length === 1
            ? `This has been open ${ageDays} days and ${missing[0]}.`
            : `This has been open ${ageDays} days and ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}.`,
        context: `${t.title}${where}`,
        taskId: t.id,
        // Being told a task is incomplete is not being chased for lateness.
        countsAsReminder: false,
      });
      continue;
    }

    // Respect the cadence: no second nudge until the repeat window passes.
    if (t.reminded_at) {
      const sinceDays = Math.floor((Date.now() - new Date(t.reminded_at).getTime()) / 86400_000);
      if (sinceDays < sla.reminder_repeat_days) continue;
    }

    const owner = t.profiles?.full_name ?? 'whoever picks it up';
    const where = t.projects?.name ? ` on ${t.projects.name}` : '';
    const escalate = t.reminder_count >= 1;

    triggers.push({
      type: escalate ? 'task_escalation' : 'task_overdue',
      projectId: t.project_id,
      vendorId: t.vendor_id,
      // Unassigned work has nobody to nudge; it still needs raising so it
      // shows up rather than quietly rotting.
      target: escalate ? null : (t.profiles?.email ?? null),
      reason: escalate
        ? `${owner} was reminded and "${t.title}" is still open${t.due_date ? ` (due ${t.due_date})` : ''}.`
        : t.assigned_to
          ? `This is overdue${t.due_date ? ` (due ${t.due_date})` : ` — raised ${ageDays} days ago`} and still with ${owner}.`
          : `This is overdue${t.due_date ? ` (due ${t.due_date})` : ` — raised ${ageDays} days ago`} and nobody owns it.`,
      context: `${t.title}${where}`,
      taskId: t.id,
    });
  }

  // 1. Vendor silence — POs placed but not confirmed past the threshold.
  const { data: silentPos } = await supabaseAdmin
    .from('purchase_orders')
    .select('id, po_number, project_id, vendor_id, order_date, vendors(name, contacts)')
    .eq('org_id', orgId)
    .eq('status', 'placed')
    .lte('order_date', daysAgoIso(vendorDays).slice(0, 10));
  for (const po of silentPos ?? []) {
    const vendor = (po as { vendors?: { name?: string; contacts?: { email?: string }[] } }).vendors;
    triggers.push({
      type: 'vendor_silence',
      projectId: (po as { project_id: string | null }).project_id,
      vendorId: (po as { vendor_id: string | null }).vendor_id,
      target: vendor?.contacts?.[0]?.email ?? null,
      reason: `No confirmation on ${(po as { po_number?: string }).po_number ?? 'the order'} in over ${vendorDays} days.`,
      context: `${vendor?.name ?? 'vendor'} — ${(po as { po_number?: string }).po_number ?? 'PO'}`,
    });
  }

  // 2. Date slipping — POs past ETA, not yet received.
  const { data: latePos } = await supabaseAdmin
    .from('purchase_orders')
    .select('id, po_number, project_id, vendor_id, eta, vendors(name, contacts)')
    .eq('org_id', orgId)
    .lt('eta', todayIso())
    .not('status', 'in', '("received","cancelled")');
  for (const po of latePos ?? []) {
    const vendor = (po as { vendors?: { name?: string; contacts?: { email?: string }[] } }).vendors;
    triggers.push({
      type: 'date_slipping',
      projectId: (po as { project_id: string | null }).project_id,
      vendorId: (po as { vendor_id: string | null }).vendor_id,
      target: vendor?.contacts?.[0]?.email ?? null,
      reason: `Delivery is past its ETA (${(po as { eta?: string }).eta}).`,
      context: `${vendor?.name ?? 'vendor'} — ${(po as { po_number?: string }).po_number ?? 'PO'}`,
    });
  }

  // 3. Client approval overdue — projects stuck in "approval".
  const { data: stuck } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, updated_at')
    .eq('org_id', orgId)
    .eq('stage', 'approval')
    .lt('updated_at', daysAgoIso(clientDays));
  for (const p of stuck ?? []) {
    triggers.push({
      type: 'client_approval_overdue',
      projectId: (p as { id: string }).id,
      vendorId: null,
      target: null,
      reason: `Awaiting client approval for over ${clientDays} days.`,
      context: `${(p as { name: string }).name} (${(p as { client_name?: string }).client_name ?? 'client'})`,
    });
  }

  // 4. Spec gaps — internal reminders (no email).
  const { data: gaps } = await supabaseAdmin
    .from('spec_gaps')
    .select('id, item, project_id')
    .eq('org_id', orgId)
    .eq('resolved', false);
  for (const g of gaps ?? []) {
    triggers.push({
      type: 'spec_gap',
      projectId: (g as { project_id: string }).project_id,
      vendorId: null,
      target: null,
      reason: `Missing information on "${(g as { item: string }).item}" before it can be ordered.`,
      context: (g as { item: string }).item,
    });
  }

  let raised = 0;
  let drafted = 0;
  const withGmailMessage = await hasDraftGmailMessage();
  const withDraftOwner = await hasDraftOwner();

  for (const t of triggers) {
    // Dedupe against an existing open follow-up of the same kind — and
    // against one recently marked sent, which is new. A nudge the studio
    // posted from Gmail now closes itself, and without this the engine would
    // raise the identical chase again the following night: a vendor who
    // never confirms would earn a fresh draft every 24 hours. Wait out the
    // same silence window before asking again.
    const sentCutoff = daysAgoIso(vendorDays);
    const dedupe = supabaseAdmin
      .from('follow_ups')
      .select('id')
      .eq('org_id', orgId)
      .eq('type', t.type)
      .or(`status.in.(open,drafted),and(status.eq.sent,updated_at.gte.${sentCutoff})`);
    if (t.taskId) dedupe.eq('task_id', t.taskId);
    else if (t.projectId) dedupe.eq('project_id', t.projectId);
    if (!t.taskId && t.vendorId) dedupe.eq('vendor_id', t.vendorId);
    const { data: dupes } = await dedupe;
    if (dupes && dupes.length) continue;

    let draftId: string | null = null;
    let status: 'open' | 'drafted' = 'open';

    // Resolve the real correspondent + thread from recent email; fall
    // back to the vendor's stored contact where no email exists yet.
    let resolved: Recipient | null = null;
    // Internal reminders go to the teammate on t.target; never resolve them
    // against a vendor thread, or a nudge would be addressed to the vendor.
    if (INTERNAL_TYPES.includes(t.type)) {
      resolved = null;
    } else if (t.type === 'vendor_silence' || t.type === 'date_slipping') {
      resolved = await resolveRecipient(orgId, { vendorId: t.vendorId });
    } else if (t.type === 'client_approval_overdue') {
      resolved = await resolveRecipient(orgId, { projectId: t.projectId, preferClass: 'client_approval' });
    }
    const to = resolved?.to ?? t.target;

    if (to) {
      try {
        const gen = await draftBody(t);
        const subject = resolved?.subject
          ? /^re:/i.test(resolved.subject)
            ? resolved.subject
            : `Re: ${resolved.subject}`
          : gen.subject;
        // Kept in the system, and pushed to the real Gmail thread (when one
        // is known) so the nudge can be found, edited and sent from Gmail.
        const ccLine = resolved?.cc.length ? `\nCc: ${resolved.cc.join(', ')}` : '';
        const composed = `To: ${to}${ccLine}\n\n${gen.body}`;

        // Through whoever's mailbox this thread is actually in — a vendor
        // relationship resolved from a teammate's PERSONAL mailbox has to
        // be answered through their own Google connection, or the draft
        // lands as a stray, unthreaded message in a different account.
        let pushed: { draftId: string; messageId: string } | null = null;
        try {
          const gmail = await gmailForReply(orgId, resolved?.ownerId ?? null);
          if (gmail) {
            const content: DraftContent = {
              to, cc: resolved?.cc.length ? resolved.cc.join(', ') : undefined,
              subject, body: gen.body, threadId: resolved?.threadId ?? undefined,
            };
            pushed = await createDraft(gmail, content);
          }
        } catch (err) {
          console.error('[followups] gmail draft push failed', (err as Error).message);
        }

        const { data: draftRow } = await supabaseAdmin!
          .from('drafts')
          .insert({
            org_id: orgId, follow_up_id: null, subject, body_preview: composed,
            // A reply quotes the thread it answers, so it inherits that
            // mail's privacy — see ingest.ts's own reply drafts.
            ...(withDraftOwner && resolved?.ownerId ? { owner_id: resolved.ownerId } : {}),
            ...(pushed ? { gmail_draft_id: pushed.draftId } : {}),
            ...(pushed && withGmailMessage ? { gmail_message_id: pushed.messageId } : {}),
          })
          .select('id')
          .maybeSingle();
        draftId = draftRow?.id ?? null;
        status = 'drafted';
        drafted++;
      } catch (err) {
        console.error('[followups] draft failed', (err as Error).message);
      }
    }

    await supabaseAdmin!.from('follow_ups').insert({
      org_id: orgId,
      type: t.type,
      project_id: t.projectId,
      vendor_id: t.vendorId,
      task_id: t.taskId ?? null,
      target: to,
      reason: t.reason,
      due_date: todayIso(),
      status,
      draft_id: draftId,
    });

    // Stamp the task so the next run waits out the repeat window instead of
    // nudging the same person every night. The count only moves for a real
    // reminder, because it is what decides when to escalate.
    if (t.taskId) {
      const patch: Record<string, unknown> = { reminded_at: new Date().toISOString() };
      if (t.countsAsReminder !== false) {
        const { data: cur } = await supabaseAdmin!
          .from('tasks')
          .select('reminder_count')
          .eq('id', t.taskId)
          .maybeSingle();
        patch.reminder_count = ((cur as { reminder_count?: number } | null)?.reminder_count ?? 0) + 1;
      }
      await supabaseAdmin!.from('tasks').update(patch).eq('id', t.taskId);
    }
    raised++;
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'followups.run',
    entity: 'follow_ups',
    meta: { raised, drafted, resolved },
  });

  return { ok: true, raised, drafted, resolved };
}
