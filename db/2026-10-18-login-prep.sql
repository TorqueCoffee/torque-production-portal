-- Login slice, step 0 (before the login code deploys): let signed-in users use activity_log and
-- plan_state (ADR 0023).
--
-- These two tables' 6 policies are `to anon` only, unlike the other tables' `to public`. A device
-- signed in with Supabase Auth runs as `authenticated`, so without this, from the moment devices
-- sign in until the access migration, Finalize would be refused silently and every activity
-- and undo record dropped. Additive: anon keeps exactly what it has.
--
-- Run in the Supabase SQL editor (project gblkovtjylrfdotoktkb). Undo:
-- db/2026-10-18-login-prep-rollback.sql (only with the login code reverted).

begin;

do $$
declare p record;
begin
  for p in select * from (values
    ('activity_log', 'anon read activity_log'),
    ('activity_log', 'anon write activity_log'),
    ('activity_log', 'anon update activity_log'),
    ('plan_state', 'anon read plan_state'),
    ('plan_state', 'anon write plan_state'),
    ('plan_state', 'anon update plan_state')
  ) as x(t, name) loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = p.t
                     and policyname = p.name and roles = array['anon']::name[]) then
      raise exception 'Policy "%" on % is not `to anon` as expected.', p.name, p.t;
    end if;
  end loop;
end $$;

alter policy "anon read activity_log" on public.activity_log to anon, authenticated;
alter policy "anon write activity_log" on public.activity_log to anon, authenticated;
alter policy "anon update activity_log" on public.activity_log to anon, authenticated;
alter policy "anon read plan_state" on public.plan_state to anon, authenticated;
alter policy "anon write plan_state" on public.plan_state to anon, authenticated;
alter policy "anon update plan_state" on public.plan_state to anon, authenticated;

commit;
