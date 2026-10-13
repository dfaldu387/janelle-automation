# Deploying to Vercel

One Vercel project serves both halves of the app:

| Path | Served by |
| --- | --- |
| `/`, `/projects`, `/drafts`, … | the built React app in `apps/web/dist` |
| `/api/*` | the Express API, as a single serverless function |

Because both live on one domain, the browser makes same-origin requests and
there is no CORS to configure.

## How it is wired

- **`vercel.json`** sets the build command, points the static output at
  `apps/web/dist`, rewrites unknown paths to `index.html` for the React
  router, and registers the cron jobs.
- **`api/[...path].mjs`** is the serverless function. Vercel scans the
  top-level `api/` directory, and the catch-all filename means every
  `/api/*` request reaches it with the original path intact.
- **`apps/api/src/app.ts`** holds the Express app with no server attached.
  `apps/api/src/index.ts` adds `listen()` and the node-cron scheduler for
  local and self-hosted runs; the serverless function imports the app only.

## Environment variables

Set these in **Project → Settings → Environment Variables** (Production and
Preview). Names match `.env.example`.

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | |
| `SUPABASE_ANON_KEY` | |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never expose to the browser. |
| `GOOGLE_CLIENT_ID` | |
| `GOOGLE_CLIENT_SECRET` | |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-DOMAIN/api/auth/google/callback` |
| `GOOGLE_SCOPES` | Same value as local |
| `ANTHROPIC_API_KEY` | |
| `ANTHROPIC_MODEL` | `claude-opus-5` |
| `TOKEN_ENCRYPTION_KEY` | Must be the **same** key used locally, or stored Google tokens cannot be decrypted |
| `CRON_SECRET` | `openssl rand -hex 32`. Cron endpoints refuse everything while unset |
| `CORS_ORIGINS` | `https://YOUR-DOMAIN` |
| `VITE_SUPABASE_URL` | Build-time, public |
| `VITE_SUPABASE_ANON_KEY` | Build-time, public |
| `VITE_API_BASE_URL` | **Leave unset.** The app then calls `/api/*` on its own origin |

`SUPABASE_DB_URL` is only needed for `npm run db:apply:seed`, which is run
from a developer machine, not from Vercel.

## After the first deploy

1. Add the deployed callback URL to the Google Cloud OAuth client's
   **Authorized redirect URIs**: `https://YOUR-DOMAIN/api/auth/google/callback`.
2. Add `https://YOUR-DOMAIN` to Supabase → Authentication → URL Configuration
   (Site URL and Redirect URLs), so email and Google sign-in return correctly.
3. Sign in, then reconnect Gmail and Drive from Settings. Tokens are stored
   per user and per redirect URI.
4. Check `https://YOUR-DOMAIN/api/health` — it reports which integrations the
   server can see.

## Scheduled work

**The app is now self-hosted at https://janelle.dev-build.in** (see
`deploy/README.md`): `services/scheduler.ts` (node-cron) runs every scheduled
job in the API process, and migration 0031 switches the Supabase pg_cron jobs
off. Vercel Cron is not used (`vercel.json` has no `crons`).

If the app ever goes back to Vercel, a serverless function cannot hold
node-cron timers: re-run 0021, 0022, 0024, 0027 and 0028 so Supabase pg_cron
calls the `/api/ops/cron/*` endpoints again, authenticated with `CRON_SECRET`.

> **Never register a cron more often than once a day on Hobby.** Vercel rejects
> the whole deployment, after a build that passed, with only "Deployment
> failed" on the PR. That is what happened to PR #11: the video sweep went in
> at `*/5 * * * *`. Anything that needs to run more often goes through an
> external scheduler, as below.

**On the Hobby plan Vercel runs each cron job at most once a day**, so
everything more frequent is scheduled by **Supabase** instead: `pg_cron`
fires the job and `pg_net` calls the endpoint with the bearer secret. Nothing
is set in Vercel's cron settings or GitHub for these.

