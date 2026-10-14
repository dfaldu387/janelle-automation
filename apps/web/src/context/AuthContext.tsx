import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { api, SessionExpiredError } from '../lib/api';
import { clearImpersonation } from '../lib/impersonate';
import { recordSignIn } from '../lib/loginEvents';
import type { Action, Resource, Seat, UserRole } from '@janelle/shared';

/** What this person may do, per module, with the studio's overrides applied. */
export type Access = Partial<Record<Resource, Record<Action, boolean>>>;

interface Profile {
  id: string;
  org_id: string | null;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  /** The named seat, where one has been assigned. Finer than the role. */
  seat: Seat | null;
}

interface SessionUser {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  seat: Seat | null;
}

interface AuthCtx {
  /** Supabase env present — auth is possible. */
  configured: boolean;
  /** Initial session + profile resolution in progress. */
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  user: SessionUser | null;
  /** Set when the profile could not be loaded (e.g. API unreachable). */
  profileError: string | null;
  /**
   * Whether this person's Google is connected — null while `/me` is still
   * in flight. Read from the same call that loads the profile, so nothing
   * that depends on it has to wait for a request of its own.
   */
  googleConnected: boolean | null;
  /**
   * Whether Google has REFUSED the connected grant — the status reads
   * connected, but it must be approved again before anything can be read.
   * Drives the reconnect prompt on sign-in. False until `/me` has answered.
   */
  googleNeedsReconnect: boolean;
  /**
   * Whether this person may do something. Defaults to allowed while `/me`
   * is still loading, so the shell does not flicker every module away and
   * back on each refresh.
   */
  may: (resource: Resource, action?: Action) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Arrived from a "reset your password" link.
   *
   * The link signs the person IN — that is how it lets them set a new
   * password without knowing the old one. So a session exists and the app
   * would otherwise drop them straight onto the dashboard, with no way to
   * finish the thing they came to do. While this is true the shell is held
   * back and the reset screen is shown instead.
   */
  recovery: boolean;
  /** Done resetting — release the app. */
  endRecovery: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  /** Whether Google is connected; null until `/me` has answered. */
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  /** Whether a connected grant has been refused and must be reconnected. */
  const [googleNeedsReconnect, setGoogleNeedsReconnect] = useState(false);
  // Read from the URL before anything else: supabase-js consumes the hash
  // as it starts up, and by the time a listener is attached the evidence
  // that this was a recovery link can already be gone.
  const [recovery, setRecovery] = useState(() => {
    try {
      return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type') === 'recovery';
    } catch {
      return false;
    }
  });

  /** Load the profile for the current session, bootstrapping if needed. */
  const loadProfile = useCallback(async () => {
    setProfileError(null);
    try {
      const me = await api<{
        profile: Profile | null;
        access?: Access;
        google?: { status?: string; needs_reconnect?: string | null };
      }>('/me');
      // `/me` already says whether Google is connected, and this call is
      // awaited before the app renders. Reading it here means the first-run
      // prompt can decide on the first paint; asking again from the prompt
      // put a second request — and a visible delay — in front of it.
      //
      // Only a definite answer moves it. `unknown` (the server could not read
      // the connection) or a missing field keeps what was already known, so
      // a hiccup never raises the connect prompt over a working grant.
      const status = me.google?.status;
      if (status === 'connected') {
        setGoogleConnected(true);
        // Connected-but-refused: the reconnect prompt keys off this.
        setGoogleNeedsReconnect(Boolean(me.google?.needs_reconnect));
      } else if (status === 'disconnected') {
        setGoogleConnected(false);
        setGoogleNeedsReconnect(false);
      }
      if (me.profile?.org_id) {
        setProfile(me.profile);
        setAccess(me.access ?? null);
        return;
      }
      // No profile yet — provision org + profile on first sign-in.
      const created = await api<Profile>('/auth/bootstrap', { method: 'POST', body: '{}' });
      setProfile(created);
    } catch (err) {
      setProfile(null);
      // Not an unreachable API: the session was dead and has been dropped,
      // so the login screen is already on its way.
      if (err instanceof SessionExpiredError) return;
      setProfileError((err as Error).message || 'Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) {
      setLoading(false);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        // Covers the Google round trip, which lands on a fresh page load
        // with the session already restored and no auth event of its own.
        recordSignIn(data.session);
        await loadProfile();
      }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, next) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(next);
      if (next) {
        // Deduplicated inside, on Supabase's own last_sign_in_at: this
        // fires on a restored session as well as on a real sign-in.
        recordSignIn(next);
        await loadProfile();
      } else {
        // Covers a session that expired, not only the Sign out button.
        clearImpersonation();
        setProfile(null);
        setAccess(null);
        setProfileError(null);
        setGoogleConnected(null);
        setGoogleNeedsReconnect(false);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signOut = async () => {
    // Signing out while viewing as a teammate ends that too — the admin's
    // set-aside session must not survive a sign-out on a shared machine.
    clearImpersonation();
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setAccess(null);
    setProfileError(null);
    setRecovery(false);
    setGoogleConnected(null);
    setGoogleNeedsReconnect(false);
  };

  // Unknown means allowed: a slow /me must never look like a revoked module.
  const may = (resource: Resource, action: Action = 'read') =>
    access?.[resource]?.[action] ?? true;

  const user: SessionUser | null =
    session && profile
      ? {
          id: session.user.id,
          email: session.user.email ?? profile.email,
          name: profile.full_name ?? session.user.email ?? 'Team member',
          role: profile.role,
          seat: profile.seat ?? null,
        }
      : null;

  return (
    <Ctx.Provider
      value={{
        configured: supabaseConfigured, loading, session, profile, user, profileError, may,
        refresh: loadProfile, signOut, googleConnected, googleNeedsReconnect,
        recovery, endRecovery: () => setRecovery(false),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
