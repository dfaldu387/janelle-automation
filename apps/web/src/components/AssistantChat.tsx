import { useEffect, useLayoutEffect, useRef, useState, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import { ASSISTANT_NAME } from '@janelle/shared';
import { useAssistant, type AttachedFile, type ChatMessage } from '../context/AssistantContext';
import { api } from '../lib/api';
import { useConfirmAction, useRecordCheckin, type CheckinOutcome, type CheckinTask } from '../lib/queries';
import { bestHearing, listen, speak, type MicLevel, type StopListening } from '../lib/speech';
import { AssistantAnswerView, BriefingAnswerView, AttachedFiles, answerIsPictures, answerIsWide, sizeLabel } from './AssistantAnswer';
import { useImagineOptions } from '../lib/queries';
import { readableAttachment } from '../lib/attachments';
import { IconMic, IconPlus, IconSend, IconStop } from './icons';
import { IconTalk } from './AssistantPanel';

/**
 * The conversation with Jenny: what was said, what she is doing now, and
 * the ways to say the next thing — typed, one spoken question, or a spoken
 * back-and-forth.
 *
 * One component for both places she appears. `compact` is the side panel,
 * which is narrow whatever the window size; the full page is not.
 */

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconCopy = (p: IconProps) => (
  <svg {...stroke} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>
);
const IconCheck = (p: IconProps) => <svg {...stroke} {...p}><path d="M20 6 9 17l-5-5" /></svg>;
const IconSpeaker = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);
const IconClip = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.5 7" /></svg>
);
const IconX = (p: IconProps) => <svg {...stroke} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconRetry = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
);
const IconSparkle = (p: IconProps) => (
  <svg {...stroke} {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    <path d="M12 8.5 13.3 11.2 16 12l-2.7 1.3L12 16l-1.3-2.7L8 12l2.7-.8z" />
  </svg>
);
const IconSearch = (p: IconProps) => (
  <svg {...stroke} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
const IconClock = (p: IconProps) => (
  <svg {...stroke} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
const IconTrend = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M3 17 9 11l4 4 8-8" /><path d="M15 7h6v6" /></svg>
);
const IconEvidence = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><circle cx="11.5" cy="14.5" r="2.5" /><path d="m13.5 16.5 2 2" /></svg>
);

/**
 * The questions offered on an empty conversation, each as a card: what kind
 * of question it is, and the question itself, sent as written when pressed.
 */
const QUICK_CARDS: { label: string; question: string; icon: (p: IconProps) => JSX.Element }[] = [
  { label: 'What is late', question: 'What tasks are overdue right now?', icon: IconSearch },
  { label: 'This week', question: 'What did the team work on this week?', icon: IconClock },
  { label: 'Across projects', question: 'Which projects have the most open tasks?', icon: IconTrend },
  { label: 'Chase vendors', question: 'Show me pending vendor follow-ups', icon: IconEvidence },
];


export function JennyAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brass font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.46 }}
      aria-hidden="true"
    >
      {ASSISTANT_NAME[0]}
    </span>
  );
}