Setup, once, in the Supabase SQL editor: store the address and secret in
Vault (`app_url`, and `cron_secret` — the same value as `CRON_SECRET` on
Vercel; 0021's header has the two lines), then run 0021, 0022, 0024, 0027 and 0028.
Recent runs are in `cron.job_run_details`, and each call's HTTP status in
`net._http_response`. A 401 there means the Vault secret and Vercel's differ.

**`/api/ops/cron/ingest`** is called only when a studio is due, and reads each studio only
as often as it chose in Settings → Reading email (the last start is kept in
`settings.ingest_ran_at`), and never a studio set to "Only when I ask". Most
calls therefore do nothing. Add `?force=1` to read every studio at once.

**`/api/ops/cron/media`** finishes video clips whose tab was closed while they
rendered. Without it, a clip nobody is watching when it finishes is written
off after ten minutes.

**`/api/ops/cron/tasks`** closes the tasks that the mail since they were
raised shows are finished. It is called every five minutes but reviews each
studio only as often as the admin chose in Settings → Reading email → "Close
finished tasks" (default hourly; Off skips it; last start in
`settings.task_review_ran_at`). Only a task with mail it has not been checked
against costs a Claude call. `?force=1` reviews every studio now.

**`/api/ops/cron/midday-reminder`** emails the studio's daily task
reminders, twice a day. At 9am Pacific each teammate gets their **top
priorities** — their open work due today or earlier, most overdue first,
cut at five with a count of the rest, plus anything of theirs that is
blocked. At 5pm each gets an **end-of-day check-in**: what they finished,
what is still open and rolls to tomorrow, what is blocked, what is due
tomorrow, and a question asking what is in the way. The owner gets a compact
copy of each: one card per person with their counts and top three, never the
full lists (caps in `PERSONAL_CAPS` / `OWNER_CAPS`,
`services/middayReminder.ts`). With Slack connected and "Message each person
directly" on in Settings, the same plans also go out as Slack DMs (owner
included; `services/slackReminder.ts`; needs the `users:read.email` and
`im:write` scopes on the bot). **Answers** to the check-in are read three
ways and all land the same place (`services/checkin.ts`): a reply to the
check-in email (the ingest recognises the subject and writes "done" /
"blocked" / "tomorrow" onto the tasks the reply names, no model call, and
never raises a task from it); the check-in in Jenny (`/assistant?checkin=1`,
offered after 4pm local — a Done / Blocked / Tomorrow button per task,
`GET`/`POST /api/assistant/checkin`); or marking the task Blocked on the
board. A blocker's reason is kept as a `Blocked: …` comment on the task and
shown under it in the next morning's plan; a reply that names no task is
shown whole under the person's name. Polled every
15 minutes, but only sends in the 9am and 5pm Pacific hours, and at most
once per studio per slot (last start in `settings.midday_reminder_ran_at`)
— the wall-clock-hour gate keeps the times through the PST/PDT change
without editing the schedule. Real sends, not drafts (see `sendMessage` in
`services/gmail.ts`). `?force=1` sends now regardless of the hour or the
last send; `?slot=morning|evening` picks which email.

**The Supabase schedules are only the fastest pace.** How often each job
really runs for a studio is the admin's setting, read on every call, so a
change in Settings takes effect on the next call with no SQL and no deploy.

Self-hosted, the node-cron scheduler runs all four and the Supabase jobs
should be unscheduled (`select cron.unschedule('email-ingest')` and so on),
or both will do the work.

A single function invocation is capped at 60 seconds (`maxDuration` in
`vercel.json`), so a very large first ingestion may need several runs. Each
run is guarded against overlapping with another, and skips work it has
already done.

## Testing the function locally

`npm run dev` still runs the normal two-process setup. To exercise the
serverless entry exactly as Vercel will:

```bash
npm run build
npx vercel dev
```
