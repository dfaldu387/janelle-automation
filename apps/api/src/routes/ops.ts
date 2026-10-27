import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { backfillEmailBodies, refileFromAttachments, runIngest } from '../services/ingest.js';
import { autoMergeDuplicates, promoteAll, removeVendorProjects } from '../services/promote.js';
import { importHouzzProjects, importHouzzTasks } from '../services/houzz.js';
import { draftConnectInvites } from '../services/onboarding.js';
import { buildTeamActivity, runTeamActivityDigest } from '../services/teamActivity.js';
import { reviewTaskHygiene, closeStaleTasks } from '../services/taskCleanup.js';
import { buildDailyReport } from '../services/dailyReport.js';
import { runFollowUps, resolveFollowUps } from '../services/followups.js';
import { runReport } from '../services/report.js';
import { runDigest } from '../services/digest.js';
import { advanceActiveTasks, backfillTasks, mergeDuplicateTasks, reviewOpenTasks } from '../services/tasks.js';
import { fileDocumentsToDrive } from '../services/driveFiling.js';
import { sweepJobs } from '../services/mediaJobs.js';
import { keepGoogleAlive } from '../services/googleKeepalive.js';
import { runMiddayReminder, reminderSlotNow, type ReminderSlot } from '../services/middayReminder.js';
import { runSlackSync } from '../services/slackSync.js';
import { runSlackDigest } from '../services/slackDigest.js';
import { runSlackReport } from '../services/slackReport.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { claimCronSlot } from '../lib/cronSlot.js';
import { pacificHourNow, pacificWeekday } from '../lib/pacificTime.js';
import {
  INGEST_RAN_FIELD,
  MIDDAY_REMINDER_COOLDOWN_MS,
  MIDDAY_REMINDER_HOURS,
  MIDDAY_REMINDER_RAN_FIELD,
  SLACK_DIGEST_COOLDOWN_MS,
  SLACK_DIGEST_HOUR,
  SLACK_DIGEST_RAN_FIELD,
  SLACK_REPORT_COOLDOWN_MS,
  SLACK_REPORT_HOURS,
  SLACK_REPORT_RAN_FIELD,
  TASK_REVIEW_RAN_FIELD,
  TEAM_ACTIVITY_COOLDOWN_MS,
  TEAM_ACTIVITY_HOUR,
  TEAM_ACTIVITY_RAN_FIELD,
  TEAM_ACTIVITY_WEEKDAY,
} from '../lib/cronJobs.js';

export const opsRouter = Router();

// ── Scheduled jobs ──────────────────────────────────────────
// The self-hosted server runs these jobs itself with node-cron
// (services/scheduler.ts). These endpoints remain for running a job by hand
// (`?force=1`) and for an external caller such as Supabase pg_cron.
// They authenticate with CRON_SECRET rather than a user session, so they
// are declared BEFORE `requireAuth` is applied to the rest of the router.

const cronRouter = Router();

/** Callers send `Authorization: Bearer $CRON_SECRET`. Denies when unset. */
cronRouter.use((req, res, next) => {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on the server' });
  }
  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.key ?? '');
  if (given !== secret) return res.status(401).json({ error: 'Not authorised' });
  next();
});

/**
 * How long a whole request may spend working before it must answer.
 *
 * Vercel kills the function at `maxDuration` (vercel.json) and the caller
 * sees a 504 FUNCTION_INVOCATION_TIMEOUT with no result at all. Every job
 * below is resumable, so they stop themselves short of that instead and
 * report what is left.
 *
 * Short rather than nearly-maxDuration: a long-held connection is the one
 * that gets dropped between the browser and the function, and a dropped
 * request carries no status for the caller to act on. The cron path gets
 * more room, since nothing is waiting on its connection.
 */
const JOB_BUDGET_MS = Number(process.env.JOB_BUDGET_MS || 20_000);
const CRON_BUDGET_MS = Number(process.env.CRON_BUDGET_MS || 45_000);

/**
 * Run a job for every organisation, collecting per-org results.
 *
 * The budget is for the request, not for each org, so it is shared out as
 * the loop goes: an org reached with no time left is skipped rather than
 * started and cut off mid-flight.
 */
