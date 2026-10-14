import type { OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from './supabase.js';
import { decrypt, encrypt } from './crypto.js';
import { oauthClient, servicesGranted, type GoogleService } from './google.js';
import { latestGoogleHealth } from './googleHealth.js';

/**
 * Build a Google OAuth2 client authenticated as a given user, using
 * their stored (encrypted) tokens. Returns null when the user has no
 * connected Google integration. Refreshed tokens are persisted back.
 */
/**
 * Whether this error means the stored Google grant is no longer usable.
 *
 * Google answers a refresh with `invalid_client` when the credentials in
 * the environment are not the ones that issued the refresh token — the
 * usual cause is the OAuth client being rotated or replaced while a token
 * from the old one is still in the database. `invalid_grant` is the same
 * problem from the other end: the user revoked access, or the token
 * expired from disuse.
 *
 * Neither is retryable and neither is a bug. They need a person to
 * reconnect Google, so callers report that rather than failing as though
 * the server broke.
 */
export function isGoogleAuthFailure(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } } | null;
  const code = e?.response?.data?.error ?? '';
  const message = e?.message ?? '';
  return /invalid_client|invalid_grant|unauthorized_client/i.test(`${code} ${message}`);
}

export async function googleClientForUser(userId: string, service?: GoogleService): Promise<OAuth2Client | null> {
  if (!supabaseAdmin) return null;

  const { data: integration } = await supabaseAdmin
    .from('integrations')
    .select('encrypted_tokens, status, scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();

  if (!integration?.encrypted_tokens || integration.status !== 'connected') return null;
  if (service && !servicesGranted(integration.scopes)[service]) return null;

  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(decrypt(integration.encrypted_tokens));
  } catch {
    return null;
  }

  const client = oauthClient();
  client.setCredentials(tokens);

  // Persist refreshed tokens so the refresh token is not lost.
  client.on('tokens', async (fresh) => {
    const merged = { ...tokens, ...fresh };
    if (!supabaseAdmin) return;
    await supabaseAdmin
      .from('integrations')
      .update({ encrypted_tokens: encrypt(JSON.stringify(merged)) })
      .eq('user_id', userId)
      .eq('provider', 'google');
  });

  return client;
}

/**
 * The user whose Google account acts as the org's ingestion source.
 * For now this is the principal; later this can be configurable.
 */
/**
 * Everyone in the studio whose Google is connected, principal or not.
 *
 * `orgSourceUserId` answers "whose mailbox speaks for the studio" and
 * returns exactly one. That was the whole model while a single shared
 * address fed everything — and it meant a team member connecting their own
 * Google achieved nothing at all: the reading pass never looked at it.
 *
 * Oldest connection first, so the studio's own mailbox — connected long
 * before anyone else's — is read first and its mail keeps being filed as
 * the shared history rather than as somebody's personal copy.
 */
export async function connectedMailboxUserIds(orgId: string): Promise<string[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from('integrations')
    .select('user_id, profiles!inner(org_id)')
    .eq('org_id', orgId)
    .eq('provider', 'google')
    .eq('status', 'connected')
    .order('connected_at', { ascending: true });
  return [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id).filter(Boolean))];
}

export async function orgSourceUserId(orgId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  // The principal who actually connected Google. "Any principal" was fine
  // with one; with a second added on Team & roles, whichever the database
  // returned first became the source — often the one with no Google
  // connection, and reading stopped.
  const { data: connectedRows } = await supabaseAdmin
    .from('integrations')
    .select('user_id, profiles!inner(role, org_id)')
    .eq('org_id', orgId)
    .eq('provider', 'google')
    .eq('status', 'connected')
    .eq('profiles.role', 'principal')
    .order('connected_at', { ascending: true });
  const connected = ((connectedRows ?? []) as { user_id: string | null }[])
    .map((r) => r.user_id)
    .filter((id): id is string => Boolean(id));

  if (connected.length) {
    // Prefer a grant Google still ACCEPTS. `status` only says someone once
    // connected and has not pressed Disconnect — it stays "connected" after
    // Google has refused the grant, so choosing the oldest connected principal
    // made a dead mailbox the voice of the studio while a working one sat
    // right beside it (the account could not read or send a thing, yet every
    // lookup went through it). The first connected principal with no standing
    // refusal wins; if every one is refused, the oldest still stands, so this
    // never does worse than before — it only ever picks a better account.
    const health = await latestGoogleHealth(connected);
    return connected.find((id) => health.get(id)?.ok !== false) ?? connected[0];
  }

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .eq('role', 'principal')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
