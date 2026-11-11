-- ============================================================
--  0041 · Deleting an email no longer deletes its task
--          (fast track, Step 0c)
--
--  tasks.source_email_id was `on delete cascade` (0002), so removing
--  an email row silently removed the task raised from it. v2 rule:
--  never delete tasks (spec §8.4). The link is cleared instead.
--
--  Changes the constraint only; no rows are touched. Safe to re-run.
--  Finds the foreign key by its column rather than by name, so an
--  environment where Postgres named it differently is still fixed.
-- ============================================================

do $$
declare
  fk record;
begin
  for fk in
    select c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.tasks'::regclass
      and c.contype = 'f'
      and a.attname = 'source_email_id'
  loop
    execute format('alter table public.tasks drop constraint %I', fk.conname);
  end loop;
end $$;

alter table tasks
  add constraint tasks_source_email_id_fkey
  foreign key (source_email_id) references emails(id) on delete set null;
