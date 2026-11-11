-- ============================================================
--  0043 · Repair: drop the two new tasks → profiles foreign keys
--
--  0040 (source_mailbox_id) and 0042 (deleted_by) each added a
--  foreign key from tasks to profiles. tasks already had one
--  (assigned_to), and every query in the app embeds the assignee as
--  `profiles(...)`. With three relationships PostgREST refuses those
--  queries (PGRST201 "more than one relationship was found"), which
--  emptied the task board and broke every task read that names the
--  person.
--
--  Same fix as completed_by in 0032: keep the columns, drop the FKs.
--  No data is touched. Safe to re-run.
-- ============================================================

alter table tasks drop constraint if exists tasks_source_mailbox_id_fkey;
alter table tasks drop constraint if exists tasks_deleted_by_fkey;

-- Make PostgREST pick up the change immediately.
notify pgrst, 'reload schema';
