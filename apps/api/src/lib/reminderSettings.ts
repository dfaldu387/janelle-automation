import { z } from 'zod';
import { supabaseAdmin } from './supabase.js';

/**
 * Reminder v2 settings (fast track, Task C1; spec §4).
 *
 * One key in `organizations.settings`, written through merge_org_settings
 * (migration 0023) like the Slack settings:
 *
 *   reminders_v2   the whole object below, always stored complete
 *
 * Safe by default: dry_run is ON and pilot_mode is ON with nobody in the
 * pilot list, so nothing reaches anyone until an admin changes both.
 * If the stored value cannot be read, the defaults are used (still safe).
 */

export const REMINDERS_V2_FIELD = 'reminders_v2';

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');
const nonNegInt = z.number().int().min(0);

const settingsSchema = z.object({
  /** When true, nothing is sent: the notifier logs instead. */
  dry_run: z.boolean(),
  /** When true, only pilot_users receive anything. */
  pilot_mode: z.boolean(),
  /** Profile ids. Empty + pilot_mode = nobody receives anything. */
  pilot_users: z.array(z.string().uuid()),
  digest: z.object({
    send_time_local: timeOfDay,
    max_items: z.number().int().min(1).max(20),
    skip_weekends: z.boolean(),
  }),
  priority: z.object({
    p1_due_within_hours: nonNegInt,
    p2_due_within_days: nonNegInt,
    client_waiting_reply_hours: nonNegInt,
  }),
  escalation: z.object({
    owner_nudge_after_business_days: nonNegInt,
    manager_after_business_days: nonNegInt,
  }),
  waiting: z.object({ followup_after_business_days: nonNegInt }),
  backlog: z.object({ stale_after_days: z.number().int().min(1) }),
  instant_alerts: z.object({ enabled: z.boolean() }),
});

export type ReminderSettings = z.infer<typeof settingsSchema>;

export const REMINDER_DEFAULTS: ReminderSettings = {
  dry_run: true, // DEFAULT TRUE: nothing is sent unless explicitly turned off
  pilot_mode: true,
  pilot_users: [],
  digest: { send_time_local: '07:30', max_items: 5, skip_weekends: true },
  priority: { p1_due_within_hours: 48, p2_due_within_days: 7, client_waiting_reply_hours: 24 },
  escalation: { owner_nudge_after_business_days: 2, manager_after_business_days: 5 },
  waiting: { followup_after_business_days: 3 },
  backlog: { stale_after_days: 30 },
  instant_alerts: { enabled: true },
};

/** A partial update: any subset of the keys, nested groups may be partial too. */
export type ReminderSettingsPatch = {
  [K in keyof ReminderSettings]?: ReminderSettings[K] extends unknown[]
    ? ReminderSettings[K]
    : ReminderSettings[K] extends object
      ? Partial<ReminderSettings[K]>
      : ReminderSettings[K];
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defaults overlaid with whatever is stored; one level of nesting, arrays replaced whole. */
function overlay(base: ReminderSettings, raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(base);
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in base)) continue; // ignore unknown keys
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return out;
}

async function readStored(orgId: string): Promise<unknown> {
  if (!supabaseAdmin) return undefined;
  const { data, error } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  if (error) throw new Error(error.message);
  const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  return settings[REMINDERS_V2_FIELD];
}

/** The studio's v2 reminder settings, defaults filled in. Never throws: falls back to the (safe) defaults. */
export async function getReminderSettings(orgId: string): Promise<ReminderSettings> {
  try {
    const parsed = settingsSchema.safeParse(overlay(REMINDER_DEFAULTS, await readStored(orgId)));
    if (parsed.success) return parsed.data;
    console.error('[reminders] stored reminders_v2 is invalid — using safe defaults:', parsed.error.issues[0]?.message);
  } catch (err) {
    console.error('[reminders] could not read reminders_v2 — using safe defaults:', (err as Error).message);
  }
  return structuredClone(REMINDER_DEFAULTS);
}

export class ReminderSettingsError extends Error {}

/**
 * Apply a partial update and store the complete result. Rejects (and stores
 * nothing) when the result would be invalid.
 */
export async function updateReminderSettings(orgId: string, patch: ReminderSettingsPatch): Promise<ReminderSettings> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  if (!isPlainObject(patch)) throw new ReminderSettingsError('Send an object of settings to change');
  const unknownKeys = Object.keys(patch).filter((k) => !(k in REMINDER_DEFAULTS));
  if (unknownKeys.length) throw new ReminderSettingsError(`Unknown setting: ${unknownKeys.join(', ')}`);

  const current = await getReminderSettings(orgId);
  const parsed = settingsSchema.safeParse(overlay(current, patch));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReminderSettingsError(`${issue?.path.join('.') || 'settings'}: ${issue?.message ?? 'invalid'}`);
  }

  const { error } = await supabaseAdmin.rpc('merge_org_settings', {
    p_org_id: orgId,
    p_patch: { [REMINDERS_V2_FIELD]: parsed.data },
  });
  if (error) throw new Error(error.message);
  return parsed.data;
}
