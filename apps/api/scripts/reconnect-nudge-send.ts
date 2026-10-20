// ============================================================
//  Reconnect nudge — one-off SEND (Option B).
//
//  Re-sends the official reconnect email to every connected
//  Google account that currently shows "Needs reconnect"
//  (recorded google.health is not ok), BYPASSING the keep-alive's
//  once-per-drop dedup. Everyone who is down gets a fresh nudge
//  with a new one-tap consent link.
//
//  Reuses the real machinery so it is byte-identical to the
//  automatic flow: reconnectEmail (template), reconnectConsentUrl
//  (signed state), gmailFor + sendMessage, and the same
//  google.reconnect_email audit entry.
//
//  SAFE BY DEFAULT: without --send it only prints what it WOULD do.
//
//  Usage (from repo root):
//    npx tsx apps/api/scripts/reconnect-nudge-send.ts          # preview
//    npx tsx apps/api/scripts/reconnect-nudge-send.ts --send   # actually send
// ============================================================
import { supabaseAdmin } from '../src/lib/supabase.js';
import { latestGoogleHealth } from '../src/lib/googleHealth.js';
import { orgSourceUserId } from '../src/lib/tokens.js';
import { GOOGLE_SERVICES, reconnectConsentUrl, servicesGranted, type GoogleService } from '../src/lib/google.js';
import { reconnectEmail } from '../src/services/emailTemplate.js';
import { gmailFor, sendMessage } from '../src/services/gmail.js';
import { deliveryAddressFor } from '../src/lib/studioTeam.js';

// Matches services/googleKeepalive.ts — the action every reconnect email is logged under.
const RECONNECT_EMAIL_ACTION = 'google.reconnect_email';

const DO_SEND = process.argv.includes('--send');

interface IntegrationRow {
  org_id: string;
  user_id: string;
  scopes: string | null;
  connected_at: string | null;
}

async function main() {
  if (!supabaseAdmin) {
    console.error('✗ Supabase admin client not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }

  const { data: integ } = await supabaseAdmin
    .from('integrations')
    .select('org_id, user_id, scopes, connected_at')
    .eq('provider', 'google')
    .eq('status', 'connected');
  const rows = (integ ?? []) as IntegrationRow[];
  const userIds = rows.map((r) => r.user_id).filter(Boolean);
  if (!userIds.length) {
    console.log('No connected Google integrations found.');
    return;
  }

  const { data: profs } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, role')
    .in('id', userIds);
  const profile = new Map(
    ((profs ?? []) as { id: string; full_name: string | null; email: string | null; role: string | null }[]).map((p) => [p.id, p]),
  );

  const health = await latestGoogleHealth(userIds);

  // Broken = recorded health.ok === false (same as the Team screen).
  const broken = rows.filter((r) => health.get(r.user_id)?.ok === false);
  // Healthy + Gmail-capable candidates to SEND FROM, per org.
  const healthyGmailByOrg = new Map<string, string[]>();
  for (const r of rows) {
    if (health.get(r.user_id)?.ok === false) continue;
    if (!servicesGranted(r.scopes).gmail) continue;
    healthyGmailByOrg.set(r.org_id, [...(healthyGmailByOrg.get(r.org_id) ?? []), r.user_id]);
  }

  if (!broken.length) {
    console.log('Nobody currently shows "Needs reconnect". Nothing to send.');
    return;
  }

  // Sender per org — mirror emailTheDropped.senderFor: org source if it is
  // among the healthy, else the first healthy Gmail-capable account.
  const senderByOrg = new Map<string, string | null>();
  async function senderFor(orgId: string): Promise<string | null> {
    if (senderByOrg.has(orgId)) return senderByOrg.get(orgId)!;
    const healthy = healthyGmailByOrg.get(orgId) ?? [];
    let id: string | null = null;
    if (healthy.length) {
      const source = await orgSourceUserId(orgId);
      id = source && healthy.includes(source) ? source : healthy[0];
    }
    senderByOrg.set(orgId, id);
    return id;
  }

  console.log(`\n=== Reconnect nudge — ${DO_SEND ? 'SEND' : 'PREVIEW (no --send)'} ===\n`);
  console.log(`Need reconnect: ${broken.length}\n`);

  const gmailCache = new Map<string, Awaited<ReturnType<typeof gmailFor>>>();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of broken) {
    const p = profile.get(r.user_id);
    const name = p?.full_name ?? '';
    const email = p?.email ?? null;
    if (!email) {
      console.log(`  ⚠ SKIP ${name || r.user_id} — no email on file`);
      skipped++;
      continue;
    }

    const senderId = await senderFor(r.org_id);
    if (!senderId) {
      console.log(`  ⚠ SKIP ${name} <${email}> — no healthy Gmail account to send from in this studio`);
      skipped++;
      continue;
    }
    const senderEmail = profile.get(senderId)?.email ?? senderId;

    const granted = servicesGranted(r.scopes);
    const services = GOOGLE_SERVICES.filter((s) => granted[s]);
    const serviceArg: GoogleService | 'all' = services.length === 1 ? services[0] : 'all';
    const labels = services.map((s): 'Gmail' | 'Drive' => (s === 'gmail' ? 'Gmail' : 'Drive'));
    const url = reconnectConsentUrl(r.user_id, serviceArg);
    const mail = reconnectEmail({ name, url, services: labels.length ? labels : undefined });

    if (!DO_SEND) {
      console.log(`  • WOULD SEND to ${name} <${email}>  (from ${senderEmail})  re-grant: ${labels.join('+') || 'Gmail+Drive'}`);
      continue;
    }

    try {
      if (!gmailCache.has(senderId)) gmailCache.set(senderId, await gmailFor(senderId));
      const gmail = gmailCache.get(senderId) ?? null;
      if (!gmail) {
        console.log(`  ⚠ SKIP ${name} <${email}> — could not open sender mailbox ${senderEmail}`);
        skipped++;
        continue;
      }
      await sendMessage(gmail, { to: deliveryAddressFor(email), subject: mail.subject, body: mail.text, html: mail.html });
      await supabaseAdmin.from('activity_log').insert({
        org_id: r.org_id,
        actor: null,
        action: RECONNECT_EMAIL_ACTION,
        entity: 'integrations',
        entity_id: r.user_id,
        meta: { email, source: 'reconnect-nudge-send' },
      });
      console.log(`  ✓ SENT to ${name} <${email}>  (from ${senderEmail})`);
      sent++;
    } catch (err) {
      console.log(`  ✗ FAILED ${name} <${email}>: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n=== Done. ${DO_SEND ? `sent ${sent}, skipped ${skipped}, failed ${failed}` : 'preview only — re-run with --send to send'} ===\n`);
}

main().catch((err) => {
  console.error('✗ Reconnect nudge failed:', (err as Error).message ?? err);
  process.exit(1);
});
