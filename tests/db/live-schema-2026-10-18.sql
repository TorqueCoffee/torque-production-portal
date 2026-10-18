-- Live access state of project gblkovtjylrfdotoktkb on 2026-10-18, before the login slice,
-- rebuilt for tests/db/login-rls.test.js (L4). Read from pg_policies, pg_class.relacl,
-- pg_proc.proacl, information_schema.columns, pg_constraint and pg_get_functiondef. Columns,
-- primary keys and unique constraints are the live ones (a published table needs its primary
-- key as replica identity, or UPDATE and DELETE on it fail).

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role green_planner_app nologin;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, last_sign_in_at timestamptz, deleted_at timestamptz, is_anonymous boolean not null default false, raw_app_meta_data jsonb);
-- Supabase's auth.jwt(): the claims PostgREST and Realtime set for the request.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role, green_planner_app;
grant execute on function auth.jwt() to anon, authenticated, service_role, green_planner_app;

grant usage on schema public to anon, authenticated, service_role, green_planner_app;

create table public.activity_log (id uuid not null default gen_random_uuid(), team_id text not null, plan_date date not null default current_date, kind text not null, text text not null, undo jsonb, undone boolean not null default false, created_at timestamptz not null default now());
create table public.archived_plan (id uuid not null default gen_random_uuid(), team_id text not null, sku text, product_name text, variant_title text, final_qty integer, source text default 'shopify', archived_at timestamptz default now(), archive_date date default current_date);
create table public.b2b_progress (id uuid not null default gen_random_uuid(), team_id text not null, company_name text not null, product_name text not null, variant_title text not null, qty_needed integer not null default 0, qty_bagged integer not null default 0, plan_date date not null default current_date, updated_at timestamptz default now());
create table public.blend_matrix (id uuid not null default gen_random_uuid(), product_name text not null, component_name text not null, ratio numeric not null, batch_size_lbs numeric not null default 7);
create table public.daily_plan (id uuid not null default gen_random_uuid(), team_id text not null, sku text not null, product_name text not null, variant_title text not null, qty_needed integer not null default 0, qty_bagged integer not null default 0, oldest_order_date date, locked boolean default false, done boolean default false, source text default 'shopify', note text, updated_at timestamptz default now(), created_at timestamptz default now());
create table public.green_coffee_settings (id uuid not null default gen_random_uuid(), component_name text not null, batch_size_lbs numeric not null default 7, shrinkage_pct numeric not null default 15, batches_done integer not null default 0, last_reset date, probat_batch_lbs numeric, probat_shrink_pct numeric not null default 15, roast_machine text not null default 'primo');
create table public.plan_state (team_id text not null, plan_date date not null default current_date, finalized_at timestamptz, updated_at timestamptz not null default now());
create table public.roasting_progress (id uuid not null default gen_random_uuid(), team_id text not null, green_name text not null, batches_done integer not null default 0, plan_date date not null default current_date, updated_at timestamptz default now(), locked_roasted_lbs numeric);
create table public.shipping_labels (id uuid not null default gen_random_uuid(), order_id text not null, order_name text, box_index integer not null, box_count integer not null, cost numeric not null, currency text not null default 'USD', service text, is_cubic boolean, zone text, dest_zip text, weight_lb numeric, tracking_number text, shippo_object_id text, status text not null default 'purchased', created_at timestamptz not null default now(), tracking_url text, label_url text);
create table public.subscription_schedule (id uuid not null default gen_random_uuid(), week_start date not null, modernist text, classicist text, espressoist text, updated_at timestamptz default now());
alter table public.activity_log add primary key (id);
alter table public.archived_plan add primary key (id);
alter table public.b2b_progress add primary key (id), add unique (team_id, company_name, product_name, variant_title, plan_date);
alter table public.blend_matrix add primary key (id);
alter table public.daily_plan add primary key (id), add unique (team_id, sku);
alter table public.green_coffee_settings add primary key (id), add unique (component_name);
alter table public.plan_state add primary key (team_id, plan_date);
alter table public.roasting_progress add primary key (id), add unique (team_id, green_name, plan_date);
alter table public.shipping_labels add primary key (id), add unique (shippo_object_id);
alter table public.subscription_schedule add primary key (id), add unique (week_start);

alter table public.activity_log enable row level security;
grant all on public.activity_log to anon, authenticated, service_role;
alter table public.archived_plan enable row level security;
grant all on public.archived_plan to anon, authenticated, service_role;
alter table public.b2b_progress enable row level security;
grant all on public.b2b_progress to anon, authenticated, service_role;
alter table public.blend_matrix enable row level security;
grant all on public.blend_matrix to anon, authenticated, service_role;
alter table public.daily_plan enable row level security;
grant all on public.daily_plan to anon, authenticated, service_role;
alter table public.green_coffee_settings enable row level security;
grant all on public.green_coffee_settings to anon, authenticated, service_role;
alter table public.plan_state enable row level security;
grant all on public.plan_state to anon, authenticated, service_role;
alter table public.roasting_progress enable row level security;
grant all on public.roasting_progress to anon, authenticated, service_role;
alter table public.shipping_labels enable row level security;
grant all on public.shipping_labels to anon, authenticated, service_role;
alter table public.subscription_schedule enable row level security;
grant all on public.subscription_schedule to anon, authenticated, service_role;
grant select on public.blend_matrix to green_planner_app;
grant select on public.green_coffee_settings to green_planner_app;

