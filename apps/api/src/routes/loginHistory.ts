import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasColumn } from '../lib/columns.js';
import { isPrivateAddress, locate } from '../lib/geoip.js';
import { decodeClaims, methodFromToken } from '../lib/signInMethod.js';

/**
 * Who signed in, when, how — and who could not.
 *
 * Two halves that look unrelated and are not:
 *
 *   POST /event  — the browser reporting an attempt. Takes no session,
 *                  because the attempts worth recording are the ones where
 *                  there is no session to show.
 *   GET  /       — the Login history screen. Supervisors only.
 *
 * The write is deliberately forgiving and the read deliberately strict. A
 * sign-in screen must never be made worse by the thing watching it, so
 * every failure path in the write ends in `{ ok: true }` and a server-side
 * log, rather than an error the person trying to sign in has to read.
 */
export const loginHistoryRouter = Router();

/** Whether migration 0034 has been applied. */
function hasLoginEvents(): Promise<boolean> {
  return hasColumn('login_events', 'id');
}

/** Whether sign-ins carry a place yet — migration 0035. */
function hasLocation(): Promise<boolean> {
  return hasColumn('login_events', 'city');
}

/** Whether a row can say where its address came from — migration 0036. */
function hasIpSource(): Promise<boolean> {
  return hasColumn('login_events', 'ip_source');
}

/** Whether a row can name the session it belongs to — migration 0037. */
function hasSessionId(): Promise<boolean> {
  return hasColumn('login_events', 'session_id');
}

/**
 * An address shaped like one, and routable.
 *
 * Applied to whatever the browser claims before any of it is believed:
 * it reaches the row, so it must not be able to put arbitrary text in a
 * column, nor send the geolocation service something that is not an
 * address at all.
 */
function publicAddress(raw: unknown): string | null {
  const value = clip(raw, 64);
  if (!value) return null;
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const v6 = /^[0-9a-fA-F:]{3,45}$/;
  if (!v4.test(value) && !v6.test(value)) return null;
  if (v4.test(value) && value.split('.').some((o) => Number(o) > 255)) return null;
  // A private address from the browser is no more useful than one from the
  // connection, and is not worth marking a row as client-sourced for.
  return isPrivateAddress(value) ? null : value;
}

const METHODS = ['password', 'google', 'recovery', 'invite', 'unknown'] as const;
type Method = (typeof METHODS)[number];

function parseMethod(raw: unknown): Method {
  return (METHODS as readonly string[]).includes(String(raw)) ? (String(raw) as Method) : 'unknown';
}

/** Trim to something a text column should hold, or null. */
function clip(raw: unknown, max: number): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value ? value.slice(0, max) : null;
}

function parseEmail(raw: unknown): string | null {
  const value = clip(raw, 320);
  return value ? value.toLowerCase() : null;
}

/**
 * The caller's address, as near as a proxy lets us get.
 *
 * nginx sits in front of this in the studio's deployment, so `req.ip` is
 * the proxy unless Express is told to trust it — which it is not, app-wide,
 * and turning that on changes how every other route reads addresses. The
 * header is read here instead, where being approximately right is useful
 * and being wrong costs nothing: this is a column on an audit row, not an
 * access decision.
 */
function callerIp(req: { header: (name: string) => string | undefined; ip?: string }): string | null {
  const forwarded = req.header('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  const ip = first || req.header('x-real-ip') || req.ip || '';
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) reads as noise on screen.
  return clip(ip.replace(/^::ffff:/, ''), 64);
}

/**
 * How many reports one address may file before we stop writing them down.
 *
 * The endpoint is open by necessity, so somebody could sit and post to it.
 * The cap is per address per window, generous enough that a person
 * genuinely struggling to sign in — several wrong passwords, a Google round
 * trip, a reset — is never silently dropped.
 *
 * In memory, which means per process: the studio runs one PM2 process, so
 * this holds. On a serverless deploy it degrades to a per-instance cap,
 * which is still a cap.
 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 30;
const recent = new Map<string, { count: number; until: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const seen = recent.get(key);
  if (!seen || seen.until < now) {
    recent.set(key, { count: 1, until: now + RATE_WINDOW_MS });
    // Opportunistic sweep, so the map cannot grow without bound.
    if (recent.size > 500) {
      for (const [k, v] of recent) if (v.until < now) recent.delete(k);
    }
    return false;
  }
  seen.count += 1;
  return seen.count > RATE_MAX;
}

/**
 * Record an attempt.
 *
 * Unauthenticated, with one rule that makes that safe to allow: a claimed
 * SUCCESS is only believed when it arrives with a working token, and the
 * identity then comes from the token rather than from the body. A failure
 * needs no proof — there is nothing to gain by inventing one, and refusing
 * them would lose exactly the rows this table exists for.
 */
