import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../components/hue';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, SEATS, SEAT_KEYS, USER_ROLES, type Seat, type UserRole } from '@janelle/shared';
import { Page, PageHeading, Card, Pill, PasswordInput } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useTable, SortTh, SearchInput, FilterSelect, TableToolbar, TablePager, matches } from '../components/table';
import { startImpersonation } from '../lib/impersonate';
import {
  useAddTeamMember, useDraftConnectInvites, useEditTeamMember, useRemoveTeamMember, useResetMemberPassword, useSendInvite, useSetMemberDisabled,
  useSetRole, useTeam, useTeamAbilities, useTeamActivity, useSendTeamActivity,
  type AddedMember, type PasswordReset, type TeamMember, type TeamActivityPerson,
} from '../lib/queries';


/** What each role is for, in the studio's own terms. */
const ROLE_BLURB: Record<UserRole, string> = {
  principal: 'Full access. The only role that can change people, roles and studio rules.',
  coordinator: 'Runs the board: reassigns work, chases follow-ups, edits any project or order.',
  designer: 'Owns specs and drawings. Edits projects and the prompt library, not money.',
  procurement: 'Owns vendors and purchase orders. Cannot change project stages.',
  assistant: 'Works their own queue and drafts. Read-only everywhere else.',
};


function AddPerson({ onDone }: { onDone: () => void }) {
  const add = useAddTeamMember();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('assistant');
  const [invite, setInvite] = useState(false);
  const [added, setAdded] = useState<AddedMember | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          { email: email.trim(), full_name: name.trim(), role, invite },
          {
            onSuccess: (result) => {
              setEmail('');
              setName('');
              // Kept on screen rather than closing: the password is here, and
              // closing the form would be the last anyone saw of it.
              if (invite && result?.password) setAdded(result);
              else onDone();
            },
          },
        );
      }}
      className="border-t border-line-soft bg-sunk/30 px-5 py-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[12rem]">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Name</span>
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Joanna" />
        </label>
        <label className="flex-1 min-w-[14rem]">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Email</span>
          <input
            className="input w-full"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="joanna@janelleinteriors.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary btn-sm" disabled={add.isPending || !email.trim()}>
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-soft">
        <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
        {/* Off by default: adding someone to the roster should not put mail in
            their inbox unless the studio chose to. */}
        Email them a sign-in link now
      </label>
      <p className="mt-1 text-[11px] text-ink-faint">
        {invite
          ? 'Sent from the studio mailbox, with a password to sign in and a copy to the principal.'
          : 'No email is sent. They sign in later with this address using “forgot password”.'}
      </p>

      {add.isError && <p className="mt-2 text-[12.5px] text-crit">{(add.error as Error).message}</p>}

      {/* The password is shown once, here, and never again. It is the only
          copy the studio has if the email did not arrive. */}
      {added && (
        <div
          className={`mt-3 rounded-lg px-3 py-2.5 text-[12.5px] ${
            added.emailed ? 'bg-good/10 text-good' : 'bg-warn/10 text-warn'
          }`}
        >
          {added.emailed ? (
            <>Invitation sent to {added.email}.</>
          ) : (
            <>
              <span className="font-semibold">{added.email} was added, but the email did not send.</span>
              {added.mailError ? ` (${added.mailError})` : ''} Give them this password yourself — it is not
              shown again:
            </>
          )}
          {added.password && (
            <div className="mt-2 flex items-center gap-2">
              <code className="select-all rounded bg-ink/10 px-2 py-1 font-mono text-[12.5px] text-ink">
                {added.password}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(added.password ?? '')}
                className="btn-secondary btn-sm"
              >
                Copy
              </button>
              <button type="button" onClick={() => setAdded(null)} className="btn-ghost btn-sm">
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

/** Whose Google is connected — until it is, none of that person's mail is read. */
function GoogleStatus({ g }: { g: TeamMember['google'] }) {
  if (!g?.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint" title="Their mail is not being read until they connect Gmail in Settings">
        <span className="h-2 w-2 rounded-full bg-ink-faint/40" aria-hidden="true" />
        Not connected
      </span>
    );
  }
  if (g.needs_reconnect) {
    return (
      <span
        className="inline-flex flex-col"
        title={`Google refused the stored access (${g.needs_reconnect}). Only they can fix this: sign in and press Reconnect in Settings.`}
      >
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-crit">
          <span className="h-2 w-2 rounded-full bg-crit" aria-hidden="true" />
          Needs reconnect
        </span>
        <span className="pl-3.5 text-[11px] text-ink-faint">they must reconnect</span>
      </span>
    );
  }
  const partial = !(g.gmail && g.drive);
  const since = g.connected_at
    ? new Date(g.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  return (
    <span className="inline-flex flex-col">
      <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${partial ? 'text-warn' : 'text-good'}`}>
        <span className={`h-2 w-2 rounded-full ${partial ? 'bg-warn' : 'bg-good'}`} aria-hidden="true" />
        {partial ? (g.gmail ? 'Gmail only' : 'Drive only') : 'Connected'}
      </span>
      {since && <span className="pl-3.5 text-[11px] text-ink-faint">since {since}</span>}
    </span>
  );
}

/** Matches the API and the reset-password screen. */
const MIN_MEMBER_PASSWORD = 8;

const PASSWORD_MODES = [
  ['generate', 'Generate one'],
  ['type', 'Type one'],
] as const;

/**
 * The row's less frequent actions, behind one button.
 *
 * Six buttons on every row read as a wall; the two used most — signing in
 * as someone and editing them — stay in view, the rest open from here.
 */
function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  // Where to draw the menu. Fixed to the viewport, because the table scrolls
  // sideways and anything positioned inside it is clipped at its edge — the
  // bottom rows' menus would open into nothing.
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const open = at !== null;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (open || !button.current) return setAt(null);
    const r = button.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    // Opens upward when there is not room for it below.
    setAt(window.innerHeight - r.bottom < 280 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A fixed menu would float away from its row on scroll; close instead.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        className="btn-ghost btn-sm px-2"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="More"
        onClick={toggle}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {at && (
        <div
          role="menu"
          style={{ position: 'fixed', top: at.top, bottom: at.bottom, right: at.right }}
          className="z-50 w-60 rounded-xl border border-line bg-surface p-1 text-left shadow-pop"
        >
          {children(() => setAt(null))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children, hint, onClick, disabled, danger,
}: { children: ReactNode; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="focusable flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className={`text-[13px] font-medium ${danger ? 'text-crit' : 'text-ink'}`}>{children}</span>
      {hint && <span className="text-[11.5px] text-ink-faint">{hint}</span>}
    </button>
  );
}

/**
 * One person as a table row: who they are, their role and seat, whether
 * their Google is connected, what they carry, and — for someone allowed to
 * manage the team — editing, inviting or removing them. The confirmations
 * open as a full-width row beneath, so a person is never lost by a slip.
 */
function PersonRow({
  m, canUpdate, canDelete, canImpersonate, principals, activePrincipals, columns,
}: {
  m: TeamMember; canUpdate: boolean; canDelete: boolean; canImpersonate: boolean;
  principals: number;
  /** Principals whose accounts are not disabled — the last one cannot be. */
  activePrincipals: number;
  columns: number;
}) {
  const { user } = useAuth();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const setRole = useSetRole();
  const edit = useEditTeamMember();
  const remove = useRemoveTeamMember();
  const [mode, setMode] = useState<'view' | 'edit' | 'remove' | 'invite' | 'password' | 'disable' | null>('view');
  const invite = useSendInvite();
  const resetPassword = useResetMemberPassword();
  const setDisabled = useSetMemberDisabled();
  // The reset form: generate one, or type one; and whether to email it.
  const [pwMode, setPwMode] = useState<'generate' | 'type'>('generate');
  const [typedPassword, setTypedPassword] = useState('');
  const [notify, setNotify] = useState(false);
  const [reset, setReset] = useState<PasswordReset | null>(null);
  // The issued password, shown once. Kept on the row rather than in a toast,
  // because it belongs to this person and nothing else can recover it.
  const [sent, setSent] = useState<AddedMember | null>(null);
  const [name, setName] = useState(m.full_name ?? '');
  const [email, setEmail] = useState(m.email ?? '');

  const lastPrincipal = m.role === 'principal' && principals <= 1;
  const lastActivePrincipal = m.role === 'principal' && !m.disabled && activePrincipals <= 1;
  const error = (setRole.error ?? edit.error ?? remove.error ?? setDisabled.error ?? (switchError ? new Error(switchError) : null)) as Error | null;
  const panel =
    mode === 'edit' || mode === 'invite' || mode === 'remove' || mode === 'password' || mode === 'disable' ||
    Boolean(sent) || Boolean(reset) || Boolean(error);
  const who = m.full_name ?? m.email ?? 'this person';
  const typedTooShort = pwMode === 'type' && typedPassword.length < MIN_MEMBER_PASSWORD;

  const openPassword = () => {
    setPwMode('generate');
    setTypedPassword('');
    setNotify(false);
    setReset(null);
    resetPassword.reset();
    setMode(mode === 'password' ? 'view' : 'password');
  };

  return (
    <>
      <tr className={`transition-colors hover:bg-sunk/40 ${panel ? 'bg-sunk/30' : ''}`}>
        <td className="py-2.5 pl-5 pr-3">
          <div className="flex items-center gap-3">
            <Avatar name={m.full_name ?? m.email} size={28} />
            <div className="min-w-0">
              <div className={`truncate text-[13.5px] font-medium ${m.disabled ? 'text-ink-soft' : 'text-ink'}`}>
                {m.full_name ?? '—'}
                {m.is_you && <span className="ml-1.5 rounded bg-brass/10 px-1.5 py-px text-[10.5px] font-semibold text-brass-deep">you</span>}
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                <span className="truncate">{m.email ?? '—'}</span>
                {m.disabled && (
                  <span className="shrink-0 rounded bg-crit/10 px-1.5 py-px text-[10.5px] font-semibold text-crit">Disabled</span>
                )}
              </div>
            </div>
          </div>
        </td>

        <td className="px-3 py-2.5">
          {canUpdate ? (
            <select
              className="input h-8 w-full min-w-[9rem] py-0 text-[12.5px]"
              value={m.role}
              // Losing the last principal would make roles unchangeable
              // by anyone, so that one case is locked in the UI too.
              disabled={setRole.isPending || lastPrincipal}
              title={lastPrincipal ? 'The studio needs at least one principal' : undefined}
              onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as UserRole })}
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          ) : (
            <Pill tone="neutral">{ROLE_LABELS[m.role]}</Pill>
          )}
        </td>

        <td className="px-3 py-2.5">
          {/* The seat is what routes work: two people can share a role and
              owe completely different outcomes. */}
          {canUpdate ? (
            <select
              className="input h-8 w-full min-w-[10rem] py-0 text-[12.5px]"
              value={m.seat ?? ''}
              disabled={setRole.isPending}
              title="The named seat from the roles document — this is what routes work"
              onChange={(e) => setRole.mutate({ id: m.id, seat: (e.target.value || null) as Seat | null })}
            >
              <option value="">No seat</option>
              {SEAT_KEYS.map((k) => (
                <option key={k} value={k}>{SEATS[k].label}</option>
              ))}
            </select>
          ) : m.seat ? (
            <Pill tone="brass">{SEATS[m.seat].label}</Pill>
          ) : (
            <span className="text-[12px] text-ink-faint">—</span>
          )}
        </td>

        <td className="px-3 py-2.5">
          <GoogleStatus g={m.google} />
        </td>

        <td className="px-3 py-2.5 text-right tabular-nums">
          {m.live_tasks ? (
            <span className="text-[13px] font-medium text-ink">{m.live_tasks}</span>
          ) : (
            <span className="text-[12px] text-ink-faint">—</span>
          )}
        </td>

        {columns > 5 && (
          <td className="py-2.5 pl-3 pr-5">
            <div className="flex justify-end gap-1">
              {/* Only the studio admin account sees this; the API checks again. */}
              {canImpersonate && !m.is_you && m.email && (
                <button
                  type="button"
                  className="btn-ghost btn-sm text-brass-deep"
                  disabled={switching}
                  title={`See the system exactly as ${m.full_name ?? m.email} does. Recorded in the audit log.`}
                  onClick={() => {
                    setSwitching(true);
                    setSwitchError(null);
                    startImpersonation(m.id, user?.name ?? 'your account').catch((err: Error) => {
                      setSwitchError(err.message);
                      setSwitching(false);
                    });
                  }}
                >
                  {switching ? 'Signing in…' : 'Log in as'}
                </button>
              )}
              {canUpdate && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')} aria-label={`Edit ${m.full_name ?? m.email}`}>
                  Edit
                </button>
              )}
              {(canUpdate || (canDelete && !m.is_you)) && (
                <RowMenu label={`More actions for ${who}`}>
                  {(close) => (
                    <>
                      {canUpdate && m.email && !m.disabled && (
                        <MenuItem
                          onClick={() => {
                            close();
                            setMode(mode === 'invite' ? 'view' : 'invite');
                          }}
                          hint="Email them a new password"
                        >
                          Send sign-in details
                        </MenuItem>
                      )}
                      {canUpdate && (
                        <MenuItem
                          onClick={() => {
                            close();
                            openPassword();
                          }}
                          hint="Type or generate a new one"
                        >
                          Reset password
                        </MenuItem>
                      )}
                      {canUpdate && !m.is_you && m.disabled && (
                        <MenuItem
                          onClick={() => {
                            close();
                            setDisabled.mutate({ id: m.id, disabled: false }, { onSuccess: () => setMode('view') });
                          }}
                          hint="Let them sign in again"
                        >
                          Enable account
                        </MenuItem>
                      )}
                      {canUpdate && !m.is_you && !m.disabled && (
                        <MenuItem
                          onClick={() => {
                            close();
                            setDisabled.reset();
                            setMode('disable');
                          }}
                          disabled={lastActivePrincipal}
                          hint={lastActivePrincipal ? 'The studio needs an active principal' : 'Block sign-in, keep everything'}
                        >
                          Disable account
                        </MenuItem>
                      )}
                      {canDelete && !m.is_you && (
                        <MenuItem
                          danger
                          onClick={() => {
                            close();
                            setMode(mode === 'remove' ? 'view' : 'remove');
                          }}
                          disabled={lastPrincipal}
                          hint={lastPrincipal ? 'The studio needs at least one principal' : 'Delete their account'}
                        >
                          Remove from studio
                        </MenuItem>
                      )}
                    </>
                  )}
                </RowMenu>
              )}
            </div>
          </td>
        )}
      </tr>

      {panel && (
        <tr className="bg-sunk/30">
          <td colSpan={columns} className="px-5 pb-3.5 pt-0">
            {mode === 'edit' && (
              <form
                className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const change: { id: string; full_name?: string; email?: string } = { id: m.id };
                  if (name.trim() !== (m.full_name ?? '')) change.full_name = name.trim();
                  if (email.trim().toLowerCase() !== (m.email ?? '').toLowerCase()) change.email = email.trim();
                  if (!change.full_name && !change.email) {
                    setMode('view');
                    return;
                  }
                  edit.mutate(change, { onSuccess: () => setMode('view') });
                }}
              >
                <label className="min-w-[12rem] flex-1">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Name</span>
                  <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
                </label>
                <label className="min-w-[14rem] flex-1">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Sign-in email</span>
                  <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className="btn-primary btn-sm" disabled={edit.isPending}>
                    {edit.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setName(m.full_name ?? '');
                      setEmail(m.email ?? '');
                      edit.reset();
                      setMode('view');
                    }}
                  >
                    Cancel
                  </button>
                </div>
                <p className="w-full text-[11.5px] text-ink-faint">No email is sent when a name or address changes.</p>
              </form>
            )}

            {/* Asked first, because it REPLACES whatever password they have.
                Nobody can read an existing password back — not even a
                principal — so "send it again" can only mean "issue a new one". */}
            {mode === 'invite' && (
              <div role="alertdialog" aria-label={`Send sign-in details to ${m.full_name ?? m.email}`} className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3">
                <p className="text-[13px] text-ink">
                  Email <span className="font-semibold">{m.email}</span> a new password? Their current one stops working,
                  and a copy of the message goes to the principal.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={invite.isPending}
                    onClick={() =>
                      invite.mutate(m.id, {
                        onSuccess: (r) => {
                          setSent(r);
                          setMode(null);
                        },
                      })
                    }
                  >
                    {invite.isPending ? 'Sending…' : 'Send it'}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('view')}>
                    Cancel
                  </button>
                  {invite.isError && <span className="text-[12.5px] text-crit">{(invite.error as Error).message}</span>}
                </div>
              </div>
            )}

            {sent && (
              <div className={`rounded-lg px-4 py-3 text-[12.5px] ${sent.emailed ? 'bg-good/10 text-good' : 'bg-warn/10 text-warn'}`}>
                {sent.emailed ? (
                  <>Sent to {sent.email}.</>
                ) : (
                  <>
                    <span className="font-semibold">The email did not send.</span>
                    {sent.mailError ? ` (${sent.mailError})` : ''} Their password has still been changed — give them this:
                  </>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sent.password && (
                    <code className="select-all rounded bg-ink/10 px-2 py-1 font-mono text-[12.5px] text-ink">{sent.password}</code>
                  )}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(sent.password ?? '')}>
                    Copy
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setSent(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {mode === 'password' && (
              <form
                aria-label={`Reset the password for ${who}`}
                className="rounded-lg border border-line bg-surface px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typedTooShort) return;
                  resetPassword.mutate(
                    { id: m.id, password: pwMode === 'type' ? typedPassword : undefined, notify: notify && Boolean(m.email) },
                    {
                      onSuccess: (r) => {
                        setReset(r);
                        setTypedPassword('');
                        setMode(null);
                      },
                    },
                  );
                }}
              >
                <p className="text-[13px] text-ink">
                  New password for <span className="font-semibold">{who}</span>. Whatever they use now stops working straight away.
                </p>
                <div role="radiogroup" aria-label="How to set it" className="mt-3 flex flex-wrap gap-1.5">
                  {PASSWORD_MODES.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={pwMode === value}
                      onClick={() => setPwMode(value)}
                      className={`focusable rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                        pwMode === value ? 'border-brass/50 bg-brass/15 text-ink' : 'border-line text-ink-soft hover:bg-sunk hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {pwMode === 'type' && (
                  <label className="mt-3 block max-w-sm">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">New password</span>
                    <PasswordInput
                      className="w-full"
                      value={typedPassword}
                      onChange={(e) => setTypedPassword(e.target.value)}
                      maxLength={72}
                      autoComplete="new-password"
                      autoFocus
                    />
                    <span className={`mt-1 block text-[11.5px] ${typedPassword && typedTooShort ? 'text-crit' : 'text-ink-faint'}`}>
                      At least {MIN_MEMBER_PASSWORD} characters.
                    </span>
                  </label>
                )}
                {m.email && (
                  <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-ink-soft">
                    <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4" />
                    Email it to {m.email}
                  </label>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="submit" className="btn-primary btn-sm" disabled={resetPassword.isPending || typedTooShort}>
                    {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      resetPassword.reset();
                      setMode('view');
                    }}
                  >
                    Cancel
                  </button>
                  {resetPassword.isError && <span className="text-[12.5px] text-crit">{(resetPassword.error as Error).message}</span>}
                </div>
              </form>
            )}

            {reset && (
              <div className={`rounded-lg px-4 py-3 text-[12.5px] ${reset.mailError ? 'bg-warn/10 text-warn' : 'bg-good/10 text-good'}`}>
                {reset.mailError ? (
                  <>
                    <span className="font-semibold">Password changed, but the email did not send.</span> ({reset.mailError})
                    {reset.password ? ' Give them this:' : ' Pass the new password on yourself.'}
                  </>
                ) : reset.emailed ? (
                  <>Password changed and emailed to {reset.email}.</>
                ) : reset.password ? (
                  <>Password changed. Give them this — it is not shown again:</>
                ) : (
                  <>Password changed. Pass it on to them yourself.</>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {reset.password && !reset.emailed && (
                    <>
                      <code className="select-all rounded bg-ink/10 px-2 py-1 font-mono text-[12.5px] text-ink">{reset.password}</code>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(reset.password ?? '')}>
                        Copy
                      </button>
                    </>
                  )}
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setReset(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {mode === 'disable' && (
              <div role="alertdialog" aria-label={`Disable ${who}`} className="rounded-lg border border-crit/30 bg-crit/5 px-4 py-3">
                <p className="text-[13px] text-ink">
                  Disable <span className="font-semibold">{who}</span>? They are signed out at once and cannot sign in until the account
                  is enabled again. Their tasks, mail and history stay exactly as they are. Nothing is emailed to them.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-crit px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    disabled={setDisabled.isPending}
                    onClick={() => setDisabled.mutate({ id: m.id, disabled: true }, { onSuccess: () => setMode('view') })}
                  >
                    {setDisabled.isPending ? 'Disabling…' : 'Disable'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setDisabled.reset();
                      setMode('view');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {mode === 'remove' && (
              <div role="alertdialog" aria-label={`Remove ${m.full_name ?? m.email}`} className="rounded-lg border border-crit/30 bg-crit/5 px-4 py-3">
                <p className="text-[13px] text-ink">
                  Remove <span className="font-semibold">{m.full_name ?? m.email}</span> from the studio? They will no longer be
                  able to sign in.
                  {m.live_tasks ? ` Their ${m.live_tasks} open task${m.live_tasks === 1 ? '' : 's'} will stay on the board, unassigned.` : ''}{' '}
                  Nothing is emailed to them.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-crit px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(m.id)}
                  >
                    {remove.isPending ? 'Removing…' : 'Remove'}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => { remove.reset(); setMode('view'); }}>
                    Keep
                  </button>
                </div>
              </div>
            )}

            {error && <p className="mt-2 text-[12.5px] text-crit">{error.message}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Draft "connect your Google" invites for everyone set up but not connected.
 *
 * The drafts land in the studio mailbox for review — nothing is sent, so the
 * person who runs the studio reads each (and drops any for a teammate who has
 * since left) before it goes. Ordered most-open-work first, so the invite that
 * matters most is on top. Safe to press again: anyone drafted in the last week
 * is skipped rather than drafted twice.
 */
function DraftConnectInvites() {
  const draft = useDraftConnectInvites();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);

  const run = () => {
    setMsg(null);
    draft.mutate(undefined, {
      onSuccess: (d) => {
        if (!d.ok) {
          const why =
            d.reason === 'no_source_mailbox'
              ? 'No studio mailbox is connected to draft from.'
              : d.reason ?? 'Could not draft the invites.';
          return setMsg({ text: why, tone: 'crit' });
        }
        if (!d.drafted && !d.skippedRecent) return setMsg({ text: 'Everyone is already connected — nothing to draft.', tone: 'good' });
        const who = d.people.length ? ` For: ${d.people.map((p) => p.name).join(', ')}.` : '';
        const skip = d.skippedRecent ? ` ${d.skippedRecent} skipped (drafted in the last week).` : '';
        setMsg({
          text: d.drafted
            ? `Drafted ${d.drafted} invite${d.drafted === 1 ? '' : 's'} in the studio mailbox — review and send from Gmail.${who}${skip}`
            : `Nothing new to draft.${skip}`,
          tone: 'good',
        });
      },
      onError: (e) => setMsg({ text: (e as Error).message, tone: 'crit' }),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={draft.isPending}
        className="btn-secondary btn-sm"
        title="Writes a connect-your-Gmail draft into the studio mailbox for each unconnected teammate. Nothing is sent — you review and send from Gmail."
      >
        {draft.isPending ? 'Drafting…' : 'Draft connect invites'}
      </button>
      {msg && (
        <span className={`max-w-md text-right text-[12px] ${msg.tone === 'crit' ? 'text-crit' : 'text-ink-faint'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** "2026-10-24" / ISO → "Oct 24", or "—" when there is nothing. */
function sentDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function emailsText(p: TeamActivityPerson): string {
  if (!p.connected) return 'not connected';
  if (p.emailsSent === null) return '—';
  return `${p.emailsSent}${p.emailsCapped ? '+' : ''}`;
}

/**
 * The weekly per-person activity digest, on demand — mail each teammate sent and
 * how their task load moved, to set against reported hours. Principal-only, and
 * explicit that these are activity signals, not a measure of hours (Drive is a
 * blind spot). Collapsed by default because it reads Gmail live for each person.
 */
function TeamActivityPanel() {
  const [open, setOpen] = useState(false);
  const activity = useTeamActivity(open);
  const send = useSendTeamActivity();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);

  const emailNow = () => {
    setMsg(null);
    send.mutate(undefined, {
      onSuccess: (d) => {
        if (!d.ok) {
          const why =
            d.reason === 'no_source_mailbox'
              ? 'No studio mailbox is connected to send from.'
              : d.reason === 'no_owner'
                ? 'No principal with an email is set up to send to.'
                : d.reason ?? 'Could not send the digest.';
          return setMsg({ text: why, tone: 'crit' });
        }
        setMsg(
          d.ownersSent
            ? { text: `Emailed to the owner${d.ownersSent === 1 ? '' : 's'} — check your inbox.`, tone: 'good' }
            : { text: 'Nobody to report on yet.', tone: 'good' },
        );
      },
      onError: (e) => setMsg({ text: (e as Error).message, tone: 'crit' }),
    });
  };

  const people = activity.data?.people ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Team activity this week</h2>
          <p className="text-[12px] text-ink-faint">Mail sent and how task load moved — signals to read against reported hours, not hours themselves.</p>
        </div>
        <div className="flex items-center gap-2">
          {open && (
            <button onClick={emailNow} disabled={send.isPending} className="btn-secondary btn-sm" title="Email this week's digest to the studio owner now.">
              {send.isPending ? 'Sending…' : 'Email it to me'}
            </button>
          )}
          <button onClick={() => setOpen((v) => !v)} className="btn-ghost btn-sm">
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {open && (
        <>
          {msg && (
            <div className={`px-5 pt-3 text-[12.5px] ${msg.tone === 'crit' ? 'text-crit' : 'text-ink-faint'}`}>{msg.text}</div>
          )}

          {activity.isLoading && <div className="px-5 py-8 text-center text-[13px] text-ink-faint">Reading each connected mailbox…</div>}
          {activity.isError && <div className="px-5 py-8 text-center text-[13px] text-crit">Could not load activity.</div>}

          {!activity.isLoading && !activity.isError && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line-soft bg-sunk/40 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                      <th className="py-2.5 pl-5 pr-3 font-semibold">Person</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Emails sent</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Done</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Open</th>
                      <th className="px-3 py-2.5 text-right font-semibold">Overdue</th>
                      <th className="py-2.5 pl-3 pr-5 text-right font-semibold">Last sent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {people.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-5 py-8 text-center text-[13px] text-ink-faint">Nobody to report on yet.</td>
                      </tr>
                    )}
                    {people.map((p) => (
                      <tr key={p.id} className="text-[13px]">
                        <td className="py-2.5 pl-5 pr-3 font-medium text-ink">{p.name}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${p.connected ? 'text-ink' : 'text-ink-faint'}`}>{emailsText(p)}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${p.tasksCompleted ? 'text-good' : 'text-ink-faint'}`}>{p.tasksCompleted}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ink">{p.tasksOpen}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${p.tasksOverdue ? 'font-semibold text-crit' : 'text-ink-faint'}`}>{p.tasksOverdue}</td>
                        <td className="py-2.5 pl-3 pr-5 text-right text-ink-soft">{sentDay(p.lastSentAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {activity.data?.notes?.length ? (
                <ul className="border-t border-line-soft px-5 py-3 text-[12px] leading-relaxed text-ink-faint">
                  {activity.data.notes.map((n, i) => (
                    <li key={i} className="before:mr-1.5 before:content-['•']">{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default function Team() {
  const { profile } = useAuth();
  const isPrincipal = profile?.role === 'principal';
  const { data: team, isLoading } = useTeam();
  const { data: can } = useTeamAbilities();
  const [adding, setAdding] = useState(false);

  const principals = team.filter((m) => m.role === 'principal').length;
  const activePrincipals = team.filter((m) => m.role === 'principal' && !m.disabled).length;
  const manages = Boolean(can?.create || can?.update || can?.delete || can?.impersonate);
  const columns = manages ? 6 : 5;
  const googleConnected = team.filter((m) => m.google?.connected).length;

  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const shown = useMemo(
    () =>
      team.filter((m) => {
        if (roleFilter !== 'all' && m.role !== roleFilter) return false;
        if (statusFilter === 'active' && m.disabled) return false;
        if (statusFilter === 'disabled' && !m.disabled) return false;
        if (statusFilter === 'connected' && !m.google?.connected) return false;
        if (statusFilter === 'not_connected' && m.google?.connected) return false;
        return matches(query, m.full_name, m.email);
      }),
    [team, query, roleFilter, statusFilter],
  );
  const table = useTable(shown, {
    storageKey: 'team',
    defaultSort: { key: 'name', dir: 'asc' },
    sorters: {
      name: (m) => m.full_name || m.email,
      role: (m) => ROLE_LABELS[m.role] ?? m.role,
      seat: (m) => (m.seat ? SEATS[m.seat]?.label : ''),
      google: (m) => (m.google?.connected ? 1 : 0),
      tasks: (m) => m.live_tasks ?? 0,
    },
  });
  const filtering = Boolean(query.trim()) || roleFilter !== 'all' || statusFilter !== 'all';
  const rolesPresent = USER_ROLES.filter((r) => team.some((m) => m.role === r));

  return (
    <Page>
      <PageHeading
        title="Team & roles"
        action={
          can?.create ? (
            <button onClick={() => setAdding((v) => !v)} className="btn-primary btn-sm">
              {adding ? 'Cancel' : 'Add person'}
            </button>
          ) : undefined
        }
      />

      <div className="space-y-6">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">People</h2>
              <p className="text-[12px] text-ink-faint">{team.length} in the studio</p>
            </div>
            {!isLoading && team.length > 0 && (
              <div className="flex items-center gap-2 text-[12px]">
                <Pill tone={googleConnected === team.length ? 'good' : 'warn'}>
                  {googleConnected} of {team.length} connected Google
                </Pill>
                {googleConnected < team.length && (
                  <span className="hidden text-ink-faint md:inline">Mail is only read for people who have connected.</span>
                )}
                {manages && googleConnected < team.length && <DraftConnectInvites />}
              </div>
            )}
          </div>

          {adding && <AddPerson onDone={() => setAdding(false)} />}

          {team.length > 0 && (
            <TableToolbar
              search={<SearchInput value={query} onChange={setQuery} placeholder="Search name or email" label="Search people" />}
              filters={
                <>
                  <FilterSelect
                    label="Filter by role"
                    value={roleFilter}
                    onChange={setRoleFilter}
                    options={[{ value: 'all', label: 'All roles' }, ...rolesPresent.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }))]}
                  />
                  <FilterSelect
                    label="Filter by status"
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: 'all', label: 'Any status' },
                      { value: 'active', label: 'Active' },
                      { value: 'disabled', label: 'Switched off' },
                      { value: 'connected', label: 'Google connected' },
                      { value: 'not_connected', label: 'Google not connected' },
                    ]}
                  />
                </>
              }
              shown={shown.length}
              total={team.length}
              noun="member"
              onClear={
                filtering
                  ? () => {
                      setQuery('');
                      setRoleFilter('all');
                      setStatusFilter('all');
                    }
                  : null
              }
            />
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line-soft bg-sunk/40 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  <SortTh table={table} col="name" className="py-2.5 pl-5 pr-3 font-semibold">Person</SortTh>
                  <SortTh table={table} col="role" className="px-3 py-2.5 font-semibold">Role</SortTh>
                  <SortTh table={table} col="seat" className="px-3 py-2.5 font-semibold">Seat</SortTh>
                  <SortTh table={table} col="google" className="px-3 py-2.5 font-semibold">Google</SortTh>
                  <SortTh table={table} col="tasks" align="right" className="px-3 py-2.5 font-semibold">Open tasks</SortTh>
                  {manages && (
                    <th className="py-2.5 pl-3 pr-5 text-right font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {isLoading && (
                  <tr>
                    <td colSpan={columns} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td>
                  </tr>
                )}

                {!isLoading && team.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                      Nobody here yet. Tasks stay unassigned until the studio's people are added.
                    </td>
                  </tr>
                )}

                {!isLoading && team.length > 0 && shown.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                      Nobody matches these filters.
                    </td>
                  </tr>
                )}

                {table.rows.map((m) => (
                  <PersonRow
                    key={m.id}
                    m={m}
                    canUpdate={Boolean(can?.update)}
                    canDelete={Boolean(can?.delete)}
                    canImpersonate={Boolean(can?.impersonate)}
                    principals={principals}
                    activePrincipals={activePrincipals}
                    columns={columns}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <TablePager table={table} noun="member" />

          {!manages && (
            <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
              Only someone allowed to manage the team can add, edit or remove people.
            </div>
          )}
        </Card>

        {isPrincipal && <TeamActivityPanel />}

        <Card>
          <div className="border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">What each role may do</h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              Everyone can see the studio's work — that visibility is the point. What is restricted is
              changing money, changing someone else's assignment, and changing the rules.
            </p>
          </div>

          <ul className="divide-y divide-line-soft">
            {USER_ROLES.map((r) => (
              <li key={r} className="px-5 py-3">
                <span className="text-[13.5px] font-semibold text-ink">{ROLE_LABELS[r]}</span>
                <span className="ml-2 text-[13px] text-ink-soft">{ROLE_BLURB[r]}</span>
              </li>
            ))}
          </ul>

          <div className="border-t border-line-soft px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12.5px] text-ink-soft">
                Exactly what each role may do — module by module, and editable without a deploy —
                lives in Permissions.
              </p>
              <Link to="/settings?tab=permissions" className="btn-secondary btn-sm shrink-0">
                Open Permissions →
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </Page>
  );
}
