import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../env.js';

/** The two Google services the studio can connect independently. */
export type GoogleService = 'gmail' | 'drive';
export const GOOGLE_SERVICES: GoogleService[] = ['gmail', 'drive'];

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose', // drafts only — never sends
];
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

/** Scopes a given service needs. `GOOGLE_SCOPES` in .env can override the full set. */
export function scopesFor(service: GoogleService | 'all'): string[] {
  if (service === 'gmail') return GMAIL_SCOPES;
  if (service === 'drive') return DRIVE_SCOPES;
  return env.google.scopes.length ? env.google.scopes : [...GMAIL_SCOPES, ...DRIVE_SCOPES];
}

/** Which services a space-separated granted-scope string covers. */
export function servicesGranted(scopes: string | null | undefined): Record<GoogleService, boolean> {
  const granted = new Set((scopes ?? '').split(/\s+/).filter(Boolean));
  const has = (needed: string[]) => needed.every((s) => granted.has(s));
  return { gmail: has(GMAIL_SCOPES), drive: has(DRIVE_SCOPES) };
}

/** Build a fresh Google OAuth2 client from configured credentials. */
export function oauthClient() {
  return new OAuth2Client(
    env.google.clientId,
    env.google.clientSecret,
    env.google.redirectUri,
  );
}

/**
 * The consent URL a user visits to grant access to one service (or all).
 * `include_granted_scopes` makes this incremental: connecting Drive after
 * Gmail yields one token that covers both.
 * `state` carries the signed user id so the callback knows who returned.
 */
export function consentUrl(state: string, service: GoogleService | 'all' = 'all'): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',       // request a refresh token
    prompt: 'consent',
    include_granted_scopes: true,
    scope: scopesFor(service),
    state,
  });
}

/**
 * Signed OAuth state: "<userId>.<service>.<next>.<hmac>", so the callback can
 * trust which user began a flow and where to land them, without a session
 * store. Lives here rather than in the auth route because the keep-alive also
 * needs to mint a consent link (see `reconnectConsentUrl`), and both must sign
 * it the same way.
 */
export type ReturnTo = 'settings' | 'dashboard';

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', env.tokenEncryptionKey || 'dev')
    .update(payload)
    .digest('hex')
    .slice(0, 32);
}

export function signState(userId: string, service: string, next: ReturnTo = 'settings'): string {
  return `${userId}.${service}.${next}.${sign(`${userId}.${service}.${next}`)}`;
}

export function verifyState(state: string): { userId: string; service: string; next: ReturnTo } | null {
  const [userId, service, next, mac] = state.split('.');
  if (!userId || !service || !next || !mac) return null;
  if (next !== 'settings' && next !== 'dashboard') return null;
  return sign(`${userId}.${service}.${next}`) === mac ? { userId, service, next } : null;
}

/**
 * A ready-to-click Google consent link for one user — for emailing someone
 * whose grant has lapsed. The callback trusts the signed state, so the link
 * needs no app session: they click, approve with Google, and land back in
 * Settings reconnected. `service` is theirs to re-grant, defaulting to both.
 */
export function reconnectConsentUrl(userId: string, service: GoogleService | 'all' = 'all'): string {
  return consentUrl(signState(userId, service, 'settings'), service);
}
