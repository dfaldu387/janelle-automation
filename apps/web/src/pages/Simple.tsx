import { Fragment, useEffect, useMemo, useState } from 'react';
import { Avatar, CategoryTag, ProjectName } from '../components/hue';
import { Link, useSearchParams } from 'react-router-dom';
import { Page, PageHeading, Card, Pill, money, shortDate } from '../components/ui';
import { useEmails, useEmail, useDocuments, gmailMessageUrl, gmailLinkProps, type DocSource } from '../lib/queries';
import { useAuth } from '../context/AuthContext';
import { apiBlob } from '../lib/api';
import { useTable, SortTh, SearchInput, FilterSelect, TableToolbar, TablePager, matches } from '../components/table';
import { TASK_CATEGORIES, TASK_CATEGORY_LABELS } from '@janelle/shared';

/** Fetch a document's original PDF and open it in a new tab. */
async function openDocument(id: string, onError: (m: string) => void) {
  const win = window.open('', '_blank'); // open synchronously to dodge popup blockers
  try {
    const blob = await apiBlob(`/documents/${id}/file`);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (win) win.close();
    onError((e as Error).message);
  }
}

const REPLYABLE = ['vendor_quote', 'order_confirmation', 'client_approval'];

const emailClassLabel: Record<string, string> = {
  vendor_quote: 'Quote',
  order_confirmation: 'Order confirm',
  client_approval: 'Client approval',
  houzz_notification: 'Houzz',
  general: 'General',
  unclassified: 'Unclassified',
};
const emailClassTone: Record<string, 'brass' | 'good' | 'warn' | 'neutral'> = {
  vendor_quote: 'brass',
  order_confirmation: 'good',
  client_approval: 'warn',
  houzz_notification: 'neutral',
  general: 'neutral',
};

/** The full timestamp behind the relative "2 days", shown on hover. */
function exactWhen(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
}

