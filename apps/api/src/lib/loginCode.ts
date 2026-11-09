import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { env } from '../env.js';
import { supabaseAdmin } from './supabase.js';
import { decodeClaims, methodFromToken, type SignInMethod } from './signInMethod.js';

/**
 * The emailed code asked for after signing in.
 *
 * Asked after Continue with Google (LOGIN_CODE_GOOGLE=true) and after email
 * and password (LOGIN_CODE_PASSWORD=true). Never after a password-reset link,
 * which already proves the person reads that inbox, nor after "Log in as".
 *
 * Proof is per session. Supabase gives each sign-in its own session_id, and
 * entering the code marks that session verified, so a new sign-in on any
 * device needs a new code. See supabase/migrations/0039_login_codes.sql.
 */
export const LOGIN_CODE_REQUIRED = 'login_code_required';
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_AFTER_MS = 60_000;
export const MAX_CODES_PER_HOUR = 5;

export interface SignInSession {
  /** How the session began, read from the signed token. Null when unreadable. */
  method: SignInMethod | null;
  /** Supabase's id for this sign-in, from the access token. */
  sessionId: string | null;
}

/** How the token's session began. The token is already verified by `getUser`. */
export function signInSession(token: string, user: Pick<User, 'identities'>): SignInSession {
  const claims = decodeClaims(token);
  return {
    method: methodFromToken(claims, user.identities ?? null),
    sessionId: typeof claims?.session_id === 'string' ? claims.session_id : null,
  };
}

/** Whether a session begun this way has to give a code before the app opens. */
export function codeRequiredFor(method: SignInMethod | null | undefined): boolean {
  if (method === 'google') return env.loginCode.google;
  if (method === 'password') return env.loginCode.password;
  return false;
}

// Verified sessions, remembered so the check costs one query per session,
// not one per request. Positive answers only: an unverified session is asked
// again every time, so entering the code takes effect at once.
const verified = new Map<string, number>();
const REMEMBER_MS = 12 * 3600_000;

export function rememberVerified(sessionId: string): void {
  verified.set(sessionId, Date.now() + REMEMBER_MS);
  if (verified.size > 5000) {
    const now = Date.now();
    for (const [id, until] of verified) if (until < now) verified.delete(id);
  }
}

/** Throws when the database cannot answer, so the caller can refuse rather than guess. */
export async function isVerified(sessionId: string): Promise<boolean> {
  const until = verified.get(sessionId);
  if (until && until > Date.now()) return true;
  const { data, error } = await supabaseAdmin!
    .from('verified_sessions')
    .select('session_id')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  rememberVerified(sessionId);
  return true;
}

function hashKey(): string {
  const key = env.tokenEncryptionKey || env.supabase.serviceRoleKey;
  if (!key) throw new Error('No key to protect sign-in codes with');
  return key;
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Tied to the session, so a code is worthless for any other sign-in. */
export function hashCode(sessionId: string, code: string): string {
  return createHmac('sha256', hashKey()).update(`${sessionId}:${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "j•••••e@janelleinteriors.com": enough to recognise, not to harvest. */
export function maskEmail(email: string | null): string {
  if (!email) return 'your email';
  const [user, domain] = email.split('@');
  if (!domain || !user) return email;
  if (user.length <= 2) return `${user[0]}•@${domain}`;
  return `${user[0]}${'•'.repeat(user.length - 2)}${user[user.length - 1]}@${domain}`;
}
