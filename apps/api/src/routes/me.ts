import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { servicesGranted } from '../lib/google.js';
import { hasTaskComments, profileColumns } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { latestGoogleHealth } from '../lib/googleHealth.js';
import { RESOURCES, canWith } from '@janelle/shared';

export const meRouter = Router();

// Current user's profile + org + Google connection status.
meRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { db, userId } = req.auth!;

    // The connection is read as the server, scoped to the verified user id,
    // and a failed read is reported as `unknown` — never as `disconnected`.
    // The web app locks the screen behind "Connect Gmail & Drive" on
    // `disconnected`, and it asks on every session refresh (hourly, and when
    // a sleeping laptop wakes), so one dropped read used to send people
    // through Google consent again with a grant that was working fine.
    const [{ data: profile }, { data: integration, error: integrationError }] = await Promise.all([
      db.from('profiles').select(await profileColumns('id, org_id, full_name, email, role, avatar_url')).eq('id', userId).maybeSingle(),
      (supabaseAdmin ?? db).from('integrations').select('status, connected_at, scopes').eq('user_id', userId).eq('provider', 'google').maybeSingle(),
    ]);
    if (integrationError) console.error('[me] google status unreadable:', integrationError.message);

    const connected = integration?.status === 'connected';
    const services = connected ? servicesGranted(integration?.scopes) : { gmail: false, drive: false };

    // A grant Google has REFUSED since it was connected: the status still
    // reads "connected", but nothing can be read until the person approves
    // again, and no token can repair it. Surfaced so the app can prompt them
    // to reconnect the moment they sign in, rather than leaving them staring
    // at stale mail with no sign anything is wrong. Mirrors Team & Roles.
    let needsReconnect: string | null = null;
    if (connected) {
      const h = (await latestGoogleHealth([userId])).get(userId);
      if (h && !h.ok && (!integration?.connected_at || h.at > integration.connected_at)) {
        needsReconnect = h.reason ?? 'Google refused the stored access';
      }
    }

    // What this person may actually do, with the studio's overrides already
    // applied. The client had no way to ask: it rendered every page to
    // everybody and found out on the 403. Now a module the role cannot view
    // simply is not offered.
    const role = req.auth!.role;
    const access = Object.fromEntries(
      RESOURCES.map((resource) => [
        resource,
        {
          read: canWith(req.auth!.permissions, role, resource, 'read'),
          create: canWith(req.auth!.permissions, role, resource, 'create'),
          update: canWith(req.auth!.permissions, role, resource, 'update'),
          delete: canWith(req.auth!.permissions, role, resource, 'delete'),
        },
      ]),
    );

    res.json({
      data: {
        profile,
        access,
        google: {
          status: integrationError ? 'unknown' : integration?.status ?? 'disconnected',
          connected_at: integration?.connected_at ?? null,
          scopes: integration?.scopes ?? '',
          services,
          // Null unless the grant is connected-but-refused; carries Google's
          // reason, for the reconnect prompt.
          needs_reconnect: needsReconnect,
        },
      },
    });
  }),
);

/**
 * What I have been pulled into and not yet looked at.
 *
 * The bell is a derived view — it counts open follow-ups and waiting drafts,
 * neither of which has a read state, so neither can ever be "seen". A
 * mention is different: it is addressed to one person and it is finished
 * with once they have read it. Hence `read_at` rather than a status, and
 * hence this being the only thing in the panel that can go back to zero.
 */
meRouter.get(
  '/mentions',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await hasTaskComments())) return res.json({ data: [] });
    const { db, userId } = req.auth!;

    const { data, error } = await db
      .from('task_comment_mentions')
      .select('id, task_id, created_at, task_comments(body, profiles(full_name)), tasks(title)')
      .eq('user_id', userId)
      .is('read_at', null)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

/**
 * Mark mentions read — the ones listed, or everything when none are named.
 *
 * Scoped to the caller in the filter as well as by RLS: "mark read" that
 * could be aimed at somebody else's bell is a way to make their mentions
 * disappear unseen.
 */
meRouter.post(
  '/mentions/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!(await hasTaskComments())) return res.json({ data: { read: 0 } });
    const { db, userId } = req.auth!;

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 100) : null;
    let q = db
      .from('task_comment_mentions')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null);
    if (ids?.length) q = q.in('id', ids);

    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    res.json({ data: { read: data?.length ?? 0 } });
  }),
);
