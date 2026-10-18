-- Login slice, step 3b: close the database to anyone not signed in (ADR 0023).
--
-- Run in the Supabase SQL editor (project gblkovtjylrfdotoktkb), only after:
--   0. db/2026-10-18-login-prep.sql is applied,
--   2. every account has signed in on its devices, and
--   3a. PORTAL_AUTH_ENFORCE=1 is live on Vercel.
-- Undo: db/2026-10-18-login-rls-rollback.sql.
--
-- What it does:
--   * The 36 public-schema policies granted to public/anon move to `authenticated`. Each keeps
--     its command and its USING/CHECK expressions (ALTER POLICY changes only the role) and is
--     renamed "authenticated …". Same access as before for signed-in users: 7 tables full CRUD;
--     activity_log and plan_state no DELETE; shipping_labels INSERT/UPDATE only, no SELECT
--     (ADR 0004).
--   * Only the portal's own accounts count: each of the 10 tables gets one RESTRICTIVE policy
--     requiring app_metadata.portal_staff = true in the caller's JWT, and the three recovery
--     functions return or change nothing for anyone else. Restrictive policies are ANDed with
--     the permissive ones, so those keep their exact expressions. A stranger who got a
--     Supabase Auth user (a sign-up toggle left on, an anonymous sign-in) gets nothing.
--   * green_planner_app (the green planner's role, not a member of `authenticated`) gets a
--     SELECT policy on the only two tables it has a SELECT grant on.
--   * PUBLIC and anon lose EXECUTE on the three SECURITY DEFINER recovery functions (ADR 0011).
--     That includes green_planner_app, which could run them through PUBLIC.
--   * Tables, sequences and functions created later in public by `postgres` (the SQL editor)
--     no longer get Supabase's explicit anon grants. Two gaps remain, both written down in
--     ADR 0023: a new function still gets EXECUTE for PUBLIC (anon included) from Postgres's
--     built-in default, which only a database-wide change could remove, so every new function
--     needs `revoke execute ... from public, anon`; and objects created by supabase_admin keep
--     Supabase's defaults, which this role can't change.
-- Table GRANTs to anon on the existing tables stay: with no policy, anon reads [] and every
-- write is refused.
--
-- The checks at the top and bottom raise an error (and nothing is changed) if the database is
-- not in the state this was written against, or does not end up where it should.

begin;

-- Preconditions ------------------------------------------------------------------------
do $$
declare
  expected text[][] := array[
    ['archived_plan', 'anon read archived_plan', 'public'],
    ['archived_plan', 'anon write archived_plan', 'public'],
    ['archived_plan', 'anon update archived_plan', 'public'],
    ['archived_plan', 'anon delete archived_plan', 'public'],
    ['b2b_progress', 'anon read b2b_progress', 'public'],
    ['b2b_progress', 'anon write b2b_progress', 'public'],
    ['b2b_progress', 'anon update b2b_progress', 'public'],
    ['b2b_progress', 'anon delete b2b_progress', 'public'],
    ['blend_matrix', 'anon read blend_matrix', 'public'],
    ['blend_matrix', 'anon write blend_matrix', 'public'],
    ['blend_matrix', 'anon update blend_matrix', 'public'],
    ['blend_matrix', 'anon delete blend_matrix', 'public'],
    ['daily_plan', 'anon read daily_plan', 'public'],
    ['daily_plan', 'anon write daily_plan', 'public'],
    ['daily_plan', 'anon update daily_plan', 'public'],
    ['daily_plan', 'anon delete daily_plan', 'public'],
    ['green_coffee_settings', 'anon read green_coffee_settings', 'public'],
    ['green_coffee_settings', 'anon write green_coffee_settings', 'public'],
    ['green_coffee_settings', 'anon update green_coffee_settings', 'public'],
    ['green_coffee_settings', 'anon delete green_coffee_settings', 'public'],
    ['roasting_progress', 'anon read roasting_progress', 'public'],
    ['roasting_progress', 'anon write roasting_progress', 'public'],
    ['roasting_progress', 'anon update roasting_progress', 'public'],
    ['roasting_progress', 'anon delete roasting_progress', 'public'],
    ['subscription_schedule', 'anon read subscription_schedule', 'public'],
    ['subscription_schedule', 'anon write subscription_schedule', 'public'],
    ['subscription_schedule', 'anon update subscription_schedule', 'public'],
    ['subscription_schedule', 'anon delete subscription_schedule', 'public'],
    ['activity_log', 'anon read activity_log', 'anon,authenticated'],
    ['activity_log', 'anon write activity_log', 'anon,authenticated'],
    ['activity_log', 'anon update activity_log', 'anon,authenticated'],
    ['plan_state', 'anon read plan_state', 'anon,authenticated'],
    ['plan_state', 'anon write plan_state', 'anon,authenticated'],
    ['plan_state', 'anon update plan_state', 'anon,authenticated'],
    ['shipping_labels', 'insert shipping_labels', 'public'],
    ['shipping_labels', 'update shipping_labels', 'public']
  ];
  i int;
begin
  -- Lock-out guard: every account exists for a person or the floor iPad, carries the staff
  -- marker and has signed in; an anonymous user would also be `authenticated`.
  if not exists (select 1 from auth.users) then
    raise exception 'No Supabase Auth accounts exist yet. Do step 2 first, or this locks everyone out.';
  end if;
  if exists (select 1 from auth.users where last_sign_in_at is null and deleted_at is null) then
    raise exception 'Some accounts have never signed in: %. Sign in with each (step 2) first.',
      (select string_agg(email, ', ') from auth.users where last_sign_in_at is null and deleted_at is null);
  end if;
  if exists (select 1 from auth.users where is_anonymous) then
    raise exception 'Anonymous users exist. Turn anonymous sign-ins off and delete them first.';
  end if;
  if exists (select 1 from auth.users where deleted_at is null
               and coalesce(raw_app_meta_data ->> 'portal_staff', '') <> 'true') then
    raise exception 'Accounts without the portal_staff marker: %. Mark them (RUNBOOK step 0) or delete them; they would be locked out.',
      (select string_agg(coalesce(email, id::text), ', ') from auth.users where deleted_at is null
         and coalesce(raw_app_meta_data ->> 'portal_staff', '') <> 'true');
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 36 then
    raise exception 'Expected 36 policies in public, found %. The database has changed since this was written (or login-prep is missing).',
      (select count(*) from pg_policies where schemaname = 'public');
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename = expected[i][1] and policyname = expected[i][2]
                     and roles::text = '{' || expected[i][3] || '}') then
      raise exception 'Policy "%" on % (to %) is not as expected. Is db/2026-10-18-login-prep.sql applied?', expected[i][2], expected[i][1], expected[i][3];
    end if;
  end loop;
