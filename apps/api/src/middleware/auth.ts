import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin, supabaseForToken } from '../lib/supabase.js';
import { canWith, type Action, type PermissionOverrides, type Resource, type Seat, type UserRole } from '@janelle/shared';
import { loadOverrides } from '../lib/permissions.js';
import { profileColumns } from '../lib/columns.js';
import { LOGIN_CODE_REQUIRED, codeRequiredFor, isVerified, signInSession } from '../lib/loginCode.js';
import type { SignInMethod } from '../lib/signInMethod.js';

/** Data attached to an authenticated request. */
export interface AuthContext {
  userId: string;
  email: string | null;
  orgId: string | null;
  role: UserRole | null;
  /**
   * The named seat this person holds, where one has been assigned.
   *
   * Finer than the role, and the roles document routes by it: two people
   * can both be `assistant` and own completely different outcomes.
   */
  seat: Seat | null;
  /** Supabase client scoped to this user (RLS-enforced). */
  db: SupabaseClient;
  /** The studio's edits to the default permission matrix, if any. */
  permissions: PermissionOverrides;
  /** Supabase's id for this sign-in. Absent where a context is built without a token. */
  sessionId?: string | null;
  /** How this session began: Google, password, a reset link and so on. */
  signInMethod?: SignInMethod | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verifies the Bearer token with Supabase, loads the user's profile
 * (org + role), and attaches an RLS-scoped client to the request.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Backend not configured',
      detail: 'Add SUPABASE_URL and keys to .env to enable data and auth.',
    });
  }

  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Disabled from Team & roles. The ban stops new sign-ins and token
  // refreshes, but an access token already issued stays valid for up to an
  // hour — refused here, so disabling someone takes effect on their next
  // click rather than whenever their token happens to run out. 401, so the
  // app drops the session and shows the sign-in screen.
  const bannedUntil = data.user.banned_until ? Date.parse(data.user.banned_until) : NaN;
  if (!Number.isNaN(bannedUntil) && bannedUntil > Date.now()) {
    return res.status(401).json({ error: 'This account has been disabled' });
  }

  // Signing in is followed by an emailed code (lib/loginCode.ts).
  // Until it is entered, only the routes that send and check it answer.
  // Refused, not let through, when the check itself cannot be made.
  const signIn = signInSession(token, data.user);
  if (codeRequiredFor(signIn.method) && !req.originalUrl.startsWith('/api/login-code')) {
    let ok = false;
    try {
      ok = Boolean(signIn.sessionId) && (await isVerified(signIn.sessionId!));
    } catch (err) {
      console.error('[login-code] check failed:', (err as Error).message);
      return res.status(503).json({ error: 'Could not check your sign-in code. Try again in a moment.' });
    }
    if (!ok) {
      return res.status(403).json({ error: 'Enter the code we emailed you to finish signing in.', code: LOGIN_CODE_REQUIRED });
    }
  }

  // Profile carries org + role. Read via admin to avoid a policy
  // chicken-and-egg on first login.
  // `seat` only when migration 0008 has been applied — see lib/seats.ts.
  // This select runs on every authenticated request, so asking for a column
  // that is not there yet would take the whole API down.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select(await profileColumns('org_id, role'))
    .eq('id', data.user.id)
    .maybeSingle();

  const orgId = (profile as { org_id?: string | null } | null)?.org_id ?? null;

  req.auth = {
    userId: data.user.id,
    email: data.user.email ?? null,
    orgId,
    role: ((profile as { role?: UserRole } | null)?.role as UserRole) ?? null,
    seat: ((profile as { seat?: Seat | null } | null)?.seat as Seat) ?? null,
    // Non-null here: we returned 503 above when Supabase is unconfigured.
    db: supabaseForToken(token) as SupabaseClient,
    permissions: await loadOverrides(orgId),
    sessionId: signIn.sessionId,
    signInMethod: signIn.method,
  };

  next();
}

/**
 * Restrict a route by the shared permission matrix. Use after requireAuth.
 * Prefer this over requireRole: it keeps the API and the UI in step, since
 * both read the same table in @janelle/shared.
 */
export function requirePermission(resource: Resource, action: Action) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!canWith(req.auth?.permissions, req.auth?.role ?? null, resource, action)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        detail: `Your role (${req.auth?.role ?? 'none'}) cannot ${action} ${resource}.`,
      });
    }
    next();
  };
}

/** Restrict a route to specific roles. Use after requireAuth. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.role || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
