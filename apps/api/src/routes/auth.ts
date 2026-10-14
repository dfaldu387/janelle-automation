import { Router } from 'express';
import { env, isGoogleConfigured } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import {
  consentUrl,
  oauthClient,
  servicesGranted,
  scopesFor,
  signState,
  verifyState,
  type GoogleService,
  type ReturnTo,
} from '../lib/google.js';
import { decrypt } from '../lib/crypto.js';
import { encrypt } from '../lib/crypto.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { runIngest } from '../services/ingest.js';

export const authRouter = Router();

// The OAuth state signer and the two fixed return destinations live in
// lib/google.ts, so the keep-alive can mint the same kind of signed consent
// link when it emails someone to reconnect. `ReturnTo` is carried inside the
// signed state rather than a query parameter: the round trip goes out to
// Google and back, and anything not signed could be changed on the way — an
// open redirect is exactly how that goes wrong.

function parseService(raw: unknown): GoogleService | 'all' {
  return raw === 'gmail' || raw === 'drive' ? raw : 'all';
}

// Step 1 — the web app asks for the consent URL (must be signed in).
// `?service=gmail|drive` limits the request to that service; omit for both.
authRouter.get(
  '/google/url',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({ error: 'Google integration is not configured on the server' });
    }
    const service = parseService(req.query.service);
    // Only the two names are accepted; anything else lands on Settings.
    const next: ReturnTo = req.query.next === 'dashboard' ? 'dashboard' : 'settings';
    const url = consentUrl(signState(req.auth!.userId, service, next), service);
    res.json({ data: { url } });
  }),
);

// Step 2 — Google redirects here with an authorization code.
authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const code = String(req.query.code ?? '');
    const state = verifyState(String(req.query.state ?? ''));
    const webApp = env.corsOrigins[0] ?? 'http://localhost:5173';
    const service = state?.service ?? 'all';

    if (!code || !state || !supabaseAdmin) {
      return res.redirect(`${webApp}/settings?google=error&service=${service}`);
    }
    const { userId } = state;

    const client = oauthClient();
    const { tokens } = await client.getToken(code);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .maybeSingle();

    if (!profile?.org_id) {
      return res.redirect(`${webApp}/settings?google=error&service=${service}`);
    }

    // Incremental auth: the new token covers previously granted scopes too,
    // so merge Google's reported scope set with what we already stored.
    const { data: existing } = await supabaseAdmin
      .from('integrations')
      .select('scopes, encrypted_tokens')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle();
    const granted = new Set<string>([
      ...(existing?.scopes ?? '').split(/\s+/).filter(Boolean),
      ...String(tokens.scope ?? scopesFor(parseService(service)).join(' ')).split(/\s+/).filter(Boolean),
    ]);

    // Keep an earlier refresh token if Google did not issue a new one.
    let merged: Record<string, unknown> = { ...tokens };
    if (!tokens.refresh_token && existing?.encrypted_tokens) {
      try {
        const prev = JSON.parse(decrypt(existing.encrypted_tokens)) as Record<string, unknown>;
        if (prev.refresh_token) merged = { ...prev, ...tokens };
      } catch {
        /* fall through with fresh tokens only */
      }
    }

    await supabaseAdmin.from('integrations').upsert(
      {
        org_id: profile.org_id,
        user_id: userId,
        provider: 'google',
        encrypted_tokens: encrypt(JSON.stringify(merged)),
        scopes: [...granted].join(' '),
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' },
    );

    await supabaseAdmin.from('activity_log').insert({
      org_id: profile.org_id,
      actor: userId,
      action: 'google.connect',
      entity: 'integrations',
      entity_id: userId,
      meta: { service, ...servicesGranted([...granted].join(' ')) },
    });

    // Read their last thirty days straight away, rather than leaving them
    // with an empty system until the half-hourly scheduler next comes round.
    //
    // Deliberately not awaited: a first sync is minutes of Gmail and Claude
    // work, and this request is an OAuth redirect the browser is holding
    // open. It starts here and carries on after the person lands back in
    // Settings; the watermark makes it resumable if it is cut short, and
    // only mail overlapping the studio's own correspondence is fetched.
    if (servicesGranted([...granted].join(' ')).gmail) {
      void runIngest(profile.org_id, { onlyUserId: userId, budgetMs: 45_000 })
        .then((r) => {
          if (r.ok) console.log(`[auth] first sync for ${userId}: ${r.emails} email(s), ${r.tasks} task(s)`);
          else console.warn(`[auth] first sync for ${userId} did not run: ${r.reason}`);
        })
        .catch((err) => console.error('[auth] first sync failed:', (err as Error).message));
    }

    // Back where they started: Settings when they went looking for it, the
    // dashboard when this was the first-run prompt after an invitation.
    const landing = state.next === 'dashboard' ? '/' : '/settings';
    res.redirect(`${webApp}${landing}?google=connected&service=${service}`);
  }),
);

/**
 * Revoke the Google grant and clear it locally. Best-effort on the revoke:
 * a token Google has already invalidated should still disconnect here.
 */
