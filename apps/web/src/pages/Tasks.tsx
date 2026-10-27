import { Fragment, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import {
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  canManageTasks,
  defaultTaskCategory,
  type FollowUpType,
  type TaskCategory,
  type TaskKind,
  type TaskStatus,
} from '@janelle/shared';
import { Page, PageHeading, Card, Pill, shortDate, ConfirmDialog } from '../components/ui';
import { ScopeToggle, useScope } from '../components/ScopeToggle';
import { IconBoard, IconSearch, IconList } from '../components/icons';
import { Avatar, CATEGORY_HUE, HUE, HueDot, ProjectName } from '../components/hue';
import { useAuth } from '../context/AuthContext';
import {
  daysEarly, useAddComment, useCloseStaleTasks, useDeleteComment, useDeleteTask, useImportHouzzTasks, useProjects, useTaskDetail, useTaskHygiene, useTasks, useTeam, useUpdateComment, useUpdateTask,
  type HygieneReason, type TaskComment, type TaskView, type TeamMember,
} from '../lib/queries';
import { DatePicker } from '../components/DatePicker';

const tone: Record<TaskKind, 'crit' | 'warn' | 'brass' | 'neutral'> = {
  quote_request: 'brass',
  order_followup: 'warn',
  client_approval: 'crit',
  spec_review: 'brass',
  scheduling: 'warn',
  admin: 'neutral',
};

/** The accent each board column is headed with. */
const COLUMN_DOT: Partial<Record<TaskStatus, string>> = {
  open: 'bg-ink-faint',
  in_progress: 'bg-olive',
  blocked: 'bg-crit',
  done: 'bg-good',
};

/** The same colour as a band across the top of the column, so each column reads as its own lane. */
const COLUMN_TOP: Partial<Record<TaskStatus, string>> = {
  open: 'border-t-ink-faint',
  in_progress: 'border-t-olive',
  blocked: 'border-t-crit',
  done: 'border-t-good',
};

/** Replaces the platform's own select arrow, which cannot be themed. */
function Chevron({ className = '' }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** A quiet marker on the card — not an alert, just a fact worth seeing. */
function Tag({ children, title, tone: t }: { children: ReactNode; title?: string; tone: 'crit' | 'good' | 'neutral' }) {
  const tones = {
    crit: 'bg-crit/15 text-crit',
    good: 'bg-good/15 text-good',
    neutral: 'bg-sunk text-ink-faint',
  };
  return (
    <span
      title={title}
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] ${tones[t]}`}
    >
      {children}
    </span>
  );
}

/** Labels for the nudges raised against a task, in its history. */
const HISTORY_LABELS: Partial<Record<FollowUpType, string>> = {
  task_overdue: 'Owner reminded',
  task_escalation: 'Escalated to the principal',
  task_unowned: 'Chased for an owner',
  task_no_next_step: 'Chased for a next step',
  task_no_due_date: 'Chased for a due date',
};

/** "2 days early", "on its due date", "1 day late" — how finished work met its date. */
function finishedLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'on its due date';
  const n = Math.abs(days);
  return `${n} day${n === 1 ? '' : 's'} ${days > 0 ? 'early' : 'late'}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * The conversation on a task.
 *
 * Replaces subtasks, which asked the studio to break work into steps and was
 * used for almost nothing — the thing people actually needed to record was
 * what had just happened: the vendor called back, this is blocked on Carlos,
 * someone else should pick it up. That went into Slack and email, where the
 * task could not see it and nobody reading the task later could find it.
 *
 * @mentions are chosen from the roster, not typed: the composer keeps the
 * picked ids beside the text and sends both. Matching names out of prose is
 * how a mention reaches the wrong Joanna, or nobody.
 */
function CommentThread({
  taskId, comments, available, userId,
}: { taskId: string; comments: TaskComment[]; available: boolean; userId: string | undefined }) {
  const team = useTeam().data;
  const add = useAddComment(taskId);
  const editComment = useUpdateComment(taskId);
  const deleteComment = useDeleteComment(taskId);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Which comment is in inline-edit mode, and its current text.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  /*
   * The word being typed after an "@", if the caret is still inside it.
   * Null closes the picker — which is what a space does, since a mention is
   * one token and "@carissa and" should not keep offering names.
   */
  const [query, setQuery] = useState<string | null>(null);
  const onType = (value: string, caret: number) => {
    setDraft(value);
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    const word = at === -1 ? null : upto.slice(at + 1);
    setQuery(word !== null && !/\s/.test(word) ? word.toLowerCase() : null);
  };

  const matches =
    query === null
      ? []
      : team
          .filter((m) => !picked.includes(m.id))
          .filter((m) => (m.full_name ?? m.email ?? '').toLowerCase().includes(query))
          .slice(0, 5);

  /** Swap the half-typed "@wha" for the chosen name, and remember the id. */
  const choose = (id: string, name: string) => {
    const caret = boxRef.current?.selectionStart ?? draft.length;
    const upto = draft.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return;
    const next = `${draft.slice(0, at)}@${name} ${draft.slice(caret)}`;
    setDraft(next);
    setPicked((p) => (p.includes(id) ? p : [...p, id]));
    setQuery(null);
    boxRef.current?.focus();
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || add.isPending) return;
    // Only the people still named in the text: picking someone and then
    // deleting their name is a change of mind, not a mention.
    const still = picked.filter((id) => {
      const m = team.find((t) => t.id === id);
      return !!m && draft.includes(`@${m.full_name ?? m.email ?? ''}`);
    });
    add.mutate(
      { body, mentions: still },
      { onSuccess: () => { setDraft(''); setPicked([]); setQuery(null); } },
    );
  };

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Comments</h3>
        {comments.length > 0 && (
          <span className="text-[11.5px] text-ink-faint">{comments.length}</span>
        )}
      </div>

      {comments.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2">
          {comments.map((c) => {
            const isAuthor = !!userId && c.author === userId;
            const isEditing = editing?.id === c.id;
            return (
              <li key={c.id} className="group rounded-lg border border-line-soft bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-ink">
                    {c.profiles?.full_name ?? 'A former teammate'}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-[11.5px] text-ink-faint">{shortDate(c.created_at)}</span>
                    {isAuthor && !isEditing && (
                      <>
                        <button
                          type="button"
                          title="Edit comment"
                          onClick={() => setEditing({ id: c.id, text: c.body })}
                          className="focusable ml-1 rounded px-1 py-0.5 text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          title="Delete comment"
                          disabled={deleteComment.isPending}
                          onClick={() => deleteComment.mutate(c.id)}
                          className="focusable rounded px-1 py-0.5 text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-crit group-hover:opacity-100"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-1.5">
                    <textarea
                      className="input min-h-[56px] resize-y text-[13px]"
                      value={editing.text}
                      autoFocus
                      onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const body = editing.text.trim();
                          if (!body || editComment.isPending) return;
                          editComment.mutate(
                            { commentId: c.id, body },
                            { onSuccess: () => setEditing(null) },
                          );
                        }
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                      {editComment.isError && (
                        <span className="text-[11.5px] text-crit">{(editComment.error as Error).message}</span>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={!editing.text.trim() || editComment.isPending}
                          onClick={() => {
                            const body = editing.text.trim();
                            if (!body) return;
                            editComment.mutate(
                              { commentId: c.id, body },
                              { onSuccess: () => setEditing(null) },
                            );
                          }}
                        >
                          {editComment.isPending ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{c.body}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!available ? (
        <p className="text-[12.5px] text-ink-faint">
          Comments need migration 0033 applied before they can be added.
        </p>
      ) : (
        <div className="relative">
          <textarea
            ref={boxRef}
            className="input min-h-[64px] resize-y"
            placeholder="Add a comment… @ someone to notify them"
            value={draft}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line — a comment is short
              // far more often than it is a paragraph.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape' && query !== null) {
                e.stopPropagation();
                setQuery(null);
              }
            }}
          />

          {matches.length > 0 && (
            <ul
              role="listbox"
              aria-label="People you can mention"
              className="popover absolute bottom-full left-0 z-20 mb-1 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop"
            >
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => choose(m.id, m.full_name ?? m.email ?? '')}
                    className="focusable block w-full px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-sunk"
                  >
                    {m.full_name ?? m.email}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex items-center gap-2">
            {picked.length > 0 && (
              <span className="text-[11.5px] text-ink-faint">
                Notifies {picked.length} {picked.length === 1 ? 'person' : 'people'}
              </span>
            )}
            <button
              onClick={submit}
              disabled={!draft.trim() || add.isPending}
              className="btn-secondary btn-sm ml-auto shrink-0"
            >
              {add.isPending ? 'Posting…' : 'Comment'}
            </button>
          </div>
        </div>
      )}

      {add.isError && <p className="mt-2 text-[12.5px] text-crit">{(add.error as Error).message}</p>}
    </section>
  );
}

/**
 * Everything behind one task.
 *
 * The board answers "where is this"; the card cannot answer "what is it,
 * where did it come from, and what has happened since" without becoming
 * unreadable. So the card stays a summary and the detail lives here — one
 * request, opened by clicking the card.
 */
function TaskPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, isError, error } = useTaskDetail(id);
  const team = useTeam().data;
  const projects = useProjects().data;
  const updateTask = useUpdateTask();
  const { user } = useAuth();

  // Tell the shell that a full-screen overlay is open so it does not
  // compress the board for Jenny's side panel — the board is already
  // behind this backdrop and the reflow would be visible through it.
  useEffect(() => {
    document.documentElement.dataset.taskPanelOpen = 'true';
    return () => { delete document.documentElement.dataset.taskPanelOpen; };
  }, []);

  // Escape closes it, like every other overlay the studio uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = data?.task;
  const finishedAt = t?.status === 'done' ? t.completed_at ?? t.updated_at : null;
  // Migration 0032 stores the id; the roster that fills the owner dropdown
  // turns it into a name. Unknown ids (someone since removed from the team)
  // fall back to saying a person did it, which is still the fact that matters.
  const closedBy = t?.completed_by ? team.find((p) => p.id === t.completed_by)?.full_name ?? 'someone since removed' : null;
  const finished = finishedLabel(daysEarly(t?.due_date ?? null, finishedAt ?? null));

  /*
   * Portalled to <body>, like every other full-screen overlay in this app.
   *
   * z-50 beat the top bar's z-30 only as long as nothing between this and
   * <body> opened a stacking context of its own — and this is the one
   * overlay that renders from inside the page, under AppShell's <main>. The
   * moment anything up that chain got a z-index, a transform or an
   * `isolate`, the whole panel dropped behind a z-30 header and its top
   * strip came out underneath the bell and the avatar. A z-index raised
   * higher would not have helped: inside a trapped stacking context the
   * number means nothing.
   *
   * AppShell already solves this for ConnectGooglePrompt and TaskReminder by
   * mounting them outside the main column. A page cannot do that, so it
   * portals instead — same guarantee, reached from where the panel lives.
   */
  return createPortal(
    // `dock-aware`: when Jenny's panel is docked on a wide screen, this stops
    // at her edge instead of sliding underneath her.
    <div className="dock-aware fixed inset-0 z-50 flex justify-end">
      {/* Black, not ink: in dark mode ink is near-white, and a backdrop made
          from it washed the page grey instead of dimming it. */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      {/* bg-surface, not bg-canvas — "canvas" is not a colour in this theme,
          so the panel rendered with no background and the board showed
          through its text. */}
      <aside
        role="dialog"
        aria-label="Task detail"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-line bg-surface shadow-pop"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            {t && (
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Pill tone={tone[t.kind]}>{TASK_KIND_LABELS[t.kind]}</Pill>
                <Pill tone="neutral">{TASK_STATUS_LABELS[t.status]}</Pill>
              </div>
            )}
            <h2 className="text-[16px] font-semibold leading-snug text-ink">
              {t?.title ?? 'Task'}
            </h2>
          </div>
          <button onClick={onClose} className="btn-secondary btn-sm shrink-0">
            Close
          </button>
        </header>

        {isLoading && <p className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</p>}
        {isError && <p className="px-5 py-10 text-center text-[13px] text-crit">{(error as Error).message}</p>}

        {t && (
          <div className="flex flex-col gap-6 px-5 py-5">
            {t.detail && <p className="text-[13.5px] leading-relaxed text-ink-soft">{t.detail}</p>}

            <dl className="grid grid-cols-2 gap-4">
              <Field label="Owner">
                {t.profiles?.full_name ?? (t.assigned_to ? 'Assigned' : <span className="text-warn">Unassigned</span>)}
              </Field>
              <Field label="Due">
                {t.due_date ? shortDate(t.due_date) : <span className="text-warn">No due date</span>}
              </Field>
              <Field label="Project">
                <select
                  aria-label="Task project"
                  className="focusable -ml-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[13.5px] text-ink"
                  value={t.project_id ?? ''}
                  disabled={updateTask.isPending}
                  onChange={(e) => updateTask.mutate({ id, project_id: e.target.value || null })}
                >
                  <option value="">— No project —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select
                  aria-label="Task category"
                  className="focusable -ml-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[13.5px] text-ink"
                  value={t.category ?? defaultTaskCategory(t.kind, t.seat)}
                  disabled={updateTask.isPending}
                  onChange={(e) => updateTask.mutate({ id, category: e.target.value as TaskCategory })}
                >
                  {TASK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{TASK_CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
                {updateTask.isError && (
                  <span className="mt-1 block text-[12px] text-crit">{(updateTask.error as Error).message}</span>
                )}
              </Field>
              <Field label="Raised">{shortDate(t.created_at)}</Field>
            </dl>

            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                Next step
              </h3>
              {t.next_step ? (
                <p className="text-[13.5px] text-ink">{t.next_step}</p>
              ) : (
                <p className="text-[13px] text-warn">
                  None written down — the studio&rsquo;s SOP asks for one on every task.
                </p>
              )}
            </div>

            {/* Where it came from. The first question anyone asks of a task
                raised by a machine is which email produced it. */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                From this email
              </h3>
              {data?.email ? (
                <div className="rounded-lg border border-line-soft bg-surface p-3">
                  <p className="text-[13.5px] font-medium text-ink">{data.email.subject ?? '(no subject)'}</p>
                  <p className="mt-0.5 text-[12px] text-ink-faint">
                    {data.email.from_addr ?? 'unknown sender'}
                    {data.email.received_at && <> · {shortDate(data.email.received_at)}</>}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                    {data.email.extracted_json?.summary ?? data.email.snippet ?? ''}
                  </p>
                  <Link
                    to={`/inbox?open=${data.email.id}`}
                    className="focusable mt-2 inline-block text-[12.5px] font-semibold text-brass-deep hover:underline"
                  >
                    Open in Inbox →
                  </Link>
                </div>
              ) : data?.emailHiddenFrom ? (
                <p className="text-[13px] text-ink-faint">
                  Raised from an email in {data.emailHiddenFrom}'s personal mailbox — theirs to read, not
                  visible here.
                </p>
              ) : (
                <p className="text-[13px] text-ink-faint">
                  Added by hand — there is no email behind this one.
                </p>
              )}
            </section>

            {/* The conversation on the task — what replaced subtasks. */}
            <CommentThread
              taskId={id}
              comments={data?.comments ?? []}
              available={data?.commentsAvailable !== false}
              userId={user?.id}
            />

            {/* What has happened since. Reminders and escalations are the
                system acting on its own, so they are worth showing plainly. */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                Progress
              </h3>
              <ol className="flex flex-col gap-2 border-l border-line-soft pl-4">
                <li className="relative text-[13px] text-ink-soft">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brass" />
                  {data?.email || data?.emailHiddenFrom ? 'Raised from email' : 'Added by hand'} · {shortDate(t.created_at)}
                </li>
                {(data?.history ?? []).map((h) => (
                  <li key={h.id} className="relative text-[13px] text-ink-soft">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-warn" />
                    {HISTORY_LABELS[h.type] ?? h.type} · {shortDate(h.created_at)}
                    {h.reason && <span className="block text-[12px] text-ink-faint">{h.reason}</span>}
                  </li>
                ))}
                {t.status === 'done' && (
                  <li className="relative text-[13px] text-ink-soft">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-good" />
                    {t.completion_note ? 'Closed automatically' : closedBy ? `Closed by ${closedBy}` : 'Closed'}
                    {finishedAt && <> · {shortDate(finishedAt)}</>}
                    {finished && <> · {finished}</>}
                    {/* The system's reason, in full: which email, and the words
                        in it that finished the work. Dragging the card back
                        out of Done reopens it and clears this. */}
                    {t.completion_note && (
                      <span className="block text-[12px] text-ink-faint">{t.completion_note}</span>
                    )}
                  </li>
                )}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * The board.
 *
 * A list is the right shape for "what do I owe" and the wrong one for
 * "where is everything" — the studio reads the second question far more
 * often, and a flat list made a task with no owner look exactly like one in
 * progress. Columns are the task's own statuses, so moving a card IS the
 * status change: no form, no dropdown, one drag.
 *
 * Drag and drop is the browser's own, deliberately. A board is the kind of
 * screen that invites a library, and the HTML drag events cover it in about
 * twenty lines; every card is also reachable without a mouse through the
 * same status dropdown the list view uses.
 */
const BOARD_COLUMNS: { status: TaskStatus; hint: string }[] = [
  { status: 'open', hint: 'Not started' },
  { status: 'in_progress', hint: 'Being worked on' },
  { status: 'blocked', hint: 'Waiting on something' },
  { status: 'done', hint: 'Finished' },
];

function Initials({ name }: { name: string }) {
  return <Avatar name={name} size={20} />;
}

/** Two staggered checkmarks — "done", distinct from a single tick used elsewhere. */
function IconDoubleCheck(p: { width?: number; height?: number }) {
  return (
    <svg
      width={p.width ?? 11}
      height={p.height ?? 11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 12.5 6 17l7-11" />
      <path d="M8 12.5 12.5 17l7-11" />
    </svg>
  );
}

const BoardCard = memo(function BoardCard({
  t,
  mayEdit,
  team,
  onDragStart,
  onAssign,
  onDue,
  onOpen,
  onDelete,
  onComplete,
}: {
  t: TaskView;
  mayEdit: boolean;
  team: TeamMember[];
  onDragStart: (id: string) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
  /** Absent when this role may not delete tasks. */
  onDelete?: (t: TaskView) => void;
  onComplete: (id: string) => void;
}) {
  const unowned = !t.assignedTo;
  return (
    <li
      draggable={mayEdit}
      onDragStart={(e) => {
        onDragStart(t.id);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload on the transfer.
        e.dataTransfer.setData('text/plain', t.id);
      }}
      onClick={() => onOpen(t.id)}
      className={`board-card group relative overflow-hidden rounded-xl border bg-surface p-3.5 shadow-card ${
        mayEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${t.overdue ? 'border-crit/40' : 'border-line hover:border-ink-faint/50'}`}
    >
      {/* A bar down the edge rather than a red box around everything. The
          full border fought the card's own outline and made a late task look
          broken; an edge marker is read just as fast and stays legible when
          three of them sit in a column together. */}
      {t.overdue && <span className="absolute inset-y-0 left-0 w-[3px] bg-crit" aria-hidden="true" />}

      <div className="mb-2 flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <HueDot hue={CATEGORY_HUE[t.category]} className="h-1.5 w-1.5" />
          <span className="truncate text-[10px] font-bold uppercase tracking-[0.07em] text-ink-faint">
            <span className={HUE[CATEGORY_HUE[t.category]].text}>{TASK_CATEGORY_LABELS[t.category]}</span> · {TASK_KIND_LABELS[t.kind]}
          </span>
        </span>
        {t.overdue && <Tag tone="crit">Overdue</Tag>}
        {/* The system moved this one here on its own. Said on the card, not
            only in the panel, so a close nobody expected is noticed. */}
        {t.closedNote && (
          <Tag tone="good" title={t.closedNote}>
            Auto-closed
          </Tag>
        )}
        {/* The board says these are raised from email. A card that was not
            is the exception, and worth being able to see at a glance rather
            than having to open it. */}
        {!t.fromEmail && !t.closedNote && (
          <Tag tone="neutral" title="Added by hand, not raised from email">
            By hand
          </Tag>
        )}

        {/* Completing a task is what this board is FOR, and this button was
            dressed as though it were incidental: a 20px grey circle on a
            grey hairline, the same weight as the delete cross beside it,
            going green only once the pointer was already on it. People
            could not find it and said so. It now wears its colour at rest —
            the one green thing on the card — and fills in solid when you
            reach for it. `text-surface` rather than white: the green is
            dark on the light theme and light on the dark one, and the
            surface colour inverts with it. */}
        {mayEdit && t.status !== 'done' && (
          <button
            type="button"
            aria-label={`Mark "${t.title}" as done`}
            title="Mark as done"
            className="focusable ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full border border-good/50 bg-good/10 text-good transition-all hover:scale-110 hover:border-good hover:bg-good hover:text-surface focus-visible:border-good focus-visible:bg-good focus-visible:text-surface"
            draggable={false}
            onDragStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onComplete(t.id);
            }}
          >
            <IconDoubleCheck width={13} height={13} />
          </button>
        )}

        {onDelete && (
          <button
            type="button"
            aria-label={`Delete "${t.title}"`}
            title="Delete this task"
            className={`focusable shrink-0 rounded px-1 text-[13px] leading-none text-ink-faint transition-colors hover:text-crit ${
              mayEdit && t.status !== 'done' ? '' : 'ml-auto'
            }`}
            draggable={false}
            onDragStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(t);
            }}
          >
            ✕
          </button>
        )}
      </div>

      <p className="text-[13.5px] font-semibold leading-snug tracking-[-0.005em] text-ink">{t.title}</p>

      {/* The SOP wants one next step on every task; showing the gap on the
          card is what makes it get filled in. Finished work has no next
          step to chase, so a Done card says when it was finished instead. */}
      {t.status === 'done' ? (
        t.completedAt && (
          <p className="mt-1.5 text-[12px] text-ink-soft">
            Done {shortDate(t.completedAt)}
            {finishedLabel(t.daysEarly) && (
              <span className={t.daysEarly !== null && t.daysEarly < 0 ? 'text-warn' : 'text-good'}>
                {' '}· {finishedLabel(t.daysEarly)}
              </span>
            )}
          </p>
        )
      ) : t.nextStep ? (
        <p className="mt-1.5 text-[12px] text-ink-soft">
          <span className="text-ink-faint">Next:</span> {t.nextStep}
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] text-warn">No next step</p>
      )}

      {t.project !== '—' && (
        <ProjectName name={t.project} className="mt-2 max-w-full text-[11.5px] text-ink-faint" />
      )}

      {/* Owner and date are changed here rather than on another screen: the
          board is where the gaps are visible, so it is where they get
          filled. Inputs swallow the drag so picking a date is not a drag.
          A hairline separates what the card SAYS from what it can DO. */}
      <div
        className="mt-3 flex items-center gap-1 border-t border-line-soft pt-2"
        draggable={false}
        onDragStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {mayEdit ? (
          <span className="relative flex min-w-0 flex-1 items-center gap-1">
            {t.assignedTo && <Initials name={t.assignee} />}
            <select
              className="control-quiet pr-5"
              value={t.assignedTo ?? ''}
              aria-label={`Who owns "${t.title}"`}
              onChange={(e) => onAssign(t.id, e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? m.email ?? 'Teammate'}
                </option>
              ))}
            </select>
            <Chevron className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          </span>
        ) : unowned ? (
          <span className="min-w-0 flex-1 px-1.5 text-[11.5px] font-semibold text-warn">Unassigned</span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[11.5px] text-ink-soft">
            <Initials name={t.assignee} />
            <span className="truncate">{t.assignee}</span>
          </span>
        )}

        {mayEdit ? (
          <DatePicker
            compact
            className="control-quiet"
            valueClassName={t.overdue ? 'font-semibold text-crit' : 'text-ink-soft'}
            value={t.due}
            placeholder="Due date"
            ariaLabel={`Due date for "${t.title}"`}
            onChange={(next) => onDue(t.id, next)}
          />
        ) : (
          <span
            className={`shrink-0 px-1.5 text-[11.5px] tabular-nums ${
              t.overdue ? 'font-semibold text-crit' : 'text-ink-faint'
            }`}
          >
            {t.due ? shortDate(t.due) : 'No due date'}
          </span>
        )}
      </div>
    </li>
  );
});

function Board({
  tasks,
  team,
  mayEdit,
  onMove,
  onAssign,
  onDue,
  onOpen,
  onDelete,
}: {
  tasks: TaskView[];
  team: TeamMember[];
  mayEdit: (assignedTo: string | null) => boolean;
  onMove: (id: string, status: TaskStatus) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
  onDelete?: (t: TaskView) => void;
}) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  // `dragover` fires many times a second per column. Setting state on every
  // one of them re-rendered the whole board continuously, which is what made
  // a drag feel heavy — so only a genuine change is written.
  const enter = useCallback((status: TaskStatus) => {
    setOver((current) => (current === status ? current : status));
  }, []);

  // `dragleave` also fires when the pointer crosses from the column onto a
  // card INSIDE it. Leaving for a descendant is not leaving, and treating it
  // as one made the highlight strobe on and off under the cursor.
  const leave = useCallback((e: React.DragEvent, status: TaskStatus) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setOver((current) => (current === status ? null : current));
  }, []);

  const startDrag = useCallback((id: string) => {
    dragged.current = id;
  }, []);

  const drop = (status: TaskStatus) => {
    const id = dragged.current;
    dragged.current = null;
    setOver(null);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status || !mayEdit(task.assignedTo)) return;
    onMove(id, status);
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col.status);
        return (
          <section
            key={col.status}
            onDragOver={(e) => {
              // preventDefault on every event is what marks this a drop
              // target; the state write is separately guarded above.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              enter(col.status);
            }}
            onDragLeave={(e) => leave(e, col.status)}
            onDrop={(e) => {
              e.preventDefault();
              drop(col.status);
            }}
            className={`rounded-2xl border border-t-[3px] p-3 transition-colors ${COLUMN_TOP[col.status] ?? 'border-t-ink-faint'} ${
              over === col.status ? 'border-brass bg-brass/5' : 'border-line bg-sunk'
            }`}
          >
            <header className="mb-3 flex items-center gap-2 px-1">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${COLUMN_DOT[col.status] ?? 'bg-ink-faint'}`}
                aria-hidden="true"
              />
              <h3 className="text-[12px] font-bold uppercase tracking-[0.06em] text-ink-soft">
                {TASK_STATUS_LABELS[col.status]}
              </h3>
              <span className="ml-auto grid h-5 min-w-[20px] place-items-center rounded-full border border-line bg-surface px-1.5 text-[11px] font-semibold tabular-nums text-ink-soft">
                {items.length}
              </span>
            </header>

            {/* The column is as tall as the screen allows and its cards scroll inside it, so the page itself does not scroll. */}
            <ul className="flex flex-col gap-2.5">
              {items.map((t) => (
                <BoardCard
                  key={t.id}
                  t={t}
                  mayEdit={mayEdit(t.assignedTo)}
                  team={team}
                  onDragStart={startDrag}
                  onAssign={onAssign}
                  onDue={onDue}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onComplete={(id) => onMove(id, 'done')}
                />
              ))}
              {items.length === 0 && (
                <li className="rounded-xl border border-dashed border-ink-faint/40 bg-surface/60 px-3 py-7 text-center text-[11.5px] text-ink-faint">
                  {col.hint}
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Statuses a row can still be moved to; done/cancelled drop out of the list filter. */
const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked'];

type DueFilter = 'any' | 'last3' | 'overdue' | 'today' | 'week' | 'next7' | 'range';

const DUE_OPTIONS: { v: DueFilter; label: string }[] = [
  { v: 'any', label: 'Any due date' },
  { v: 'last3', label: 'Added in the last 3 days' },
  { v: 'overdue', label: 'Overdue' },
  { v: 'today', label: 'Due today' },
  { v: 'week', label: 'Due this week' },
  { v: 'next7', label: 'Due in the next 7 days' },
  { v: 'range', label: 'Date range…' },
];

interface TaskFilters {
  /** '' everyone, 'unassigned', or a teammate's id. */
  person: string;
  /** Empty means every status. */
  statuses: TaskStatus[];
  /** Empty means every category. */
  categories: TaskCategory[];
  due: DueFilter;
  from: string;
  to: string;
}

const NO_FILTERS: TaskFilters = { person: '', statuses: [], categories: [], due: 'any', from: '', to: '' };
/** What the board opens on: this week's work. "Clear all" shows everything, and that choice is remembered for the tab. */
const DEFAULT_FILTERS: TaskFilters = { ...NO_FILTERS, due: 'week' };

/** How many filters are switched on — the number on the button. */
function activeFilterCount(f: TaskFilters): number {
  return (f.person ? 1 : 0) + (f.statuses.length ? 1 : 0) + (f.categories.length ? 1 : 0) + (f.due !== 'any' ? 1 : 0);
}

/** A local calendar date as YYYY-MM-DD — what `due_date` is stored as. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether a task's due date falls in the chosen window. Dates compare as text. */
function dueMatches(t: TaskView, f: TaskFilters): boolean {
  const due = t.due ? t.due.slice(0, 10) : null;
  const now = new Date();
  const today = isoDay(now);
  switch (f.due) {
    case 'any':
      return true;
    case 'last3':
      return Date.now() - Date.parse(t.createdAt) <= 3 * 86_400_000;
    case 'overdue':
      return Boolean(due && due < today && t.status !== 'done');
    case 'today':
      return due === today;
    case 'week': {
      // Monday to Sunday of the current week.
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return Boolean(due && due >= isoDay(monday) && due <= isoDay(sunday));
    }
    case 'next7': {
      const end = new Date(now);
      end.setDate(now.getDate() + 7);
      return Boolean(due && due >= today && due <= isoDay(end));
    }
    case 'range':
      if (!due) return !f.from && !f.to;
      return (!f.from || due >= f.from) && (!f.to || due <= f.to);
  }
}

/**
 * How urgent a task is by its due date, most urgent first. The tiers are the
 * studio's SLA: a task three or more days late is critical, anything late is
 * overdue, and what is not yet due is ranked by how soon.
 */
const SLA_TIERS = [
  { key: 'critical', label: 'Critical — 3+ days overdue' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'soon', label: 'Due in the next 2 days' },
  { key: 'week', label: 'Due within a week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
  { key: 'closed', label: 'Closed' },
] as const;
type SlaTier = (typeof SLA_TIERS)[number]['key'];

/** Whole days from `due` to today; positive when late. */
function daysLate(t: TaskView): number {
  if (!t.due) return 0;
  const p = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00`);
  return Math.round((p(isoDay(new Date())) - p(t.due)) / 86_400_000);
}

function slaTier(t: TaskView): SlaTier {
  if (!OPEN_STATUSES.includes(t.status)) return 'closed';
  if (!t.due) return 'none';
  const late = daysLate(t);
  if (late >= 3) return 'critical';
  if (late >= 1) return 'overdue';
  if (late === 0) return 'today';
  if (late >= -2) return 'soon';
  if (late >= -7) return 'week';
  return 'later';
}

function IconFilter(p: { width?: number; height?: number }) {
  return (
    <svg width={p.width ?? 16} height={p.height ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z" />
    </svg>
  );
}

/**
 * Whose work, in what state, and when it is due — in a drop-down beside the
 * other board controls rather than a bar across the page.
 *
 * The Mine/All toggle answers "mine or the studio's"; this answers what a
 * coordinator asks in the morning: what is Joanna carrying, what is
 * blocked, what falls due this week, what slipped.
 */
function TaskFilterMenu({
  filters, onChange, team, shown, total,
}: {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  team: TeamMember[];
  shown: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch });
  const toggleStatus = (s: TaskStatus) =>
    set({ statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] });

  // Closed by a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = 'mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint';
  const field = 'input h-8 w-full py-0 text-[12.5px]';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? `Filters (${count} on)` : 'Filter tasks'}
        title={count ? `${shown} of ${total} tasks shown` : 'Filter by person, status or due date'}
        className={`focusable relative grid h-8 w-8 place-items-center rounded-lg border transition-colors ${
          count || open
            ? 'border-brass bg-brass/10 text-brass-deep'
            : 'border-line bg-surface text-ink-soft hover:border-ink-faint hover:text-ink'
        }`}
      >
        <IconFilter />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brass px-1 text-[9.5px] font-bold leading-none text-white ring-2 ring-surface">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter tasks"
          className="popover absolute right-0 top-full z-40 mt-1.5 w-[300px] overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
            <span className="text-[13px] font-semibold text-ink">Filters</span>
            <span className="text-[11.5px] text-ink-faint">{count ? `${shown} of ${total}` : `${total} tasks`}</span>
          </div>

          <div className="space-y-3.5 px-4 py-3.5">
            <div>
              <label className={label} htmlFor="filter-person">Person</label>
              <select
                id="filter-person"
                className={`${field} ${filters.person ? 'border-brass' : ''}`}
                value={filters.person}
                onChange={(e) => set({ person: e.target.value })}
              >
                <option value="">Everyone</option>
                <option value="unassigned">Unassigned</option>
                {team.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name ?? m.email ?? 'Teammate'}</option>
                ))}
              </select>
            </div>

            <div>
              <span className={label}>Status</span>
              <div className="flex flex-wrap gap-1.5">
                {TASK_STATUSES.map((s) => {
                  const on = filters.statuses.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleStatus(s)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        on ? 'border-brass bg-brass/15 text-ink' : 'border-line text-ink-soft hover:border-ink-faint hover:text-ink'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${COLUMN_DOT[s] ?? 'bg-ink-faint'}`} aria-hidden="true" />
                      {TASK_STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className={label}>Category</span>
              <div className="flex flex-wrap gap-1.5">
                {TASK_CATEGORIES.map((c) => {
                  const on = filters.categories.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set({ categories: on ? filters.categories.filter((x) => x !== c) : [...filters.categories, c] })
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        on ? 'border-brass bg-brass/15 text-ink' : 'border-line text-ink-soft hover:border-ink-faint hover:text-ink'
                      }`}
                    >
                      <HueDot hue={CATEGORY_HUE[c]} />
                      {TASK_CATEGORY_LABELS[c]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className={label} htmlFor="filter-due">Due</label>
              <select
                id="filter-due"
                className={`${field} ${filters.due !== 'any' ? 'border-brass' : ''}`}
                value={filters.due}
                onChange={(e) => set({ due: e.target.value as DueFilter })}
              >
                {DUE_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
              {filters.due === 'range' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <DatePicker
                    ariaLabel="Due from"
                    placeholder="From"
                    className={field}
                    value={filters.from}
                    max={filters.to || undefined}
                    onChange={(next) => set({ from: next ?? '' })}
                  />
                  <DatePicker
                    ariaLabel="Due to"
                    placeholder="To"
                    className={field}
                    value={filters.to}
                    min={filters.from || undefined}
                    onChange={(next) => set({ to: next ?? '' })}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-line-soft bg-sunk/40 px-4 py-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!count}
              onClick={() => onChange(NO_FILTERS)}
            >
              Clear all
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Load the "house" task list out of Houzz Pro.
 *
 * Houzz has no API a third party can read a studio's own tasks through, so the
 * CSV its task screen exports is the route — the same as the project import on
 * the Projects page. The file is read here and posted as text; it never leaves
 * for anywhere but this studio's own API. Safe to run again: rows match on
 * project + title, so a re-import updates the card instead of duplicating it.
 */
function HouzzTaskImport() {
  const importCsv = useImportHouzzTasks();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setMsg(null);
    const csv = await file.text();
    importCsv.mutate(csv, {
      onSuccess: (d) => {
        if (!d.ok) return setMsg({ text: d.reason ?? 'Nothing could be read from that file.', tone: 'crit' });
        const parts = [`${d.created} added`, `${d.updated} updated`];
        if (d.skipped) parts.push(`${d.skipped} skipped`);
        // Name anyone the file assigned work to that we could not match, and
        // any column nothing was read from, so a renamed export shows up here
        // rather than importing silent blanks or leaving work unowned unseen.
        const extra: string[] = [];
        if (d.unmatchedAssignees.length) extra.push(` Unassigned (no match): ${d.unmatchedAssignees.join(', ')}.`);
        if (d.unusedColumns.length) extra.push(` Columns not read: ${d.unusedColumns.join(', ')}.`);
        setMsg({ text: `${parts.join(', ')}.${extra.join('')}`, tone: 'good' });
      },
      onError: (e) => setMsg({ text: (e as Error).message, tone: 'crit' }),
    });
    // Let the same file be chosen again after a correction.
    if (input.current) input.current.value = '';
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <button
        onClick={() => input.current?.click()}
        disabled={importCsv.isPending}
        className="btn-secondary btn-sm"
        title="Export your task list from Houzz Pro, then choose the file here"
      >
        {importCsv.isPending ? 'Reading file…' : 'Import Houzz tasks'}
      </button>
      {msg && (
        <span className={`max-w-md text-right text-[12px] ${msg.tone === 'crit' ? 'text-crit' : 'text-ink-faint'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

const CLEANUP_REASON: Record<HygieneReason, string> = {
  assignee_gone: 'Assignee has left',
  stale: 'Untouched 45+ days',
};

/**
 * Board cleanup — the answer to "167 open?". The open count climbs because the
 * email-driven auto-closer only ever closes a task that an email proves done;
 * work finished in Houzz or in person, and tasks nobody has touched in months,
 * stay open for ever. This lists those (assignee gone, or long untouched) and
 * clears the chosen ones in one pass. Nothing is deleted — a cleared task is
 * cancelled and can be reopened from the board — so it is safe to run.
 */
function BoardCleanup() {
  const [open, setOpen] = useState(false);
  const hygiene = useTaskHygiene();
  const close = useCloseStaleTasks();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);

  const candidates = hygiene.data?.candidates ?? [];

  // Select everything by default when the panel opens or the list changes, so
  // the common case is one click; untick what you want to keep.
  useEffect(() => {
    if (open) setSelected(new Set(candidates.map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hygiene.data]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = () => {
    setResult(null);
    close.mutate([...selected], {
      onSuccess: (d) => {
        if (!d.ok) return setResult(d.reason ?? 'Could not clear the tasks.');
        setResult(`Cleared ${d.closed} task${d.closed === 1 ? '' : 's'} — reopen any from the board if needed.`);
        setSelected(new Set());
      },
      onError: (e) => setResult((e as Error).message),
    });
  };

  const count = candidates.length;

  return (
    <>
      <button
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
        className="btn-secondary btn-sm"
        title="See why tasks are still open and clear the ones that are finished or abandoned"
      >
        Clean up board{count ? ` (${count})` : ''}
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={() => setOpen(false)}>
            <div
              className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b border-line-soft px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[16px] font-semibold text-ink">Clean up the board</h2>
                  <button onClick={() => setOpen(false)} className="btn-ghost btn-sm">Close</button>
                </div>
                <p className="mt-1 text-[12.5px] text-ink-soft">
                  {hygiene.data ? `${hygiene.data.total} tasks open.` : 'Checking the board…'}{' '}
                  These haven't been auto-closed because no email ever marked them done — they're finished-and-forgotten
                  or belong to someone who's left. Clearing cancels them (not deleted); reopen any from the board.
                </p>
                {hygiene.data && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[11.5px]">
                    <Pill tone="warn">{hygiene.data.counts.assignee_gone} assignee has left</Pill>
                    <Pill tone="warn">{hygiene.data.counts.stale} untouched 45+ days</Pill>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-b border-line-soft px-5 py-2 text-[12px] text-ink-soft">
                <span>{selected.size} of {count} selected</span>
                <div className="flex gap-3">
                  <button className="text-brass hover:underline" onClick={() => setSelected(new Set(candidates.map((c) => c.id)))}>Select all</button>
                  <button className="text-ink-faint hover:underline" onClick={() => setSelected(new Set())}>None</button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {hygiene.isLoading && <div className="px-5 py-10 text-center text-[13px] text-ink-faint">Reading the board…</div>}
                {!hygiene.isLoading && count === 0 && (
                  <div className="px-5 py-10 text-center text-[13px] text-ink-faint">Nothing to clear — the board is tidy.</div>
                )}
                <ul className="divide-y divide-line-soft">
                  {candidates.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-5 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        className="mt-1 h-4 w-4 shrink-0 accent-brass"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-ink">{c.title}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-faint">
                          <span className="text-warn">{CLEANUP_REASON[c.reason]}</span>
                          {c.assignee && <span>· {c.assignee}</span>}
                          {c.project && <span>· {c.project}</span>}
                          <span>· {c.ageDays}d idle</span>
                          {c.dueDate && <span>· was due {shortDate(c.dueDate)}</span>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line-soft px-5 py-3">
                <span className={`text-[12px] ${result ? 'text-ink-soft' : 'text-ink-faint'}`}>{result ?? 'Cleared tasks are reversible.'}</span>
                <button
                  onClick={run}
                  disabled={close.isPending || selected.size === 0}
                  className="btn-primary btn-sm"
                >
                  {close.isPending ? 'Clearing…' : `Clear ${selected.size} selected`}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default function Tasks() {
  const { data: tasks, isLoading } = useTasks();
  const { data: team } = useTeam();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const { user, may } = useAuth();
  // Which task's detail panel is open, if any.
  //
  // Seeded from ?task=, so a task named in an answer, a digest or a link
  // someone pasted opens on the task itself rather than on the board with
  // the reader left to find it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [openTask, setOpenTask] = useState<string | null>(() => searchParams.get('task'));

  // A `?task=` reading only taken at mount misses every later one: Jenny's
  // docked panel sits alongside this same page, so clicking a task there is
  // a same-route navigation, not a fresh page load, and never remounts this
  // component. Watching the param directly is what makes a second click —
  // to a different task while one is already open — actually switch panels.
  useEffect(() => {
    const wanted = searchParams.get('task');
    if (!wanted || wanted === openTask) return;
    setOpenTask(wanted);
  }, [searchParams, openTask]);

  // Drop the parameter once it has been used: it has done its job, and
  // leaving it in the URL would re-open the panel on every later close.
  useEffect(() => {
    if (!openTask || !searchParams.has('task')) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('task');
        return next;
      },
      { replace: true },
    );
  }, [openTask, searchParams, setSearchParams]);

  // The board answers "where is everything", the list "what do I owe".
  // Remembered per browser so the studio is not re-choosing every visit.
  const [view, setView] = useState<'board' | 'list'>(() => {
    try {
      return localStorage.getItem('tasks.view') === 'list' ? 'list' : 'board';
    } catch {
      return 'board';
    }
  });

  // The list is grouped by category, or by how urgent each task is.
  const [groupBy, setGroupBy] = useState<'category' | 'priority'>(() => {
    try {
      return localStorage.getItem('tasks.groupBy') === 'priority' ? 'priority' : 'category';
    } catch {
      return 'category';
    }
  });
  const chooseGroup = (next: 'category' | 'priority') => {
    setGroupBy(next);
    try {
      localStorage.setItem('tasks.groupBy', next);
    } catch {
      // The choice just will not stick.
    }
  };

  const chooseView = (next: 'board' | 'list') => {
    setView(next);
    try {
      localStorage.setItem('tasks.view', next);
    } catch {
      // A private window refuses storage; the choice just will not stick.
    }
  };

  // Whoever runs the board, by role or by seat — see canManageTasks.
  const supervisor = canManageTasks(user?.role ?? null, user?.seat ?? null);

  // Mine first. The board opened on the whole studio, so the answer to
  // "what do I owe" was to read every column and pick your own cards out.
  // Unassigned work stays visible in "Mine": it is nobody's yet, and
  // claiming it is exactly what the board is for.
  const [scope] = useScope();
  const isMine = (t: TaskView) => t.assignedTo === user?.id || !t.assignedTo;

  // Remembered for the tab, so opening a task and coming back keeps them.
  const [filters, setFilters] = useState<TaskFilters>(() => {
    try {
      const saved = sessionStorage.getItem('tasks.filters');
      const parsed = saved ? { ...NO_FILTERS, ...(JSON.parse(saved) as Partial<TaskFilters>) } : DEFAULT_FILTERS;
      return {
        ...parsed,
        statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
        // A choice saved before that option was removed ("No due date") falls back to any date.
        due: DUE_OPTIONS.some((o) => o.v === parsed.due) ? parsed.due : 'any',
      };
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  const changeFilters = (next: TaskFilters) => {
    setFilters(next);
    try {
      sessionStorage.setItem('tasks.filters', JSON.stringify(next));
    } catch {
      // Private window: the filters just will not survive a reload.
    }
  };

  // Choosing a person is a question about the whole studio, so it looks
  // past Mine — "show me Joanna's work" should not come back empty because
  // the toggle was left on Mine.
  const byPerson = (t: TaskView) =>
    !filters.person ||
    (filters.person === 'unassigned' ? !t.assignedTo : t.assignedTo === filters.person);
  const base = filters.person ? tasks : scope === 'mine' ? tasks.filter(isMine) : tasks;
  const byStatus = (t: TaskView) => !filters.statuses.length || filters.statuses.includes(t.status);
  const byCategory = (t: TaskView) => !filters.categories.length || filters.categories.includes(t.category);
  // Every word typed has to appear somewhere on the task, in any order, so
  // "lemon tile" finds "Chase Home Depot for delayed tile … Lemon Residence".
  const [search, setSearch] = useState('');
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const bySearch = (t: TaskView) => {
    if (!words.length) return true;
    const hay = [
      t.title, t.detail, t.nextStep, t.project, t.assignee,
      TASK_CATEGORY_LABELS[t.category], TASK_KIND_LABELS[t.kind], TASK_STATUS_LABELS[t.status],
    ].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const scoped = base.filter((t) => byPerson(t) && byStatus(t) && byCategory(t) && bySearch(t) && dueMatches(t, filters));
  const unfilteredCount = base.length;
  const filtering = activeFilterCount(filters) > 0 || words.length > 0;
  const mineCount = tasks.filter((t) => isMine(t) && OPEN_STATUSES.includes(t.status)).length;
  const allCount = tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length;

  const visible =
    filters.statuses.includes('done') ? scoped : scoped.filter((t) => OPEN_STATUSES.includes(t.status));

  // The board always shows its Done column — that is what a board is for, and
  // "Hide closed" was written for the list. Only the most recently FINISHED
  // work, so a year of it does not bury the columns that still need a person.
  // Ordered by when it was finished, not when it was raised: a task from last
  // month closed this morning used to fall outside the twelve and vanish from
  // the board instead of landing in Done.
  const DONE_ON_BOARD = 12;
  const finishedAt = (t: TaskView) => (t.completedAt ? Date.parse(t.completedAt) : 0);
  const boardTasks = [
    ...scoped.filter((t) => OPEN_STATUSES.includes(t.status)),
    ...scoped
      .filter((t) => t.status === 'done')
      .sort((a, b) => finishedAt(b) - finishedAt(a))
      .slice(0, DONE_ON_BOARD),
  ];

  /** Anyone can work their own queue or claim an unowned task; only a
   *  supervisor can move work between other people. */
  const mayEdit = (assignedTo: string | null) =>
    supervisor || !assignedTo || assignedTo === user?.id;

  /**
   * Removing a task for good is the studio's decision, not a teammate's —
   * the server holds the same rule, this only decides whether to offer it.
   * Confirmed first: there is no undo, and the card sits under the cursor
   * during a drag.
   */
  const mayDelete = may('tasks', 'delete');
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null);
  const onDelete = (t: TaskView) => setDeleteTarget(t);
  const confirmDelete = () => {
    if (!deleteTarget) return;
    remove.mutate(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <Page>
      <PageHeading
        title="Tasks"
        // Board-only: the drag and the ✓✓ button it describes are both on
        // the board view, and said once here rather than repeated on every
        // card.
        sub={view === 'board' ? 'Drag a card to Done, or press the green ✓✓ on a card, to complete it.' : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {supervisor && <BoardCleanup />}
            {supervisor && <HouzzTaskImport />}
            <div className="relative">
              <IconSearch
                width={15}
                height={15}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
                placeholder="Search tasks"
                aria-label="Search tasks"
                className="focusable h-8 w-36 rounded-lg border border-line bg-surface pl-8 pr-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-brass sm:w-56"
              />
            </div>
            <ScopeToggle mine={mineCount} all={allCount} />
            <TaskFilterMenu
              filters={filters}
              onChange={changeFilters}
              team={team}
              shown={view === 'board' ? boardTasks.length : visible.length}
              total={unfilteredCount}
            />
            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="How to show the tasks">
              {([
                { v: 'board' as const, label: 'Board', Icon: IconBoard },
                { v: 'list' as const, label: 'List', Icon: IconList },
              ]).map(({ v, label, Icon }) => (
                <button
                  key={v}
                  onClick={() => chooseView(v)}
                  aria-pressed={view === v}
                  aria-label={label}
                  title={label}
                  className={`focusable grid h-7 w-7 place-items-center rounded-md transition-colors ${
                    view === v ? 'bg-brass text-white' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <Icon width={15} height={15} />
                </button>
              ))}
            </div>

          </div>
        }
      />


      {view === 'board' && (
        <>
          {isLoading && (
            <div className="py-12 text-center text-[13px] text-ink-faint">Loading…</div>
          )}
          {/* Only a studio with no tasks at all gets the empty-state box.
              Filtered down to nothing, the board keeps its columns — the
              layout should not jump because a filter came back empty. */}
          {!isLoading && boardTasks.length === 0 && !filtering && (
            <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
              No tasks yet. They appear here as the system reads email and spots work that needs doing.
            </div>
          )}
          {!isLoading && boardTasks.length === 0 && filtering && (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-soft">
              <span>No tasks match these filters.</span>
              <button type="button" className="font-medium text-brass hover:underline" onClick={() => changeFilters(NO_FILTERS)}>
                Clear filters
              </button>
            </div>
          )}
          {!isLoading && (boardTasks.length > 0 || filtering) && (
            <Board
              tasks={boardTasks}
              team={team}
              mayEdit={mayEdit}
              onMove={(id, status) => update.mutate({ id, status })}
              onAssign={(id, assigned_to) => update.mutate({ id, assigned_to })}
              onDue={(id, due_date) => update.mutate({ id, due_date })}
              onOpen={setOpenTask}
              onDelete={mayDelete ? onDelete : undefined}
            />
          )}
          {update.isError && (
            <div className="mt-4 text-[12.5px] text-crit">{(update.error as Error).message}</div>
          )}
        </>
      )}

      {view === 'list' && (
      <Card>
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <h2 className="text-[16px] font-semibold text-ink">
            {filters.statuses.includes('done') ? 'All tasks' : 'Open work'}
          </h2>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-[12px]" role="group" aria-label="Group tasks by">
              {([['category', 'Category'], ['priority', 'Priority (SLA)']] as const).map(([v, text]) => (
                <button
                  key={v}
                  onClick={() => chooseGroup(v)}
                  aria-pressed={groupBy === v}
                  className={`focusable rounded-md px-2.5 py-1 font-medium transition-colors ${
                    groupBy === v ? 'bg-brass text-white' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-ink-faint">{visible.length} shown</span>
          </div>
        </div>
        <ul className="divide-y divide-line-soft">
          {isLoading && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</li>
          )}
          {!isLoading && visible.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
              {filtering
                ? 'No tasks match these filters.'
                : 'No open tasks. They appear here as the system reads email and spots work that needs doing.'}
            </li>
          )}
          {(groupBy === 'priority'
            ? SLA_TIERS.map((tier) => ({
                key: tier.key as string,
                label: tier.label as string,
                urgent: tier.key === 'critical' || tier.key === 'overdue',
                items: visible
                  .filter((t) => slaTier(t) === tier.key)
                  .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')),
              }))
            : TASK_CATEGORIES.map((c) => ({
                key: c as string,
                label: TASK_CATEGORY_LABELS[c] as string,
                urgent: false,
                items: visible.filter((t) => t.category === c),
              }))
          ).map(({ key: c, label: groupLabel, urgent, items: group }) => {
            if (!group.length) return null;
            return (
              <Fragment key={c}>
                <li className="flex items-center justify-between bg-sunk px-5 py-2">
                  <h3
                    className={`flex items-center gap-2 text-[11.5px] font-bold uppercase tracking-[0.07em] ${
                      urgent ? 'text-crit' : c in CATEGORY_HUE ? HUE[CATEGORY_HUE[c as TaskCategory]].text : 'text-ink-soft'
                    }`}
                  >
                    {c in CATEGORY_HUE && <HueDot hue={CATEGORY_HUE[c as TaskCategory]} />}
                    {groupLabel}
                  </h3>
                  <span className="text-[11.5px] text-ink-faint">{group.length}</span>
                </li>
                {group.map((t) => (
                <li key={t.id} className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-3 sm:w-40">
                    <Pill tone={tone[t.kind]}>{TASK_KIND_LABELS[t.kind]}</Pill>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-ink">{t.title}</div>
                    {t.detail && <div className="text-[13px] text-ink-soft">{t.detail}</div>}
                    <div className="mt-0.5 text-[11px] text-ink-faint">
                      {t.project !== '—' ? <ProjectName name={t.project} className="align-bottom" /> : t.project} · raised {t.age}
                      {t.due && <> · due {shortDate(t.due)}</>}
                      {t.overdue && daysLate(t) > 0 && (
                        <span className="font-semibold text-crit"> · {daysLate(t)} day{daysLate(t) > 1 ? 's' : ''} overdue</span>
                      )}
                      {t.status === 'done' && t.completedAt ? (
                        <>
                          {' '}· done {shortDate(t.completedAt)}
                          {finishedLabel(t.daysEarly) && <>, {finishedLabel(t.daysEarly)}</>}
                          {t.closedNote && <span title={t.closedNote}> · closed automatically</span>}
                        </>
                      ) : (
                        t.status !== 'open' && <> · {TASK_STATUS_LABELS[t.status]}</>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                    {t.assignedTo ? (
                      <Avatar name={t.assignee} size={28} />
                    ) : (
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sunk text-[12px] font-bold text-ink-faint" title="Unassigned">?</span>
                    )}

                    {supervisor ? (
                      <select
                        className="input w-auto max-w-[9rem]"
                        value={t.assignedTo ?? ''}
                        onChange={(e) => update.mutate({ id: t.id, assigned_to: e.target.value || null })}
                      >
                        <option value="">Unassigned</option>
                        {team.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.full_name ?? m.email ?? 'Teammate'}
                          </option>
                        ))}
                      </select>
                    ) : !t.assignedTo ? (
                      <button
                        onClick={() => update.mutate({ id: t.id, assigned_to: user?.id ?? null })}
                        className="btn-secondary btn-sm"
                      >
                        Claim
                      </button>
                    ) : (
                      <span className="text-[12.5px] text-ink-faint">{t.assignee}</span>
                    )}

                    <select
                      className="input w-auto max-w-[9rem]"
                      value={t.status}
                      disabled={!mayEdit(t.assignedTo)}
                      title={mayEdit(t.assignedTo) ? undefined : "Only a principal or coordinator can change someone else's task"}
                      onChange={(e) => update.mutate({ id: t.id, status: e.target.value as TaskStatus })}
                    >
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {TASK_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
                ))}
              </Fragment>
            );
          })}
        </ul>
        {update.isError && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-crit">
            {(update.error as Error).message}
          </div>
        )}
        <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
          Tasks are assigned by role, then by seat, and finally to whoever runs the board — so
          work is only left unassigned when there is nobody at all to take it.
        </div>
      </Card>
      )}

      {openTask && <TaskPanel id={openTask} onClose={() => setOpenTask(null)} />}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete "${deleteTarget?.title ?? ''}"?`}
        message="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </Page>
  );
}
