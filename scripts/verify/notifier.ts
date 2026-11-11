// ============================================================
//  Verify services/notifier.ts against the DEV database (Task C2).
//
//  Usage (from repo root):
//    npx tsx scripts/verify/notifier.ts --pilot <profileId> --other <profileId>
//    npx tsx scripts/verify/notifier.ts --pilot <id> --other <id> --send
//
//  --pilot  a dev profile used as the pilot user
//  --other  a second dev profile (non-pilot / inactive cases)
//  --send   also run case 5: ONE real email, only if
//           REMINDERS_TEST_RECIPIENT is set (it goes there, nowhere else)
//
//  Prints PASS / FAIL / SKIP per case. Always restores the original
//  reminders_v2 settings with dry_run = true, and the --other profile's
//  is_active, even if a case throws. Log rows it writes are kept
//  (keys start with "verify:") — nothing is deleted.
// ============================================================
import { assertNotProduction, check, failureCount, skip } from './_guard.js';

assertNotProduction();

const { supabaseAdmin } = await import('../../apps/api/src/lib/supabase.js');
const { resolveOrgId } = await import('../../apps/api/src/lib/org.js');
const { REMINDERS_V2_FIELD } = await import('../../apps/api/src/lib/reminderSettings.js');
const { notify } = await import('../../apps/api/src/services/notifier.js');
const { env } = await import('../../apps/api/src/env.js');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const pilotId = arg('--pilot');
const otherId = arg('--other');
const DO_SEND = process.argv.includes('--send');

if (!supabaseAdmin) {
  console.error('✗ Supabase is not configured (.env).');
  process.exit(1);
}
if (!pilotId || !otherId || pilotId === otherId) {
  console.error('✗ Pass two different dev profile ids: --pilot <id> --other <id>');
  process.exit(1);
}
const orgId = await resolveOrgId();
if (!orgId) {
  console.error('✗ Could not resolve the organization (expects exactly one on dev).');
  process.exit(1);
}

const db = supabaseAdmin;
const run = `verify:${Date.now()}`;
const html = '<p>This is a <b>v2 notifier verification</b> email. Please ignore.</p>';

async function readSettingsRaw(): Promise<Record<string, unknown>> {
  const { data, error } = await db.from('organizations').select('settings').eq('id', orgId).single();
  if (error) throw new Error(error.message);
  return ((data as { settings: Record<string, unknown> }).settings ?? {}) as Record<string, unknown>;
}
async function putV2(value: unknown): Promise<void> {
  const { error } = await db.rpc('merge_org_settings', { p_org_id: orgId, p_patch: { [REMINDERS_V2_FIELD]: value } });
  if (error) throw new Error(error.message);
}
async function setV2(patch: Record<string, unknown>): Promise<void> {
  const current = ((await readSettingsRaw())[REMINDERS_V2_FIELD] ?? {}) as Record<string, unknown>;
  await putV2({ ...current, ...patch });
}
async function rowsFor(key: string): Promise<{ status: string; payload: Record<string, unknown> | null; error: string | null }[]> {
  const { data, error } = await db.from('notifications_log').select('status, payload, error').eq('idempotency_key', key);
  if (error) throw new Error(error.message);
  return (data ?? []) as { status: string; payload: Record<string, unknown> | null; error: string | null }[];
}
async function setActive(id: string, active: boolean): Promise<void> {
  const { error } = await db.from('profiles').update({ is_active: active }).eq('id', id);
  if (error) throw new Error(error.message);
}

const originalV2 = (await readSettingsRaw())[REMINDERS_V2_FIELD];
const { data: otherRow } = await db.from('profiles').select('is_active').eq('id', otherId).maybeSingle();
const otherWasActive = (otherRow as { is_active: boolean | null } | null)?.is_active !== false;

