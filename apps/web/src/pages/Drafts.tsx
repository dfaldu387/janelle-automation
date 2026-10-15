import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Page, PageHeading, Card } from '../components/ui';
import { RichTextEditor, toEditorHtml, htmlToPlainText } from '../components/RichTextEditor';
import { useDrafts, useDeleteDraft, useUpdateDraft, gmailMessageUrl, isMobileOrTablet, type DraftRow } from '../lib/queries';
import { ScopeToggle, useScope } from '../components/ScopeToggle';
import { useAuth } from '../context/AuthContext';

/** Split a stored draft into its To / Cc header lines and the message body. */
function parseDraft(text: string): { to: string; cc: string; body: string } {
  const to = text.match(/^To:\s*(.+)$/im)?.[1].trim() ?? '';
  const cc = text.match(/^Cc:\s*(.+)$/im)?.[1].trim() ?? '';
  const body = text.replace(/^To:.*$/im, '').replace(/^Cc:.*$/im, '').replace(/^\s+/, '');
  return { to, cc, body };
}

/**
 * Gmail's compose deep link. Opens a new message in the user's Gmail with
 * every field prefilled — nothing is sent until they press Send there.
 *
 * Routed through Google's account chooser when the studio address is known, so
 * the compose opens in the studio account or prompts to sign into it — never
 * silently in a stranger's account that happens to be signed into this Chrome
 * profile (where `authuser=` alone would land it). Falls back to a plain
 * compose when the address is unknown.
 */
function gmailComposeUrl(
  d: { to: string; cc: string; subject: string; body: string },
  mailboxEmail?: string | null,
): string {
  const q = new URLSearchParams({ view: 'cm', fs: '1' });
  if (mailboxEmail) q.set('authuser', mailboxEmail);
  if (d.to) q.set('to', d.to);
  if (d.cc) q.set('cc', d.cc);
  if (d.subject) q.set('su', d.subject);
  if (d.body) q.set('body', htmlToPlainText(d.body));
  const compose = `https://mail.google.com/mail/?${q.toString()}`;
  // Mobile/iPad: the direct compose link so the Gmail app opens it. Desktop:
  // the account chooser so the compose opens in the studio account.
  if (isMobileOrTablet() || !mailboxEmail) return compose;
  return `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(mailboxEmail)}&continue=${encodeURIComponent(compose)}`;
}

function ageFrom(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return days <= 0 ? 'today' : `${days}d ago`;
}

function GmailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/** Read-only view of a draft body: renders HTML from the editor, or plain text. */
function DraftBody({ body }: { body: string }) {
  if (/<(p|br|div|ul|ol|h\d|blockquote)\b/i.test(body)) {
    return <div className="ck-content rte-content text-[14px] leading-relaxed text-ink" dangerouslySetInnerHTML={{ __html: body }} />;
  }
  return <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink">{body}</pre>;
}