// ── Messages ────────────────────────────────────────────────

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function DayDivider({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
      <span className="h-px flex-1 bg-line" />
      {dayLabel(at)}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * What a drafted email says, shown before anyone confirms it.
 *
 * Confirming a task sight unseen is fine — its summary is the task. An email
 * is not: the summary is a subject line, and the words that go to a client
 * are the whole point. So the draft is shown in full, where it can be read.
 */
function DraftPreview({ input }: { input: Record<string, unknown> }) {
  const line = (label: string, value: unknown) =>
    value ? (
      <div className="flex gap-2">
        <span className="w-14 shrink-0 text-ink-faint">{label}</span>
        <span className="min-w-0 break-words text-ink">{String(value)}</span>
      </div>
    ) : null;

  return (
    <div className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px]">
      {line('To', input.to)}
      {line('Cc', input.cc)}
      {line('Subject', input.subject)}
      <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-line border-t border-line pt-2 leading-relaxed text-ink-soft">
        {String(input.body ?? '')}
      </p>
    </div>
  );
}

/**
 * What she has prepared, and the person's answer to it.
 *
 * Three states, always visible: waiting (with the ways to answer — a button,
 * or just saying yes), saved, or turned down. A proposal that looks the same
 * before and after is how "I've created the task" got said about a task
 * nobody had saved.
 */
function Proposals({ message }: { message: ChatMessage }) {
  const { markDone, markDismissed, acknowledge } = useAssistant();
  const confirm = useConfirmAction();
  if (!message.proposed?.length) return null;

  return (
    <div className="mt-3 space-y-2.5 border-t border-line pt-3">
      {message.proposed.map((p, j) => {
        const key = `${message.id}-${j}`;
        const saved = message.done?.includes(key);
        const dismissed = message.dismissed?.includes(key);
        const isDraft = p.tool === 'propose_draft';
        const isUpdate = p.tool === 'propose_task_update';
        return (
          <div key={key} className="space-y-2">
            {isDraft && !dismissed && <DraftPreview input={p.input} />}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className={`text-[13px] ${dismissed ? 'text-ink-faint line-through' : 'text-ink'}`}>{p.summary}</span>
              {saved ? (
                <Link
                  to={isDraft ? '/drafts' : '/tasks'}
                  className="inline-flex items-center gap-1 rounded-full bg-good/10 px-2 py-0.5 text-[12px] font-semibold text-good"
                >
                  <IconCheck width={13} height={13} />
                  {isDraft ? 'Saved to Drafts' : isUpdate ? 'Updated' : 'Added to Tasks'}
                </Link>
              ) : dismissed ? (
                <span className="text-[12px] text-ink-faint">{isUpdate ? 'Not changed' : 'Not added'}</span>
              ) : (
                <>
                  <button
                    className="btn-primary btn-sm"
                    disabled={confirm.isPending}
                    onClick={() =>
                      confirm.mutate(
                        { tool: p.tool, input: p.input },
                        {
                          onSuccess: (result) => {
                            markDone(message.id, key);
                            acknowledge(result);
                          },
                        },
                      )
                    }
                  >
                    {confirm.isPending ? 'Saving…' : isDraft ? 'Save to Drafts' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={confirm.isPending}
                    onClick={() => markDismissed(message.id, key)}
                  >
                    Dismiss
                  </button>
                  <span className="text-[11.5px] text-ink-faint">or just say “yes”</span>
                </>
              )}
            </div>
          </div>
        );
      })}
      {confirm.isError && <p className="text-[12.5px] text-crit">{(confirm.error as Error).message}</p>}
    </div>
  );
}

const shortDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const OUTCOME_LABEL: Record<CheckinOutcome, string> = { done: 'Done', blocked: 'Blocked', tomorrow: 'Rolls to tomorrow' };

/**
 * The end-of-day check-in: the day's tasks, each with a button per answer.
 *
 * An answer is saved the moment it is pressed (POST /assistant/checkin) —
 * the task's status, a note with the reason, a line in the log — and kept
 * on the message, so a reopened conversation still shows what was said.
 * "Blocked" asks why before saving: the reason is what tomorrow's plan,
 * and the owner, need to see.
 */
function CheckinAnswerView({ message }: { message: ChatMessage }) {
  const { setCheckinOutcome } = useAssistant();
  const record = useRecordCheckin();
  const [asking, setAsking] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = message.checkin ?? [];

  const answer = (t: CheckinTask, outcome: CheckinOutcome, note?: string) => {
    setBusy(t.id);
    setError(null);
    record.mutate(
      { task_id: t.id, outcome, note: note?.trim() || null },
      {
        onSuccess: () => {
          setCheckinOutcome(message.id, t.id, outcome, note?.trim() || null);
          setAsking(null);
          setWhy('');
        },
        onError: (e) => setError((e as Error).message),
        onSettled: () => setBusy(null),
      },
    );
  };

  const groups: { key: CheckinTask['bucket']; label: string; hint?: string }[] = [
    { key: 'open', label: 'Still open', hint: 'Done, blocked, or does it roll to tomorrow?' },
    { key: 'blocked', label: 'Blocked', hint: 'Still stuck? Say what is in the way.' },
    { key: 'tomorrow', label: 'Due tomorrow' },
    { key: 'done', label: 'Finished today' },
  ];

  return (
    <div className="space-y-4">
      <p className="text-[14px] leading-relaxed text-ink">{message.answer?.lead ?? message.content}</p>
      {groups.map((g) => {
        const rows = tasks.filter((t) => t.bucket === g.key);
        if (!rows.length) return null;
        return (
          <div key={g.key}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                {g.label} <span className="font-medium">({rows.length})</span>
              </span>
              {g.hint && <span className="text-[11.5px] text-ink-faint">{g.hint}</span>}
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {rows.map((t) => {
                const meta = [t.project, t.due ? `due ${shortDay(t.due)}` : null].filter(Boolean).join(' · ');
                const settled = t.outcome ?? null;
                const open = asking === t.id;
                return (
                  <li key={t.id} className="px-3.5 py-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                      <div className="min-w-0 flex-1">
                        <Link to={`/tasks?task=${t.id}`} className={`focusable text-[13.5px] font-semibold leading-snug text-ink hover:underline ${settled === 'done' || g.key === 'done' ? 'line-through text-ink-soft' : ''}`}>
                          {t.title}
                        </Link>
                        {meta && <p className="text-[12px] text-ink-soft">{meta}</p>}
                        {t.note && !settled && (
                          <p className="mt-1 border-l-2 border-crit/60 pl-2 text-[12px] text-ink-soft">{t.note}</p>
                        )}
                        {settled && t.outcomeNote && (
                          <p className="mt-1 border-l-2 border-brass/60 pl-2 text-[12px] text-ink-soft">{t.outcomeNote}</p>
                        )}
                      </div>
                      {g.key === 'done' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-good/10 px-2 py-0.5 text-[11.5px] font-semibold text-good">
                          <IconCheck width={12} height={12} /> Done
                        </span>
                      ) : settled ? (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                            settled === 'done' ? 'bg-good/10 text-good' : settled === 'blocked' ? 'bg-crit/10 text-crit' : 'bg-sunk text-ink-soft'
                          }`}
                        >
                          {settled === 'done' && <IconCheck width={12} height={12} />}
                          {OUTCOME_LABEL[settled]}
                        </span>
                      ) : (
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                          <button type="button" className="btn-secondary btn-sm" disabled={busy === t.id} onClick={() => answer(t, 'done')}>
                            Done
                          </button>
                          <button
                            type="button"
                            className={`btn-secondary btn-sm ${open ? 'border-crit/50 text-crit' : ''}`}
                            disabled={busy === t.id}
                            onClick={() => {
                              setAsking(open ? null : t.id);
                              setWhy('');
                            }}
                          >
                            {g.key === 'blocked' ? 'Still blocked' : 'Blocked'}
                          </button>
                          <button type="button" className="btn-ghost btn-sm" disabled={busy === t.id} onClick={() => answer(t, 'tomorrow')}>
                            Tomorrow
                          </button>
                        </div>
                      )}
                    </div>
                    {open && !settled && (
                      <form
                        className="mt-2 flex flex-wrap items-end gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          answer(t, 'blocked', why);
                        }}
                      >
                        <textarea
                          autoFocus
                          rows={2}
                          value={why}
                          onChange={(e) => setWhy(e.target.value)}
                          placeholder="What is in the way? Who are you waiting on?"
                          className="input min-w-0 flex-1 resize-none text-[13px]"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              answer(t, 'blocked', why);
                            }
                          }}
                        />
                        <button type="submit" className="btn-primary btn-sm" disabled={busy === t.id}>
                          {busy === t.id ? 'Saving…' : 'Save'}
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {error && <p className="text-[12.5px] text-crit">{error}</p>}
      {tasks.some((t) => t.bucket !== 'done' && !t.outcome) && (
        <p className="text-[12.5px] text-ink-faint">Anything not answered stays as it is. Something else in your way? Just say so here.</p>
      )}
    </div>
  );
}

/** Small, quiet actions under an answer: take the words away, or hear them. */
function MessageActions({ message }: { message: ChatMessage }) {
  const { canSpeak } = useAssistant();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused — nothing useful to say about it */
    }
  }

  const btn = 'focusable inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-faint transition-colors hover:bg-sunk hover:text-ink';
  return (
    <div className="mt-1 flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
      <button type="button" onClick={copy} className={btn} aria-label="Copy answer">
        {copied ? <IconCheck /> : <IconCopy />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {canSpeak && (
        <button type="button" onClick={() => speak(message.answer?.speech || message.content)} className={btn} aria-label="Read answer aloud">
          <IconSpeaker />
          Listen
        </button>
      )}
      <span className="ml-1 text-[11px] text-ink-faint">{timeOf(message.at)}</span>
    </div>
  );
}

const IconPencil = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>
);

/**
 * A question the person asked — which they can take back and ask better.
 *
 * Asked wrongly ("the flooring plan" when they meant the finish plan), the
 * only way on was to type the whole thing again underneath, and the wrong
 * answer stayed in the history for the model to build on. Editing asks it
 * again in place: what came after is replaced, so the conversation reads as
 * though it had been asked right the first time.
 */
function UserMessage({ message }: { message: ChatMessage }) {
  const { editMessage, pending, messages } = useAssistant();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // How much of the conversation an edit would replace, so it is said first.
  const after = messages.length - 1 - messages.findIndex((m) => m.id === message.id);

  // Open with the cursor at the end, sized to the words.
  useLayoutEffect(() => {
    const el = box.current;
    if (!editing || !el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [editing, draft]);
  useEffect(() => {
    const el = box.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const canSend = !pending && (!!draft.trim() || !!message.files?.length);
  const sendLabel = message.made === 'image' ? 'Draw it' : message.made === 'video' ? 'Make it' : 'Send';
  const submit = () => {
    if (!canSend) return;
    setEditing(false);
    editMessage(message.id, draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(message.content);
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused — nothing useful to say about it */
    }
  }

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-brass/50 bg-brass/5 p-2.5">
          <textarea
            ref={box}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // As in the box below: Enter sends, Shift+Enter is a new line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            aria-label="Edit your message"
            className="block max-h-60 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed text-ink outline-none"
          />
          {message.files?.length ? <AttachedFiles files={message.files} /> : null}
          {/*
            * Icons on a phone, words where there is room for them. Two
            * worded buttons and the warning never fitted one line on a
            * narrow screen: the buttons stacked and the warning they were
            * stacked under got clipped mid-sentence. The label survives as
            * the tooltip and the accessible name, so nothing is lost but the
            * space it was taking.
            */}
          <div className="mt-2 flex items-center justify-end gap-2">
            {after > 0 && (
              <span className="mr-auto min-w-0 px-1.5 text-[11.5px] leading-snug text-ink-faint">
                Sending replaces {after === 1 ? 'the answer' : 'everything'} below
              </span>
            )}
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel"
              title="Cancel"
              className="btn-secondary btn-sm shrink-0 px-2 sm:px-3"
            >
              <IconX width={15} height={15} className="sm:hidden" />
              <span className="hidden sm:inline">Cancel</span>
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={sendLabel}
              title={sendLabel}
              className="btn-primary btn-sm shrink-0 px-2 sm:px-3"
            >
              <IconSend width={15} height={15} className="sm:hidden" />
              <span className="hidden sm:inline">{sendLabel}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const btn =
    'focusable inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-faint transition-colors hover:bg-sunk hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="group flex flex-col items-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brass/10 px-4 py-2.5 text-[14px] leading-relaxed text-ink">
        {message.content && <p className="whitespace-pre-line">{message.content}</p>}
        {message.files?.length ? <AttachedFiles files={message.files} /> : null}
      </div>
      {/* Always there on a phone, where nothing hovers; on hover elsewhere. */}
      <div className="mt-1 flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
        <button type="button" onClick={copy} className={btn} aria-label="Copy your message">
          {copied ? <IconCheck /> : <IconCopy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(message.content);
            setEditing(true);
          }}
          disabled={pending}
          className={btn}
          aria-label="Edit this message and ask again"
          title={pending ? 'Wait for the answer in progress first' : 'Edit and ask again'}
        >
          <IconPencil />
          Edit
        </button>
      </div>
    </div>
  );
}

/*
 * `app` is the standalone page — Jenny installed and opened on her own.
 * There she reads as a messaging app rather than a panel in a workflow
 * system: her words sit plainly on the page instead of inside a tinted
 * card, and the avatar goes, because in a conversation with exactly one
 * other party every message is already attributed by which side it is on.
 * The panel and the studio's own page keep the card treatment, which is
 * what tells them apart from the page behind them.
 */
function MessageView({ message, compact, app = false }: { message: ChatMessage; compact: boolean; app?: boolean }) {
  const { send, imagine, pending } = useAssistant();

  if (message.role === 'user') return <UserMessage message={message} />;

  if (message.kind === 'error') {
    return (
      <div className={`flex ${app ? '' : 'gap-2.5'}`}>
        {!app && <JennyAvatar />}
        <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-crit/30 bg-crit/5 px-4 py-2.5">
          <p className="text-[13.5px] text-ink">That didn't work: {message.content}</p>
          {(message.retry || message.retryFiles?.length) && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                // A failed picture is drawn again, not asked of Jenny.
                message.retryKind
                  ? imagine(message.retry ?? '', message.retryKind, { files: message.retryFiles })
                  : send(message.retry ?? '', { files: message.retryFiles })
              }
              className="btn-secondary btn-sm mt-2"
            >
              <IconRetry />
              {message.retryKind === 'image' ? 'Draw it again' : message.retryKind === 'video' ? 'Make it again' : 'Try again'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const briefing = message.kind === 'briefing';
  const checkin = message.kind === 'checkin';
  const width = compact || checkin || answerIsWide(message.answer)
    ? 'w-full'
    : answerIsPictures(message.answer)
      ? 'w-full max-w-[38rem]'
      : message.answer?.items.length
        ? 'w-full max-w-[40rem]'
        : 'max-w-[85%]';

  return (
    <div className={`group flex ${app ? '' : 'gap-2.5'}`}>
      {!app && <JennyAvatar />}
      <div className={`min-w-0 ${app ? 'w-full' : width}`}>
        <div
          className={
            app
              ? 'text-[15px] leading-relaxed text-ink'
              : `rounded-2xl rounded-tl-md px-4 py-3 text-[14px] leading-relaxed text-ink ${
                  briefing || checkin ? 'border border-brass/25 bg-brass/[0.06]' : 'bg-sunk'
                }`
          }
        >
          {briefing && (
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-brass-deep">Your briefing</div>
          )}
          {checkin && (
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-brass-deep">End-of-day check-in</div>
          )}
          {checkin ? (
            <CheckinAnswerView message={message} />
          ) : message.answer ? (
            briefing
              ? <BriefingAnswerView answer={message.answer} wide={!compact && !app} />
              : <AssistantAnswerView answer={message.answer} compact={compact} />
          ) : (
            <p className="whitespace-pre-line">{message.content}</p>
          )}
          <Proposals message={message} />
          <Rendering message={message} />
        </div>
        <MessageActions message={message} />
      </div>
    </div>
  );
}

/**
 * A clip still being drawn.
 *
 * Shown under the answer that asked for it, because the answer arrived
 * first and said so. It is replaced by the video itself when the job
 * finishes — the person does not reload, and does not have to ask again.
 */
function Rendering({ message }: { message: ChatMessage }) {
  const waiting = message.jobs?.length ?? 0;
  if (!waiting) return null;
  return (
    <div
      className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink-soft"
      role="status"
      aria-live="polite"
    >
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {waiting > 1 ? `${waiting} clips are rendering` : 'The clip is rendering'} — it appears here when it is ready.
    </div>
  );
}

/** What she is doing while the answer is on its way. */
function Working({ status }: { status: string | null }) {
  return (
    <div className="flex items-center gap-2.5" role="status" aria-live="polite">
      <JennyAvatar />
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-sunk px-4 py-2.5 text-[13px] text-ink-soft">
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {status ? `${status}…` : 'Thinking…'}
      </div>
    </div>
  );
}

function Suggestions({ items, onPick, disabled }: { items: string[]; onPick: (q: string) => void; disabled: boolean }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pl-[38px]">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onPick(s)}
          className="focusable rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:border-brass/50 hover:bg-brass/5 hover:text-ink disabled:opacity-50"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Saying the next thing ───────────────────────────────────

/** What Jenny can read. The server checks the bytes too; this only saves a wasted upload. */
const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Anything picture-shaped is offered: what the server cannot take is
// converted in the browser first (see lib/attachments).
const ACCEPT_ATTR = '.pdf,image/*,.heic,.heif,.avif,.svg,.xlsx,.xls,.docx,.csv,.tsv,.txt,.md';
const MAX_FILES = 4;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: 'uploading' | 'ready' | 'failed';
  file?: AttachedFile;
  error?: string;
  /** A local picture of an image, for the chip. */
  thumb?: string;
  controller: AbortController;
}

/**
 * Worth trying, rather than known-good.
 *
 * What a file really is gets decided from its bytes a moment later, and
 * anything the browser can display is converted before it is sent — so the
 * gate here only needs to keep out what is plainly not a document or a
 * picture at all.
 */
const readableType = (f: File) =>
  f.type.startsWith('image/') ||
  f.type === 'application/pdf' ||
  ACCEPT.includes(f.type) ||
  /\.(pdf|png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|svg|xlsx?|docx?|csv|tsv|txt|md)$/i.test(f.name);

type ComposeMode = 'ask' | 'image';

const IconChat = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></svg>
);
const IconImage = (p: IconProps) => (
  <svg {...stroke} {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m21 16-5-5-9 9" /></svg>
);
function Composer({
  compact,
  app = false,
  page = false,
  dropInto,
}: {
  compact: boolean;
  app?: boolean;
  page?: boolean;
  dropInto: React.MutableRefObject<((files: File[]) => void) | null>;
}) {
  const {
    send, imagine, pending, stop, canListen, lookingAt, focusRequest, setMicError, vocabulary, uploadFile, prefill, attachRequest,
    newConversation, messages, handsFree, setHandsFree,
  } = useAssistant();
  const { data: canMake } = useImagineOptions();
  const [text, setText] = useState('');
  /**
   * Ask, or make.
   *
   * Asking goes through Jenny, who decides what to do with it. Making does
   * not: the person has already decided, so it goes straight to the
   * provider and costs no model tokens at all.
   */
  const [mode, setMode] = useState<ComposeMode>('ask');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<HTMLInputElement>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [listening, setListening] = useState(false);
  /*
   * Live, as opposed to merely asked for.
   *
   * `listening` goes true the moment the button is pressed; the microphone
   * is not recording until the recogniser's own `onstart` fires, which on a
   * Bluetooth headset is seconds later. Saying "Listening…" in between is
   * what made people start talking into a microphone that was not on yet.
   */
  const [micLive, setMicLive] = useState(false);
  // What the microphone is actually picking up. Without it, a person talking
  // too quietly watched the button pulse away as though it were working.
  const [mic, setMic] = useState<MicLevel | null>(null);
  // What the microphone last heard, with every hearing of it. Sent along only
  // while the words in the box are still exactly what was heard — once the
  // person corrects them, the correction is the question.
  const [heard, setHeard] = useState<{ best: string; alternatives: string[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const stopListening = useRef<StopListening | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequest]);

  // Grows with what is typed, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [text]);

  useEffect(() => () => stopListening.current?.({ discard: true }), []);

  useEffect(() => {
    if (!attachMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-attach-menu]')) setAttachMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [attachMenu]);

  // "Create a task for …" from the guide: in the box, cursor at the end.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    setHeard(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [prefill]);

  const attachRequestSeen = useRef(attachRequest);
  useEffect(() => {
    if (attachRequest === attachRequestSeen.current) return;
    attachRequestSeen.current = attachRequest;
    picker.current?.click();
  }, [attachRequest]);

  const patch = (id: string, change: Partial<Attachment>) =>
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...change } : a)));

  /** Start uploading straight away, so sending does not wait on it. */
  function addFiles(files: File[]) {
    setAttachError(null);
    const room = MAX_FILES - attachments.length;
    const refused: string[] = [];
    const accepted = files.filter((f) => {
      if (!readableType(f)) refused.push(`${f.name} is not a PDF or an image`);
      else if (f.size > MAX_FILE_BYTES) refused.push(`${f.name} is too large`);
      else return true;
      return false;
    });
    if (accepted.length > room) refused.push(`only ${MAX_FILES} files fit on one question`);
    if (refused.length) setAttachError(`Not attached: ${refused.join('; ')}.`);

    for (const f of accepted.slice(0, Math.max(0, room))) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      const thumb = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      setAttachments((list) => [
        ...list,
        { id, name: f.name, size: f.size, mimeType: f.type || 'application/pdf', status: 'uploading', thumb, controller },
      ]);
      readableAttachment(f)
        .then((ready) => {
          // A HEIC shows as a broken thumbnail until it has been converted.
          if (ready !== f && ready.type.startsWith('image/')) {
            if (thumb) URL.revokeObjectURL(thumb);
            patch(id, { thumb: URL.createObjectURL(ready), mimeType: ready.type });
          }
          return uploadFile(ready, controller.signal);
        })
        .then((file) => patch(id, { status: 'ready', file, mimeType: file.mimeType }))
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          // A format the browser cannot open left a broken thumbnail
          // behind; the message says what it is, so the box is noise.
          if (thumb) URL.revokeObjectURL(thumb);
          patch(id, { status: 'failed', error: err.message, thumb: undefined });
        });
    }
    ref.current?.focus();
  }
  dropInto.current = addFiles;

  function removeAttachment(a: Attachment) {
    a.controller.abort();
    if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttachments((list) => list.filter((x) => x.id !== a.id));
    // Uploaded but never sent: nothing refers to it, so it is not kept.
    if (a.file) {
      void api('/assistant/uploads/forget', { method: 'POST', body: JSON.stringify({ tokens: [a.file.token] }) }).catch(() => {});
    }
  }

  const uploading = attachments.some((a) => a.status === 'uploading');
  const ready = attachments.filter((a) => a.status === 'ready' && a.file).map((a) => a.file as AttachedFile);
  const canSend = !pending && !uploading && (Boolean(text.trim()) || ready.length > 0);

  function submit() {
    if (!canSend) return;
    if (mode !== 'ask') {
      imagine(text, mode, { files: ready });
    } else {
      const spoken = heard && text.trim() === heard.best ? { alternatives: heard.alternatives } : {};
      send(text, { ...spoken, files: ready });
    }
    setText('');
    setHeard(null);
    for (const a of attachments) if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttachments([]);
    setAttachError(null);
  }

  /**
   * One spoken question, left in the box to check before it goes.
   *
   * It used to send the moment the browser stopped listening, so a misheard
   * name went straight to Jenny. Now the words appear as they are heard, the
   * best hearing stays in the box, and Enter sends it — a second to catch
   * "Danish" before it becomes the question. Hands-free Talk still sends on
   * its own, for when there is nobody's hand free to press Enter.
   *
   * What is said is added to what is already in the box, so a question can
   * be typed and finished aloud, or said in two goes. Listening ends at a
   * pause, or when the microphone is pressed again.
   */
  function toggleMic() {
    if (listening) {
      stopListening.current?.();
      return;
    }
    setMicError(null);
    setHeard(null);
    setListening(true);
    setMicLive(false);
    const before = text;
    const withBefore = (words: string) => [before.trim(), words.trim()].filter(Boolean).join(' ');
    stopListening.current = listen({
      // Pressing the microphone means "my turn": she stops talking first.
      interrupt: true,
      // Nothing is sent without Enter, so a thinking pause can be longer.
      pauseMs: 2_600,
      onLevel: setMic,
      onStart: () => setMicLive(true),
      onInterim: (words) => setText(withBefore(words)),
      onResult: (hearings) => {
        const ranked = bestHearing(hearings, vocabulary);
        const best = withBefore(ranked[0].transcript);
        setText(best);
        setHeard({ best, alternatives: ranked.map((h) => withBefore(h.transcript)) });
        requestAnimationFrame(() => {
          const el = ref.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
      onError: (msg) => {
        setMicError(msg);
        setText(before);
      },
      onEnd: () => {
        setListening(false);
        setMicLive(false);
        setMic(null);
        stopListening.current = null;
      },
    });
  }

  return (
    <div
      className={`px-4 pt-3 ${compact ? 'border-t border-line pb-3' : 'pb-2.5'} ${
        page ? 'sticky bottom-0 z-10 bg-paper pb-4' : ''
      }`}
      data-attach-menu
    >
    <div className={compact || app ? '' : 'mx-auto w-full max-w-6xl'}>
      {/* A live meter while listening. It answers the question the old
          "Listening…" placeholder could not: is it hearing ME? A voice too
          quiet to transcribe is told so while there is still time to move
          closer, rather than after the attempt has already failed. */}
      {listening && mic && (
        <div className="mb-2 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
            <span
              className={`block h-full rounded-full transition-[width,background-color] duration-75 ${
                mic.speaking ? 'bg-good' : mic.faint ? 'bg-warn' : 'bg-ink-faint/50'
              }`}
              style={{ width: `${Math.round(mic.level * 100)}%` }}
            />
          </span>
          <span
            className={`shrink-0 text-[11px] ${mic.faint ? 'font-medium text-warn' : 'text-ink-faint'}`}
            role="status"
            aria-live="polite"
          >
            {!micLive
              ? 'Starting the microphone…'
              : mic.faint
                ? 'Too quiet — move closer'
                : mic.speaking
                  ? 'Hearing you'
                  : 'Listening…'}
          </span>
        </div>
      )}
      {lookingAt && (
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <span className="h-1.5 w-1.5 rounded-full bg-brass" aria-hidden="true" />
          Looking at <span className="font-medium text-ink-soft">{lookingAt}</span> — ask about "this project"
        </div>
      )}
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached files">
          {attachments.map((a) => (
            <li
              key={a.id}
              className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-1.5 ${
                a.status === 'failed' ? 'border-crit/40 bg-crit/5' : 'border-line bg-surface'
              }`}
            >
              {a.thumb ? (
                <img src={a.thumb} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-crit/10 text-[9.5px] font-semibold text-crit" aria-hidden="true">
                  PDF
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[12rem] truncate text-[12.5px] font-medium text-ink" title={a.name}>
                  {a.name}
                </span>
                <span className={`block text-[11px] ${a.status === 'failed' ? 'text-crit' : 'text-ink-faint'}`}>
                  {a.status === 'uploading' ? 'Uploading…' : a.status === 'failed' ? a.error ?? 'Upload failed' : sizeLabel(a.size)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
                className="focusable grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-sunk hover:text-ink"
              >
                <IconX width={14} height={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Only while making: the cost of what is about to be sent. Asking
          needs no line of its own. */}
      {canMake && mode !== 'ask' && (
        <p className="mb-1.5 px-1 text-[11.5px] text-ink-faint">
          {`${attachments.length > 0 ? 'Transforms what you attached' : 'Drawn from your words'} · no tokens spent`}
        </p>
      )}
      <div className="flex items-center gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={`flex flex-1 gap-1 border border-line bg-surface shadow-card transition-[border-color,box-shadow] focus-within:border-brass focus-within:shadow-pop ${
          app
            ? 'flex-wrap items-center rounded-3xl px-2.5 py-2'
            : 'items-end rounded-[26px] py-1.5 pl-2 pr-1.5'
        }`}
      >
        {/* File inputs: main (desktop + Files option), camera, photos */}
        <input ref={picker} type="file" accept={ACCEPT_ATTR} multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <input ref={photosRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />

        {/*
          * One quiet "+" for everything that is not typing: attach a file (or
          * on a phone, the camera and photos), switch to making an image, or
          * start a new conversation. The box itself stays a field, a mic and
          * a send button, so the first thing on the screen is the question.
          */}
        <div className="relative shrink-0" data-attach-menu>
          <button
            type="button"
            onClick={() => setAttachMenu((v) => !v)}
            aria-label="Attach a file, make an image, or start a new conversation"
            aria-haspopup="menu"
            aria-expanded={attachMenu}
            title="Attach, make an image, or start over"
            className={`focusable grid h-9 w-9 place-items-center rounded-full transition-colors ${
              attachMenu ? 'bg-sunk text-ink' : 'text-ink-faint hover:bg-sunk hover:text-ink'
            }`}
          >
            <IconPlus width={18} height={18} className={`transition-transform ${attachMenu ? 'rotate-45' : ''}`} />
          </button>
          {attachMenu && (
            <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-2xl border border-line bg-surface py-1 shadow-pop">
              {[
                { label: 'Attach a file', hint: 'PDF, image, spreadsheet, document', ref: picker, always: true, icon: <IconClip width={17} height={17} /> },
                { label: 'Camera', hint: null, ref: cameraRef, always: false, icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg> },
                { label: 'Photos', hint: null, ref: photosRef, always: false, icon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg> },
              ].map(({ label, hint, ref: inputRef, always, icon }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  disabled={attachments.length >= MAX_FILES}
                  onClick={() => { inputRef.current?.click(); setAttachMenu(false); }}
                  className={`focusable w-full items-center gap-3 px-3.5 py-2.5 text-left text-[13.5px] text-ink transition-colors hover:bg-sunk disabled:opacity-40 ${always ? 'flex' : 'flex sm:hidden'}`}
                >
                  <span className="text-ink-soft">{icon}</span>
                  <span className="min-w-0">
                    <span className="block">{label}</span>
                    {hint && <span className="block text-[11.5px] text-ink-faint">{hint}</span>}
                  </span>
                </button>
              ))}
              {canMake && canMake.image.ready && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={mode === 'image'}
                  onClick={() => { setMode(mode === 'image' ? 'ask' : 'image'); setAttachMenu(false); ref.current?.focus(); }}
                  className="focusable flex w-full items-center gap-3 border-t border-line px-3.5 py-2.5 text-left text-[13.5px] text-ink transition-colors hover:bg-sunk"
                >
                  <span className={mode === 'image' ? 'text-brass-deep' : 'text-ink-soft'}><IconImage width={17} height={17} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{mode === 'image' ? 'Back to asking' : 'Make an image'}</span>
                    <span className="block text-[11.5px] text-ink-faint">
                      {mode === 'image'
                        ? `${ASSISTANT_NAME} answers from the studio's records, mail and Drive`
                        : `${attachments.length > 0 ? 'Transforms what you attached' : 'Drawn from your words'} · no tokens spent`}
                    </span>
                  </span>
                  {mode === 'image' && <IconCheck width={15} height={15} className="shrink-0 text-brass-deep" />}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                disabled={messages.length === 0 || pending}
                onClick={() => { newConversation(); setText(''); setAttachments([]); setAttachMenu(false); ref.current?.focus(); }}
                className="focusable flex w-full items-center gap-3 border-t border-line px-3.5 py-2.5 text-left text-[13.5px] text-ink transition-colors hover:bg-sunk disabled:opacity-40"
              >
                <span className="text-ink-soft"><IconChat width={17} height={17} /></span>
                <span className="min-w-0">
                  <span className="block">New conversation</span>
                  {messages.length === 0 && <span className="block text-[11.5px] text-ink-faint">This one has not started yet</span>}
                </span>
              </button>
            </div>
          )}
        </div>
        {mode === 'image' && (
          <button
            type="button"
            onClick={() => { setMode('ask'); ref.current?.focus(); }}
            title="Making an image — press to go back to asking"
            className="focusable mb-1 flex h-7 shrink-0 items-center gap-1 rounded-full bg-brass/10 px-2 text-[12px] font-medium text-brass-deep hover:bg-brass/15"
          >
            <IconImage width={13} height={13} />
            Image
            <IconX width={12} height={12} />
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // A screenshot pasted in is an attachment, not text.
            const files = Array.from(e.clipboardData.files ?? []);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Not while an input
            // method is composing, or Enter would send half a word.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          // Short in the panel: a placeholder that wraps makes an empty box two lines tall.
          placeholder={
            listening
              ? micLive ? 'Listening…' : 'Starting the microphone — wait for the prompt'
              : mode === 'image'
                ? 'Describe the picture — the room, the materials, the light'
                : compact
                  ? `Ask ${ASSISTANT_NAME} anything…`
                  : `Ask ${ASSISTANT_NAME} anything, or say what you need done`
          }
          aria-label={`Message ${ASSISTANT_NAME}`}
          className={`max-h-36 min-h-[36px] resize-none bg-transparent px-1.5 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-faint ${
            app ? 'order-first w-full basis-full' : 'flex-1'
          }`}
        />
        {canListen && (
          <button
            type="button"
            onClick={toggleMic}
            aria-label={listening ? 'Stop listening' : 'Ask by voice'}
            aria-pressed={listening}
            title={listening ? 'Stop listening' : 'Ask by voice'}
            className={`focusable relative grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-colors ${
              listening ? 'border-crit/40 bg-crit/10 text-crit' : 'border-line text-ink-soft hover:bg-sunk hover:text-ink'
            } ${app ? 'order-last' : ''}`}
          >
            {listening ? <IconStop /> : <IconMic />}
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-crit/20" aria-hidden="true" />}
          </button>
        )}
        {pending ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop"
            title="Stop waiting for this answer"
            className={`focusable grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-surface transition-opacity hover:opacity-85 ${
              app ? 'order-last ml-auto' : ''
            }`}
          >
            <IconStop width={16} height={16} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!canSend}
            className={`focusable grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brass text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
              app ? 'order-last ml-auto' : ''
            }`}
          >
            <IconSend width={18} height={18} />
          </button>
        )}
      </form>
      {canListen && (
        <button
          type="button"
          onClick={() => setHandsFree(!handsFree)}
          aria-pressed={handsFree}
          aria-label={handsFree ? 'End hands-free conversation' : 'Talk hands-free'}
          title={handsFree ? 'End hands-free conversation' : 'Talk hands-free'}
          className={`focusable flex shrink-0 items-center justify-center rounded-full border transition-colors ${
            compact ? 'h-9 gap-1.5 px-2.5 text-[12.5px] font-medium' : 'h-12 w-12 shadow-card'
          } ${
            handsFree ? 'border-brass/40 bg-brass/15 text-brass-deep' : 'border-line bg-surface text-ink-soft hover:bg-sunk hover:text-ink'
          }`}
        >
          <IconTalk width={compact ? 15 : 18} height={compact ? 15 : 18} />
          {compact ? <span>{handsFree ? 'End' : 'Talk'}</span> : <span className="sr-only">{handsFree ? 'End hands-free' : 'Talk hands-free'}</span>}
        </button>
      )}
      </div>
      {attachError && (
        <p className="mt-1.5 px-1 text-[11.5px] text-crit" role="alert">
          {attachError}
        </p>
      )}
      {uploading && !attachError && (
        <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">Uploading — you can send once it's done.</p>
      )}
      {heard && text.trim() === heard.best && !pending && (
        <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">
          That's what I heard — fix anything I got wrong, then press Enter.
        </p>
      )}
      {!attachError && !uploading && !heard && !listening && (
        <p className="mt-1.5 hidden text-center text-[11px] text-ink-faint sm:block">Enter to send · Shift+Enter for a new line</p>
      )}
    </div>
    </div>
  );
}

/**
 * The spoken conversation: one control, and a clear picture of whose turn
 * it is. Typing is still a tap away — "Type instead" ends the loop.
 */
function VoiceBar() {
  const { voice, status, setHandsFree, skipSpeaking, doneTalking, interim, micLevel, micLive } = useAssistant();

  // Waiting on the recogniser, not on the person. "Go ahead" here is an
  // instruction to talk into a microphone that is not recording yet.
  const starting = voice === 'listening' && !micLive;
  const faint = voice === 'listening' && micLive && micLevel?.faint && !interim;

  const label = starting
    ? 'Starting the microphone…'
    : faint
      ? 'I can barely hear you — move closer or speak up'
      : voice === 'listening'
        ? interim
          ? 'Listening — pause when you’re done'
          : micLevel?.speaking
            ? 'Hearing you — keep going'
            : 'Listening — go ahead'
        : voice === 'speaking'
          ? 'Speaking'
          : `${status ?? 'Thinking'}…`;

  return (
    <div className="border-t border-line px-4 pb-4 pt-4">
      <div className="flex flex-col items-center gap-3">
        {/* While listening the orb grows with the voice, so it is obvious
            whether the microphone is getting anything. It used to pulse on a
            timer whatever the room sounded like, which told someone talking
            too quietly that all was well. */}
        <span
          className={`voice-orb voice-orb--${voice}`}
          aria-hidden="true"
          style={
            voice === 'listening' && micLevel
              ? { transform: `scale(${(1 + micLevel.level * 0.35).toFixed(3)})`, transition: 'transform 80ms linear' }
              : undefined
          }
        >
          {voice === 'listening' ? <IconMic width={22} height={22} /> : <JennyAvatar size={40} />}
        </span>
        <p
          className={`text-[13.5px] font-medium ${faint ? 'text-warn' : starting ? 'text-ink-faint' : 'text-ink'}`}
          role="status"
          aria-live="polite"
        >
          {label}
        </p>
        {/* The words as they are heard, so a mishearing is visible before it is sent. */}
        {voice === 'listening' && interim && (
          <p className="max-w-full px-2 text-center text-[13px] italic text-ink-soft line-clamp-3">“{interim}”</p>
        )}
        <div className="flex gap-2">
          {voice === 'listening' && interim && (
            <button type="button" onClick={doneTalking} className="btn-primary btn-sm">
              Send now
            </button>
          )}
          {voice === 'speaking' && (
            <button type="button" onClick={skipSpeaking} className="btn-secondary btn-sm">
              Skip
            </button>
          )}
          <button type="button" onClick={() => setHandsFree(false)} className="btn-secondary btn-sm">
            Type instead
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The conversation ────────────────────────────────────────

export function AssistantChat({
  compact = false,
  app = false,
  page = false,
}: {
  compact?: boolean;
  app?: boolean;
  /**
   * The conversation is the page: it scrolls with the window rather than
   * inside a box of its own, and the composer sticks to the bottom of the
   * screen. The side panel and the app keep their own scroll.
   */
  page?: boolean;
}) {
  const { messages, pending, status, send, briefingLoading, handsFree, micError, setMicError } = useAssistant();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // On the page the window is the scroller, so "has the person scrolled up
  // to read something" is read from the window instead.
  useEffect(() => {
    if (!page) return;
    const onScroll = () => {
      const root = document.documentElement;
      pinned.current = root.scrollHeight - window.scrollY - window.innerHeight < 120;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page]);
  // Files dropped anywhere on the conversation go to the composer.
  const dropInto = useRef<((files: File[]) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  // Follow the conversation down — unless the person has scrolled up to
  // read something, in which case a new line arriving must not yank them.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A fresh conversation reads from the top: the guide starts there.
    if (messages.length === 0) {
      if (page) window.scrollTo({ top: 0 });
      else el.scrollTo({ top: 0 });
      pinned.current = true;
      return;
    }
    const last = messages[messages.length - 1];
    if (pinned.current || last?.role === 'user') {
      if (page) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, pending, status, page]);

  const last = messages[messages.length - 1];
  const suggestions = !pending && last?.role === 'assistant' ? (last.answer?.suggestions ?? []) : [];

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!carriesFiles(e) || handsFree) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (carriesFiles(e) && !handsFree) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!handsFree) dropInto.current?.(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-brass bg-surface/85 text-center">
          <div>
            <IconClip width={26} height={26} className="mx-auto text-brass-deep" />
            <p className="mt-2 text-[14px] font-semibold text-ink">Drop to attach</p>
            <p className="text-[12.5px] text-ink-soft">PDFs and images — {ASSISTANT_NAME} reads them for you</p>
          </div>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className={`flex-1 ${page ? '' : 'min-h-0 overflow-y-auto'} ${
          messages.length === 0 && !briefingLoading
            ? 'flex flex-col items-center justify-center px-4 py-8'
            : `space-y-4 px-4 ${page ? 'pb-6 pt-12' : 'py-5'}`
        }`}
      >
        {messages.length === 0 &&
          (briefingLoading ? (
            <Working status="Getting today's briefing" />
          ) : (
            <div className={`flex w-full flex-col items-center text-center ${compact ? 'max-w-sm gap-5' : 'max-w-2xl gap-7'}`}>
              <div>
                <div className={`mx-auto grid place-items-center rounded-2xl bg-brass/10 ring-1 ring-brass/20 ${compact ? 'mb-3 h-12 w-12' : 'mb-5 h-14 w-14'}`}>
                  <IconSparkle width={compact ? 22 : 26} height={compact ? 22 : 26} className="text-brass-deep" />
                </div>
                <h2 className={`font-semibold leading-tight tracking-tight text-ink ${compact ? 'text-[17px]' : 'text-[24px]'}`}>
                  What would you like to know about the studio?
                </h2>
                <p className={`mx-auto mt-2.5 leading-relaxed text-ink-soft ${compact ? 'max-w-xs text-[12.5px]' : 'max-w-lg text-[14px]'}`}>
                  Ask a question in plain English. {ASSISTANT_NAME} searches the studio's tasks, mail, projects and Drive and explains what she finds, naming where each answer came from.
                </p>
              </div>
              <div className={`grid w-full gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                {QUICK_CARDS.map(({ label, question, icon: Icon }) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => send(question)}
                    className="focusable flex items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left shadow-card transition-colors hover:border-brass/50 hover:bg-brass/5"
                  >
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brass/10 text-brass-deep">
                      <Icon width={16} height={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">{label}</span>
                      <span className="mt-0.5 block text-[13.5px] leading-snug text-ink">{question}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}

        {/* One readable column on the page, like the reading width of a
            document; the panel is already narrow. */}
        <div className={`space-y-4 ${compact || app ? '' : 'mx-auto w-full max-w-6xl'}`}>
          {messages.map((m, i) => (
            <div key={m.id} className="space-y-4">
              {(i === 0 || dayLabel(messages[i - 1].at) !== dayLabel(m.at)) && <DayDivider at={m.at} />}
              <MessageView message={m} compact={compact} app={app} />
            </div>
          ))}

          <Suggestions items={suggestions} onPick={send} disabled={pending} />

          {pending && <Working status={status} />}
        </div>
      </div>

      {/*
        * Everything that reaches here is about the microphone — not heard,
        * heard faintly, stopped listening — and it arrives while someone is
        * looking at the orb, not at the page. As a full-width strip it read
        * as another row of the conversation. An inset card with the mic on
        * it, announced to screen readers and moving slightly as it lands,
        * reads as something that just happened and wants answering.
        */}
      {micError && (
        <div className="px-3 pb-0.5 pt-2">
          <div
            role="alert"
            aria-live="assertive"
            className="assistant-alert flex items-start gap-2.5 rounded-xl border border-crit/35 bg-crit/10 py-2.5 pl-3 pr-2 text-[12.5px] leading-snug text-crit"
          >
            <IconMic width={15} height={15} className="mt-px shrink-0" />
            <p className="min-w-0 flex-1">{micError}</p>
            <button
              type="button"
              onClick={() => setMicError(null)}
              aria-label="Dismiss"
              title="Dismiss"
              className="focusable grid h-6 w-6 shrink-0 place-items-center rounded-md text-crit/70 transition-colors hover:bg-crit/15 hover:text-crit"
            >
              <IconPlus width={12} height={12} className="rotate-45" />
            </button>
          </div>
        </div>
      )}

      {handsFree ? <VoiceBar /> : <Composer compact={compact} app={app} page={page} dropInto={dropInto} />}
    </div>
  );
}