async function revokeGoogle(userId: string): Promise<void> {
  if (!supabaseAdmin) return;

  const { data: integration } = await supabaseAdmin
    .from('integrations')
    .select('org_id, encrypted_tokens')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();

  if (integration?.encrypted_tokens) {
    try {
      const tokens = JSON.parse(decrypt(integration.encrypted_tokens)) as { refresh_token?: string; access_token?: string };
      const token = tokens.refresh_token ?? tokens.access_token;
      if (token) await oauthClient().revokeToken(token);
    } catch {
      /* token may already be invalid — still disconnect locally */
    }
  }

  await supabaseAdmin
    .from('integrations')
    .update({ status: 'disconnected', encrypted_tokens: null, scopes: '' })
    .eq('user_id', userId)
    .eq('provider', 'google');

  if (integration?.org_id) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: integration.org_id,
      actor: userId,
      action: 'google.disconnect',
      entity: 'integrations',
      entity_id: userId,
      meta: {},
    });
  }
}

// Disconnect Google entirely: revoke the token best-effort and mark the
// integration disconnected. Both Gmail and Drive stop working until reconnected.
authRouter.delete(
  '/google',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    await revokeGoogle(req.auth!.userId);
    res.json({ data: { ok: true } });
  }),
);

/**
 * Disconnect ONE service, leaving the other working.
 *
 * Google issues a single grant covering both services, and its revoke
 * endpoint is all-or-nothing — there is no way to hand back just
 * drive.readonly. What is ours to control is which scopes this app holds
 * and uses, so that is what this drops: Drive stops being read, Gmail
 * carries on, and reconnecting is one consent screen away (Google
 * re-grants an already-approved scope without a second prompt).
 *
 * When the last service goes, fall through to the full disconnect so a
 * revoked-looking integration is actually revoked rather than left as a
 * live token with no scopes.
 */
authRouter.delete(
  '/google/:service',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const { userId } = req.auth!;

    const service = req.params.service;
    if (service !== 'gmail' && service !== 'drive') {
      return res.status(400).json({ error: 'Unknown service' });
    }

    const { data: integration } = await supabaseAdmin
      .from('integrations')
      .select('org_id, scopes, encrypted_tokens')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle();

    if (!integration) return res.status(404).json({ error: 'Google is not connected' });

    const row = integration as { org_id: string | null; scopes: string | null };
    const dropped = new Set(scopesFor(service));
    const remaining = (row.scopes ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((s) => !dropped.has(s));

    // Nothing left to use — revoke the grant properly instead of keeping a
    // token the app no longer has any reason to hold.
    const stillUsed = servicesGranted(remaining.join(' '));
    if (!stillUsed.gmail && !stillUsed.drive) {
      await revokeGoogle(userId);
      return res.json({ data: { ok: true, services: stillUsed } });
    }

    await supabaseAdmin
      .from('integrations')
      .update({ scopes: remaining.join(' ') })
      .eq('user_id', userId)
      .eq('provider', 'google');

    if (row.org_id) {
      await supabaseAdmin.from('activity_log').insert({
        org_id: row.org_id,
        actor: userId,
        action: 'google.disconnect_service',
        entity: 'integrations',
        entity_id: userId,
        meta: { service, remaining: stillUsed },
      });
    }

    res.json({ data: { ok: true, services: stillUsed } });
  }),
);

// Bootstrap — ensure the signed-in user has an org + profile.
// First user of a fresh install becomes the principal and creates the
// organization; later users join it (as assistant) pending role change.
authRouter.post(
  '/bootstrap',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const { userId, email } = req.auth!;

    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, org_id, role, full_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (existing?.org_id) return res.json({ data: existing });

    const { data: orgs } = await supabaseAdmin.from('organizations').select('id').limit(1);
    let orgId = orgs?.[0]?.id as string | undefined;
    let role: 'principal' | 'assistant' = 'assistant';
    if (!orgId) {
      const { data: newOrg } = await supabaseAdmin
        .from('organizations')
        .insert({
          name: 'Janelle Interiors',
          settings: { vendor_silence_days: 3, client_approval_days: 5, report_day: 'monday' },
        })
        .select('id')
        .maybeSingle();
      orgId = newOrg?.id;
      role = 'principal';
    }

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const fullName =
      (authUser?.user?.user_metadata?.full_name as string) ??
      (authUser?.user?.user_metadata?.name as string) ??
      (email ? email.split('@')[0] : null);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: userId, org_id: orgId, email, full_name: fullName, role })
      .select('id, org_id, role, full_name, email')
      .maybeSingle();

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: userId,
      action: 'auth.bootstrap',
      entity: 'profiles',
      entity_id: userId,
      meta: { role },
    });

    res.json({ data: profile });
  }),
);

// Disconnect — remove stored tokens for the current user.
authRouter.post(
  '/google/disconnect',
  requireAuth,
  asyncHandler(async (req, res) => {
    await req.auth!.db
      .from('integrations')
      .update({ status: 'disconnected', encrypted_tokens: null, connected_at: null })
      .eq('user_id', req.auth!.userId)
      .eq('provider', 'google');
    res.json({ data: { ok: true } });
  }),
);
