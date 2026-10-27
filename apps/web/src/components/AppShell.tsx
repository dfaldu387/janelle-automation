import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BrandLogo } from './BrandLogo';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useFollowUps, useDrafts, useMentions, useMarkMentionsRead, ageFrom } from '../lib/queries';
import { AssistantLauncher, AssistantPanel } from './AssistantPanel';
import { TaskReminder } from './TaskReminder';
import { ConnectGooglePrompt } from './ConnectGooglePrompt';
import { endImpersonation, readImpersonation } from '../lib/impersonate';
import { HUE, type Hue } from './hue';
import { ASSISTANT_NAME, ROLE_LABELS, canSupervise, type Resource } from '@janelle/shared';
import {
  IconDashboard, IconProjects, IconVendors, IconDoc,
  IconPrompt, IconBell, IconInbox, IconTask, IconAssistant, IconSettings, IconDraft, IconSun, IconMoon,
  IconLogout, IconArrow, IconActivity, IconCalendar,
} from './icons';

const PINNED_KEY = 'janelle.sidebar.pinned';
const PINNED_CHANGE = 'janelle.sidebar.change';

/** Pages that are not in the default nav but can be pinned by the user. */
const PINNABLE_PAGES: Record<string, NavItem> = {
  audit: { to: '/jenny-assistant', label: 'Audit Chat', Icon: IconActivity, hue: 'indigo' },
};

function readPinnedKeys(): string[] {
  try { return JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]'); } catch { return []; }
}

export function toggleSidebarPin(key: string) {
  const current = readPinnedKeys();
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  try { localStorage.setItem(PINNED_KEY, JSON.stringify(next)); } catch {}
  window.dispatchEvent(new Event(PINNED_CHANGE));
  return next.includes(key);
}

export function isSidebarPinned(key: string) {
  return readPinnedKeys().includes(key);
}

type NavItem = {
  to: string;
  label: string;
  Icon: typeof IconDashboard;
  end?: boolean;
  /** The module this page is. Hidden when the role may not view it. */
  needs?: Resource;
  /** The icon's own colour, so each page is found by colour as well as by name. */
  hue?: Hue;
  /**
   * For a screen that exists to CHANGE something rather than to read it.
   *
   * Team & roles and Permissions are administration, and every role can view
   * both by default — which is why a designer saw the whole Admin section.
   * Gating them on the ability to view was the wrong test: the roster itself
   * has to stay readable (it is where assignee names come from everywhere
   * else), so what decides is whether this person can change it.
   */
  needsWrite?: Resource;
  /** Supervisors only — the audit trail, per SUPERVISOR_ROLES. */
  supervisorOnly?: boolean;
  /**
   * The principal's alone, whatever the permission matrix says.
   *
   * Permissions is the module that grants every other module. Gating it on a
   * cell inside itself would let it be handed to someone else, and the point
   * of it being the owner's is that it cannot be.
   */
  principalOnly?: boolean;
};

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  // First: the day-to-day work. Slack is set up under Settings → Slack.
  {
    title: 'Automation',
    items: [
      { to: '/follow-ups', label: 'Top Priority Actions', Icon: IconBell, needs: 'follow_ups', hue: 'amber' },
      { to: '/daily', label: 'Daily Report', Icon: IconCalendar, supervisorOnly: true, hue: 'green' },
      { to: '/assistant', label: ASSISTANT_NAME, Icon: IconAssistant, hue: 'violet' },
      { to: '/tasks', label: 'Tasks', Icon: IconTask, needs: 'tasks', hue: 'sky' },
      { to: '/inbox', label: 'Inbox', Icon: IconInbox, needs: 'emails', hue: 'teal' },
      { to: '/drafts', label: 'Drafts', Icon: IconDraft, needs: 'drafts', hue: 'pink' },
      // Audit Chat is pinnable from the /jenny-assistant page — hidden here by default.
      // Reports and Audit Log are out of the menu on purpose. The pages still work at
      // /reports and /activity; add the lines back to show them:
      //   { to: '/reports', label: 'Reports', Icon: IconReport, needs: 'reports' },
      //   { to: '/activity', label: 'Audit Log', Icon: IconActivity, supervisorOnly: true },
    ],
  },
  {
    // Team & Roles and Permissions are tabs under Settings.
    title: 'Studio',
    items: [
      { to: '/', label: 'Dashboard', Icon: IconDashboard, end: true, hue: 'green' },
      { to: '/projects', label: 'Projects', Icon: IconProjects, needs: 'projects', hue: 'orange' },
      { to: '/vendors', label: 'Vendors & Orders', Icon: IconVendors, needs: 'vendors', hue: 'indigo' },
      { to: '/documents', label: 'Documents', Icon: IconDoc, needs: 'documents', hue: 'sky' },
      { to: '/prompts', label: 'Prompt Studio', Icon: IconPrompt, needs: 'prompts', hue: 'violet' },
    ],
  },
];

