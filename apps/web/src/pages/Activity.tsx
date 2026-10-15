import { useMemo, useState } from 'react';
import { Page, PageHeading, Card } from '../components/ui';
import { useActivity, useTeam, type ActivityView, type ActivityFilters } from '../lib/queries';

/**
 * How each recorded action reads on the page. The stored value is a terse
 * key ("projects.merged"); this is what a person should see instead.
 */
const ACTION_LABEL: Record<string, string> = {
  'ingest.run': 'Read Gmail & Drive',
  'followups.run': 'Ran the follow-up engine',
  'followups.resolved': 'Cleared resolved follow-ups',
  'report.generate': 'Generated the weekly report',
  'digest.run': 'Sent the digest',
  'promote.run': 'Filed email to projects',
  'projects.merged': 'Merged a project',
  'projects.vendor_rows_removed': 'Removed vendor rows',
  'projects.houzz_import': 'Imported from Houzz',
  'draft.create': 'Created a draft',
  'draft.edit': 'Edited a draft',
  'task.create': 'Created a task',
  'task.complete': 'Completed a task',
  'task.reopen': 'Reopened a task',
  'task.auto_complete': 'Auto-closed a task',
  'task.delete': 'Deleted a task',
  'task.comment': 'Commented on a task',
  'task.checkin': 'Checked in on a task',
  'tasks.deduped': 'Merged duplicate tasks',
  'tasks.advanced': 'Moved tasks to in progress',
  'tasks.reviewed': 'Reviewed open tasks',
  'tasks.subtasks_removed': 'Removed subtasks',
  'assistant.task_create': 'Jenny created a task',
  'assistant.task_update': 'Jenny updated a task',
  'assistant.draft_create': 'Jenny created a draft',
  'vendor.add': 'Added a vendor',
  'permission.grant': 'Granted a permission',
  'permission.revoke': 'Revoked a permission',
  'team.role_change': 'Changed a role',
  'team.edit': 'Edited a teammate',
  'team.invite': 'Invited a teammate',
  'team.add': 'Added a teammate',
  'team.remove': 'Removed a teammate',
  'team.reinvite': 'Re-sent an invite',
  'team.password_reset': 'Reset a password',
  'team.disable': 'Disabled an account',
  'team.enable': 'Re-enabled an account',
  'auth.impersonate': 'Viewed as a teammate',
  'auth.bootstrap': 'Set up the workspace',
  'google.connect': 'Connected Google',
  'google.disconnect': 'Disconnected Google',
  'google.disconnect_service': 'Disconnected a Google service',
  'usage.link_rotate': 'Changed the usage link',
  'usage.link_revoke': 'Turned off the usage link',
  'settings.clarity_set': 'Session recording',
  'settings.picture_engine_set': 'Changed the image engine',
};

function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  // A settings.* we have not named yet still reads better than the raw key.
  if (action.startsWith('settings.')) return 'Changed a setting';
  if (action.startsWith('slack')) return 'Slack';
  return action.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const prettyKey = (k: string) => k.replace(/_/g, ' ');

/** A count phrased for people: "1 email", "3 emails". */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Turn a row's raw `meta` into one readable line, phrased per action. The old
 * page dumped every key ("done: true, tasks: 0, emails: 0, …"); this says only
 * what happened, and only when it is worth saying.
 */
