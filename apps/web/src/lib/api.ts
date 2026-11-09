import { supabase } from './supabase';

/**
 * Where the API lives.
 *
 * In a deployed build the API is served from the same origin (Vercel routes
 * /api/* to the serverless function), so an empty base gives same-origin
 * requests and no CORS. Set VITE_API_BASE_URL to override — for example when
 * the API is hosted separately.
 */
const BASE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.PROD ? '' : 'http://localhost:4055')
).replace(/\/+$/, '');

/**
 * The request never reached the API, or its answer never came back.
 *
 * `fetch` throws a bare `TypeError: Failed to fetch` for every one of these
 * — offline, connection reset, a long request dropped in transit — which
 * reads on screen as though the server rejected the work. It did not: the
 * server may well have finished it. Callers that can safely ask again test
 * for this and retry rather than reporting failure.
 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server — check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * The API turned the session away (401) and it could not be renewed.
 *
 * supabase-js hands back whatever session it has stored, and a stored
 * session can be dead on the server — signed out elsewhere, the refresh
 * token revoked, the account removed. Left alone the app showed "the API
 * isn't responding" over a perfectly healthy API. Instead the stale session
 * is dropped here, which fires SIGNED_OUT and puts the login screen up.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session has expired — please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Signed in, and the emailed code has not been entered yet.
 * The app shows the code screen instead of the studio until it is.
 */
export class LoginCodeRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginCodeRequiredError';
  }
}

/** Why the app signed someone out, for the sign-in screen to show once. */
export const SIGNED_OUT_REASON = 'janelle.signedOutReason';

async function authHeader(headers: Headers): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
}

/**
 * After a 401: try once to renew the session (the token may only look
 * unexpired to a slow clock). True when renewed and the request can be sent
 * again; otherwise the session is cleared locally and false comes back.
 */
async function renewAfter401(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.auth.refreshSession();
  if (!error && data.session) return true;
  // Disabled from Team & roles: say so on the sign-in screen, rather than
  // leaving them to wonder why they were thrown out.
  if (error && /banned/i.test(error.message)) {
    try {
      sessionStorage.setItem(SIGNED_OUT_REASON, 'This account has been disabled. Ask the studio admin to turn it back on.');
    } catch {
      /* storage blocked — they still reach the sign-in screen */
    }
  }
  await supabase.auth.signOut({ scope: 'local' });
  return false;
}

/**
 * Thin fetch wrapper that attaches the current Supabase access token
 * so the API can enforce row-level security. Throws on non-2xx, and
 * throws NetworkError when there was no response at all.
 */
export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  await authHeader(headers);

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  } catch (err) {
    throw new NetworkError(err);
  }

  // A 401 never ran the request, so sending it again once is safe.
  if (res.status === 401 && headers.has('Authorization')) {
    if (!retried && (await renewAfter401())) return api<T>(path, init, true);
    if (retried && supabase) await supabase.auth.signOut({ scope: 'local' });
    throw new SessionExpiredError();
  }

  const body = await res.json().catch(() => ({}));
  if (res.status === 403 && (body as { code?: string }).code === 'login_code_required') {
    throw new LoginCodeRequiredError((body as { error?: string }).error ?? 'Enter your sign-in code.');
  }
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (body as { data: T }).data;
}

/**
 * POST and read the reply as newline-delimited JSON events, as they arrive.
 *
 * For work that reports progress before it finishes. Every line is handed
 * to `onEvent`; the promise settles when the stream ends. A non-2xx status
 * throws with the server's message, like `api()`; no response at all throws
 * NetworkError; an abort throws the browser's AbortError, which callers
 * treat as the person changing their mind rather than as a failure.
 */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' });
  await authHeader(headers);

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  if (res.status === 401 && headers.has('Authorization')) {
    await renewAfter401();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    const failure = await res.json().catch(() => ({}));
    throw new Error((failure as { error?: string }).error ?? `Request failed (${res.status})`);
  }

  // A browser without streamable bodies still gets every event, at the end.
  if (!res.body) {
    for (const raw of (await res.text()).split('\n')) {
      if (raw.trim()) onEvent(JSON.parse(raw));
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      // Only whole lines are parsed; a line split across two chunks waits
      // for the rest of itself.
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const raw = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (raw) onEvent(JSON.parse(raw));
      }
      if (done) break;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // The connection dropped mid-answer: the server may have finished, but
    // nothing more is coming, which to the person is the same as unreachable.
    if (err instanceof TypeError) throw new NetworkError(err);
    throw err;
  }
  if (buffered.trim()) onEvent(JSON.parse(buffered));
}

/**
 * Fetch an endpoint that deliberately has no session: the token in the URL
 * is the credential. Used by the shared AI usage report, which is opened by
 * people who have no account here.
 */
export async function publicApi<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (body as { data: T }).data;
}

/**
 * Tell the API something happened, and carry on regardless.
 *
 * For the sign-in screen's own audit rows. It differs from `api()` in the
 * two ways that matter there: a missing session is normal rather than an
 * error — a failed sign-in has no token, which is the whole point of the
 * row — and nothing it can go wrong with is ever raised to the caller. The
 * person is trying to get into the system; the record of that attempt must
 * not be able to stand in their way.
 */
export async function report(path: string, body: unknown): Promise<void> {
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    await authHeader(headers);
    await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    /* offline, blocked, API down — none of it is the person's problem */
  }
}

/**
 * Fetch a binary response (e.g. a PDF) with the auth token attached,
 * returning a blob. Throws with the server error message on non-2xx.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  await authHeader(headers);
  const res = await fetch(`${BASE}/api${path}`, { headers });
  if (res.status === 401 && headers.has('Authorization')) {
    await renewAfter401();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.blob();
}

/**
 * Send a file as the raw request body, and read back the usual `{ data }`.
 *
 * Raw rather than JSON or a form: base64 makes a file a third larger, and a
 * serverless request body has a hard size cap that a PDF reaches quickly.
 */
export async function apiUpload<T>(path: string, file: Blob, signal?: AbortSignal): Promise<T> {
  const headers = new Headers({ 'Content-Type': file.type || 'application/octet-stream' });
  await authHeader(headers);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: file, signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  if (res.status === 401 && headers.has('Authorization')) {
    await renewAfter401();
    throw new SessionExpiredError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 413 && !(body as { error?: string }).error) throw new Error('That file is too large.');
    throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
  }
  return (body as { data: T }).data;
}
