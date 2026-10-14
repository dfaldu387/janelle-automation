import { supabaseAdmin } from './supabase.js';

/**
 * The last word on whether Google still accepts each connected grant.
 *
 * Written by the keep-alive (services/googleKeepalive.ts) as `google.health`
 * rows in the audit log, and read here by everything that needs to know the
 * truth rather than the stored `status`: the Team screen, `/me`, the reconnect
 * prompt, and the choice of which mailbox speaks for the studio. Kept in its
 * own lib module so a route or `orgSourceUserId` can read health without
 * pulling in the keep-alive — and the gmail and email machinery behind it.
 */

export const GOOGLE_HEALTH_ACTION = 'google.health';

export interface GoogleHealth {
  ok: boolean;
  /** Why it failed, in Google's words. */
  reason?: string;
}

/** The last recorded health per user, newest first. */
export async function latestGoogleHealth(userIds: string[]): Promise<Map<string, GoogleHealth & { at: string }>> {
  const out = new Map<string, GoogleHealth & { at: string }>();
  if (!supabaseAdmin || !userIds.length) return out;
  const { data } = await supabaseAdmin
    .from('activity_log')
    .select('entity_id, meta, created_at')
    .eq('action', GOOGLE_HEALTH_ACTION)
    .in('entity_id', userIds)
    .order('created_at', { ascending: false })
    .limit(500);
  for (const row of (data ?? []) as { entity_id: string; meta: GoogleHealth | null; created_at: string }[]) {
    if (!out.has(row.entity_id) && row.meta) out.set(row.entity_id, { ...row.meta, at: row.created_at });
  }
  return out;
}
