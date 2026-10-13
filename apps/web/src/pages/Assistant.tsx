import { useLayoutEffect, useRef, useState } from 'react';
import { Bot, History, X } from 'lucide-react';
import { AssistantChat } from '../components/AssistantChat';
import { AssistantHistory } from '../components/AssistantHistory';
import { AgentCards } from '../components/AgentPicker';
import { useSearchParams } from 'react-router-dom';
import { useAssistant } from '../context/AssistantContext';

/** Never shorter than this, however little room the window has. */
const MIN_CHAT_PX = 448;

/** The page's own bottom padding, left clear beneath the conversation. */
const BOTTOM_GAP_PX = 24;

/**
 * Stretch from wherever this lands to the bottom of the window.
 *
 * The height was `calc(100vh - 15rem)` — a guess at everything above it,
 * which went stale the moment the page heading changed size and left a band
 * of dead space under the conversation. Measuring is right whatever the
 * heading does, and stays right the next time it changes.
 *
 * It cannot feed back on itself: this element is the last block in its
 * column, so its own height can never move its top, and a measurement that
 * has not changed writes no state.
 */
function useFillsViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // Where it starts on the PAGE, not in the window. getBoundingClientRect
      // is window-relative, so once the page had scrolled even slightly the
      // top read smaller and the card grew by exactly the scroll distance;
      // that overflowed the window, kept the page scrolled, and left the
      // composer below the fold — and it stayed that way until a reload.
      // The two pixels of slack stop rounding from tipping the page into
      // overflow, whose scrollbar narrows the page and re-wraps the heading
      // above, which moves the top and starts the measuring over.
      const top = el.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(MIN_CHAT_PX, Math.floor(window.innerHeight - top - BOTTOM_GAP_PX - 2));
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
    };

    measure();
    window.addEventListener('resize', measure);
    // Anything above it changing height — a heading wrapping, a banner
    // appearing — moves where it starts, so the page itself is watched.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  return [ref, height] as const;
}

type Panel = 'conversations' | 'agents';

/**
 * Jenny with the whole screen to herself.
 *
 * The same conversation as the side panel — not a second one — for when an
 * answer is a long table, or a spoken conversation deserves the room. The
 * conversation IS the page: no card around it and no tab strip above it.
 * Past conversations and the agents are two small buttons in the corner,
 * each opening over the conversation and closing back to it, so nothing
 * sits between the person and the question they came to ask.
 */
export default function Assistant() {
  const { conversations, agents, setAgents } = useAssistant();
  const [params, setParams] = useSearchParams();
  const [fillRef, fillHeight] = useFillsViewport<HTMLDivElement>();

  // `?tab=` is kept so links into the history or the agents still work.
  const asked = params.get('tab');
  const panel: Panel | null = asked === 'agents' || asked === 'conversations' ? asked : null;
  const show = (next: Panel | null) => {
    const p = new URLSearchParams(params);
    if (next) p.set('tab', next);
    else p.delete('tab');
    setParams(p, { replace: true });
  };

  const corner = [
    { key: 'conversations' as const, label: 'Conversations', count: conversations.length, on: false, icon: History },
    { key: 'agents' as const, label: 'Agents', count: agents.length, on: agents.length > 0, icon: Bot },
  ];

  return (
    // At least a screen tall so the welcome sits centred, and free to grow
    // past it: a long conversation scrolls with the page, not inside a box.
    // The negative bottom margin lets the composer sit flush on the window's
    // edge instead of above the page's own padding.
    <div ref={fillRef} className="relative -mb-6 flex flex-col md:-mb-8" style={fillHeight ? { minHeight: fillHeight + BOTTOM_GAP_PX } : undefined}>
      {/* The corner: past conversations, and which agents are on. */}
      {/* Stays in the corner as the page scrolls, just under the sticky header. */}
      <div className="pointer-events-none sticky top-[4.5rem] z-20 -mb-8 flex h-8 items-center justify-end gap-1.5 pr-1 sm:pr-2">
        {corner.map(({ key, label, count, on, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => show(panel === key ? null : key)}
            aria-pressed={panel === key}
            title={label}
            className={`focusable pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors ${
              panel === key
                ? 'border-brass/40 bg-brass/15 text-brass-deep'
                : 'border-line bg-surface/80 text-ink-soft backdrop-blur hover:bg-sunk hover:text-ink'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="hidden sm:inline">{label}</span>
            {count > 0 && (
              <span
                className={`grid min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-bold leading-[18px] ${
                  on ? 'bg-brass text-white' : 'bg-sunk text-ink-faint'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <AssistantChat page />

      {panel && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-paper/70 p-2 pt-16 backdrop-blur-[2px] sm:p-6 sm:pt-20" onClick={() => show(null)}>
          <div
            role="dialog"
            aria-label={panel === 'agents' ? 'Agents' : 'Conversations'}
            onClick={(e) => e.stopPropagation()}
            className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop ${
              panel === 'agents' ? 'max-w-4xl' : 'max-w-2xl'
            }`}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <h2 className="text-[14px] font-semibold text-ink">{panel === 'agents' ? 'Agents' : 'Conversations'}</h2>
              <button
                type="button"
                onClick={() => show(null)}
                aria-label="Back to the conversation"
                title="Back to the conversation"
                className="focusable grid h-8 w-8 place-items-center rounded-full text-ink-soft hover:bg-sunk hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {panel === 'agents' ? (
              <div className="min-h-0 overflow-y-auto p-4">
                <AgentCards agents={agents} onChange={setAgents} />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col" style={{ height: 'min(36rem, calc(100vh - 10rem))' }}>
                <AssistantHistory showAgents={false} onOpened={() => show(null)} onNew={() => show(null)} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
