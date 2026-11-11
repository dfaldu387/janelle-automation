import type { NotificationStatus, NotificationType } from '@janelle/shared';
import { env } from '../env.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { getReminderSettings } from '../lib/reminderSettings.js';
import { STUDIO_MAILBOXES, deliveryAddressFor } from '../lib/studioTeam.js';
import { sendFromStudioSender } from './gmail.js';

export type { NotificationType };

/**
 * The single email gateway for every v2 reminder (fast track, Task C2).
 *
 * No v2 code may call Gmail send directly — it calls notify(). The checks run
 * in this exact order, and nothing is sent unless every one passes:
 *
 *   1. The person is active          (profiles.is_active)        else 'skipped'
 *   2. Pilot mode lets them through  (reminders_v2.pilot_users)  else 'skipped'
 *   3. The log row is INSERTED first with the idempotency key; a unique-key
 *      violation means this reminder was already handled     →  'duplicate'
 *   4. dry_run is on                 → logged, not sent           'dry_run'
 *   5. REMINDERS_TEST_RECIPIENT, when set, replaces the real address
 *   6. Sent from systems@ ONLY (no fallback to anyone's mailbox) → 'sent' / 'failed'
 *
 * notify() never throws: every outcome is a return value and a log row.
 */

export type NotifyResult = 'sent' | 'dry_run' | 'skipped' | 'duplicate' | 'failed';

export interface NotifyInput {
  orgId: string;
  userId: string;
  type: NotificationType;
  taskId?: string | null;
  /** Unique per reminder, e.g. `digest:<userId>:<localDate>`. The same key is never sent twice. */
  idempotencyKey: string;
  subject: string;
  html: string;
}

const UNIQUE_VIOLATION = '23505';

interface ProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean | null;
}

/** Plain-text alternative for the HTML body. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A row for a reminder that was not even attempted (inactive, not in the pilot).
 * Keyed apart from the real key so it never blocks a later legitimate send,
 * and ignore-on-conflict so a job that runs every few minutes leaves one row,
 * not hundreds.
 */
async function logSkipped(input: NotifyInput, reason: string): Promise<void> {
  const { error } = await supabaseAdmin!
    .from('notifications_log')
    .upsert(
      {
        org_id: input.orgId,
        user_id: input.userId,
        task_id: input.taskId ?? null,
        type: input.type,
        status: 'skipped' satisfies NotificationStatus,
        idempotency_key: `skipped:${reason}:${input.idempotencyKey}`,
        payload: { subject: input.subject, reason },
        error: reason,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );
  if (error) console.error('[notifier] could not log a skipped reminder:', error.message);
}

async function finish(rowId: string, patch: { status: NotificationStatus; error?: string | null; payload?: Record<string, unknown> }): Promise<void> {
  const { error } = await supabaseAdmin!
    .from('notifications_log')
    .update({ ...patch, sent_at: new Date().toISOString() })
    .eq('id', rowId);
  if (error) console.error('[notifier] could not update log row', rowId, error.message);
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  if (!supabaseAdmin) {
    console.error('[notifier] backend not configured; nothing sent');
    return 'failed';
  }
  let rowId: string | null = null;

  try {
    // 1. The person, and whether they are active.
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, is_active')
      .eq('id', input.userId)
      .eq('org_id', input.orgId)
      .maybeSingle();
    if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`);
    const profile = profileData as ProfileRow | null;
    if (!profile) {
      await logSkipped(input, 'user_not_found');
      return 'skipped';
    }
    if (profile.is_active === false) {
      await logSkipped(input, 'user_inactive');
      return 'skipped';
    }

    // 2. Pilot mode.
    const settings = await getReminderSettings(input.orgId);
    if (settings.pilot_mode && !settings.pilot_users.includes(input.userId)) {
      await logSkipped(input, 'not_in_pilot');
      return 'skipped';
    }

    // 3. Claim the idempotency key BEFORE anything is sent.
    const realAddress = deliveryAddressFor(profile.email);
    const testRecipient = env.reminders.testRecipient;
    const to = testRecipient || realAddress;
    const payload: Record<string, unknown> = {
      subject: input.subject,
      to,
      intended_recipient: realAddress || null,
      redirected_to_test_recipient: Boolean(testRecipient),
      html: input.html,
    };
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('notifications_log')
      .insert({
        org_id: input.orgId,
        user_id: input.userId,
        task_id: input.taskId ?? null,
        type: input.type,
        status: 'dry_run' satisfies NotificationStatus, // placeholder until the outcome is known
        idempotency_key: input.idempotencyKey,
        payload,
      })
      .select('id')
      .single();
    if (insertError) {
      if (insertError.code === UNIQUE_VIOLATION) return 'duplicate';
      throw new Error(`could not write notifications_log: ${insertError.message}`);
    }
    rowId = (inserted as { id: string }).id;

    // 4. Dry run: the row stays 'dry_run', nothing leaves the building.
    if (settings.dry_run) {
      console.log(`[notifier] DRY RUN ${input.type} → ${to || '(no address)'} · "${input.subject}" · key ${input.idempotencyKey}`);
      return 'dry_run';
    }

    // 5. Where it goes.
    if (!to) {
      await finish(rowId, { status: 'failed', error: 'recipient has no email address' });
      return 'failed';
    }

    // 6. From systems@ only.
    const from = env.mail.fromAddress;
    if (!from || !STUDIO_MAILBOXES.includes(from)) {
      await finish(rowId, { status: 'failed', error: `MAIL_FROM_ADDRESS must be the studio sender (${STUDIO_MAILBOXES.join(', ')}); got "${from || '(empty)'}"` });
      return 'failed';
    }
    try {
      const sent = await sendFromStudioSender({ to, subject: input.subject, body: htmlToText(input.html), html: input.html });
      await finish(rowId, { status: 'sent', payload: { ...payload, gmail_message_id: sent.id, from: sent.from } });
      return 'sent';
    } catch (err) {
      await finish(rowId, { status: 'failed', error: (err as Error).message });
      return 'failed';
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error('[notifier] failed:', message);
    if (rowId) await finish(rowId, { status: 'failed', error: message }).catch(() => undefined);
    return 'failed';
  }
}