end $$;

-- 1. Policies: public/anon -> authenticated (same command, same expressions) ----------
alter policy "anon read archived_plan" on public.archived_plan to authenticated;
alter policy "anon write archived_plan" on public.archived_plan to authenticated;
alter policy "anon update archived_plan" on public.archived_plan to authenticated;
alter policy "anon delete archived_plan" on public.archived_plan to authenticated;
alter policy "anon read b2b_progress" on public.b2b_progress to authenticated;
alter policy "anon write b2b_progress" on public.b2b_progress to authenticated;
alter policy "anon update b2b_progress" on public.b2b_progress to authenticated;
alter policy "anon delete b2b_progress" on public.b2b_progress to authenticated;
alter policy "anon read blend_matrix" on public.blend_matrix to authenticated;
alter policy "anon write blend_matrix" on public.blend_matrix to authenticated;
alter policy "anon update blend_matrix" on public.blend_matrix to authenticated;
alter policy "anon delete blend_matrix" on public.blend_matrix to authenticated;
alter policy "anon read daily_plan" on public.daily_plan to authenticated;
alter policy "anon write daily_plan" on public.daily_plan to authenticated;
alter policy "anon update daily_plan" on public.daily_plan to authenticated;
alter policy "anon delete daily_plan" on public.daily_plan to authenticated;
alter policy "anon read green_coffee_settings" on public.green_coffee_settings to authenticated;
alter policy "anon write green_coffee_settings" on public.green_coffee_settings to authenticated;
alter policy "anon update green_coffee_settings" on public.green_coffee_settings to authenticated;
alter policy "anon delete green_coffee_settings" on public.green_coffee_settings to authenticated;
alter policy "anon read roasting_progress" on public.roasting_progress to authenticated;
alter policy "anon write roasting_progress" on public.roasting_progress to authenticated;
alter policy "anon update roasting_progress" on public.roasting_progress to authenticated;
alter policy "anon delete roasting_progress" on public.roasting_progress to authenticated;
alter policy "anon read subscription_schedule" on public.subscription_schedule to authenticated;
alter policy "anon write subscription_schedule" on public.subscription_schedule to authenticated;
alter policy "anon update subscription_schedule" on public.subscription_schedule to authenticated;
alter policy "anon delete subscription_schedule" on public.subscription_schedule to authenticated;
alter policy "anon read activity_log" on public.activity_log to authenticated;
alter policy "anon write activity_log" on public.activity_log to authenticated;
alter policy "anon update activity_log" on public.activity_log to authenticated;
alter policy "anon read plan_state" on public.plan_state to authenticated;
alter policy "anon write plan_state" on public.plan_state to authenticated;
alter policy "anon update plan_state" on public.plan_state to authenticated;
alter policy "insert shipping_labels" on public.shipping_labels to authenticated;
alter policy "update shipping_labels" on public.shipping_labels to authenticated;

