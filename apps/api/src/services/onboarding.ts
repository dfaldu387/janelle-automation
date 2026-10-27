import { supabaseAdmin } from '../lib/supabase.js';
import { reconnectConsentUrl } from '../lib/google.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { disabledUserIds } from '../lib/userStatus.js';
import { deliveryAddressFor } from '../lib/studioTeam.js';
import { gmailFor, createDraft } from './gmail.js';
import { connectInviteEmail } from './emailTemplate.js';

/**
 * Draft the "connect your Google" invite for every teammate who is set up on
 * the system but has never connected their account — so their inbox is unread
 * and the work emailed to them lands on nobody's board.
 *
 * Why drafts, not sends: these go to real people, and some rows are stale (a
 * teammate who has left but whose profile lingers). The studio asked to see
 * each one before it goes out, so this writes a Gmail draft into the studio's
 * own mailbox and stops there — whoever runs the studio reviews each, edits if
 * they like, and sends from Gmail. Nothing here ever sends.
 *
 * Safe to run again: a teammate drafted within the last week is skipped, so a
 * second run does not pile duplicate drafts on top of the first.
 */

export const CONNECT_INVITE_ACTION = 'onboarding.connect_invite_drafted';

/** Don't re-draft someone drafted within this window. */
const REDRAFT_COOLDOWN_MS = 7 * 24 * 3600_000;

export interface ConnectInviteResult {
  ok: boolean;
  reason?: string;
  /** Drafts written into the studio mailbox this run. */
  drafted: number;
  /** Unconnected teammates skipped because one was drafted for them recently. */
  skippedRecent: number;
  /** Names/emails drafted, most open work first — so the person most worth connecting leads. */
  people: { name: string; email: string; liveTasks: number }[];
}

/** When each user was last sent a connect-invite draft, so none is re-drafted. */
async function lastDraftedAt(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supabaseAdmin || !userIds.length) return out;
  const { data } = await supabaseAdmin
    .from('activity_log')
    .select('entity_id, created_at')
    .eq('action', CONNECT_INVITE_ACTION)
    .in('entity_id', userIds)
    .order('created_at', { ascending: false })
    .limit(500);
  for (const row of (data ?? []) as { entity_id: string; created_at: string }[]) {
    if (!out.has(row.entity_id)) out.set(row.entity_id, row.created_at);
  }
  return out;
}

export async function draftConnectInvites(orgId: string): Promise<ConnectInviteResult> {
  const empty = { drafted: 0, skippedRecent: 0, people: [] };
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', ...empty };

  // The roster: everyone in the studio with a real sign-in address.
  const { data: profileRows } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const profiles = ((profileRows ?? []) as { id: string; full_name: string | null; email: string | null }[])
    .filter((p) => p.email && p.email.includes('@'));
  if (!profiles.length) return { ok: true, ...empty };

  const ids = profiles.map((p) => p.id);

  // Who is already connected — a connected Google integration means their mail
  // is read, so they need no invite.
  const connected = new Set<string>();
  const { data: integrations } = await supabaseAdmin
    .from('integrations')
    .select('user_id, status')
    .eq('provider', 'google')
    .in('user_id', ids);
  for (const row of (integrations ?? []) as { user_id: string; status: string }[]) {
    if (row.status === 'connected') connected.add(row.user_id);
  }

  // Disabled sign-ins (a teammate who has left) are not invited back in.
  const disabled = await disabledUserIds(ids);

  // How much live work each person carries, so the invites are ordered with the
  // most-loaded unconnected teammate first — the one whose unread inbox is
  // costing the studio most (on the walkthrough, Adelaide: many open, not on).
  const { data: tasks } = await supabaseAdmin
    .from('tasks')
    .select('assigned_to')
    .eq('org_id', orgId)
    .in('status', ['open', 'in_progress', 'blocked']);
  const load = new Map<string, number>();
  for (const t of (tasks ?? []) as { assigned_to: string | null }[]) {
    if (t.assigned_to) load.set(t.assigned_to, (load.get(t.assigned_to) ?? 0) + 1);
  }

  const targets = profiles
    .filter((p) => !connected.has(p.id) && !disabled.has(p.id))
    .sort((a, b) => (load.get(b.id) ?? 0) - (load.get(a.id) ?? 0));
  if (!targets.length) return { ok: true, ...empty };

  // Draft into the studio's own source mailbox — that is where the person who
  // runs the studio reviews and sends from.
  const senderId = await orgSourceUserId(orgId);
  const gmail = senderId ? await gmailFor(senderId) : null;
  if (!gmail) return { ok: false, reason: 'no_source_mailbox', ...empty };

  const drafted = await lastDraftedAt(targets.map((p) => p.id));
  const now = Date.now();

  const result: ConnectInviteResult = { ok: true, drafted: 0, skippedRecent: 0, people: [] };

  for (const p of targets) {
    const recent = drafted.get(p.id);
    if (recent && now - new Date(recent).getTime() < REDRAFT_COOLDOWN_MS) {
      result.skippedRecent++;
      continue;
    }
    try {
      const mail = connectInviteEmail({ name: p.full_name ?? '', url: reconnectConsentUrl(p.id, 'all') });
      // Write to where a mailboxless teammate actually reads (their personal
      // Gmail), the same routing the reconnect nudge uses.
      await createDraft(gmail, {
        to: deliveryAddressFor(p.email),
        subject: mail.subject,
        body: mail.text,
        html: mail.html,
      });
      result.drafted++;
      result.people.push({ name: p.full_name ?? p.email!, email: p.email!, liveTasks: load.get(p.id) ?? 0 });

      await supabaseAdmin.from('activity_log').insert({
        org_id: orgId,
        actor: null,
        action: CONNECT_INVITE_ACTION,
        entity: 'profiles',
        entity_id: p.id,
        meta: { email: p.email, live_tasks: load.get(p.id) ?? 0 },
      });
    } catch (err) {
      console.error(`[onboarding] connect-invite draft for ${p.email} failed:`, (err as Error).message);
    }
  }

  return result;
}
