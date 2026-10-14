import cron from 'node-cron';
import { supabaseAdmin } from '../lib/supabase.js';
import { runFollowUps, resolveFollowUps } from './followups.js';
import { advanceActiveTasks, reviewOpenTasks } from './tasks.js';
import { runReport } from './report.js';
import { runIngest } from './ingest.js';
import { runDigest } from './digest.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { claimCronSlot } from '../lib/cronSlot.js';
import { sweepJobs } from './mediaJobs.js';
import { keepGoogleAlive } from './googleKeepalive.js';
import { runMiddayReminder } from './middayReminder.js';
import { runSlackReport } from './slackReport.js';
import { runSlackSync } from './slackSync.js';
import { pacificHourNow } from '../lib/pacificTime.js';
import {
  INGEST_RAN_FIELD,
  MIDDAY_REMINDER_COOLDOWN_MS,
  MIDDAY_REMINDER_HOURS,
  MIDDAY_REMINDER_RAN_FIELD,
  SLACK_REPORT_COOLDOWN_MS,
  SLACK_REPORT_HOURS,
  SLACK_REPORT_RAN_FIELD,
  TASK_REVIEW_RAN_FIELD,
} from '../lib/cronJobs.js';

async function forEachOrg(fn: (orgId: string) => Promise<unknown>, label: string) {
  if (!supabaseAdmin) return;
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');
  for (const org of orgs ?? []) {
    try {
      await fn((org as { id: string }).id);
    } catch (err) {
      console.error(`[scheduler] ${label} failed for org ${(org as { id: string }).id}:`, (err as Error).message);
    }
  }
}

/**
 * Run `fn` on a cron pattern, skipping a tick while the previous run is
 * still going — a slow Gmail or provider must not stack runs on top of
 * each other. `utc` pins the daily jobs to the same UTC times vercel.json
 * used, whatever the server's own time zone is.
 */
function every(pattern: string, label: string, fn: () => Promise<unknown>, utc = false): void {
  let running = false;
  cron.schedule(
    pattern,
    () => {
      if (running) return;
      running = true;
      void fn()
        .catch((err) => console.error(`[scheduler] ${label} failed:`, (err as Error).message))
        .finally(() => {
          running = false;
        });
    },
    utc ? { timezone: 'Etc/UTC' } : undefined,
  );
}

/**
 * Register the background jobs — the long-running-server twin of the
 * /api/ops/cron/* endpoints, with the same gates and the same claim fields
 * (lib/cronJobs.ts). Because the "last ran" marks live in the database, not
 * in this process, a restart does not reset anyone's interval, and a second
 * clock (a laptop running `npm run dev`, or pg_cron left switched on) is
 * refused by the claim rather than doing the work twice.
 *
 * Ticks are free here, so they run at the fastest pace any setting needs;
 * each studio's own Settings choice decides the rest. No-op until Supabase
 * is configured, and SCHEDULER=off turns it off (e.g. a dev machine).
 */
export function startScheduler(): void {
  if (!supabaseAdmin) {
    console.log('  ▸ Scheduler idle (Supabase not configured)');
    return;
  }
  if ((process.env.SCHEDULER ?? '').toLowerCase() === 'off') {
    console.log('  ▸ Scheduler off (SCHEDULER=off)');
    return;
  }

  // Read the mail of every studio that is due, then act on it in the same
  // pass: a reply that settles a nudge, or a thread that moved since a task
  // was raised, should show without waiting for another job.
  every('* * * * *', 'ingest', () =>
    forEachOrg(async (id) => {
      const { intervalMinutes } = await readIngestSettings(id);
      if (intervalMinutes <= 0) return; // "Only when I ask"
      if (!(await claimCronSlot(id, INGEST_RAN_FIELD, intervalMinutes * 60_000))) return;
      await runIngest(id);
      await resolveFollowUps(id);
      await advanceActiveTasks(id);
    }, 'ingest'),
  );

  // Close the tasks the mail since they were raised shows are done, as often
  // as the studio chose in Settings (default hourly).
  every('*/5 * * * *', 'task review', () =>
    forEachOrg(async (id) => {
      const { taskReviewMinutes } = await readIngestSettings(id);
      if (taskReviewMinutes <= 0) return;
      if (!(await claimCronSlot(id, TASK_REVIEW_RAN_FIELD, taskReviewMinutes * 60_000))) return;
      await reviewOpenTasks(id);
      await resolveFollowUps(id);
    }, 'task review'),
  );

  // Finished video clips nobody is watching, fetched before the provider's
  // temporary link expires.
  every('*/2 * * * *', 'media', () => forEachOrg((id) => sweepJobs(id), 'media'));


  // 9am and 5pm Pacific, read from the wall clock so PST/PDT needs no edit.
  every('*/15 * * * *', 'task reminder', async () => {
    if (!MIDDAY_REMINDER_HOURS.includes(pacificHourNow())) return;
    await forEachOrg(async (id) => {
      if (!(await claimCronSlot(id, MIDDAY_REMINDER_RAN_FIELD, MIDDAY_REMINDER_COOLDOWN_MS))) return;
      await runMiddayReminder(id);
    }, 'task reminder');
  });

  // Per-task sync: post new/changed tasks to their project channel and keep
  // existing messages in step. Runs every 5 minutes; the sync's own cursor
  // and task-level claim handle concurrency safely.
  every('*/5 * * * *', 'slack sync', () =>
    forEachOrg((id) => runSlackSync(id, { budgetMs: 35_000 }), 'slack sync'),
  );

  // The completed / pending / overdue reports to their Slack channels, at
  // 9am, midday and 5pm Pacific.
  every('*/15 * * * *', 'slack report', async () => {
    if (!SLACK_REPORT_HOURS.includes(pacificHourNow())) return;
    await forEachOrg(async (id) => {
      if (!(await claimCronSlot(id, SLACK_REPORT_RAN_FIELD, SLACK_REPORT_COOLDOWN_MS))) return;
      await runSlackReport(id);
    }, 'slack report');
  });

  // The daily and weekly jobs, at the UTC times vercel.json gave them.
  every('0 2 * * *', 'follow-ups', () => forEachOrg((id) => runFollowUps(id), 'follow-ups'), true);
  every('5 7 * * *', 'digest', () => forEachOrg((id) => runDigest(id), 'digest'), true);
  every('0 7 * * 1', 'report', () => forEachOrg((id) => runReport(id), 'report'), true);

  // Every Google connection refreshed, so none sits idle until Google
  // expires it — and a revoked one is found by this, not by a failed read.
  const keepalive = async () => {
    const r = await keepGoogleAlive();
    console.log(
      `[google] keep-alive: ${r.healthy}/${r.checked} healthy, ${r.needReconnect} need reconnect` +
        `${r.reconnectEmails ? ` (${r.reconnectEmails} emailed to reconnect)` : ''}, ${r.transient} retry later`,
    );
  };
  every('15 */6 * * *', 'google keep-alive', keepalive);
  void keepalive().catch((err) => console.error('[google] keep-alive failed:', (err as Error).message));

  console.log(
    '  ▸ Scheduler started (email & task review: per-studio interval · media 2 min · reminders 9am & 5pm Pacific · Slack task reports 9am, 12pm & 5pm Pacific · follow-ups 02:00 UTC · digest 07:05 UTC · report Mon 07:00 UTC · Google keep-alive 6h)',
  );
}
