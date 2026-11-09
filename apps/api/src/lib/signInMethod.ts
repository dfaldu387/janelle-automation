/** How a session was signed in to. Shared by Login History and the Google sign-in code. */
export type SignInMethod = 'password' | 'google' | 'recovery' | 'invite' | 'unknown';

/**
 * How this session was ACTUALLY started, read out of the access token.
 *
 * `app_metadata.provider` was the obvious field and the wrong one: it
 * records how the account was first created, so an account made with a
 * password reports "email" for ever, including on the sessions that began
 * with Continue with Google. Every Google sign-in was being filed as a
 * password one.
 *
 * `amr` — Authentication Methods References, RFC 8176 — is the claim that
 * exists for exactly this question: which methods established THIS
 * session. Supabase puts it in every access token, and the token is
 * signed, so unlike anything the browser could tell us it cannot be
 * made up.
 *
 * Returns null when the claim cannot be read, so the caller can fall back
 * rather than record a confident wrong answer.
 */
export interface TokenClaims {
  amr?: { method?: string; timestamp?: number }[];
  /** The session this token belongs to — one per authentication. */
  session_id?: string;
}

/**
 * The token's payload. Already verified by `getUser` before this is
 * trusted for anything, so this only has to decode it.
 */
export function decodeClaims(token: string): TokenClaims | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return null;
  }
}

export function methodFromToken(claims: TokenClaims | null, identities: { provider?: string }[] | null): SignInMethod | null {
  const amr = claims?.amr;
  if (!Array.isArray(amr) || amr.length === 0) return null;

  // A refresh is not a way of signing in — it is the same session carrying
  // on — and it is the newest entry on any session more than an hour old.
  const real = amr.filter((e) => e.method && e.method !== 'token_refresh');
  if (real.length === 0) return null;

  // The most recent one that was a real authentication.
  const latest = real.reduce((a, b) => ((b.timestamp ?? 0) > (a.timestamp ?? 0) ? b : a));

  switch (latest.method) {
    case 'password':
      return 'password';
    case 'invite':
      return 'invite';
    case 'recovery':
      return 'recovery';
    case 'oauth':
    case 'sso/saml': {
      // amr says an external provider was used but not which one. The
      // linked identities do — and with one OAuth provider configured
      // there is only ever one answer.
      const providers = (identities ?? []).map((i) => i.provider);
      return providers.includes('google') ? 'google' : 'unknown';
    }
    default:
      // magiclink, otp, mfa/*, anonymous — none of which this app uses.
      return 'unknown';
  }
}
