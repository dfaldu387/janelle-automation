import { useAuth } from '../context/AuthContext';
import { useConnectGoogle } from '../lib/queries';
import { readImpersonation } from '../lib/impersonate';

function IconGoogle() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1Z" />
    </svg>
  );
}

/**
 * The first thing someone sees after an invitation.
 *
 * A teammate who signs in without connecting their Google has an empty
 * system: no mail is read for them, so no tasks are raised from it and the
 * board they were invited to look at has nothing on it. Explaining that
 * afterwards is harder than asking here.
 *
 * It says plainly what happens to their mail, because the honest answer is
 * the persuasive one — only studio correspondence is read, and only they
 * can see it (migration 0018).
 */
export function ConnectGooglePrompt() {
  // Taken from AuthContext, not from a query of its own: `/me` has already
  // been awaited before the shell renders, so this is known on the first
  // paint. Fetching it here again is what made the prompt arrive late,
  // after the dashboard had drawn itself.
  const { user, googleConnected, googleNeedsReconnect, signOut } = useAuth();
  const connect = useConnectGoogle();

  // Connected on paper, but Google has refused the grant — reading has quietly
  // stopped. Treated exactly like a first connect, so signing in puts the
  // reconnect in front of them instead of leaving them on stale mail. The
  // copy below changes to say so; the action is the same consent screen.
  const reconnect = googleConnected === true && googleNeedsReconnect;

  // `null` means the answer has not arrived — never guess "not connected"
  // and flash the prompt at somebody who has already done this.
  //
  // There is no dismissal. It used to defer for a day, which meant a person
  // could spend that day in a system reading none of their mail, wondering
  // why their board was empty. Connecting IS the setup step, so it stands
  // until it is done — no backdrop click, no Escape, no "not now".
  //
  // Never while the admin is signed in as a teammate: connecting from here
  // would attach the admin's Google to the teammate's login, and the blocking
  // sheet would stop the admin seeing the very screen they came to check.
  const showing = Boolean(user) && (googleConnected === false || reconnect) && !readImpersonation();

  if (!showing) return null;

  return (
    <div className="dock-aware fixed inset-0 z-50 grid place-items-center px-4">
      {/* No click-to-close: there is nothing useful behind it until this is done. */}
      <div className="absolute inset-0 bg-black/60" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-heading"
        className="popover relative w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
      >
        <div className="px-6 pt-6">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-sunk/60">
            <IconGoogle />
          </span>
          <h2 id="connect-heading" className="mt-4 text-[18px] font-semibold leading-snug text-ink">
            {reconnect ? 'Reconnect your Gmail and Drive' : 'Connect your Gmail and Drive'}
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
            {reconnect
              ? 'Google has stopped the studio reading your mail — this happens after a password change or when access times out. Until you reconnect, nothing new comes in and your board falls behind. It is one tap.'
              : 'This is how the studio reads your project mail, files it against the right job, and raises the work it finds. Until it is connected, your board stays empty.'}
          </p>

          <ul className="mt-4 space-y-2 text-[13px] text-ink-soft">
            {[
              'Only mail involving the studio, its clients and its suppliers is read — nothing else is fetched.',
              'What is read stays yours. Nobody else in the studio can see your mailbox, principals included.',
              'Nothing is ever sent on your behalf. Replies are left as drafts for you to approve.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden="true" />
                <span className="leading-snug">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-line-soft bg-sunk/40 px-6 py-3.5">
          {/* The only way past it other than connecting. Somebody who cannot
              do this right now — wrong machine, wrong account — needs a way
              out that is not a dead end. */}
          <button type="button" onClick={() => void signOut()} className="btn-ghost btn-sm">
            Sign out
          </button>
          <button
            type="button"
            disabled={connect.isPending}
            // `dashboard`: this is the first-run prompt, so Google comes back
            // to the board rather than to the Settings screen they never
            // asked for.
            onClick={() => connect.mutate({ service: 'all', next: 'dashboard' })}
            className="btn-primary btn-sm"
          >
            {connect.isPending ? 'Opening Google…' : reconnect ? 'Reconnect Gmail & Drive' : 'Connect Gmail & Drive'}
          </button>
        </div>

        {connect.isError && (
          <p className="border-t border-line-soft px-6 py-2.5 text-[12.5px] text-crit">
            {(connect.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
