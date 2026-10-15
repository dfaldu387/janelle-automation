import { supabaseAdmin } from './supabase.js';
import { orgSourceUserId } from './tokens.js';

/**
 * The Gmail address a connected account reads from, as captured at ingest
 * (migration 0038). Null when nothing is stored yet — a fresh connection
 * before its first read, or a database that predates the column.
 */
async function accountEmailFor(userId: string | null): Promise<string | null> {
  if (!supabaseAdmin || !userId) return null;
  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select('account_email')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();
  // 42703 = column missing (migration not applied); any error means "unknown".
  if (error) return null;
  return ((data as { account_email?: string | null } | null)?.account_email ?? '') || null;
}

/**
 * The Google account "Open in Gmail" should target: the owner's own connected
 * mailbox when a message names one, otherwise the studio's shared ingestion
 * account. Used to build ?authuser=<address> links that open the right account
 * whatever its index is in the viewer's Chrome profile. Null when nothing is
 * connected yet, in which case links fall back to the old index form.
 */
export async function mailboxEmail(orgId: string | null, ownerId: string | null = null): Promise<string | null> {
  if (!orgId) return null;
  const own = await accountEmailFor(ownerId);
  if (own) return own;
  return accountEmailFor(await orgSourceUserId(orgId));
}