export function Inbox() {
  const { gmailAccount } = useAuth();
  const { data: emails, isLoading } = useEmails();
  const [query, setQuery] = useState('');
  const [cls, setCls] = useState<string>('all');
  /** A TaskCategory, 'none' for mail with no category, or 'all'. */
  const [category, setCategory] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // A task's "Open in Inbox →" link lands here as /inbox?open=<id>. The id
  // is fetched on its own (not just found in the list above) because the
  // list only holds the 500 most recent messages, and a filter or page the
  // person was already on must not be able to hide the one thing the link
  // promised to show.
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('open');
  const { data: openedEmail, isLoading: openedLoading } = useEmail(openId);
  const closeOpened = () =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('open');
      return next;
    }, { replace: true });

  useEffect(() => {
    if (!openId) return;
    setExpanded((prev) => (prev.has(openId) ? prev : new Set(prev).add(openId)));
  }, [openId]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Only the classes actually present, so the filter never offers a dead option.
  const classes = useMemo(
    () => [...new Set(emails.map((m) => m.cls))].sort((a, b) =>
      (emailClassLabel[a] ?? a).localeCompare(emailClassLabel[b] ?? b)),
    [emails],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return emails.filter((m) => {
      // The message a task deep-linked to stays visible no matter what
      // filter is set — that is the one thing this screen must not hide.
      if (m.id === openId) return true;
      if (cls !== 'all' && m.cls !== cls) return false;
      if (category === 'none' ? m.category !== '' : category !== 'all' && m.category !== category) return false;
      return matches(q, m.subject, m.snippet, m.fromName, m.fromEmail, m.project, m.vendor, m.category ? TASK_CATEGORY_LABELS[m.category] : '');
    });
  }, [emails, query, cls, category, openId]);

  // A column nothing fills is left out entirely rather than drawn as a stack
  // of em dashes — measured over all mail so the shape holds while filtering.
  const showProject = emails.some((m) => m.project !== '');
  const showVendor = emails.some((m) => m.vendor !== '');
  const showCategory = emails.some((m) => m.category !== '');
  // Only the categories actually present, like the classification filter.
  const categories = TASK_CATEGORIES.filter((c) => emails.some((m) => m.category === c));
  const uncategorised = emails.some((m) => m.category === '');

  const cols = 4 + Number(showCategory) + Number(showProject) + Number(showVendor);

  // A studio mailbox runs to hundreds of messages; the table shows a
  // screenful, and the filters above decide what is being paged through.
  const pager = useTable(shown, {
    storageKey: 'inbox',
    defaultSort: { key: 'when', dir: 'desc' },
    sorters: {
      type: (m) => emailClassLabel[m.cls] ?? m.cls,
      category: (m) => (m.category ? TASK_CATEGORY_LABELS[m.category] : ''),
      from: (m) => m.fromName || m.fromEmail,
      subject: (m) => m.subject,
      project: (m) => m.project,
      vendor: (m) => m.vendor,
      when: (m) => m.receivedAt,
    },
  });
  const filtering = Boolean(query.trim()) || cls !== 'all' || category !== 'all';
  const clearFilters = () => {
    setQuery('');
    setCls('all');
    setCategory('all');
  };

  // Land on whichever page holds the message a task linked to, so "Open in
  // Inbox" does not drop someone on page 1 and leave them to go hunting.
  useEffect(() => {
    if (!openId) return;
    const idx = pager.sorted.findIndex((m) => m.id === openId);
    if (idx === -1) return;
    pager.setPage(Math.floor(idx / pager.pageSize) + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, pager.sorted]);

  useEffect(() => {
    if (!openId) return;
    document.getElementById(`email-${openId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [openId, pager.page]);

  // The list above only holds the 500 most recent messages. On the rare
  // message old enough to have aged out of it, this is the only place its
  // content is ever shown.
  const openedAgedOut = Boolean(openId) && !isLoading && !emails.some((m) => m.id === openId);

  return (
    <Page>
      <PageHeading
        title="Inbox Intelligence"
      />
      {openedAgedOut && (
        <Card className="mb-4 border-brass/40">
          <div className="flex items-start justify-between gap-4 px-5 py-4">
            {openedLoading && <p className="text-[13px] text-ink-faint">Loading the message…</p>}
            {!openedLoading && !openedEmail && (
              <p className="text-[13px] text-ink-faint">That message could not be found.</p>
            )}
            {!openedLoading && openedEmail && (
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink">{openedEmail.subject || '(no subject)'}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">
                  {openedEmail.fromName || openedEmail.fromEmail}
                  {openedEmail.receivedAt && <> · {shortDate(openedEmail.receivedAt)}</>}
                  {' · outside the 500 most recent messages shown below'}
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                  {openedEmail.summary || openedEmail.snippet || ''}
                </p>
                {openedEmail.gmailId && (
                  <a
                    href={gmailMessageUrl(openedEmail.gmailId, gmailAccount)}
                    {...gmailLinkProps()}
                    className="focusable mt-2 inline-block text-[12.5px] font-semibold text-brass-deep hover:underline"
                  >
                    Open in Gmail →
                  </a>
                )}
              </div>
            )}
            <button onClick={closeOpened} className="btn-ghost btn-sm shrink-0">Close</button>
          </div>
        </Card>
      )}
      <Card>
        <TableToolbar
          search={<SearchInput value={query} onChange={setQuery} placeholder="Search subject, sender, project or vendor" label="Search mail" />}
          filters={
            <>
              <FilterSelect
                label="Filter by type"
                value={cls}
                onChange={setCls}
                options={[{ value: 'all', label: 'All types' }, ...classes.map((c) => ({ value: c, label: emailClassLabel[c] ?? c }))]}
              />
              {categories.length > 0 && (
                <FilterSelect
                  label="Filter by category"
                  value={category}
                  onChange={setCategory}
                  options={[
                    { value: 'all', label: 'All categories' },
                    ...categories.map((c) => ({ value: c, label: TASK_CATEGORY_LABELS[c] })),
                    ...(uncategorised ? [{ value: 'none', label: 'No category' }] : []),
                  ]}
                />
              )}
            </>
          }
          shown={shown.length}
          total={emails.length}
          noun="message"
          onClear={filtering ? clearFilters : null}
        />
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[14px]">
            <colgroup>
              <col className="w-[108px]" />
              {showCategory && <col className="w-[150px]" />}
              <col className="w-[168px]" />
              {/* Subject takes every pixel the fixed columns do not: the old
                  layout stacked subject, snippet and sender in a narrow middle
                  band and left the right third of the row empty. */}
              <col />
              {showProject && <col className="w-[150px]" />}
              {showVendor && <col className="w-[150px]" />}
              <col className="w-[84px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <SortTh table={pager} col="type" className="px-5 py-2.5 font-medium">Type</SortTh>
                {showCategory && <SortTh table={pager} col="category" className="px-3 py-2.5 font-medium">Category</SortTh>}
                <SortTh table={pager} col="from" className="px-3 py-2.5 font-medium">From</SortTh>
                <SortTh table={pager} col="subject" className="px-3 py-2.5 font-medium">Subject</SortTh>
                {showProject && <SortTh table={pager} col="project" className="px-3 py-2.5 font-medium">Project</SortTh>}
                {showVendor && <SortTh table={pager} col="vendor" className="px-3 py-2.5 font-medium">Vendor</SortTh>}
                <SortTh table={pager} col="when" align="right" className="px-5 py-2.5 font-medium">When</SortTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
              )}
              {!isLoading && emails.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No mail read yet. Run “Read Gmail &amp; Drive” from the Dashboard.
                  </td>
                </tr>
              )}
              {!isLoading && emails.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No mail matches these filters.
                  </td>
                </tr>
              )}
              {pager.rows.map((m) => {
                const isOpen = expanded.has(m.id);
                const isLinked = m.id === openId;
                return (
                  <Fragment key={m.id}>
                    <tr
                      id={`email-${m.id}`}
                      onClick={() => toggle(m.id)}
                      className={`cursor-pointer align-middle transition-colors hover:bg-sunk/40 ${
                        isLinked ? 'bg-brass/5' : ''
                      }`}
                    >
                      <td className="px-5 py-2.5">
                        <Pill tone={emailClassTone[m.cls] ?? 'neutral'}>{emailClassLabel[m.cls] ?? m.cls}</Pill>
                      </td>
                      {showCategory && (
                        <td className="px-3 py-2.5">
                          {m.category ? (
                            <CategoryTag category={m.category} label={TASK_CATEGORY_LABELS[m.category]} className="max-w-full truncate" />
                          ) : (
                            <span className="text-[13px] text-ink-faint">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink" title={m.fromEmail || undefined}>
                          <Avatar name={m.fromName || m.fromEmail} size={22} />
                          <span className="truncate">{m.fromName || m.fromEmail || '—'}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {/* Subject and snippet share one line so the width is spent
                            on content instead of on a third row of text. */}
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 max-w-[60%] truncate text-[13.5px] font-medium text-ink">
                            {m.subject}
                          </span>
                          {m.snippet && (
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">{m.snippet}</span>
                          )}
                          {REPLYABLE.includes(m.cls) && (
                            <Link
                              to="/drafts"
                              onClick={(e) => e.stopPropagation()}
                              className="focusable shrink-0 rounded text-[12px] font-semibold text-brass-deep hover:underline"
                              title="A reply is waiting in Drafts"
                            >
                              ✎ drafted
                            </Link>
                          )}
                        </div>
                      </td>
                      {showProject && (
                        <td className="px-3 py-2.5">
                          {m.project ? <ProjectName name={m.project} className="max-w-full text-[13px] text-ink-soft" /> : <span className="text-[13px] text-ink-faint">—</span>}
                        </td>
                      )}
                      {showVendor && (
                        <td className="px-3 py-2.5">
                          <span className="block truncate text-[13px] text-ink-soft">{m.vendor || '—'}</span>
                        </td>
                      )}
                      <td className="px-5 py-2.5 text-right text-[12px] text-ink-faint" title={exactWhen(m.receivedAt)}>
                        {m.when}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={isLinked ? 'bg-brass/5' : 'bg-sunk/20'}>
                        <td colSpan={cols} className="px-5 py-4">
                          <p className="text-[13px] leading-relaxed text-ink-soft">
                            {m.summary || m.snippet || 'No preview available.'}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {m.gmailId ? (
                              <a
                                href={gmailMessageUrl(m.gmailId, gmailAccount)}
                                {...gmailLinkProps()}
                                onClick={(e) => e.stopPropagation()}
                                className="focusable text-[12.5px] font-semibold text-brass-deep hover:underline"
                              >
                                Open in Gmail →
                              </a>
                            ) : (
                              <span className="text-[12px] text-ink-faint">No Gmail message on file for this row.</span>
                            )}
                            {isLinked && (
                              <button
                                onClick={(e) => { e.stopPropagation(); closeOpened(); }}
                                className="text-[12px] text-ink-faint hover:text-ink-soft hover:underline"
                              >
                                Clear from link
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <TablePager table={pager} noun="message" />
      </Card>
    </Page>
  );
}

const docTypeLabel: Record<string, string> = {
  quote: 'Quote',
  order_confirmation: 'Order confirmation',
  purchase_order: 'Purchase order',
  other: 'Other',
};

function sharedWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit',
  });
}

function SharedBy({ source }: { source: DocSource | null }) {
  if (!source) return <span className="text-ink-faint">—</span>;
  if (source.kind === 'drive') {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-olive/10 text-olive" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M8.5 3h7l6 10.5-3.5 6.5h-12L2.5 13.5 8.5 3Z" /><path d="M8.5 3l6 10.5M2.5 13.5h12" /></svg>
        </span>
        <span className="leading-tight">
          <span className="block text-[13.5px] font-medium text-ink">Google Drive</span>
          <span className="block text-[11.5px] text-ink-faint">picked up from the shared folder</span>
        </span>
      </span>
    );
  }
  const initial = (source.fromName || source.fromEmail || '?').slice(0, 1).toUpperCase();
  const showEmail = source.fromEmail && source.fromEmail !== source.fromName;
  return (
    <span className="inline-flex max-w-[260px] items-center gap-2" title={source.subject ? `Email: ${source.subject}` : undefined}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brass/10 text-[12px] font-bold text-brass-deep" aria-hidden="true">
        {initial}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[13.5px] font-medium text-ink">{source.fromName || source.fromEmail || 'Unknown sender'}</span>
        {showEmail && <span className="block truncate text-[11.5px] text-ink-faint">{source.fromEmail}</span>}
        {!showEmail && source.subject && <span className="block truncate text-[11.5px] text-ink-faint">{source.subject}</span>}
      </span>
    </span>
  );
}

export function Documents() {
  const { data: docs, isLoading } = useDocuments();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');

  // Only the types actually parsed, so the filter never offers a dead option.
  const types = useMemo(
    () => [...new Set(docs.map((d) => d.type))].sort((a, b) =>
      (docTypeLabel[a] ?? a).localeCompare(docTypeLabel[b] ?? b)),
    [docs],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (type !== 'all' && d.type !== type) return false;
      return matches(
        q, d.vendor, d.project, docTypeLabel[d.type] ?? d.type,
        d.source?.fromName, d.source?.fromEmail, d.source?.subject,
      );
    });
  }, [docs, query, type]);

  // Same rule as the Inbox: a column nothing fills is left out rather than
  // drawn as a stack of em dashes. Measured over every document, not the
  // filtered set, so columns do not appear and vanish as you type.
  const showVendor = docs.some((d) => d.vendor !== '');
  const showProject = docs.some((d) => d.project !== '');
  // Type, Shared by, Received, Total, Confidence and File always render.
  const cols = 6 + Number(showVendor) + Number(showProject);

  const pager = useTable(shown, {
    storageKey: 'documents',
    defaultSort: { key: 'received', dir: 'desc' },
    sorters: {
      type: (d) => docTypeLabel[d.type] ?? d.type,
      vendor: (d) => d.vendor,
      project: (d) => d.project,
      sharedBy: (d) => d.source?.fromName || d.source?.fromEmail || '',
      // When it was shared where that is known, else when it was parsed — the
      // same date the column shows first.
      received: (d) => (d.source?.kind === 'gmail' && d.source.sharedAt) || d.createdAt,
      total: (d) => d.total,
      confidence: (d) => d.confidence,
    },
  });
  const filtering = Boolean(query.trim()) || type !== 'all';
  const clearFilters = () => {
    setQuery('');
    setType('all');
  };

  return (
    <Page>
      <PageHeading
        title="Document Intelligence"
      />
      {error && (
        <div className="mb-4 rounded-lg bg-crit/10 px-4 py-2.5 text-[13px] text-crit">{error}</div>
      )}
      <Card>
        <TableToolbar
          search={<SearchInput value={query} onChange={setQuery} placeholder="Search vendor, project or sender" label="Search documents" />}
          filters={
            <FilterSelect
              label="Filter by document type"
              value={type}
              onChange={setType}
              options={[{ value: 'all', label: 'All types' }, ...types.map((t) => ({ value: t, label: docTypeLabel[t] ?? t }))]}
            />
          }
          shown={shown.length}
          total={docs.length}
          noun="document"
          onClear={filtering ? clearFilters : null}
        />

        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <SortTh table={pager} col="type" className="px-5 py-3 font-semibold">Type</SortTh>
                {showVendor && <SortTh table={pager} col="vendor" className="px-5 py-3 font-semibold">Vendor</SortTh>}
                {showProject && <SortTh table={pager} col="project" className="px-5 py-3 font-semibold">Project</SortTh>}
                <SortTh table={pager} col="sharedBy" className="px-5 py-3 font-semibold">Shared by</SortTh>
                <SortTh table={pager} col="received" className="px-5 py-3 font-semibold">Received</SortTh>
                <SortTh table={pager} col="total" align="right" className="px-5 py-3 font-semibold">Total</SortTh>
                <SortTh table={pager} col="confidence" align="right" className="px-5 py-3 font-semibold">Confidence</SortTh>
                <th className="px-5 py-3 text-right font-semibold">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
              )}
              {!isLoading && docs.length === 0 && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">No documents parsed yet.</td></tr>
              )}
              {!isLoading && docs.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No documents match these filters.
                  </td>
                </tr>
              )}
              {pager.rows.map((d) => (
                <tr key={d.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                  <td className="px-5 py-3"><Pill tone="brass">{docTypeLabel[d.type] ?? d.type}</Pill></td>
                  {showVendor && (
                    <td className="px-5 py-3 font-medium text-ink">
                      {d.vendor ? (
                        <span className="flex min-w-0 items-center gap-2"><Avatar name={d.vendor} size={22} /><span className="truncate">{d.vendor}</span></span>
                      ) : '—'}
                    </td>
                  )}
                  {showProject && <td className="px-5 py-3">{d.project ? <ProjectName name={d.project} /> : '—'}</td>}
                  <td className="px-5 py-3"><SharedBy source={d.source} /></td>
                  <td className="px-5 py-3 whitespace-nowrap" title={exactWhen(d.createdAt)}>
                    {d.source?.kind === 'gmail' ? (
                      <span className="leading-tight">
                        <span className="block text-[13px] text-ink">{sharedWhen(d.source.sharedAt)}</span>
                        <span className="block text-[11.5px] text-ink-faint">via email · parsed {d.when}</span>
                      </span>
                    ) : (
                      <span className="leading-tight">
                        <span className="block text-[13px] text-ink">{d.when === 'today' ? 'Today' : d.when}</span>
                        <span className="block text-[11.5px] text-ink-faint">parsed</span>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-ink">{money(d.total)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{Math.round(d.confidence * 100)}%</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => { setError(null); openDocument(d.id, setError); }}
                      className="btn-secondary btn-sm text-brass-deep"
                    >
                      View PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePager table={pager} noun="document" />
      </Card>
    </Page>
  );
}