alter policy "anon read archived_plan" on public.archived_plan rename to "authenticated read archived_plan";
alter policy "anon write archived_plan" on public.archived_plan rename to "authenticated write archived_plan";
alter policy "anon update archived_plan" on public.archived_plan rename to "authenticated update archived_plan";
alter policy "anon delete archived_plan" on public.archived_plan rename to "authenticated delete archived_plan";
alter policy "anon read b2b_progress" on public.b2b_progress rename to "authenticated read b2b_progress";
alter policy "anon write b2b_progress" on public.b2b_progress rename to "authenticated write b2b_progress";
alter policy "anon update b2b_progress" on public.b2b_progress rename to "authenticated update b2b_progress";
alter policy "anon delete b2b_progress" on public.b2b_progress rename to "authenticated delete b2b_progress";
alter policy "anon read blend_matrix" on public.blend_matrix rename to "authenticated read blend_matrix";
alter policy "anon write blend_matrix" on public.blend_matrix rename to "authenticated write blend_matrix";
alter policy "anon update blend_matrix" on public.blend_matrix rename to "authenticated update blend_matrix";
alter policy "anon delete blend_matrix" on public.blend_matrix rename to "authenticated delete blend_matrix";
alter policy "anon read daily_plan" on public.daily_plan rename to "authenticated read daily_plan";
alter policy "anon write daily_plan" on public.daily_plan rename to "authenticated write daily_plan";
alter policy "anon update daily_plan" on public.daily_plan rename to "authenticated update daily_plan";
alter policy "anon delete daily_plan" on public.daily_plan rename to "authenticated delete daily_plan";
alter policy "anon read green_coffee_settings" on public.green_coffee_settings rename to "authenticated read green_coffee_settings";
alter policy "anon write green_coffee_settings" on public.green_coffee_settings rename to "authenticated write green_coffee_settings";
alter policy "anon update green_coffee_settings" on public.green_coffee_settings rename to "authenticated update green_coffee_settings";
alter policy "anon delete green_coffee_settings" on public.green_coffee_settings rename to "authenticated delete green_coffee_settings";
alter policy "anon read roasting_progress" on public.roasting_progress rename to "authenticated read roasting_progress";
alter policy "anon write roasting_progress" on public.roasting_progress rename to "authenticated write roasting_progress";
alter policy "anon update roasting_progress" on public.roasting_progress rename to "authenticated update roasting_progress";
alter policy "anon delete roasting_progress" on public.roasting_progress rename to "authenticated delete roasting_progress";
alter policy "anon read subscription_schedule" on public.subscription_schedule rename to "authenticated read subscription_schedule";
alter policy "anon write subscription_schedule" on public.subscription_schedule rename to "authenticated write subscription_schedule";
alter policy "anon update subscription_schedule" on public.subscription_schedule rename to "authenticated update subscription_schedule";
alter policy "anon delete subscription_schedule" on public.subscription_schedule rename to "authenticated delete subscription_schedule";
alter policy "anon read activity_log" on public.activity_log rename to "authenticated read activity_log";
alter policy "anon write activity_log" on public.activity_log rename to "authenticated write activity_log";
alter policy "anon update activity_log" on public.activity_log rename to "authenticated update activity_log";
alter policy "anon read plan_state" on public.plan_state rename to "authenticated read plan_state";
alter policy "anon write plan_state" on public.plan_state rename to "authenticated write plan_state";
alter policy "anon update plan_state" on public.plan_state rename to "authenticated update plan_state";
alter policy "insert shipping_labels" on public.shipping_labels rename to "authenticated insert shipping_labels";
alter policy "update shipping_labels" on public.shipping_labels rename to "authenticated update shipping_labels";

