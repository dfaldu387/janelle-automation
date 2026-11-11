import { supabaseAdmin } from './supabase.js';

/**
 * The off-switch for every v1 task reminder (v2 fast track, Step 0a).
 *
 * One key in `organizations.settings`, written through merge_org_settings
 * (migration 0023) like the Slack settings:
 *
 *   reminders_v1_enabled   boolean, default FALSE
 *
 * When it is false, these return early and log
 * `[reminders] skipped: v1 reminders disabled (<path>)`:
 *   - the 9am/5pm task email + Slack DMs      services/middayReminder.ts (also /api/ops/cron/midday-reminder?force=1)
 *   - the personal Slack DMs on their own     services/slackReminder.ts
 *   - task-based follow-up nudges             services/followups.ts sections 0, 0b, 0c
 *   - the task lists in the Slack briefing    services/slackDigest.ts
 *   - the Slack task reports                  services/slackReport.ts
 *   - "due" announcements in the Slack sync   services/slackSync.ts announceDue
 *
 * Gmail ingest, task review, Google keep-alive and team activity are not
 * affected. Fails closed: if the setting cannot be read, reminders stay off.
 */

export const REMINDERS_V1_FIELD = 'reminders_v1_enabled';

export async function remindersV1Enabled(orgId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    if (error) throw new Error(error.message);
    const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
    return settings[REMINDERS_V1_FIELD] === true;
  } catch (err) {
    console.error('[reminders] could not read reminders_v1_enabled — treating v1 reminders as off:', (err as Error).message);
    return false;
  }
}

export async function setRemindersV1Enabled(orgId: string, enabled: boolean): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const { error } = await supabaseAdmin.rpc('merge_org_settings', { p_org_id: orgId, p_patch: { [REMINDERS_V1_FIELD]: enabled } });
  if (error) throw new Error(error.message);
}

/** The single log line every guarded path writes when it stands down. */
export function logV1Skipped(path: string): void {
  console.log(`[reminders] skipped: v1 reminders disabled (${path})`);
}
