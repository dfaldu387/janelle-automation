import { Page, PageHeading, Card, Pill, shortDate } from '../components/ui';
import { useDailyReport, type DailyItem, type DailyPerson } from '../lib/queries';

/** A readable day: "Monday, Oct 27". */
function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A clock time for "last active", in the reader's own zone. */
function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** One task line — title, where it belongs, when it's due, and a jump to its email. */
function ItemRow({ item, showAssignee = false }: { item: DailyItem; showAssignee?: boolean }) {
  const meta = [
    showAssignee ? item.assignee : null,
    item.project, // the Houzz-searchable reference
  ].filter(Boolean);
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-faint">
          {meta.map((m, i) => (
            <span key={i}>{i > 0 ? `· ${m}` : m}</span>
          ))}
          {item.due && (
            <span className={item.overdue ? 'text-crit' : ''}>
              · {item.overdue ? 'was due' : 'due'} {shortDate(item.due)}
            </span>
          )}
        </div>
      </div>
      {item.emailUrl && (
        <a
          href={item.emailUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-[11.5px] font-medium text-brass hover:underline"
          title="Open the email thread in Gmail"
        >
          Open email ↗
        </a>
      )}
    </li>
  );
}

function PersonCard({ p }: { p: DailyPerson }) {
  const active =
    p.activity.connected && p.activity.emailsSent !== null
      ? `${p.activity.emailsSent} email${p.activity.emailsSent === 1 ? '' : 's'} sent${p.activity.lastSentAt ? `, last ${clock(p.activity.lastSentAt)}` : ''}`
      : p.activity.connected
        ? 'activity unavailable'
        : 'mailbox not connected';

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-5 py-3">
        <h3 className="text-[14px] font-semibold text-ink">{p.name}</h3>
        <div className="flex items-center gap-2 text-[11.5px]">
          <Pill tone="good">{p.completedToday.length} done today</Pill>
          <Pill tone={p.pending.length ? 'warn' : 'neutral'}>{p.pending.length} pending</Pill>
          <span className="text-ink-faint" title="Emails sent — an activity signal, not hours">{active}</span>
        </div>
      </div>

      {p.completedToday.length > 0 && (
        <>
          <div className="bg-sunk/40 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Completed today</div>
          <ul className="divide-y divide-line-soft">
            {p.completedToday.map((i) => (
              <ItemRow key={i.id} item={i} />
            ))}
          </ul>
        </>
      )}

      <div className="bg-sunk/40 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Still pending</div>
      {p.pending.length === 0 ? (
        <div className="px-5 py-3 text-[12.5px] text-ink-faint">Nothing open.</div>
      ) : (
        <ul className="divide-y divide-line-soft">
          {p.pending.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </Card>
  );
}

const FOLLOW_UP_TYPE: Record<string, string> = {
  vendor_silence: 'Vendor quiet',
  client_approval_overdue: 'Client approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
};

export default function DailyReport() {
  const { data, isLoading, isError, isFetching } = useDailyReport();

  const fires = data?.fires;
  const fireCount = (fires?.blocked.length ?? 0) + (fires?.overdue.length ?? 0) + (fires?.followUps.length ?? 0);

  return (
    <Page>
      <PageHeading
        eyebrow="Every day"
        title="Daily Report"
        sub={data ? `${longDate(data.date)}${isFetching ? ' · refreshing…' : ''}` : undefined}
      />

      {isLoading && <Card><div className="px-5 py-10 text-center text-[13px] text-ink-faint">Pulling today together…</div></Card>}
      {isError && <Card><div className="px-5 py-10 text-center text-[13px] text-crit">Could not load the report.</div></Card>}

      {data && (
        <div className="space-y-6">
          {/* 1. Fires and blockers first. */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
              <h2 className="text-[15px] font-semibold text-ink">🔥 Fires &amp; blockers</h2>
              <span className="text-[12px] text-ink-faint">{fireCount === 0 ? 'All clear' : `${fireCount} need attention`}</span>
            </div>

            {fireCount === 0 && <div className="px-5 py-6 text-center text-[13px] text-ink-faint">Nothing blocked, overdue or waiting. Rare — enjoy it.</div>}

            {fires && fires.blocked.length > 0 && (
              <>
                <div className="bg-crit/5 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-crit">Blocked</div>
                <ul className="divide-y divide-line-soft">
                  {fires.blocked.map((i) => <ItemRow key={i.id} item={i} showAssignee />)}
                </ul>
              </>
            )}

            {fires && fires.overdue.length > 0 && (
              <>
                <div className="bg-crit/5 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-crit">Overdue</div>
                <ul className="divide-y divide-line-soft">
                  {fires.overdue.map((i) => <ItemRow key={i.id} item={i} showAssignee />)}
                </ul>
              </>
            )}

            {fires && fires.followUps.length > 0 && (
              <>
                <div className="bg-warn/5 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-warn">Follow-ups waiting</div>
                <ul className="divide-y divide-line-soft">
                  {fires.followUps.map((f, idx) => (
                    <li key={idx} className="flex items-start gap-3 px-5 py-2.5 text-[13px]">
                      <span className="font-medium text-ink">{FOLLOW_UP_TYPE[f.type] ?? 'Follow-up'}</span>
                      <span className="text-[11.5px] text-ink-faint">
                        {[f.vendor, f.project].filter(Boolean).join(' · ')}
                        {f.reason ? ` — ${f.reason}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          {/* 2. Then the run-down, per person. */}
          <div>
            <h2 className="mb-3 text-[15px] font-semibold text-ink">By team member</h2>
            {data.people.length === 0 ? (
              <Card><div className="px-5 py-6 text-center text-[13px] text-ink-faint">No one has open or completed work today.</div></Card>
            ) : (
              <div className="space-y-4">
                {data.people.map((p) => <PersonCard key={p.id} p={p} />)}
              </div>
            )}
          </div>

          {data.unassignedPending.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-b border-line-soft px-5 py-3">
                <h2 className="text-[15px] font-semibold text-ink">Unassigned</h2>
                <p className="text-[12px] text-ink-faint">Open work with nobody on it.</p>
              </div>
              <ul className="divide-y divide-line-soft">
                {data.unassignedPending.map((i) => <ItemRow key={i.id} item={i} />)}
              </ul>
            </Card>
          )}

          {data.notes.length > 0 && (
            <ul className="px-1 text-[12px] leading-relaxed text-ink-faint">
              {data.notes.map((n, i) => (
                <li key={i} className="before:mr-1.5 before:content-['•']">{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Page>
  );
}
