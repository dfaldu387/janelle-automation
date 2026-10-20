// ============================================================
//  Reconnect nudge — DRY-RUN reporter (Option B).
//
//  Lists every connected Google account that currently shows
//  "Needs reconnect" (recorded google.health is not ok) — i.e.
//  exactly who a one-off reconnect email would go to, bypassing
//  the keep-alive's once-per-drop dedup.
//
//  READ ONLY. Sends no email, refreshes no token, writes nothing.
//  It mirrors the detection in services/googleKeepalive.ts and
//  lib/googleHealth.ts without importing the gmail/send machinery.
//
//  Usage:
//    node scripts/reconnect-nudge.mjs            # dry-run report
//
//  Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
// ============================================================
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '..', '.env') });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('✗ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}
const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const GOOGLE_HEALTH_ACTION = 'google.health';
const RECONNECT_EMAIL_ACTION = 'google.reconnect_email';

// Mirror servicesGranted().gmail from lib/google.ts
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];
const hasGmail = (scopes) => {
  const granted = new Set((scopes ?? '').split(/\s+/).filter(Boolean));
  return GMAIL_SCOPES.every((s) => granted.has(s));
};

// latest-per-user from an activity_log action (newest first)
async function latestByUser(action, userIds, withMeta) {
  const out = new Map();
  if (!userIds.length) return out;
  const { data, error } = await db
    .from('activity_log')
    .select('entity_id, created_at' + (withMeta ? ', meta' : ''))
    .eq('action', action)
    .in('entity_id', userIds)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  for (const row of data ?? []) {
    if (!out.has(row.entity_id)) out.set(row.entity_id, withMeta ? { meta: row.meta, at: row.created_at } : row.created_at);
  }
  return out;
}

const fmt = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—');

async function main() {
  // Connected Google integrations
  const { data: integ, error: e1 } = await db
    .from('integrations')
    .select('org_id, user_id, scopes, connected_at')
    .eq('provider', 'google')
    .eq('status', 'connected');
  if (e1) throw e1;
  const rows = integ ?? [];
  const userIds = rows.map((r) => r.user_id).filter(Boolean);

  if (!userIds.length) {
    console.log('No connected Google integrations found.');
    return;
  }

  // Profiles for names / emails / role
  const { data: profs, error: e2 } = await db
    .from('profiles')
    .select('id, full_name, email, role, org_id')
    .in('id', userIds);
  if (e2) throw e2;
  const profile = new Map((profs ?? []).map((p) => [p.id, p]));

  const health = await latestByUser(GOOGLE_HEALTH_ACTION, userIds, true);   // user -> {meta:{ok,reason}, at}
  const mailed = await latestByUser(RECONNECT_EMAIL_ACTION, userIds, false); // user -> created_at

  // Classify each account.  broken = recorded health.ok === false.
  // healthy = no health row (healthy from the start) OR health.ok === true.
  const broken = [];
  const healthyGmailByOrg = new Map(); // org -> [{user_id, connected_at}]
  for (const r of rows) {
    const h = health.get(r.user_id);
    const isBroken = h?.meta?.ok === false;
    if (isBroken) {
      broken.push(r);
    } else if (hasGmail(r.scopes)) {
      const list = healthyGmailByOrg.get(r.org_id) ?? [];
      list.push({ user_id: r.user_id, connected_at: r.connected_at });
      healthyGmailByOrg.set(r.org_id, list);
    }
  }

  // Expected sender per org (mirror orgSourceUserId + emailTheDropped.senderFor):
  // a healthy, gmail-capable principal connected earliest; else first healthy gmail account.
  const senderByOrg = new Map();
  for (const [org, list] of healthyGmailByOrg) {
    const sorted = [...list].sort((a, b) => (a.connected_at ?? '').localeCompare(b.connected_at ?? ''));
    const principal = sorted.find((x) => profile.get(x.user_id)?.role === 'principal');
    senderByOrg.set(org, (principal ?? sorted[0])?.user_id ?? null);
  }

  console.log('\n=== Reconnect nudge — DRY RUN (no email sent) ===\n');
  console.log(`Connected Google accounts checked: ${rows.length}`);
  console.log(`Currently need reconnect:          ${broken.length}\n`);

  if (!broken.length) {
    console.log('Nobody currently shows "Needs reconnect". Nothing to send.');
    return;
  }

  const byOrg = new Map();
  for (const r of broken) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push(r);
    byOrg.set(r.org_id, list);
  }

  for (const [org, list] of byOrg) {
    const senderId = senderByOrg.get(org) ?? null;
    const senderProfile = senderId ? profile.get(senderId) : null;
    const senderLabel = senderProfile
      ? `${senderProfile.full_name ?? '(no name)'} <${senderProfile.email ?? '?'}>`
      : '⚠ NONE — no healthy Gmail-capable account in this studio; these could NOT be emailed';
    console.log(`Studio ${org}`);
    console.log(`  Would send FROM: ${senderLabel}\n`);
    console.log(`  WOULD EMAIL (${list.length}):`);
    for (const r of list) {
      const p = profile.get(r.user_id);
      const h = health.get(r.user_id);
      const name = p?.full_name ?? '(no name)';
      const email = p?.email ?? '⚠ no email on file — would be SKIPPED';
      const svc = hasGmail(r.scopes) ? 'Gmail+Drive' : 'Drive';
      console.log(`   • ${name}  <${email}>`);
      console.log(`       reason: ${h?.meta?.reason ?? 'unknown'}   broken since: ${fmt(h?.at)}`);
      console.log(`       services to re-grant: ${svc}   last reconnect email: ${fmt(mailed.get(r.user_id))}`);
    }
    console.log('');
  }
  console.log('=== End of dry run. No email was sent. ===\n');
}

main().catch((err) => {
  console.error('✗ Dry run failed:', err.message ?? err);
  process.exit(1);
});
