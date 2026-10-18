-- Undo db/2026-10-18-realtime-publication.sql: stop publishing the four tables. Devices go back
-- to seeing other devices' changes only after a reload. Access is not affected.

begin;

do $$
declare t text;
begin
  foreach t in array array['daily_plan', 'roasting_progress', 'plan_state', 'activity_log'] loop
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

commit;