-- 2a. Portal staff only (restrictive: ANDed with every permissive policy above) -----------
create policy "portal staff only" on public.activity_log as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.archived_plan as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.b2b_progress as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.blend_matrix as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.daily_plan as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.green_coffee_settings as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.plan_state as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.roasting_progress as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.shipping_labels as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));
create policy "portal staff only" on public.subscription_schedule as restrictive for all to authenticated
  using (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)) with check (coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false));

-- 2b. The green planner keeps reading its two portal tables -------------------------------
create policy "green planner read blend_matrix" on public.blend_matrix
  for select to green_planner_app using (true);
create policy "green planner read green_coffee_settings" on public.green_coffee_settings
  for select to green_planner_app using (true);

-- 3. Recovery functions: signed-in portal staff only ---------------------------------------
-- Same definitions as db/2026-07-25-ship-label-recovery.sql, plus the staff condition: anyone
-- else gets no rows / 0 rows changed. CREATE OR REPLACE keeps each function's grants.
create or replace function public.ship_labels_for_order(p_order_id text)
 returns table(order_id text, order_name text, box_index integer, box_count integer, tracking_number text, tracking_url text, label_url text, shippo_object_id text, status text, created_at timestamp with time zone)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id, sl.order_name, sl.box_index, sl.box_count,
         sl.tracking_number, sl.tracking_url, sl.label_url,
         sl.shippo_object_id, sl.status, sl.created_at
  from public.shipping_labels sl
  where sl.order_id = p_order_id
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  order by sl.box_index
$function$;

create or replace function public.ship_labels_pending()
 returns table(order_id text, order_name text, labels_bought bigint, box_count integer, bought_at timestamp with time zone)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id,
         min(sl.order_name) as order_name,
         count(*) as labels_bought,
         max(sl.box_count) as box_count,
         max(sl.created_at) as bought_at
  from public.shipping_labels sl
  where sl.status = 'purchased'
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  group by sl.order_id
$function$;

create or replace function public.mark_ship_labels_fulfilled(p_order_id text)
 returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return 0;
  end if;
  update public.shipping_labels sl
     set status = 'fulfilled'
   where sl.order_id = p_order_id
     and sl.status is distinct from 'fulfilled';
  get diagnostics n = row_count;
  return n;
end
$function$;

revoke execute on function public.ship_labels_for_order(text) from public, anon;
grant execute on function public.ship_labels_for_order(text) to authenticated;
revoke execute on function public.ship_labels_pending() from public, anon;
grant execute on function public.ship_labels_pending() to authenticated;
revoke execute on function public.mark_ship_labels_fulfilled(text) from public, anon;
grant execute on function public.mark_ship_labels_fulfilled(text) to authenticated;

-- 4. Objects created later by postgres: no anon grants by default -------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- Postconditions -----------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public'
               and roles && array['public', 'anon']::name[]) then
    raise exception 'A policy for public/anon is left.';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and roles = array['authenticated']::name[] and permissive = 'PERMISSIVE') <> 36
     or (select count(*) from pg_policies where schemaname = 'public' and roles = array['authenticated']::name[] and permissive = 'RESTRICTIVE' and policyname = 'portal staff only') <> 10
     or (select count(*) from pg_policies where schemaname = 'public' and roles = array['green_planner_app']::name[]) <> 2 then
    raise exception 'Policy counts are wrong after the change.';
  end if;
  if has_function_privilege('anon', 'public.ship_labels_for_order(text)', 'execute')
     or has_function_privilege('anon', 'public.ship_labels_pending()', 'execute')
     or has_function_privilege('anon', 'public.mark_ship_labels_fulfilled(text)', 'execute')
     or has_function_privilege('green_planner_app', 'public.mark_ship_labels_fulfilled(text)', 'execute') then
    raise exception 'anon (or PUBLIC) can still run a recovery function.';
  end if;
  if not (has_function_privilege('authenticated', 'public.ship_labels_for_order(text)', 'execute')
      and has_function_privilege('authenticated', 'public.ship_labels_pending()', 'execute')
      and has_function_privilege('authenticated', 'public.mark_ship_labels_fulfilled(text)', 'execute')) then
    raise exception 'authenticated lost a recovery function.';
  end if;
end $$;

commit;