const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', Icon: IconSettings, needs: 'settings' };

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/projects': 'Projects',
  '/vendors': 'Vendors & Orders',
  '/inbox': 'Inbox',
  '/documents': 'Documents',
  '/prompts': 'Prompt Studio',
  '/assistant': ASSISTANT_NAME,
  '/tasks': 'Tasks',
  '/follow-ups': 'Top Priority Actions',
  '/drafts': 'Drafts',
  '/daily': 'Daily Report',
  '/reports': 'Reports',
  '/activity': 'Audit Log',
  '/jenny-assistant': 'Audit Chat',
  '/team': 'Team & Roles',
  '/permissions': 'Permissions',
  '/settings': 'Settings',
};

const COLLAPSE_KEY = 'janelle.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link to="/" className={`focusable flex items-center gap-3 rounded-lg ${collapsed ? 'justify-center px-0' : 'px-2'} py-1`}>
      {collapsed ? (
        <BrandLogo variant="mark" className="w-11 shrink-0 text-nav-text" />
      ) : (
        <>
          <BrandLogo variant="mark" className="w-14 shrink-0 text-nav-text" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-semibold text-nav-text">Janelle Interiors</div>
            <div className="text-[11px] font-medium text-nav-muted">Workflow System</div>
          </div>
        </>
      )}
    </Link>
  );
}

function NavItemLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const { to, label, Icon, end, hue } = item;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) => {
        return `focusable group relative flex items-center gap-3 rounded-lg text-[14px] transition-colors ${
          collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-[9px]'
        } ${
          isActive
            ? 'bg-nav-hover font-semibold text-nav-text'
            : 'font-medium text-nav-muted hover:bg-nav-hover hover:text-nav-text'
        }`;
      }}
    >
      {({ isActive }) => {
        return (
        <>
          {isActive && (
            <span className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-brass" aria-hidden="true" />
          )}
          {/* Each page keeps its colour; the active one is lit up in it. */}
          {/* Just the glyph in the page's colour — no box around it. The
              active row is already marked by its background and the bar. */}
          <span
            className={`grid h-6 w-6 shrink-0 place-items-center transition-transform ${
              hue ? `${HUE[hue].nav} group-hover:scale-110` : isActive ? 'text-brass' : 'text-nav-muted group-hover:text-nav-text'
            }`}
          >
            <Icon width={19} height={19} strokeWidth={isActive ? 2.2 : 1.9} />
          </span>
          {!collapsed && <span className="truncate">{label}</span>}
        </>
        );
      }}
    </NavLink>
  );
}

