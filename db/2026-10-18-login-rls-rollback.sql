-- Undo db/2026-10-18-login-rls.sql (ADR 0023): back to the state after login-prep, where anyone
-- with the publishable key can read and write and signed-in users can too.
--
-- Run in the Supabase SQL editor, then unset PORTAL_AUTH_ENFORCE on Vercel and redeploy (or
-- leave it set: signed-in pages work either way). The login code can stay deployed: every
-- policy here covers `authenticated` (`to public`, or `to anon, authenticated` for
-- activity_log and plan_state). To also revert the login code, run
-- db/2026-10-18-login-prep-rollback.sql after reverting it.

begin;

-- Checked by name, not by count: tables added after the migration bring their own
-- `to authenticated` policies, which this leaves alone.
do $$
declare p record;
begin
  for p in select * from (values
    ('archived_plan', 'authenticated read archived_plan'),
    ('archived_plan', 'authenticated write archived_plan'),
    ('archived_plan', 'authenticated update archived_plan'),
    ('archived_plan', 'authenticated delete archived_plan'),
    ('b2b_progress', 'authenticated read b2b_progress'),
    ('b2b_progress', 'authenticated write b2b_progress'),
    ('b2b_progress', 'authenticated update b2b_progress'),
    ('b2b_progress', 'authenticated delete b2b_progress'),
    ('blend_matrix', 'authenticated read blend_matrix'),
    ('blend_matrix', 'authenticated write blend_matrix'),
    ('blend_matrix', 'authenticated update blend_matrix'),
    ('blend_matrix', 'authenticated delete blend_matrix'),
    ('daily_plan', 'authenticated read daily_plan'),
    ('daily_plan', 'authenticated write daily_plan'),
    ('daily_plan', 'authenticated update daily_plan'),
    ('daily_plan', 'authenticated delete daily_plan'),
    ('green_coffee_settings', 'authenticated read green_coffee_settings'),
    ('green_coffee_settings', 'authenticated write green_coffee_settings'),
    ('green_coffee_settings', 'authenticated update green_coffee_settings'),
    ('green_coffee_settings', 'authenticated delete green_coffee_settings'),
    ('roasting_progress', 'authenticated read roasting_progress'),
    ('roasting_progress', 'authenticated write roasting_progress'),
    ('roasting_progress', 'authenticated update roasting_progress'),
    ('roasting_progress', 'authenticated delete roasting_progress'),
    ('subscription_schedule', 'authenticated read subscription_schedule'),
    ('subscription_schedule', 'authenticated write subscription_schedule'),
    ('subscription_schedule', 'authenticated update subscription_schedule'),
    ('subscription_schedule', 'authenticated delete subscription_schedule'),
    ('activity_log', 'authenticated read activity_log'),
    ('activity_log', 'authenticated write activity_log'),
    ('activity_log', 'authenticated update activity_log'),
    ('plan_state', 'authenticated read plan_state'),
    ('plan_state', 'authenticated write plan_state'),
    ('plan_state', 'authenticated update plan_state'),
    ('shipping_labels', 'authenticated insert shipping_labels'),
    ('shipping_labels', 'authenticated update shipping_labels')
  ) as x(t, name) loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = p.t
                     and policyname = p.name and roles = array['authenticated']::name[]) then
      raise exception 'Policy "%" on % (to authenticated) from the login migration is missing; the database is not in that state.', p.name, p.t;
    end if;
  end loop;
end $$;