loginHistoryRouter.post(
  '/event',
  asyncHandler(async (req, res) => {
    // Answered the same way whatever happens inside: the sign-in screen is
    // waiting on this, and it must not learn anything from the shape of the
    // reply — nor be delayed by it.
    const done = () => res.json({ data: { ok: true } });

    if (!supabaseAdmin || !(await hasLoginEvents())) return done();

    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = body.outcome === 'success' ? 'success' : 'failure';
    // What the browser says it tried. Overridden below by what the token
    // proves, whenever there is a token to read.
    let method = parseMethod(body.method);

    /*
     * Which address goes on the row.
     *
     * What the API observed wins whenever it is a real one: it watched the
     * connection arrive, and nothing the browser sends can contradict that.
     * The fallback exists for the case where the observation is worthless —
     * the API reached directly on localhost, or a proxy that does not pass
     * the caller on — where the choice is a client-asserted address or no
     * location at all, for ever.
     */
    const observed = callerIp(req);
    const claimed = publicAddress(body.clientIp);
    const usable = observed && !isPrivateAddress(observed) ? observed : null;
    const ip = usable ?? claimed ?? observed;
    const ipSource: 'server' | 'client' = usable || !claimed ? 'server' : 'client';

    // Rate-limited on what was observed, never on what was claimed: the
    // claim is the part somebody could vary to get around the cap.
    if (rateLimited(observed ?? 'unknown')) return done();

    let userId: string | null = null;
    let orgId: string | null = null;
    let email = parseEmail(body.email);

    // A success has to prove who it is, and the token is what proves it.
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let sessionId: string | null = null;
    if (token) {
      const { data } = await supabaseAdmin.auth.getUser(token);
      if (data?.user) {
        userId = data.user.id;
        email = data.user.email?.toLowerCase() ?? email;
        const claims = decodeClaims(token);
        // The signed token outranks the browser's account of itself.
        const proven = methodFromToken(claims, data.user.identities ?? null);
        if (proven) method = proven;
        sessionId = typeof claims?.session_id === 'string' ? claims.session_id : null;
      }
    }

    // Nothing to back it up. Dropped rather than written down as hearsay.
    if (outcome === 'success' && !userId) return done();

    /*
     * One row per session, which is one row per actual sign-in.
     *
     * The browser reports a success every time it restores a session, not
     * only when one is created — it cannot reliably tell the difference,
     * and the memory it used to tell them apart lives in localStorage,
     * which is per origin and routinely cleared. So the question is
     * settled here instead, against the session the token names.
     *
     * The unique index added by 0037 is what actually enforces this; the
     * check is only to avoid a pointless insert in the ordinary case.
     */
    const tracksSessions = await hasSessionId();
    if (outcome === 'success' && sessionId && tracksSessions) {
      const { data: already } = await supabaseAdmin
        .from('login_events')
        .select('id')
        .eq('session_id', sessionId)
        .eq('outcome', 'success')
        .limit(1)
        .maybeSingle();
      if (already) return done();
    }

    // Tie the row to a person where we can, so the screen can group by them
    // and so "last successful sign-in" is answerable per profile.
    if (userId || email) {
      const base = supabaseAdmin.from('profiles').select('id, org_id, email').limit(1);
      const { data: profile } = await (userId ? base.eq('id', userId) : base.eq('email', email!)).maybeSingle();
      if (profile) {
        userId = profile.id;
        orgId = profile.org_id ?? null;
        email = email ?? profile.email?.toLowerCase() ?? null;
      }
    }

    const row: Record<string, unknown> = {
      org_id: orgId,
      user_id: userId,
      email,
      method,
      outcome,
      reason: outcome === 'failure' ? clip(body.reason, 500) : null,
      ip,
      user_agent: clip(req.header('user-agent'), 400),
      source: 'app',
    };

    // Resolved now rather than when the screen is read: this is evidence of
    // where somebody was at the time, and an address looked up months later
    // answers a different question. Skipped entirely before 0035, so the
    // insert never names a column the database does not have.
    if (await hasLocation()) {
      const place = await locate(ip);
      row.city = place.city;
      row.region = place.region;
      row.country = place.country;
      row.country_code = place.countryCode;
    }

    // Said out loud, so a client-asserted address is never mistaken for an
    // observed one when somebody reads this back months later.
    if (await hasIpSource()) row.ip_source = ipSource;
    if (tracksSessions && sessionId) row.session_id = sessionId;

    const { error } = await supabaseAdmin.from('login_events').insert(row);
    // A unique violation is the index doing its job — two tabs restoring
    // one session at the same moment — and is not worth a line in the log.
    if (error && error.code !== '23505') {
      // Logged, not raised: a sign-in must not fail because its audit row did.
      console.error('[login-history] could not record an attempt:', error.message);
    }

    return done();
  }),
);

