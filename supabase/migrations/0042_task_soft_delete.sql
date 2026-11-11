-- ============================================================
--  0042 · Soft delete for tasks
--
--  Decision 2026-11-11: the task Delete button must not remove the
--  row (spec §8.4, never delete tasks). Deleting now stamps
--  deleted_at / deleted_by and closes the task as cancelled; the
--  board and the task panel hide anything with deleted_at set.
--  Restoring is clearing deleted_at (and reopening the status).
--
--  Additive only; safe to re-run.
-- ============================================================

alter table tasks add column if not exists deleted_at timestamptz;
-- Deliberately NOT a foreign key (see 0043): a second tasks→profiles FK makes
-- every PostgREST embed `profiles(...)` on tasks ambiguous, like completed_by in 0032.
alter table tasks add column if not exists deleted_by uuid;

-- The board's list only ever wants the rows that are not deleted.
create index if not exists idx_tasks_not_deleted
  on tasks(org_id, created_at desc)
  where deleted_at is null;