try {
  // Start from a known, safe state.
  await setV2({ dry_run: true, pilot_mode: true, pilot_users: [pilotId] });

  // 1. dry_run → returns dry_run, row stays dry_run, nothing sent.
  {
    const key = `${run}:dry`;
    const r = await notify({ orgId, userId: pilotId, type: 'digest', idempotencyKey: key, subject: '[verify] dry run', html });
    const rows = await rowsFor(key);
    check('1. dry_run = true → dry_run, row dry_run, not sent', r === 'dry_run' && rows.length === 1 && rows[0].status === 'dry_run', `returned ${r}, rows ${rows.map((x) => x.status).join(',') || 'none'}`);
  }

  // 2. Same key twice → second is duplicate, still one row.
  {
    const key = `${run}:dup`;
    const a = await notify({ orgId, userId: pilotId, type: 'digest', idempotencyKey: key, subject: '[verify] dup', html });
    const b = await notify({ orgId, userId: pilotId, type: 'digest', idempotencyKey: key, subject: '[verify] dup', html });
    const rows = await rowsFor(key);
    check('2. same idempotency key twice → duplicate, one row', a === 'dry_run' && b === 'duplicate' && rows.length === 1, `returned ${a} then ${b}, rows ${rows.length}`);
  }

  // 3. Not in pilot_users → skipped.
  {
    const key = `${run}:notpilot`;
    const r = await notify({ orgId, userId: otherId, type: 'digest', idempotencyKey: key, subject: '[verify] not pilot', html });
    const real = await rowsFor(key);
    const skipped = await rowsFor(`skipped:not_in_pilot:${key}`);
    check('3. user not in pilot_users → skipped', r === 'skipped' && real.length === 0 && skipped.length === 1, `returned ${r}`);
  }

  // 4. Inactive user (even if in the pilot) → skipped.
  {
    await setV2({ pilot_users: [pilotId, otherId] });
    await setActive(otherId, false);
    const key = `${run}:inactive`;
    const r = await notify({ orgId, userId: otherId, type: 'digest', idempotencyKey: key, subject: '[verify] inactive', html });
    const skipped = await rowsFor(`skipped:user_inactive:${key}`);
    check('4. inactive user → skipped', r === 'skipped' && skipped.length === 1, `returned ${r}`);
    await setActive(otherId, otherWasActive);
    await setV2({ pilot_users: [pilotId] });
  }

  // 5. Real send, to the test recipient only.
  if (!DO_SEND) {
    skip('5. real send to REMINDERS_TEST_RECIPIENT', 'run again with --send to send ONE real email');
  } else if (!env.reminders.testRecipient) {
    skip('5. real send to REMINDERS_TEST_RECIPIENT', 'REMINDERS_TEST_RECIPIENT is not set — refusing to send to a real person');
  } else {
    await setV2({ dry_run: false });
    const key = `${run}:send`;
    const r = await notify({ orgId, userId: pilotId, type: 'digest', idempotencyKey: key, subject: '[verify] v2 notifier test send', html });
    const rows = await rowsFor(key);
    const to = rows[0]?.payload?.to;
    check(
      '5. dry_run = false + pilot + test recipient → sent, to the test recipient only',
      r === 'sent' && rows.length === 1 && rows[0].status === 'sent' && to === env.reminders.testRecipient,
      `returned ${r}, to ${String(to)}${rows[0]?.error ? `, error: ${rows[0].error}` : ''}`,
    );
    console.log(`      Check the inbox of ${env.reminders.testRecipient} for "[verify] v2 notifier test send".`);
  }
} catch (err) {
  check('script ran without an unexpected error', false, (err as Error).message);
} finally {
  // 6. ALWAYS restore: original settings, but dry_run forced back to true.
  try {
    const restored = { ...((originalV2 ?? {}) as Record<string, unknown>), dry_run: true };
    await putV2(restored);
    await setActive(otherId, otherWasActive);
    const after = ((await readSettingsRaw())[REMINDERS_V2_FIELD] ?? {}) as Record<string, unknown>;
    check('6. settings restored with dry_run = true', after.dry_run === true);
  } catch (err) {
    check('6. settings restored with dry_run = true', false, (err as Error).message);
    console.error('  ⚠ RESTORE FAILED — set reminders_v2.dry_run back to true by hand: PATCH /api/ops/reminders-v2/settings {"dry_run": true}');
  }
}

const failed = failureCount();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
