-- Realtime: publish the four tables the page subscribes to (ADR 0023).
--
-- supabase_realtime held no tables, so the page's realtime channels never received anything
-- and nothing polled: changes on one device showed on another only after a reload.
-- Run right after the login code is deployed, not before: the new page debounces and
-- serializes realtime reloads; the old page would reload on every row event.
-- Realtime applies the tables' RLS policies with each subscriber's token.
-- Undo: db/2026-10-18-realtime-publication-rollback.sql.

begin;

do $$
declare t text;
begin
  foreach t in array array['daily_plan', 'roasting_progress', 'plan_state', 'activity_log'] loop
    -- A published table without a replica identity refuses every UPDATE and DELETE.
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = t
                     and (c.relreplident in ('f', 'i')
                          or (c.relreplident = 'd' and exists (select 1 from pg_index x where x.indrelid = c.oid and x.indisprimary)))) then
      raise exception 'Table % has no primary key (replica identity); publishing it would break its updates.', t;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;