function DoubleChevron({ flipped }: { flipped: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-300 ease-out ${flipped ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="M11 17l-5-5 5-5" />
      <path d="M18 17l-5-5 5-5" />
    </svg>
  );
}

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  // A module the studio has closed to this role is not shown at all — a link
  // that always ends in "Insufficient permissions" is worse than no link.
  const { may, user } = useAuth();
  const supervisor = canSupervise(user?.role ?? null);
  const allowed = (i: NavItem) =>
    (!i.needs || may(i.needs)) &&
    (!i.needsWrite || may(i.needsWrite, 'update')) &&
    (!i.supervisorOnly || supervisor) &&
    (!i.principalOnly || user?.role === 'principal');
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter(allowed) }))
    .filter((g) => g.items.length > 0);

  const [pinnedKeys, setPinnedKeys] = useState(readPinnedKeys);
  useEffect(() => {
    const refresh = () => setPinnedKeys(readPinnedKeys());
    window.addEventListener('storage', refresh);
    window.addEventListener(PINNED_CHANGE, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(PINNED_CHANGE, refresh);
    };
  }, []);
  const pinnedItems = pinnedKeys.map((k) => PINNABLE_PAGES[k]).filter(Boolean) as NavItem[];

  return (
    <div className="flex h-full flex-col bg-nav">
      <div className={`flex items-center border-b border-white/10 px-3 py-3 ${collapsed ? 'justify-center' : ''}`}>
        <Brand collapsed={collapsed} />
      </div>

      <nav className={`flex-1 space-y-5 overflow-y-auto px-3 pt-4 ${collapsed ? 'space-y-3' : ''}`}>
        {groups.map((g) => (
          <div key={g.title}>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-white/10" aria-hidden="true" />
            ) : (
              <div className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-nav-muted/70">{g.title}</div>
            )}
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
        {pinnedItems.length > 0 && (
          <div>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-white/10" aria-hidden="true" />
            ) : (
              <div className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-nav-muted/70">Pinned</div>
            )}
            <div className="space-y-0.5">
              {pinnedItems.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        )}
      </nav>

      {may('settings') && (
        <div className="border-t border-white/10 px-3 py-3">
          <NavItemLink item={SETTINGS_ITEM} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

function ThemeButton() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      title={resolved === 'dark' ? 'Switch to light' : 'Switch to dark'}
      className="focusable grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk hover:text-ink"
    >
      {resolved === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

const FOLLOW_LABEL: Record<string, string> = {
  vendor_silence: 'Vendor silent',
  client_approval_overdue: 'Approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
};
const FOLLOW_TONE: Record<string, string> = {
  vendor_silence: 'bg-warn',
  client_approval_overdue: 'bg-crit',
  date_slipping: 'bg-crit',
  spec_gap: 'bg-brass',
};

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function EmptyRow({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex flex-col items-center px-6 py-8 text-center">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-good/10 text-good"><CheckIcon /></span>
      <span className="mt-2.5 text-[13.5px] font-semibold text-ink">{title}</span>
      <span className="mt-0.5 text-[12.5px] text-ink-soft">{body}</span>
    </li>
  );
}

function NotificationsMenu() {
  const { data: followUps } = useFollowUps();
  const { data: drafts } = useDrafts();
  const { data: mentions } = useMentions();
  const markRead = useMarkMentionsRead();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'mentions' | 'followups' | 'drafts'>('followups');
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  const count = followUps.length + drafts.length + mentions.length;
  const badge = count > 9 ? '9+' : String(count);
  const summary = count === 0 ? 'All caught up' : count === 1 ? '1 needs a person' : `${count} need a person`;

  /*
   * Mentions lead when there are any.
   *
   * The other two tabs are the studio's queue — true of everybody, never
   * finished, and there whether or not you look. A mention is addressed to
   * one person by name and is the only thing in here that is waiting on
   * them specifically, so it should not be a tab behind.
   */
  useEffect(() => {
    if (open && mentions.length) setTab('mentions');
  }, [open, mentions.length]);

  const tabs = [
    ...(mentions.length ? [{ key: 'mentions' as const, label: 'Mentions', n: mentions.length }] : []),
    { key: 'followups' as const, label: 'Follow-ups', n: followUps.length },
    { key: 'drafts' as const, label: 'Drafts', n: drafts.length },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? `${count} notifications` : 'Notifications'}
        title="Notifications"
        className={`focusable relative grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-sunk hover:text-ink ${open ? 'bg-sunk text-ink' : 'text-ink-soft'}`}
      >
        <IconBell className={count > 0 && !open ? 'bell-ring' : ''} />
        {count > 0 && (
          <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-crit px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="popover absolute right-0 top-full z-50 mt-1.5 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
            <div className="text-[14px] font-semibold text-ink">Notifications</div>
            <span className="text-[12px] text-ink-faint">{summary}</span>
          </div>

          <div className="flex gap-1 border-b border-line-soft px-2 pt-2">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`focusable -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                  tab === t.key ? 'border-brass text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                {t.label}
                <span className={`rounded-full px-1.5 text-[11px] font-semibold ${t.n > 0 ? 'bg-brass/10 text-brass-deep' : 'bg-sunk text-ink-faint'}`}>{t.n}</span>
              </button>
            ))}
          </div>

          <ul className="max-h-[360px] divide-y divide-line-soft overflow-y-auto">
            {tab === 'followups' && followUps.length === 0 && (
              <EmptyRow title="No open follow-ups" body="Nothing is waiting on a vendor or a client right now." />
            )}
            {tab === 'followups' &&
              followUps.slice(0, 8).map((f) => (
                <li key={f.id}>
                  <Link to="/follow-ups" onClick={close} className="focusable flex gap-3 px-4 py-3 transition-colors hover:bg-sunk/60">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${FOLLOW_TONE[f.type] ?? 'bg-ink-faint'}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{f.who}</span>
                      <span className="block truncate text-[12.5px] text-ink-soft">
                        {FOLLOW_LABEL[f.type] ?? f.type}
                        {f.reason ? ` · ${f.reason}` : ''}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] text-ink-faint">{f.project} · {f.age}</span>
                    </span>
                  </Link>
                </li>
              ))}
            {tab === 'mentions' && mentions.length === 0 && (
              <EmptyRow title="No one is waiting on you" body="When a teammate names you in a task comment, it appears here." />
            )}
            {tab === 'mentions' &&
              mentions.map((m) => (
                <li key={m.id}>
                  <Link
                    to={`/tasks?task=${m.task_id}`}
                    // Read on the way through: opening the task IS seeing it,
                    // and a badge still sitting there afterwards trains people
                    // to ignore the bell.
                    onClick={() => { markRead.mutate([m.id]); close(); }}
                    className="focusable flex gap-3 px-4 py-3 transition-colors hover:bg-sunk/60"
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-crit/10 text-[12px] font-bold text-crit">@</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">
                        {m.task_comments?.profiles?.full_name ?? 'A teammate'} mentioned you
                      </span>
                      {m.task_comments?.body && (
                        <span className="block truncate text-[12.5px] text-ink-soft">{m.task_comments.body}</span>
                      )}
                      <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                        {m.tasks?.title ?? 'A task'} · {ageFrom(m.created_at)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            {tab === 'drafts' && drafts.length === 0 && (
              <EmptyRow title="No drafts waiting" body="Reply drafts appear here after Gmail is read." />
            )}
            {tab === 'drafts' &&
              drafts.slice(0, 8).map((d) => (
                <li key={d.id}>
                  <Link to="/drafts" onClick={close} className="focusable flex gap-3 px-4 py-3 transition-colors hover:bg-sunk/60">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brass/10 text-brass-deep">
                      <IconDoc width={15} height={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{d.subject ?? 'Untitled draft'}</span>
                      {d.body_preview && <span className="block truncate text-[12.5px] text-ink-soft">{d.body_preview}</span>}
                      <span className="mt-0.5 block text-[11.5px] text-ink-faint">Waiting in Gmail · {ageFrom(d.created_at)}</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>

          <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-sunk/40 px-4 py-2.5">
            {tab === 'mentions' ? (
              <>
                <Link to="/tasks" onClick={close} className="focusable inline-flex items-center gap-1 text-[13px] font-semibold text-brass-deep hover:underline">
                  Open the task board <IconArrow width={14} height={14} />
                </Link>
                {mentions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => markRead.mutate(undefined)}
                    disabled={markRead.isPending}
                    className="focusable text-[12.5px] text-ink-soft hover:text-ink"
                  >
                    Mark all read
                  </button>
                )}
              </>
            ) : (
              <Link
                to={tab === 'followups' ? '/follow-ups' : '/drafts'}
                onClick={close}
                className="focusable inline-flex items-center gap-1 text-[13px] font-semibold text-brass-deep hover:underline"
              >
                {tab === 'followups' ? 'Open follow-up inbox' : 'Open all drafts'} <IconArrow width={14} height={14} />
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  const initial = (user?.name ?? '?').slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="focusable flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-sunk"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brass text-[13px] font-bold text-white">{initial}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[160px] truncate text-[13px] font-semibold text-ink">{user?.name}</span>
          <span className="block text-[11px] text-ink-faint">{user ? ROLE_LABELS[user.role] : ''}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`hidden text-ink-faint transition-transform md:block ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="popover absolute right-0 top-full z-50 mt-1.5 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line-soft px-4 py-3">
            <div className="truncate text-[13.5px] font-semibold text-ink">{user?.name}</div>
            <div className="truncate text-[12px] text-ink-faint">{user?.email}</div>
          </div>
          <div className="p-1.5">
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="focusable flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-soft transition-colors hover:bg-sunk hover:text-ink"
            >
              <IconSettings width={16} height={16} /> Settings
            </Link>
            <button
              role="menuitem"
              onClick={() => signOut()}
              className="focusable flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-ink-soft transition-colors hover:bg-sunk hover:text-ink"
            >
              <IconLogout width={16} height={16} /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

/**
 * Always on screen while the admin is signed in as a teammate. Everything
 * done here is done AS that person, so it must never be possible to forget.
 */
function ImpersonationBanner() {
  const [viewing] = useState(readImpersonation);
  const [leaving, setLeaving] = useState(false);
  if (!viewing) return null;
  return (
    <div className="flex min-w-0 flex-1 justify-center">
      <div
        role="status"
        title={`You are signed in as ${viewing.asName} (${viewing.asEmail}). Anything you do is done as them.`}
        className="flex min-w-0 items-center gap-2 rounded-full border border-warn/40 bg-warn/15 py-1 pl-3 pr-1 text-[12.5px] text-ink"
      >
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <span className="hidden text-ink-soft md:inline">Viewing as </span>
          <strong className="font-semibold">{viewing.asName}</strong>
          <span className="hidden text-ink-faint xl:inline"> · {viewing.asEmail}</span>
        </span>
        <button
          type="button"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void endImpersonation();
          }}
          className="shrink-0 rounded-full bg-warn px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {leaving ? 'Returning…' : <><span className="hidden sm:inline">Back to </span>{viewing.adminName}</>}
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  const base = '/' + location.pathname.split('/')[1];
  const pageTitle = PAGE_TITLES[base] ?? PAGE_TITLES['/'];

  // Jenny's panel is a backdrop-plus-overlay (see AssistantPanel): it floats
  // over the page rather than pushing it aside, so the board behind keeps its
  // exact layout when Jenny opens — the same way the midday check-in drawer
  // opens. No docking padding, and nothing here reflows the page.

  return (
    /*
     * `overflow-x-clip`, not `overflow-x-hidden`.
     *
     * They look identical and are not. `overflow-x: hidden` forces the other
     * axis to compute to `auto`, which makes this div a scroll container —
     * and a scroll container is what `position: sticky` inside it measures
     * against. This one never scrolls (the document does), so the sidebar and
     * the top bar had nothing to stick to and rode up out of the window.
     * `clip` crops the same overflow without creating a scrollport, so both
     * go back to sticking to the viewport.
     */
    <div className="flex min-h-screen overflow-x-clip">
      {/* Sidebar — desktop */}
      <aside
        className={`relative z-40 hidden shrink-0 bg-nav transition-[width] duration-200 ease-out lg:block ${collapsed ? 'w-[68px]' : 'w-60'}`}
      >
        <div className="sticky top-0 h-screen">
          <Sidebar collapsed={collapsed} />
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="focusable sidebar-toggle absolute -right-3 top-[22px] grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-ink-soft shadow-card hover:border-brass hover:text-brass-deep"
        >
          <DoubleChevron flipped={collapsed} />
        </button>
        </div>
      </aside>

      {/* Sidebar — mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute left-0 top-0 h-full w-60 shadow-pop">
            <Sidebar collapsed={false} onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface px-4 md:px-6">
          {/* Mobile: open drawer. Desktop: collapse/expand sidebar. */}
          <button
            className="focusable grid h-9 w-9 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk hover:text-ink lg:hidden"
            onClick={() => setDrawer(true)}
            aria-label="Open navigation"
          >
            <MenuIcon />
          </button>
          <button
            className="focusable hidden h-9 w-9 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk hover:text-ink lg:grid"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <MenuIcon />
          </button>

          <h1 className="hidden shrink-0 text-[15px] font-semibold text-ink sm:block">{pageTitle}</h1>

          {/* In the bar itself while signed in as a teammate — always on
              screen, never covering the page. */}
          <ImpersonationBanner />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <span className="mr-1.5">
              <AssistantLauncher />
            </span>
            <NotificationsMenu />
            <ThemeButton />
            <span className="mx-2 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
            <UserMenu />
          </div>
        </header>

        {/* Jenny's page takes the whole width: conversations, a chat and its
            tables need the room more than a reading measure does. */}
        <main
          // 1600px, not Tailwind's 7xl (1280).
          //
          // 1280 was chosen for a reading measure, but almost nothing here is
          // prose: the task board is four columns, Vendors and Projects are
          // wide tables, and the pages that DO have prose already hold it to
          // `max-w-2xl` themselves. On a normal studio monitor the cap was
          // throwing away about 80px down each side — the board got narrower
          // columns so that empty margins could exist.
          //
          // Still capped, not removed: on an ultra-wide screen a table with
          // no limit stretches until a row is impossible to follow across.
          className={`mx-auto w-full flex-1 px-4 py-6 md:px-8 md:py-8 ${base === '/assistant' ? '' : 'max-w-[1600px]'}`}
        >
          {children}
        </main>
      </div>

      <AssistantPanel />

      {/* Outside the main column so it is not affected by the page padding,
          and last so it opens over everything the shell draws. */}
      <ConnectGooglePrompt />
      <TaskReminder />
    </div>
  );
}