function detailOf(row: ActivityView): string {
  const m = row.meta ?? {};
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : '');
  const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : 0);

  switch (row.action) {
    case 'ingest.run': {
      const bits: string[] = [];
      if (num('emails')) bits.push(count(num('emails'), 'new email'));
      if (num('tasks')) bits.push(count(num('tasks'), 'task'));
      if (num('documents')) bits.push(count(num('documents'), 'document'));
      if (num('mergedProjects')) bits.push(`${count(num('mergedProjects'), 'project')} merged`);
      if (num('mergedTasks')) bits.push(`${count(num('mergedTasks'), 'duplicate')} merged`);
      if (num('replies')) bits.push(count(num('replies'), 'reply', 'replies'));
      if (num('remaining')) bits.push(`${num('remaining')} left to read`);
      return bits.length ? bits.join(' · ') : 'Nothing new';
    }
    case 'projects.merged': {
      const kept = str('kept');
      const removed = str('removed');
      const moved = num('moved');
      if (!kept && !removed) return '';
      const base = removed && kept ? `Merged “${removed}” into “${kept}”` : kept ? `Kept “${kept}”` : '';
      return moved ? `${base} · ${count(moved, 'task')} moved` : base;
    }
    case 'settings.clarity_set':
      return m.enabled === true ? 'Turned recording on' : 'Turned recording off';
    case 'tasks.deduped':
      return count(num('removed'), 'duplicate') + ' removed';
    case 'tasks.advanced':
      return `${count(num('count'), 'task')} moved to in progress`;
    case 'tasks.reviewed':
      return `${count(num('reviewed'), 'task')} reviewed, ${num('closed')} closed`;
    case 'task.create':
    case 'task.complete':
    case 'task.reopen':
    case 'task.delete':
    case 'task.comment':
    case 'task.checkin':
    case 'task.auto_complete':
    case 'assistant.task_create':
    case 'assistant.task_update':
      return str('title');
    case 'team.role_change':
      return [str('name'), str('role')].filter(Boolean).join(' → ');
    case 'team.add':
    case 'team.invite':
    case 'team.remove':
    case 'team.disable':
    case 'team.enable':
      return str('name') || str('email');
    case 'permission.grant':
    case 'permission.revoke':
      return [str('role'), str('resource'), str('action')].filter(Boolean).join(' · ');
    default: {
      // A readable fallback: drop the noise (zeros, falses, blanks) and phrase
      // what is left, rather than dumping the whole object.
      const parts = Object.entries(m)
        .filter(([, v]) => v !== null && v !== false && v !== 0 && v !== '' && typeof v !== 'object')
        .map(([k, v]) => `${prettyKey(k)}: ${v}`);
      return parts.join(' · ');
    }
  }
}

function initials(name: string | null): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** A time for today, a date before that; always the full stamp on hover. */
function timeParts(iso: string): { label: string; full: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: '—', full: '' };
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return { label: sameDay ? time : `${date}, ${time}`, full: d.toLocaleString() };
}

type Scope = NonNullable<ActivityFilters['scope']>;
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'people', label: 'People' },
  { id: 'system', label: 'System' },
];

function Who({ name, system }: { name: string | null; system: boolean }) {
  return (
    <div className="flex w-36 shrink-0 items-center gap-2">
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
          system ? 'bg-sunk text-ink-faint' : 'bg-brass/15 text-brass'
        }`}
        aria-hidden
      >
        {system ? '⚙' : initials(name) || '—'}
      </span>
      <span className="truncate text-[12.5px] font-medium text-ink-soft">{system ? 'System' : name ?? 'Unknown'}</span>
    </div>
  );
}

export default function Activity() {
  const [scope, setScope] = useState<Scope>('all');
  const [actor, setActor] = useState<string>('');
  const team = useTeam();
  const { data: rows, isLoading } = useActivity(actor ? { actor } : { scope });

  // Only people who could appear in the trail are worth offering.
  const people = useMemo(
    () => team.data.filter((m) => m.full_name || m.email).sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')),
    [team.data],
  );

  return (
    <Page>
      <PageHeading eyebrow="Trust · Transparency" title="Audit Log" />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg bg-sunk p-1">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setScope(s.id);
                setActor('');
              }}
              className={`focusable rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                !actor && scope === s.id ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <select
          className="input h-9 w-56"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label="Filter by person"
        >
          <option value="">Anyone</option>
          {people.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name ?? m.email}
            </option>
          ))}
        </select>

        {actor && (
          <button className="btn-ghost btn-sm" onClick={() => setActor('')}>
            Clear
          </button>
        )}
      </div>

      <Card>
        <ol className="divide-y divide-line-soft">
          {isLoading && <li className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</li>}
          {!isLoading && rows.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
              {actor ? 'No activity recorded for this person.' : 'No activity recorded yet.'}
            </li>
          )}
          {rows.map((r) => {
            const system = !r.actorId;
            const detail = detailOf(r);
            const t = timeParts(r.at);
            return (
              <li key={r.id} className="flex items-center gap-4 px-5 py-3">
                <Who name={r.actorName} system={system} />
                <div className="min-w-0 flex-1">
                  <span className="text-[13.5px] font-medium text-ink">{actionLabel(r.action)}</span>
                  {detail && <span className="ml-2 text-[12.5px] text-ink-soft">{detail}</span>}
                </div>
                <span className="whitespace-nowrap text-[11px] text-ink-faint" title={t.full}>
                  {t.label}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>
    </Page>
  );
}
