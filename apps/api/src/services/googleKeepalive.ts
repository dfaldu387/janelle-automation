import { supabaseAdmin } from '../lib/supabase.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { GOOGLE_SERVICES, oauthClient, reconnectConsentUrl, servicesGranted, type GoogleService } from '../lib/google.js';
import { isGoogleAuthFailure, orgSourceUserId } from '../lib/tokens.js';
import { GOOGLE_HEALTH_ACTION, latestGoogleHealth, type GoogleHealth } from '../lib/googleHealth.js';
import { gmailFor, sendMessage } from './gmail.js';
import { reconnectEmail } from './emailTemplate.js';

// Health reading lives in lib/googleHealth.ts now, so `/me` and the choice of
// studio source mailbox can read it without dragging the keep-alive (and the
// gmail + email machinery below) in with them. Re-exported so existing callers
// keep importing it from here.
export { GOOGLE_HEALTH_ACTION, latestGoogleHealth, type GoogleHealth };

/**
 * Keep every connected Google account connected.
 *
 * A connection only ever ends by someone pressing Disconnect: nothing here,
 * or anywhere else in the API, sets an integration to `disconnected`. What
 * this does is make sure the grant behind each connection is still alive:
 *
 *  - It refreshes every account's access token on a schedule, so a grant is
 *    never left idle long enough for Google to expire it, and a person who
 *    has not been read for a while is still ready the moment they are.
 *  - A failure that is only the network or Google having a bad minute is
 *    retried, and never reported as needing a reconnect.
 *  - A failure Google says is final (`invalid_grant`: access revoked, the
 *    Google password changed, the grant reset) cannot be repaired by any
 *    token: Google requires the account's owner to approve access again.
 *    It is recorded, so the Team screen can say who needs to reconnect,
 *    and the connection itself is left as it was.
 */

export const RECONNECT_EMAIL_ACTION = 'google.reconnect_email';

interface IntegrationRow {
  org_id: string;
  user_id: string;
  encrypted_tokens: string | null;
  /** Granted scopes, so a reconnect asks for exactly the services they had. */
  scopes: string | null;
}

/** A grant that lapsed this run, with the services the person had connected. */
interface Dropped {
  org_id: string;
  user_id: string;
  services: GoogleService[];
}

