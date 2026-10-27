import { useEffect, useRef, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { canSupervise, type Action, type Resource } from '@janelle/shared';
import { useAuth } from './context/AuthContext';
import { AppShell } from './components/AppShell';
import { AssistantProvider } from './context/AssistantContext';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Vendors from './pages/Vendors';
import VendorDetail from './pages/VendorDetail';
import Prompts from './pages/Prompts';
import FollowUps from './pages/FollowUps';
import Tasks from './pages/Tasks';
import Assistant from './pages/Assistant';
import Drafts from './pages/Drafts';
import Reports from './pages/Reports';
import DailyReport from './pages/DailyReport';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import ConfigNeeded from './pages/ConfigNeeded';
import UsageReport from './pages/UsageReport';
import { Inbox, Documents } from './pages/Simple';
import AuditChat from './pages/AuditChat';

function FloorPlanSVG() {
  return (
    <svg width="220" height="170" viewBox="0 0 220 170" fill="none" aria-hidden="true">
      {/* Outer boundary */}
      <rect className="fp-outer" x="12" y="12" width="196" height="146" rx="2"
        stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
      {/* Vertical divider — bedroom / living split */}
      <line className="fp-wall-v" x1="130" y1="12" x2="130" y2="108"
        stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />
      {/* Horizontal — bedroom / bath split */}
      <line className="fp-wall-h1" x1="130" y1="88" x2="208" y2="88"
        stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />
      {/* Horizontal — kitchen / living split */}
      <line className="fp-wall-h2" x1="12" y1="108" x2="82" y2="108"
        stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />

      {/* Sofa — living room */}
      <g className="fp-furniture">
        <rect x="22" y="60" width="50" height="22" rx="4"
          stroke="rgba(255,255,255,0.30)" strokeWidth="1" />
        <rect x="22" y="60" width="12" height="22" rx="3"
          stroke="rgba(255,255,255,0.20)" strokeWidth="1" />
        <rect x="60" y="60" width="12" height="22" rx="3"
          stroke="rgba(255,255,255,0.20)" strokeWidth="1" />
        {/* Coffee table */}
        <rect x="30" y="46" width="34" height="12" rx="2"
          stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
      </g>

      {/* Bed — bedroom */}
      <g className="fp-furniture">
        <rect x="140" y="20" width="60" height="58" rx="4"
          stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
        {/* Pillow left */}
        <rect x="145" y="24" width="20" height="12" rx="3"
          stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
        {/* Pillow right */}
        <rect x="170" y="24" width="20" height="12" rx="3"
          stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
        {/* Headboard line */}
        <line x1="140" y1="40" x2="200" y2="40"
          stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      </g>

      {/* Dining table — kitchen */}
      <g className="fp-furniture">
        <rect x="20" y="118" width="54" height="32" rx="3"
          stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
        <circle cx="32" cy="118" r="4" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <circle cx="62" cy="118" r="4" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <circle cx="32" cy="150" r="4" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
        <circle cx="62" cy="150" r="4" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      </g>

      {/* Bath fixtures */}
      <g className="fp-furniture">
        <rect x="138" y="96" width="64" height="62" rx="2"
          stroke="rgba(255,255,255,0.20)" strokeWidth="1" />
        <rect x="142" y="100" width="56" height="34" rx="12"
          stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
      </g>

      {/* Room labels */}
      <g className="fp-label" fill="rgba(255,255,255,0.28)" fontSize="8" fontFamily="system-ui,sans-serif">
        <text x="65" y="30" textAnchor="middle">LIVING</text>
        <text x="165" y="10" textAnchor="middle" dy="12">BEDROOM</text>
        <text x="46" y="105" textAnchor="middle" dy="-2">KITCHEN</text>
        <text x="170" y="128" textAnchor="middle" dy="-2">BATH</text>
      </g>
    </svg>
  );
}

function FullScreen({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-nav pt-16">
      <div className="loader-enter flex flex-col items-center gap-7">
        <FloorPlanSVG />
        <div className="flex flex-col items-center gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/40">
            Janelle Interiors
          </p>
          <div className="relative h-[2px] w-40 overflow-hidden rounded-full bg-white/10">
            <div className="loader-bar-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-white/50 to-transparent" />
          </div>
          <p className="text-[12px] text-white/30">{label}</p>
        </div>
      </div>
    </div>
  );
}

function BackendError({ message, onRetry, onSignOut }: { message: string; onRetry: () => void; onSignOut: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="card w-full max-w-md p-7">
        <span className="text-[12px] font-semibold text-crit">Can’t reach the server</span>
        <h1 className="mt-2 text-2xl font-semibold text-ink">The API isn’t responding</h1>
        <p className="mt-2 text-[14px] text-ink-soft">
          You’re signed in, but the app couldn’t load your profile. Make sure the API server is running
          and that <span className="text-[12.5px]">VITE_API_BASE_URL</span> matches its port.
        </p>
        <p className="mt-3 rounded-lg bg-sunk px-3 py-2 text-[11.5px] text-ink-soft">{message}</p>
        <div className="mt-5 flex gap-2">
          <button onClick={onRetry} className="btn-primary">Retry</button>
          <button onClick={onSignOut} className="btn-secondary">Sign out</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A page the studio has closed to this role.
 *
 * The sidebar already hides these, but a bookmark, a link in a digest or a
 * typed URL still lands here — and without this the page rendered and every
 * query behind it came back 403, which reads as "the system is broken"
 * rather than "this is not yours to see".
 */
function Viewable({
  needs,
  action = 'read',
  supervisorOnly,
  principalOnly,
  children,
}: {
  needs?: Resource;
  /** 'update' for the administration screens — see NavItem.needsWrite. */
  action?: Action;
  supervisorOnly?: boolean;
  /** Permissions only: the module that grants the others is not grantable. */
  principalOnly?: boolean;
  children: ReactNode;
}) {
  const { may, user } = useAuth();
  const allowed =
    (!needs || may(needs, action)) &&
    (!supervisorOnly || canSupervise(user?.role ?? null)) &&
    (!principalOnly || user?.role === 'principal');
  if (allowed) return <>{children}</>;
  return (
    <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
      This part of the studio is not open to your role. Ask a principal if you need it.
    </div>
  );
}

/**
 * Where a person starts the day: Follow-ups, or Tasks for a role that cannot
 * see Follow-ups, or the Dashboard when neither is open to them.
 *
 * Only on arrival — opening the app or signing in at `/`. Clicking Dashboard
 * in the menu afterwards still shows the Dashboard, and a `/?google=…` return
 * from connecting Google is left alone for the Dashboard to read.
 */
function useLandOnFollowUps() {
  const { session, user, may } = useAuth();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const landed = useRef(false);

  useEffect(() => {
    if (!session) {
      landed.current = false; // signed out: the next sign-in lands again
      return;
    }
    if (!user || landed.current) return;
    landed.current = true;
    if (pathname !== '/' || search) return;
    if (may('follow_ups')) navigate('/follow-ups', { replace: true });
    else if (may('tasks')) navigate('/tasks', { replace: true });
  }, [session, user, may, pathname, search, navigate]);
}

export default function App() {
  const { configured, loading, session, user, profileError, refresh, signOut, recovery } = useAuth();
  const { pathname } = useLocation();
  useLandOnFollowUps();

  // The shared AI usage report is reachable by its link alone: no sidebar,
  // no sign-in, and no wait on the session — whoever holds the URL is not
  // expected to have an account here.
  if (pathname.startsWith('/u/')) {
    return (
      <Routes>
        <Route path="/u/:token" element={<UsageReport />} />
      </Routes>
    );
  }

  if (!configured) return <ConfigNeeded />;
  if (loading) return <FullScreen label="Loading…" />;
  if (!session) return <Login />;
  // A recovery link signs the person in, so `session` is set and the shell
  // would open as normal — before they have done the one thing they came
  // for. Held here until the new password is saved.
  if (recovery) return <ResetPassword />;
  // Signed in but no profile: either provisioning, or the API is unreachable.
  if (!user) {
    if (profileError) return <BackendError message={profileError} onRetry={refresh} onSignOut={signOut} />;
    return <FullScreen label="Setting up your studio…" />;
  }

  return (
    <AssistantProvider>
      <Routes>
        {/* Standalone — no sidebar, no top bar; has its own shell */}
        <Route path="/jenny-assistant" element={<AuditChat />} />
        {/* Where she used to live. Kept so old links still arrive. */}
        <Route path="/audit" element={<Navigate to="/jenny-assistant" replace />} />

        {/* Everything else lives inside the normal AppShell */}
        <Route
          path="*"
          element={
            <AppShell>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/projects" element={<Viewable needs="projects"><Projects /></Viewable>} />
                <Route path="/projects/:id" element={<Viewable needs="projects"><ProjectDetail /></Viewable>} />
                <Route path="/vendors" element={<Viewable needs="vendors"><Vendors /></Viewable>} />
                <Route path="/vendors/:id" element={<Viewable needs="vendors"><VendorDetail /></Viewable>} />
                <Route path="/inbox" element={<Viewable needs="emails"><Inbox /></Viewable>} />
                <Route path="/documents" element={<Viewable needs="documents"><Documents /></Viewable>} />
                <Route path="/prompts" element={<Viewable needs="prompts"><Prompts /></Viewable>} />
                <Route path="/assistant" element={<Assistant />} />
                <Route path="/tasks" element={<Viewable needs="tasks"><Tasks /></Viewable>} />
                <Route path="/follow-ups" element={<Viewable needs="follow_ups"><FollowUps /></Viewable>} />
                <Route path="/drafts" element={<Viewable needs="drafts"><Drafts /></Viewable>} />
                <Route path="/daily" element={<Viewable supervisorOnly><DailyReport /></Viewable>} />
                <Route path="/reports" element={<Viewable needs="reports"><Reports /></Viewable>} />
                <Route path="/activity" element={<Viewable supervisorOnly><Activity /></Viewable>} />
                {/* Moved under Settings; the old addresses still land there. */}
                <Route path="/team" element={<Navigate to="/settings?tab=team" replace />} />
                <Route path="/permissions" element={<Navigate to="/settings?tab=permissions" replace />} />
                <Route path="/settings" element={<Viewable needs="settings"><Settings /></Viewable>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          }
        />
      </Routes>
    </AssistantProvider>
  );
}
