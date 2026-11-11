-- ============================================================
--  0040 · Reminder v2 fields (fast track, Step 0b)
--
--  Additive only. Nothing here changes an existing row or the
--  task_status enum, so v1 keeps working exactly as before.
--  Safe to re-run: every statement is "if not exists".
--
--  Plain text instead of enums for the new tasks fields, to keep
--  the first cut fast (approved in docs/V2_FASTTRACK_C_D.md).
--  Spec: janelle-reminders-v2-spec.md §3.
-- ============================================================

-- ---------- notifications_log --------------------------------
-- Every reminder v2 tries to send gets one row, written BEFORE the
-- send (services/notifier.ts). The unique idempotency_key is what
-- stops a job that runs twice from emailing twice.
create table if not exists notifications_log (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  -- History outlives the account or the task: set null, never cascade.
  user_id         uuid references profiles(id) on delete set null,
  task_id         uuid references tasks(id) on delete set null,
  -- digest | instant | escalation_owner | escalation_manager | weekly_pulse | followup_draft
  type            text not null,
  -- sent | dry_run | skipped | failed
  status          text not null,
  idempotency_key text not null unique,
  payload         jsonb,
  error           text,
  sent_at         timestamptz not null default now()
);

create index if not exists idx_notifications_log_user
  on notifications_log(org_id, user_id, sent_at desc);
create index if not exists idx_notifications_log_task
  on notifications_log(task_id) where task_id is not null;

-- Only the API's service key reads or writes it: RLS on, no policies.
alter table notifications_log enable row level security;

-- ---------- profiles -----------------------------------------
alter table profiles add column if not exists timezone   text not null default 'America/Los_Angeles';
alter table profiles add column if not exists manager_id uuid references profiles(id) on delete set null;
alter table profiles add column if not exists is_active  boolean not null default true;

-- ---------- tasks --------------------------------------------
alter table tasks add column if not exists priority          text;          -- P1 | P2 | P3 (set by the priority job)
alter table tasks add column if not exists task_type         text;          -- client | vendor | internal
-- Gmail thread IDs are per mailbox, so the thread is always paired
-- with the mailbox it came from (emails.owner_id).
-- Deliberately NOT a foreign key (see 0043): a second tasks→profiles FK makes
-- every PostgREST embed `profiles(...)` on tasks ambiguous, like completed_by in 0032.
alter table tasks add column if not exists source_mailbox_id uuid;
alter table tasks add column if not exists source_ref        text;          -- Gmail thread ID or Houzz ID
alter table tasks add column if not exists waiting_on        text;
alter table tasks add column if not exists waiting_since     timestamptz;
alter table tasks add column if not exists snooze_until      timestamptz;
alter table tasks add column if not exists escalation_level  integer not null default 0;
alter table tasks add column if not exists due_at            timestamptz;
alter table tasks add column if not exists last_activity_at  timestamptz;
alter table tasks add column if not exists closed_at         timestamptz;
-- user | auto_reply_sent | auto_houzz_status | auto_vendor_confirmed |
-- backlog_cleanup | cancelled | duplicate | legacy | deleted (soft delete, 0042)
alter table tasks add column if not exists closed_reason     text;