const RETRY_DELAYS_MS = [1_000, 4_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One account: refresh, retrying anything that is not Google saying no. */
async function refreshOne(row: IntegrationRow): Promise<GoogleHealth> {
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(decrypt(row.encrypted_tokens ?? ''));
  } catch {
    return { ok: false, reason: 'stored token unreadable (encryption key changed?)' };
  }
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!refreshToken) return { ok: false, reason: 'no refresh token stored' };

  for (let attempt = 0; ; attempt++) {
    try {
      const client = oauthClient();
      // Only the refresh token, so the client has to ask Google for a new
      // access token rather than trusting a cached one.
      client.setCredentials({ refresh_token: refreshToken });
      await client.getAccessToken();

      // Google may, rarely, rotate the refresh token; whatever it sent is
      // kept, and the old refresh token is kept when it sent none.
      const merged = { ...tokens, ...client.credentials, refresh_token: client.credentials.refresh_token || refreshToken };
      await supabaseAdmin!
        .from('integrations')
        .update({ encrypted_tokens: encrypt(JSON.stringify(merged)) })
        .eq('user_id', row.user_id)
        .eq('provider', 'google');
      return { ok: true };
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        const e = err as { message?: string; response?: { data?: { error?: string; error_description?: string } } };
        const d = e.response?.data;
        return { ok: false, reason: [d?.error, d?.error_description].filter(Boolean).join(': ') || e.message || 'invalid_grant' };
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        // Still only transient as far as anyone knows: not a reconnect.
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** When each user was last emailed a reconnect link, so they are not nagged. */
async function latestReconnectEmailAt(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supabaseAdmin || !userIds.length) return out;
  const { data } = await supabaseAdmin
    .from('activity_log')
    .select('entity_id, created_at')
    .eq('action', RECONNECT_EMAIL_ACTION)
    .in('entity_id', userIds)
    .order('created_at', { ascending: false })
    .limit(500);
  for (const row of (data ?? []) as { entity_id: string; created_at: string }[]) {
    if (!out.has(row.entity_id)) out.set(row.entity_id, row.created_at);
  }
  return out;
}

/**
 * Written only when an account's health CHANGES, so a year of healthy
 * refreshes is not a year of audit rows — and the latest row is always the
 * current state.
 */
async function recordIfChanged(row: IntegrationRow, health: GoogleHealth, previous?: GoogleHealth): Promise<void> {
  if (previous && previous.ok === health.ok && previous.reason === health.reason) return;
  if (!previous && health.ok) return; // healthy from the start: nothing to say
  await supabaseAdmin!.from('activity_log').insert({
    org_id: row.org_id,
    actor: null,
    action: GOOGLE_HEALTH_ACTION,
    entity: 'integrations',
    entity_id: row.user_id,
    meta: health,
  });
}

export async function keepGoogleAlive(): Promise<{
  checked: number;
  healthy: number;
  needReconnect: number;
  transient: number;
  reconnectEmails: number;
}> {
  const result = { checked: 0, healthy: 0, needReconnect: 0, transient: 0, reconnectEmails: 0 };
  if (!supabaseAdmin) return result;

  const { data } = await supabaseAdmin
    .from('integrations')
    .select('org_id, user_id, encrypted_tokens, scopes')
    .eq('provider', 'google')
    .eq('status', 'connected');
  const rows = (data ?? []) as IntegrationRow[];
  const userIds = rows.map((r) => r.user_id);
  const previous = await latestGoogleHealth(userIds);
  const emailedAt = await latestReconnectEmailAt(userIds);
  const runStartedAt = new Date().toISOString();

  // Who refreshed cleanly, per studio: the reconnect note has to be SENT from
  // a live mailbox, and a studio's own source account is often the one that
  // dropped — so a dropped person is mailed from whoever is still connected.
  const healthyByOrg = new Map<string, string[]>();
  // Grants that need a reconnect mail this run — one per broken spell, below.
  const dropped: Dropped[] = [];

  for (const row of rows) {
    result.checked++;
    try {
      const health = await refreshOne(row);
      const prev = previous.get(row.user_id);
      if (health.ok) {
        result.healthy++;
        // A sender has to be able to send: only a Gmail-capable account can
        // carry the reconnect note, so a Drive-only grant is not a candidate.
        if (servicesGranted(row.scopes).gmail) {
          healthyByOrg.set(row.org_id, [...(healthyByOrg.get(row.org_id) ?? []), row.user_id]);
        }
      } else {
        result.needReconnect++;
        console.warn(`[google] ${row.user_id} needs to reconnect: ${health.reason}`);
        // Mail once per spell of being refused, not every six hours. The spell
        // began when the grant last changed to bad (or now, if it just did);
        // mail only if we have not already mailed them since that point. This
        // reaches accounts already broken before this shipped, yet never nags
        // one we have already written to about the same drop.
        const brokenSince = prev && !prev.ok ? prev.at : runStartedAt;
        const lastMailed = emailedAt.get(row.user_id);
        if (!lastMailed || lastMailed < brokenSince) {
          const g = servicesGranted(row.scopes);
          dropped.push({ org_id: row.org_id, user_id: row.user_id, services: GOOGLE_SERVICES.filter((s) => g[s]) });
        }
      }
      await recordIfChanged(row, health, prev);
    } catch (err) {
      result.transient++;
      console.warn(`[google] ${row.user_id} refresh failed for now, will retry next run:`, (err as Error).message);
    }
  }

  result.reconnectEmails = await emailTheDropped(dropped, healthyByOrg);
  return result;
}

/**
 * Tell each person whose grant just lapsed, so they can reconnect themselves —
 * the one thing that restores it, since Google will not take a new token for a
 * refused grant. One mail per drop: the transition is read from the health
 * log, so a service restart does not re-send. Best-effort throughout — a mail
 * that will not send must not stop the keep-alive, and a studio with no live
 * mailbox left simply cannot be told, which the Team screen already shows.
 */
async function emailTheDropped(dropped: Dropped[], healthyByOrg: Map<string, string[]>): Promise<number> {
  if (!supabaseAdmin || !dropped.length) return 0;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', dropped.map((d) => d.user_id));
  const profile = new Map(
    ((data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]),
  );

  // Resolved once per studio: its source account if that is among the healthy,
  // otherwise whichever account refreshed cleanly first.
  const senderByOrg = new Map<string, string | null>();
  async function senderFor(orgId: string): Promise<string | null> {
    if (senderByOrg.has(orgId)) return senderByOrg.get(orgId)!;
    const healthy = healthyByOrg.get(orgId) ?? [];
    let id: string | null = null;
    if (healthy.length) {
      const source = await orgSourceUserId(orgId);
      id = source && healthy.includes(source) ? source : healthy[0];
    }
    senderByOrg.set(orgId, id);
    return id;
  }
  const gmailCache = new Map<string, Awaited<ReturnType<typeof gmailFor>>>();

  let sent = 0;
  for (const d of dropped) {
    const person = profile.get(d.user_id);
    if (!person?.email) continue;
    try {
      const senderId = await senderFor(d.org_id);
      if (!senderId) {
        console.warn(`[google] cannot email ${person.email} to reconnect: no live mailbox in their studio`);
        continue;
      }
      if (!gmailCache.has(senderId)) gmailCache.set(senderId, await gmailFor(senderId));
      const gmail = gmailCache.get(senderId) ?? null;
      if (!gmail) continue;

      const service: GoogleService | 'all' = d.services.length === 1 ? d.services[0] : 'all';
      const labels = d.services.map((s): 'Gmail' | 'Drive' => (s === 'gmail' ? 'Gmail' : 'Drive'));
      const mail = reconnectEmail({
        name: person.full_name ?? '',
        url: reconnectConsentUrl(d.user_id, service),
        services: labels.length ? labels : undefined,
      });
      await sendMessage(gmail, { to: person.email, subject: mail.subject, body: mail.text, html: mail.html });
      sent++;

      await supabaseAdmin.from('activity_log').insert({
        org_id: d.org_id,
        actor: null,
        action: RECONNECT_EMAIL_ACTION,
        entity: 'integrations',
        entity_id: d.user_id,
        meta: { email: person.email },
      });
    } catch (err) {
      console.error(`[google] reconnect email to ${person.email} failed:`, (err as Error).message);
    }
  }
  return sent;
}