async function forEachOrg<T>(fn: (orgId: string, budgetMs: number) => Promise<T>) {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', results: [] as unknown[] };
  const deadline = Date.now() + CRON_BUDGET_MS;
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');
  const results: unknown[] = [];
  let skipped = 0;
  for (const org of orgs ?? []) {
    const orgId = (org as { id: string }).id;
    const left = deadline - Date.now();
    if (left <= 0) {
      skipped++;
      continue;
    }
    try {
      results.push({ orgId, result: await fn(orgId, left) });
    } catch (err) {
      results.push({ orgId, error: (err as Error).message });
    }
  }
  return { ok: true, results, skipped };
}

// GET or POST, so a job can be run by hand with curl.
//
// The server's node-cron (services/scheduler.ts) runs this job; the endpoint is for
// running it by hand or from an outside clock. Each studio
// is read only as often as it asked in Settings → Reading email — "Only when
// I ask" is never read here. `?force=1` reads every studio now.
cronRouter.all(
  '/ingest',
  // Reading the mail and acting on what it says are one job: a hosted cron
  // must not leave the board and the follow-up queue behind the inbox.
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id, budgetMs) => {
        if (!force) {
          const { intervalMinutes } = await readIngestSettings(id);
          if (intervalMinutes <= 0) return { ok: true, skipped: 'on_demand_only' };
          if (!(await claimCronSlot(id, INGEST_RAN_FIELD, intervalMinutes * 60_000))) {
            return { ok: true, skipped: 'not_due' };
          }
        }
        const result = await runIngest(id, { budgetMs });
        await resolveFollowUps(id);
        await advanceActiveTasks(id);
        return result;
      }),
    });
  }),
);
// Close the tasks the mail since they were raised shows are done. Called
// by node-cron, or by hand here; each studio is reviewed only as often
// as it chose in Settings → Reading email. `?force=1` reviews every studio now.
cronRouter.all(
  '/tasks',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id, budgetMs) => {
        if (!force) {
          const { taskReviewMinutes } = await readIngestSettings(id);
          if (taskReviewMinutes <= 0) return { ok: true, skipped: 'off' };
          if (!(await claimCronSlot(id, TASK_REVIEW_RAN_FIELD, taskReviewMinutes * 60_000))) {
            return { ok: true, skipped: 'not_due' };
          }
        }
        const reviewed = await reviewOpenTasks(id, { budgetMs });
        // A task this pass just closed takes its follow-ups with it, now rather
        // than at the next mailbox read.
        await resolveFollowUps(id).catch((err) => console.error('[tasks] follow-up clean-up failed:', (err as Error).message));
        return reviewed;
      }),
    });
  }),
);
// Twice a day, at 9am and 5pm Pacific (migration 0024). Polled at :05 of the
// 9am/5pm Pacific hours; the hour check is the gate, and
// claimCronSlot's cooldown keeps a studio from getting either send twice in
// the same hour without drifting across the PST/PDT change, since the gate
// is the wall-clock hour rather than a fixed UTC cron time. `?force=1` sends
// now regardless of the hour or the last send.
cronRouter.all(
  '/midday-reminder',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id) => {
        if (!force) {
          if (!MIDDAY_REMINDER_HOURS.includes(pacificHourNow())) return { ok: true, skipped: 'not_midday' };
          if (!(await claimCronSlot(id, MIDDAY_REMINDER_RAN_FIELD, MIDDAY_REMINDER_COOLDOWN_MS))) {
            return { ok: true, skipped: 'already_sent' };
          }
        }
        // 9am is the plan for the day, 5pm the wrap-up. `?slot=morning|evening`
        // picks one by hand — for a test, or to send the other one early.
        const asked = String(req.query.slot ?? '');
        const slot: ReminderSlot = asked === 'morning' || asked === 'evening' ? asked : reminderSlotNow();
        return runMiddayReminder(id, slot);
      }),
    });
  }),
);
// Bring Slack up to date with the board (migration 0027). No longer scheduled —
// the task reports below replaced it — but kept for running by hand.
// Does nothing for a studio that has not connected Slack.
cronRouter.all(
  '/slack-sync',
  asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id, budgetMs) => runSlackSync(id, { budgetMs })) })),
);
// The completed / pending / overdue task reports, at 9am, midday and 5pm
// Pacific (node-cron, services/scheduler.ts). The Pacific-hour gate and the claim keep each
// slot to one post. `?force=1` posts now.
cronRouter.all(
  '/slack-report',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id) => {
        if (!force) {
          if (!SLACK_REPORT_HOURS.includes(pacificHourNow())) return { ok: true, skipped: 'not_report_hour' };
          if (!(await claimCronSlot(id, SLACK_REPORT_RAN_FIELD, SLACK_REPORT_COOLDOWN_MS))) {
            return { ok: true, skipped: 'already_sent' };
          }
        }
        return runSlackReport(id);
      }),
    });
  }),
);
// The daily Slack morning briefing (migration 0028). Scheduled again in
// services/scheduler.ts at SLACK_DIGEST_HOUR (8am Pacific) after the founder
// asked to receive it in her morning rather than open the app; this route is
// the pg_cron twin and also runs it by hand. The Pacific-hour gate and the
// claim keep it to one post a day, and the hour is wall-clock so it holds
// across the PST/PDT change. `?force=1` posts now.
cronRouter.all(
  '/slack-digest',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id) => {
        if (!force) {
          if (pacificHourNow() !== SLACK_DIGEST_HOUR) return { ok: true, skipped: 'not_digest_hour' };
          if (!(await claimCronSlot(id, SLACK_DIGEST_RAN_FIELD, SLACK_DIGEST_COOLDOWN_MS))) {
            return { ok: true, skipped: 'already_sent' };
          }
        }
        return runSlackDigest(id);
      }),
    });
  }),
);
// The weekly per-person activity digest to the owner. Scheduled in
// services/scheduler.ts for Monday 7am Pacific; this is the pg_cron twin and
// also runs it by hand. Gated to the one Pacific weekday + hour and claimed so
// it posts once a week, wall-clock so it holds across the PST/PDT change.
// `?force=1` sends now.
cronRouter.all(
  '/team-activity',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id) => {
        if (!force) {
          if (pacificWeekday() !== TEAM_ACTIVITY_WEEKDAY || pacificHourNow() !== TEAM_ACTIVITY_HOUR) {
            return { ok: true, skipped: 'not_digest_time' };
          }
          if (!(await claimCronSlot(id, TEAM_ACTIVITY_RAN_FIELD, TEAM_ACTIVITY_COOLDOWN_MS))) {
            return { ok: true, skipped: 'already_sent' };
          }
        }
        return runTeamActivityDigest(id);
      }),
    });
  }),
);
cronRouter.all('/follow-ups', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runFollowUps(id)) })));
cronRouter.all('/report', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runReport(id)) })));
cronRouter.all('/digest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runDigest(id)) })));
// Video that nobody is watching. A clip finishes a minute or two after the
// request that started it has gone, and the provider's URL for it is
// temporary — without this, a person who asked and then closed the tab
// would have paid for something that was never fetched.
cronRouter.all('/media', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => sweepJobs(id)) })));