export interface LoginEventRow {
  id: string;
  created_at: string;
  email: string | null;
  method: Method;
  outcome: 'success' | 'failure';
  reason: string | null;
  /** Kept for a real investigation; the screen shows the place instead. */
  ip: string | null;
  user_agent: string | null;
  source: 'app' | 'backfill';
  user_id: string | null;
  /** The person's name, where the attempt resolved to a profile. */
  name: string | null;
  /** Where the address was when the attempt happened. Null before 0035. */
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  /** 'server' observed it; 'client' was told it. Null before 0036. */
  ip_source: 'server' | 'client' | null;
}

/**
 * Read the history.
 *
 * Supervisors only, matching the audit log — this carries addresses and
 * devices, and is a sharper instrument than the activity trail.
 *
 * Read through the service role rather than the caller's RLS-scoped client,
 * because the rows that matter most have no org_id to match: an attempt by
 * an address belonging to nobody. Scoped here instead, to this studio's
 * rows plus the unattributed ones.
 */
loginHistoryRouter.get(
  '/',
  requireAuth,
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    // Deploying and migrating are separate acts here, so the screen says
    // "apply 0034" rather than showing an error.
    if (!(await hasLoginEvents())) {
      return res.json({ data: { ready: false, days: 0, rows: [], summary: null } });
    }

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const orgId = req.auth!.orgId;

    const columns = [
      'id, created_at, email, method, outcome, reason, ip, user_agent, source, user_id, profiles(full_name)',
      (await hasLocation()) ? ', city, region, country, country_code' : '',
      (await hasIpSource()) ? ', ip_source' : '',
    ].join('');

    let query = supabaseAdmin
      .from('login_events')
      .select(columns)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      // Enough that a month of a small studio's sign-ins arrives whole,
      // bounded so one request cannot read the whole table.
      .limit(2000);

    // `org_id.is.null` is the unattributed attempt — a wrong address, or a
    // right one with no profile. Without it, the most diagnostic rows in
    // the table would be the ones the screen could not show.
    query = orgId ? query.or(`org_id.eq.${orgId},org_id.is.null`) : query.is('org_id', null);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const rows: LoginEventRow[] = (data ?? []).map((raw) => {
      // Through `unknown`: the select list is built at runtime (the place
      // columns only exist after 0035), so PostgREST cannot infer a row
      // shape from it and hands back its generic error type instead.
      const row = raw as unknown as Record<string, unknown> & { profiles?: { full_name?: string | null } | null };
      return {
        id: String(row.id),
        created_at: String(row.created_at),
        email: (row.email as string | null) ?? null,
        method: parseMethod(row.method),
        outcome: row.outcome === 'success' ? 'success' : 'failure',
        reason: (row.reason as string | null) ?? null,
        ip: (row.ip as string | null) ?? null,
        user_agent: (row.user_agent as string | null) ?? null,
        source: row.source === 'backfill' ? 'backfill' : 'app',
        user_id: (row.user_id as string | null) ?? null,
        name: row.profiles?.full_name ?? null,
        city: (row.city as string | null) ?? null,
        region: (row.region as string | null) ?? null,
        country: (row.country as string | null) ?? null,
        country_code: (row.country_code as string | null) ?? null,
        ip_source: (row.ip_source as 'server' | 'client' | null) ?? null,
      };
    });

    /*
     * The Google verdict, asked of the WHOLE table rather than the window.
     *
     * "Has Google sign-in ever worked for anybody here" is what separates
     * one person's bad day from a provider that was never wired up, and a
     * thirty-day window is the wrong lens for it.
     */
    const { count: googleSuccessEver } = await supabaseAdmin
      .from('login_events')
      .select('id', { count: 'exact', head: true })
      .eq('method', 'google')
      .eq('outcome', 'success');

    const successes = rows.filter((r) => r.outcome === 'success');
    const failures = rows.filter((r) => r.outcome === 'failure');

    res.json({
      data: {
        ready: true,
        days,
        rows,
        summary: {
          total: rows.length,
          successes: successes.length,
          failures: failures.length,
          people: new Set(successes.map((r) => r.user_id ?? r.email).filter(Boolean)).size,
          byMethod: METHODS.map((method) => ({
            method,
            successes: successes.filter((r) => r.method === method).length,
            failures: failures.filter((r) => r.method === method).length,
          })).filter((m) => m.successes > 0 || m.failures > 0),
          /** False means nobody has ever got in this way — a configuration answer, not a user one. */
          googleEverWorked: (googleSuccessEver ?? 0) > 0,
          /** Newest first — what to read when somebody says they cannot get in. */
          recentFailures: failures.slice(0, 5),
        },
      },
    });
  }),
);