-- 1. Policies back to public (activity_log, plan_state: anon + authenticated), old names ----
alter policy "authenticated read archived_plan" on public.archived_plan to public;
alter policy "authenticated write archived_plan" on public.archived_plan to public;
alter policy "authenticated update archived_plan" on public.archived_plan to public;
alter policy "authenticated delete archived_plan" on public.archived_plan to public;
alter policy "authenticated read b2b_progress" on public.b2b_progress to public;
alter policy "authenticated write b2b_progress" on public.b2b_progress to public;
alter policy "authenticated update b2b_progress" on public.b2b_progress to public;
alter policy "authenticated delete b2b_progress" on public.b2b_progress to public;
alter policy "authenticated read blend_matrix" on public.blend_matrix to public;
alter policy "authenticated write blend_matrix" on public.blend_matrix to public;
alter policy "authenticated update blend_matrix" on public.blend_matrix to public;
alter policy "authenticated delete blend_matrix" on public.blend_matrix to public;
alter policy "authenticated read daily_plan" on public.daily_plan to public;
alter policy "authenticated write daily_plan" on public.daily_plan to public;
alter policy "authenticated update daily_plan" on public.daily_plan to public;
alter policy "authenticated delete daily_plan" on public.daily_plan to public;
alter policy "authenticated read green_coffee_settings" on public.green_coffee_settings to public;
alter policy "authenticated write green_coffee_settings" on public.green_coffee_settings to public;
alter policy "authenticated update green_coffee_settings" on public.green_coffee_settings to public;
alter policy "authenticated delete green_coffee_settings" on public.green_coffee_settings to public;
alter policy "authenticated read roasting_progress" on public.roasting_progress to public;
alter policy "authenticated write roasting_progress" on public.roasting_progress to public;
alter policy "authenticated update roasting_progress" on public.roasting_progress to public;
alter policy "authenticated delete roasting_progress" on public.roasting_progress to public;
alter policy "authenticated read subscription_schedule" on public.subscription_schedule to public;
alter policy "authenticated write subscription_schedule" on public.subscription_schedule to public;
alter policy "authenticated update subscription_schedule" on public.subscription_schedule to public;
alter policy "authenticated delete subscription_schedule" on public.subscription_schedule to public;
alter policy "authenticated read activity_log" on public.activity_log to anon, authenticated;
alter policy "authenticated write activity_log" on public.activity_log to anon, authenticated;
alter policy "authenticated update activity_log" on public.activity_log to anon, authenticated;
alter policy "authenticated read plan_state" on public.plan_state to anon, authenticated;
alter policy "authenticated write plan_state" on public.plan_state to anon, authenticated;
alter policy "authenticated update plan_state" on public.plan_state to anon, authenticated;
alter policy "authenticated insert shipping_labels" on public.shipping_labels to public;
alter policy "authenticated update shipping_labels" on public.shipping_labels to public;

alter policy "authenticated read archived_plan" on public.archived_plan rename to "anon read archived_plan";
alter policy "authenticated write archived_plan" on public.archived_plan rename to "anon write archived_plan";
alter policy "authenticated update archived_plan" on public.archived_plan rename to "anon update archived_plan";
alter policy "authenticated delete archived_plan" on public.archived_plan rename to "anon delete archived_plan";
alter policy "authenticated read b2b_progress" on public.b2b_progress rename to "anon read b2b_progress";
alter policy "authenticated write b2b_progress" on public.b2b_progress rename to "anon write b2b_progress";
alter policy "authenticated update b2b_progress" on public.b2b_progress rename to "anon update b2b_progress";
alter policy "authenticated delete b2b_progress" on public.b2b_progress rename to "anon delete b2b_progress";
alter policy "authenticated read blend_matrix" on public.blend_matrix rename to "anon read blend_matrix";
alter policy "authenticated write blend_matrix" on public.blend_matrix rename to "anon write blend_matrix";
alter policy "authenticated update blend_matrix" on public.blend_matrix rename to "anon update blend_matrix";
alter policy "authenticated delete blend_matrix" on public.blend_matrix rename to "anon delete blend_matrix";
alter policy "authenticated read daily_plan" on public.daily_plan rename to "anon read daily_plan";
alter policy "authenticated write daily_plan" on public.daily_plan rename to "anon write daily_plan";
alter policy "authenticated update daily_plan" on public.daily_plan rename to "anon update daily_plan";
alter policy "authenticated delete daily_plan" on public.daily_plan rename to "anon delete daily_plan";
alter policy "authenticated read green_coffee_settings" on public.green_coffee_settings rename to "anon read green_coffee_settings";
alter policy "authenticated write green_coffee_settings" on public.green_coffee_settings rename to "anon write green_coffee_settings";
alter policy "authenticated update green_coffee_settings" on public.green_coffee_settings rename to "anon update green_coffee_settings";
alter policy "authenticated delete green_coffee_settings" on public.green_coffee_settings rename to "anon delete green_coffee_settings";
alter policy "authenticated read roasting_progress" on public.roasting_progress rename to "anon read roasting_progress";
alter policy "authenticated write roasting_progress" on public.roasting_progress rename to "anon write roasting_progress";
alter policy "authenticated update roasting_progress" on public.roasting_progress rename to "anon update roasting_progress";
alter policy "authenticated delete roasting_progress" on public.roasting_progress rename to "anon delete roasting_progress";
alter policy "authenticated read subscription_schedule" on public.subscription_schedule rename to "anon read subscription_schedule";
alter policy "authenticated write subscription_schedule" on public.subscription_schedule rename to "anon write subscription_schedule";
alter policy "authenticated update subscription_schedule" on public.subscription_schedule rename to "anon update subscription_schedule";
alter policy "authenticated delete subscription_schedule" on public.subscription_schedule rename to "anon delete subscription_schedule";
alter policy "authenticated read activity_log" on public.activity_log rename to "anon read activity_log";
alter policy "authenticated write activity_log" on public.activity_log rename to "anon write activity_log";
alter policy "authenticated update activity_log" on public.activity_log rename to "anon update activity_log";
alter policy "authenticated read plan_state" on public.plan_state rename to "anon read plan_state";
alter policy "authenticated write plan_state" on public.plan_state rename to "anon write plan_state";
alter policy "authenticated update plan_state" on public.plan_state rename to "anon update plan_state";
alter policy "authenticated insert shipping_labels" on public.shipping_labels rename to "insert shipping_labels";
alter policy "authenticated update shipping_labels" on public.shipping_labels rename to "update shipping_labels";