// Every connected Google account refreshed, so none lapses from disuse and
// a revoked one shows up on the Team screen. Not per-org: one pass covers all.
cronRouter.all('/google-keepalive', asyncHandler(async (_req, res) => res.json({ data: await keepGoogleAlive() })));

opsRouter.use('/cron', cronRouter);

// ── Signed-in operations ────────────────────────────────────
// Everything below this line gets req.auth. Anything added ABOVE it will
// not, and a role check there fails with "Insufficient permissions" even
// for a principal — the role is simply undefined.
opsRouter.use(requireAuth);

// Raise tasks from email that was ingested before the tasks table existed.
opsRouter.post(
  '/backfill-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    // A person is waiting on this one, so it gets the short budget and
    // reports what is left rather than holding the connection open.
    const result = await backfillTasks(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS });
    // Tasks raised from old mail are often already under way: advance them
    // in the same pass rather than showing a board of stale Open cards.
    const advanced = await advanceActiveTasks(req.auth!.orgId);
    res.json({ data: { ...result, advanced } });
  }),
);

// Draft a "connect your Google" invite for every teammate who is set up but
// has never connected — written into the studio mailbox for review, never sent.
// Ordered most-open-work first (principal / coordinator only).
opsRouter.post(
  '/draft-connect-invites',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await draftConnectInvites(req.auth!.orgId) });
  }),
);

// The weekly per-person activity digest, read on demand. Owner-only: this is
// staff-performance data, so it is gated to the principal, not the coordinator.
// GET returns the week's figures for the Team page; the figures are activity
// signals (mail sent, how task load moved), never a measure of hours.
opsRouter.get(
  '/team-activity',
  requireRole('principal'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const days = Number(req.query.days);
    res.json({ data: await buildTeamActivity(req.auth!.orgId, Number.isFinite(days) && days > 0 ? days : 7) });
  }),
);

// Email that same digest to the owner now, rather than waiting for Monday.
opsRouter.post(
  '/team-activity/send',
  requireRole('principal'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await runTeamActivityDigest(req.auth!.orgId) });
  }),
);