create policy "anon read archived_plan" on public.archived_plan for select to public using (true);
create policy "anon write archived_plan" on public.archived_plan for insert to public with check (true);
create policy "anon update archived_plan" on public.archived_plan for update to public using (true);
create policy "anon delete archived_plan" on public.archived_plan for delete to public using (true);
create policy "anon read b2b_progress" on public.b2b_progress for select to public using (true);
create policy "anon write b2b_progress" on public.b2b_progress for insert to public with check (true);
create policy "anon update b2b_progress" on public.b2b_progress for update to public using (true);
create policy "anon delete b2b_progress" on public.b2b_progress for delete to public using (true);
create policy "anon read blend_matrix" on public.blend_matrix for select to public using (true);
create policy "anon write blend_matrix" on public.blend_matrix for insert to public with check (true);
create policy "anon update blend_matrix" on public.blend_matrix for update to public using (true);
create policy "anon delete blend_matrix" on public.blend_matrix for delete to public using (true);
create policy "anon read daily_plan" on public.daily_plan for select to public using (true);
create policy "anon write daily_plan" on public.daily_plan for insert to public with check (true);
create policy "anon update daily_plan" on public.daily_plan for update to public using (true);
create policy "anon delete daily_plan" on public.daily_plan for delete to public using (true);
create policy "anon read green_coffee_settings" on public.green_coffee_settings for select to public using (true);
create policy "anon write green_coffee_settings" on public.green_coffee_settings for insert to public with check (true);
create policy "anon update green_coffee_settings" on public.green_coffee_settings for update to public using (true);
create policy "anon delete green_coffee_settings" on public.green_coffee_settings for delete to public using (true);
create policy "anon read roasting_progress" on public.roasting_progress for select to public using (true);
create policy "anon write roasting_progress" on public.roasting_progress for insert to public with check (true);
create policy "anon update roasting_progress" on public.roasting_progress for update to public using (true);
create policy "anon delete roasting_progress" on public.roasting_progress for delete to public using (true);
create policy "anon read subscription_schedule" on public.subscription_schedule for select to public using (true);
create policy "anon write subscription_schedule" on public.subscription_schedule for insert to public with check (true);
create policy "anon update subscription_schedule" on public.subscription_schedule for update to public using (true);
create policy "anon delete subscription_schedule" on public.subscription_schedule for delete to public using (true);
create policy "anon read activity_log" on public.activity_log for select to anon using (true);
create policy "anon write activity_log" on public.activity_log for insert to anon with check (true);
create policy "anon update activity_log" on public.activity_log for update to anon using (true) with check (true);
create policy "anon read plan_state" on public.plan_state for select to anon using (true);
create policy "anon write plan_state" on public.plan_state for insert to anon with check (true);
create policy "anon update plan_state" on public.plan_state for update to anon using (true) with check (true);
create policy "insert shipping_labels" on public.shipping_labels for insert to public with check (true);
create policy "update shipping_labels" on public.shipping_labels for update to public using (true) with check (true);

CREATE OR REPLACE FUNCTION public.mark_ship_labels_fulfilled(p_order_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.ship_labels_for_order(p_order_id text)
 RETURNS TABLE(order_id text, order_name text, box_index integer, box_count integer, tracking_number text, tracking_url text, label_url text, shippo_object_id text, status text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select sl.order_id, sl.order_name, sl.box_index, sl.box_count,
         sl.tracking_number, sl.tracking_url, sl.label_url,
         sl.shippo_object_id, sl.status, sl.created_at
  from public.shipping_labels sl
  where sl.order_id = p_order_id
  order by sl.box_index
$function$;

CREATE OR REPLACE FUNCTION public.ship_labels_pending()
 RETURNS TABLE(order_id text, order_name text, labels_bought bigint, box_count integer, bought_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select sl.order_id,
         min(sl.order_name) as order_name,
         count(*) as labels_bought,
         max(sl.box_count) as box_count,
         max(sl.created_at) as bought_at
  from public.shipping_labels sl
  where sl.status = 'purchased'
  group by sl.order_id
$function$;

-- Live ACL on all three: =X (PUBLIC, the default), anon, authenticated, service_role.
grant execute on function public.mark_ship_labels_fulfilled(text), public.ship_labels_for_order(text), public.ship_labels_pending()
  to anon, authenticated, service_role;

-- Live: the publication exists and holds no tables.
create publication supabase_realtime;

-- Live default privileges for objects postgres creates in public (pg_default_acl, schema
-- entries only; there is no database-wide entry): anon, authenticated and service_role get
-- everything. New functions also get PUBLIC EXECUTE from Postgres's built-in default, which a
-- schema entry can't remove. Set last so the three functions above keep their live ACL.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