function DraftEditor({ draft, onDone }: { draft: DraftRow; onDone: () => void }) {
  const { gmailAccount } = useAuth();
  const parsed = parseDraft(draft.body_preview ?? '');
  const [to, setTo] = useState(parsed.to);
  const [cc, setCc] = useState(parsed.cc);
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(toEditorHtml(parsed.body));
  const update = useUpdateDraft();

  const save = () =>
    update.mutate({ id: draft.id, to, cc, subject, body }, { onSuccess: onDone });

  const field = 'flex items-center gap-3 border-b border-line-soft py-2';
  const label = 'w-14 shrink-0 text-[12.5px] font-medium text-ink-faint';
  const input = 'focusable min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-faint';

  return (
    <div className="border-t border-line-soft px-5 py-4">
      <div className="rounded-lg border border-line bg-surface px-4 pt-1">
        <div className={field}>
          <label className={label} htmlFor={`to-${draft.id}`}>To</label>
          <input id={`to-${draft.id}`} className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@vendor.com" />
        </div>
        <div className={field}>
          <label className={label} htmlFor={`cc-${draft.id}`}>Cc</label>
          <input id={`cc-${draft.id}`} className={input} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="comma-separated" />
        </div>
        <div className="flex items-center gap-3 py-2">
          <label className={label} htmlFor={`su-${draft.id}`}>Subject</label>
          <input id={`su-${draft.id}`} className={`${input} font-medium`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        </div>
      </div>

      <div className="mt-3">
        <RichTextEditor value={body} onChange={setBody} placeholder="Write the reply…" autoFocus />
      </div>

      {update.isError && <p className="mt-2 text-[12.5px] text-crit">{(update.error as Error).message}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={update.isPending || !body.trim()} className="btn-primary btn-sm">
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <a
          href={gmailComposeUrl({ to, cc, subject, body }, gmailAccount)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary btn-sm"
          title="Opens Gmail with the text as it is right now (unsaved edits included)"
        >
          <GmailIcon /> Open in Gmail
        </a>
        <button onClick={onDone} disabled={update.isPending} className="btn-ghost btn-sm">
          Cancel
        </button>
        <span className="ml-auto text-[12px] text-ink-faint">Saved edits are what "Open in Gmail" uses next time.</span>
      </div>
    </div>
  );
}

export default function Drafts() {
  const { data: all, isLoading } = useDrafts();
  const [scope] = useScope();
  const { user, gmailAccount } = useAuth();

  /**
   * Whose draft it is.
   *
   * A draft the reading pass wrote off the studio's shared mailbox belongs
   * to nobody in particular, so it stays in both views — somebody has to
   * pick it up. A draft answering a member's own mail carries their id and
   * is theirs; row security (0018) already keeps it from anyone else, so
   * this only decides what is shown first.
   */
  const isMine = (d: DraftRow) => {
    const owner = d.owner_id ?? d.created_by ?? null;
    return !owner || owner === user?.id;
  };
  // Jenny's answers link straight to one draft (/drafts?open=<id>) — that
  // draft must stay visible and land open, whichever scope is selected.
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('open');
  const drafts = scope === 'mine' ? all.filter((d) => isMine(d) || d.id === openId) : all;
  const del = useDeleteDraft();
  const [open, setOpen] = useState<Set<string>>(() => new Set(openId ? [openId] : []));
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!openId) return;
    setOpen((prev) => (prev.has(openId) ? prev : new Set(prev).add(openId)));
    document.getElementById(`draft-${openId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [openId, all.length]);

  const closeOpened = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('open');
      return next;
    }, { replace: true });

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const startEdit = (id: string) => {
    setOpen((prev) => new Set(prev).add(id));
    setEditing(id);
  };

  return (
    <Page>
      <PageHeading
        title="Drafts"
        action={<ScopeToggle mine={all.filter(isMine).length} all={all.length} />}
      />

      {isLoading && <div className="py-12 text-center text-[13px] font-medium text-ink-faint">Loading…</div>}
      {!isLoading && drafts.length === 0 && (
        <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
          No drafts yet. They appear here as the system reads email and raises follow-ups.
        </div>
      )}
      {!isLoading && drafts.length > 0 && (
        <div className="space-y-3">
          {drafts.map((d) => {
            const raw = d.body_preview ?? '';
            const { to, cc, body } = parseDraft(raw);
            const subject = d.subject ?? '';
            const isOpen = open.has(d.id);
            const isEditing = editing === d.id;
            // A real Gmail draft (pushed when this was saved) beats a
            // fabricated compose window — it opens the actual draft, in its
            // actual thread, ready to send from there.
            const isRealDraft = Boolean(d.gmail_message_id);
            const gmailUrl = isRealDraft
              ? gmailMessageUrl(d.gmail_message_id as string, gmailAccount)
              : gmailComposeUrl({ to, cc, subject, body }, gmailAccount);
            const gmailTitle = isRealDraft
              ? 'Open the actual Gmail draft, in its thread'
              : 'Open a prefilled compose window in Gmail — this draft never reached a live Gmail account';
            const preview = htmlToPlainText(body).replace(/\s+/g, ' ').slice(0, 110);
            const isLinked = d.id === openId;
            return (
              <Card key={d.id} className={`overflow-hidden ${isLinked ? 'ring-2 ring-brass' : ''}`}>
                <div id={`draft-${d.id}`} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
                  <button
                    onClick={() => toggle(d.id)}
                    aria-expanded={isOpen}
                    className="focusable flex min-w-0 flex-1 items-start gap-4 text-left"
                  >
                    <span className="mt-0.5 rounded-md bg-good/10 px-2 py-0.5 text-[12px] font-medium text-good">draft</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">{subject || '(no subject)'}</span>
                      {!isOpen && <span className="block truncate text-[13px] text-ink-soft">{preview}</span>}
                      {to && <span className="mt-0.5 block text-[11px] text-ink-faint">to {to}</span>}
                    </span>
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="mr-1 whitespace-nowrap text-[11px] text-ink-faint">{ageFrom(d.created_at)}</span>
                    {!isEditing && (
                      <button onClick={() => startEdit(d.id)} className="btn-secondary btn-sm" title="Edit this draft">
                        <PencilIcon /> Edit
                      </button>
                    )}
                    <a
                      href={gmailUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-primary btn-sm"
                      title={gmailTitle}
                    >
                      <GmailIcon /> Open in Gmail
                    </a>
                  </div>
                </div>

                {isOpen && isEditing && <DraftEditor draft={d} onDone={() => setEditing(null)} />}

                {isOpen && !isEditing && (
                  <div className="border-t border-line-soft px-5 py-4">
                    {(to || cc) && (
                      <dl className="mb-3 space-y-1 text-[13px]">
                        {to && (
                          <div className="flex gap-2">
                            <dt className="w-7 shrink-0 text-ink-faint">To</dt>
                            <dd className="text-ink">{to}</dd>
                          </div>
                        )}
                        {cc && (
                          <div className="flex gap-2">
                            <dt className="w-7 shrink-0 text-ink-faint">Cc</dt>
                            <dd className="text-ink-soft">{cc}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                    <DraftBody body={body} />
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button onClick={() => startEdit(d.id)} className="btn-primary btn-sm">
                        <PencilIcon /> Edit draft
                      </button>
                      <a href={gmailUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm">
                        <GmailIcon /> Open in Gmail
                      </a>
                      <button
                        onClick={() => navigator.clipboard?.writeText(htmlToPlainText(body)).catch(() => {})}
                        className="btn-secondary btn-sm"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => del.mutate(d.id)}
                        disabled={del.isPending}
                        className="btn-secondary btn-sm text-crit hover:border-crit"
                      >
                        Delete
                      </button>
                      {isLinked && (
                        <button onClick={closeOpened} className="text-[12px] text-ink-faint hover:text-ink-soft hover:underline">
                          Clear from link
                        </button>
                      )}
                      <span className="ml-auto text-[12px] text-ink-faint">
                        {isRealDraft
                          ? 'Opens the actual draft in Gmail. Review, then send from there.'
                          : 'Opens a new Gmail message with this content filled in. Review, then send from Gmail.'}
                      </span>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}