// The daily report in Janelle's layout: fires/blockers first, then each
// teammate's completed-today / still-pending with Gmail links and an activity
// read. Supervisor view (principal / coordinator) — it is a management summary.
opsRouter.get(
  '/daily-report',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await buildDailyReport(req.auth!.orgId) });
  }),
);

// Why the open-task count is what it is, and what a cleanup would clear. Plain
// rules, no AI — tasks whose assignee has left, and tasks untouched for too
// long, which the email-driven auto-closer never reaches (Janelle's "167 open?"
// 2026-10-27). Read on demand for the board's cleanup panel.
opsRouter.get(
  '/task-hygiene',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await reviewTaskHygiene(req.auth!.orgId) });
  }),
);

// Clear the chosen tasks — set to cancelled, kept and reversible, never deleted.
opsRouter.post(
  '/close-stale-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length) return res.status(400).json({ error: 'No task ids were sent' });
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    res.json({ data: await closeStaleTasks(req.auth!.orgId, ids, note) });
  }),
);

// Backfill: promote existing parsed emails + documents into vendors,
// projects and purchase orders (principal / coordinator only).
opsRouter.post(
  '/promote',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await promoteAll(req.auth!.orgId);
    res.json({ data: result });
  }),
);

// Bring the project list over from a Houzz Pro CSV export. Houzz has no
// API for this, so the file is the only route; it stays the source of
// truth and nothing is ever written back to it.
opsRouter.post(
  '/import-houzz',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) return res.status(400).json({ error: 'No CSV content was sent' });
    res.json({ data: await importHouzzProjects(req.auth!.orgId, csv) });
  }),
);

// Bring the "house" task list over from a Houzz Pro CSV export. Same rationale
// as the project import: Houzz has no API, stays the source of truth, and is
// never written back to. Tasks land on the board so the team sees house work
// here instead of only in Houzz (Carissa walkthrough, 2026-10-26).
opsRouter.post(
  '/import-houzz-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) return res.status(400).json({ error: 'No CSV content was sent' });
    res.json({ data: await importHouzzTasks(req.auth!.orgId, csv) });
  }),
);

// File email that has no project using what its attachments already said.
// No Claude calls; runs after every complete reading pass as well.
opsRouter.post(
  '/refile-emails',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await refileFromAttachments(req.auth!.orgId) });
  }),
);

// Fetch the body and links for mail read before they were stored. No
// Claude calls: it only fills in text the system used to throw away.
opsRouter.post(
  '/backfill-email-bodies',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await backfillEmailBodies(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS }) });
  }),
);

// Run the hourly task review now, rather than waiting for the hour.
opsRouter.post(
  '/review-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await reviewOpenTasks(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS }) });
  }),
);

// Remove tasks raised more than once for the same work. Reading email does
// this by itself at the end of a pass; this clears the existing backlog.
opsRouter.post(
  '/dedupe-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await mergeDuplicateTasks(req.auth!.orgId) });
  }),
);

// File email-attachment PDFs into the studio's Drive tree. Ingestion does this
// at the end of a pass; this runs it on demand (and clears any backlog). A
// no-op unless filing is switched on and the studio account has re-consented
// for Drive write.
opsRouter.post(
  '/file-documents',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await fileDocumentsToDrive(req.auth!.orgId) });
  }),
);

// Fold every duplicate project into one. Reading email does this by itself
// at the end of a pass; this clears a backlog that built up before then.
opsRouter.post(
  '/dedupe-projects',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const merged = await autoMergeDuplicates(req.auth!.orgId);
    const vendorRows = await removeVendorProjects(req.auth!.orgId);
    res.json({ data: { ...merged, vendorProjectsRemoved: vendorRows.removed, vendorProjectNames: vendorRows.names } });
  }),
);

// Manually trigger an ingestion pass (principal / coordinator only).
opsRouter.post(
  '/ingest',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    // Returns `done: false` with a partial count when the budget runs out.
    // The dashboard calls again until it comes back done.
    const result = await runIngest(req.auth!.orgId, {
      emailQuery: typeof req.body?.emailQuery === 'string' ? req.body.emailQuery : undefined,
      folderId: typeof req.body?.folderId === 'string' ? req.body.folderId : undefined,
      budgetMs: JOB_BUDGET_MS,
    });
    await resolveFollowUps(req.auth!.orgId);
    const advanced = await advanceActiveTasks(req.auth!.orgId);
    res.json({ data: { ...result, advanced } });
  }),
);
