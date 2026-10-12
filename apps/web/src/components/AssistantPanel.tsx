import { useEffect, useState, type SVGProps } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ASSISTANT_NAME } from '@janelle/shared';
import { useAssistant } from '../context/AssistantContext';
import { AssistantChat, JennyAvatar } from './AssistantChat';
import { AssistantHistory } from './AssistantHistory';

/**
 * Jenny, at hand from anywhere: a button in the header, a shortcut, and a
 * panel that opens beside whatever you are looking at rather than instead
 * of it.
 */

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconClose = (p: IconProps) => <svg {...stroke} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconExpand = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /></svg>
);
const IconHistory = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>
);
const IconNewChat = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const IconTalk = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M4 10v4" /><path d="M8 7v10" /><path d="M12 4v16" /><path d="M16 7v10" /><path d="M20 10v4" /></svg>
);
const IconSparkle = (p: IconProps) => (
  <svg {...stroke} {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="m12 8 1.2 2.8L16 12l-2.8 1.2L12 16l-1.2-2.8L8 12l2.8-1.2Z" />
  </svg>
);

/** "⌘K" on a Mac, "Ctrl K" everywhere else — the key the person will actually press. */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const SHORTCUT_LABEL = isMac ? '⌘K' : 'Ctrl K';

const onAssistantPage = (path: string) => path.startsWith('/assistant');

/** The header button. Carries the count of things in an unopened briefing. */
export function AssistantLauncher() {
  const { open, setOpen, unseen } = useAssistant();
  const { pathname } = useLocation();
  if (onAssistantPage(pathname)) return null;

  const label = unseen
    ? `Ask ${ASSISTANT_NAME} — ${unseen} ${unseen === 1 ? 'thing needs' : 'things need'} you`
    : `Ask ${ASSISTANT_NAME} (${SHORTCUT_LABEL})`;

  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label={label}
      aria-expanded={open}
      title={label}
      className={`focusable relative flex h-9 items-center gap-2 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
        open ? 'border-brass/50 bg-brass/10 text-brass-deep' : 'border-line text-ink-soft hover:border-brass/40 hover:bg-sunk hover:text-ink'
      }`}
    >
      <IconSparkle className={open ? 'text-brass-deep' : 'text-brass'} />
      <span className="hidden sm:inline">Ask {ASSISTANT_NAME}</span>
      <kbd className="hidden rounded border border-line bg-sunk px-1.5 py-px font-sans text-[10.5px] text-ink-faint md:inline">
        {SHORTCUT_LABEL}
      </kbd>
      {unseen > 0 && (
        <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brass px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface">
          {unseen > 9 ? '9+' : unseen}
        </span>
      )}
    </button>
  );
}

/** The header of the panel: who she is, what she is doing, and the few things to do with her. */
function PanelHeader({ showingHistory, toggleHistory }: { showingHistory: boolean; toggleHistory: () => void }) {
  const { setOpen, newConversation, handsFree, setHandsFree, canListen, pending, status, voice, messages, conversations } =
    useAssistant();

  const doing =
    voice === 'listening' ? 'Listening' : voice === 'speaking' ? 'Speaking' : pending ? `${status ?? 'Thinking'}…` : 'Your assistant';

  const iconBtn =
    'focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk hover:text-ink disabled:opacity-40';

  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <JennyAvatar size={34} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[15px] font-semibold text-ink">{ASSISTANT_NAME}</div>
        <div className={`truncate text-[12px] ${pending || voice !== 'off' ? 'text-brass-deep' : 'text-ink-faint'}`}>{doing}</div>
      </div>

      {canListen && (
        <button
          type="button"
          onClick={() => setHandsFree(!handsFree)}
          aria-pressed={handsFree}
          title={handsFree ? 'End the spoken conversation' : 'Talk hands-free — she answers aloud and listens again'}
          className={`focusable flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors ${
            handsFree ? 'bg-brass text-white hover:bg-brass-deep' : 'text-ink-soft hover:bg-sunk hover:text-ink'
          }`}
        >
          <IconTalk width={16} height={16} />
          Talk
        </button>
      )}
      <button
        type="button"
        onClick={toggleHistory}
        aria-pressed={showingHistory}
        disabled={handsFree}
        aria-label="Past conversations"
        title={`Past conversations${conversations.length ? ` (${conversations.length})` : ''}`}
        className={`${iconBtn} ${showingHistory ? 'bg-brass/10 text-brass-deep' : ''}`}
      >
        <IconHistory />
      </button>
      <button
        type="button"
        onClick={newConversation}
        disabled={messages.length === 0}
        aria-label="New conversation"
        title="New conversation"
        className={iconBtn}
      >
        <IconNewChat />
      </button>
      <Link to="/assistant" aria-label="Open full page" title="Open full page" className={iconBtn}>
        <IconExpand />
      </Link>
      <button type="button" onClick={() => setOpen(false)} aria-label="Close" title="Close (Esc)" className={iconBtn}>
        <IconClose />
      </button>
    </div>
  );
}

/**
 * The panel, and the shortcut that summons it from anywhere.
 *
 * Opens beside the page rather than over it where the screen is wide enough
 * — AppShell makes room — so "what is late on this one?" can be asked while
 * the project is still in view.
 */
export function AssistantPanel() {
  const { open, setOpen, requestFocus } = useAssistant();
  const { pathname } = useLocation();
  const onPage = onAssistantPage(pathname);
  const [history, setHistory] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        // A rich-text editor already means something by ⌘K — insert a link.
        // Inside one, the editor keeps it.
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable) return;
        e.preventDefault();
        if (onPage) requestFocus();
        else setOpen(!open);
        return;
      }
      if (e.key === 'Escape' && open && !onPage) {
        // The list closes first; the panel on the next press.
        if (history) setHistory(false);
        else setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onPage, setOpen, requestFocus, history]);

  if (!open || onPage) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)} aria-hidden />
      <aside
        aria-label={ASSISTANT_NAME}
        className="assistant-drawer fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-pop sm:w-[440px]"
      >
        <PanelHeader showingHistory={history} toggleHistory={() => setHistory((v) => !v)} />
        {history ? (
          <AssistantHistory onOpened={() => setHistory(false)} onNew={() => setHistory(false)} />
        ) : (
          <AssistantChat compact />
        )}
      </aside>
    </>
  );
}