-- 2. The staff-only and green planner policies ---------------------------------------------
drop policy if exists "portal staff only" on public.activity_log;
drop policy if exists "portal staff only" on public.archived_plan;
drop policy if exists "portal staff only" on public.b2b_progress;
drop policy if exists "portal staff only" on public.blend_matrix;
drop policy if exists "portal staff only" on public.daily_plan;
drop policy if exists "portal staff only" on public.green_coffee_settings;
drop policy if exists "portal staff only" on public.plan_state;
drop policy if exists "portal staff only" on public.roasting_progress;
drop policy if exists "portal staff only" on public.shipping_labels;
drop policy if exists "portal staff only" on public.subscription_schedule;
drop policy if exists "green planner read blend_matrix" on public.blend_matrix;
drop policy if exists "green planner read green_coffee_settings" on public.green_coffee_settings;

-- 3. Recovery functions as before the login slice (no staff condition), callable with the
-- publishable key again ------------------------------------------------------------------
create or replace function public.ship_labels_for_order(p_order_id text)
 returns table(order_id text, order_name text, box_index integer, box_count integer, tracking_number text, tracking_url text, label_url text, shippo_object_id text, status text, created_at timestamp with time zone)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id, sl.order_name, sl.box_index, sl.box_count,
         sl.tracking_number, sl.tracking_url, sl.label_url,
         sl.shippo_object_id, sl.status, sl.created_at
  from public.shipping_labels sl
  where sl.order_id = p_order_id
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
  group by sl.order_id
$function$;

create or replace function public.mark_ship_labels_fulfilled(p_order_id text)
 returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  update public.shipping_labels sl
     set status = 'fulfilled'
   where sl.order_id = p_order_id
     and sl.status is distinct from 'fulfilled';
  get diagnostics n = row_count;
  return n;
end
$function$;

grant execute on function public.ship_labels_for_order(text) to public, anon;
grant execute on function public.ship_labels_pending() to public, anon;
grant execute on function public.mark_ship_labels_fulfilled(text) to public, anon;

-- 4. Supabase's default anon grants for objects postgres creates later ---------------------
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant all on sequences to anon;
alter default privileges for role postgres in schema public grant execute on functions to anon;

do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('portal staff only', 'green planner read blend_matrix', 'green planner read green_coffee_settings'))
     or exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'authenticated %'
               and tablename in ('activity_log', 'archived_plan', 'b2b_progress', 'blend_matrix', 'daily_plan', 'green_coffee_settings', 'plan_state', 'roasting_progress', 'shipping_labels', 'subscription_schedule')) then
    raise exception 'Policies are not back to the pre-login state.';
  end if;
  if not has_function_privilege('anon', 'public.ship_labels_pending()', 'execute') then
    raise exception 'anon EXECUTE was not restored.';
  end if;
end $$;

commit;
