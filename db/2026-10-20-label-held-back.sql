-- B3b: hold back a bought retail label (docs/decisions/0029-retail-pack-and-fulfill.md).
-- Apply before the B3b page deploys and before retail buying is switched on (RETAIL_BUY_ENABLED
-- in index.html). Needs the channel and void migrations (db/2026-10-19-*.sql) first.
--
-- On the Pack screen a packer can hold back an order they can't send today. The label stays
-- bought, the order stays open in Shopify, and the next person to open Pack sees it still held:
-- the state lives on the label row, never in the page (Decision 1), so a reload, another
-- device or a second packer all see the same thing. There is no batch id; the batch is every
-- retail label that is bought and not fulfilled.
--   * shipping_labels.held_back_at: when it was held back; null = included in the batch.
--   * set_ship_label_held_back(order, held): sets or clears held_back_at on that order's live
--     retail label (channel 'retail', status 'purchased'). Returns the rows changed: 1 = done,
--     0 = nothing to change (a B2B, fulfilled or voided row, or a caller who is not portal
--     staff). SECURITY DEFINER with the staff check, like mark_ship_label_voided, because
--     shipping_labels has no SELECT policy (ADR 0004) and so can't be PATCHed.
--   * ship_labels_for_order() also returns weight_lb (the billed whole lb the fulfill step
--     checks the pack against), dest_zip (the ZIP the label was bought for) and held_back_at;
--     ship_labels_pending() also returns held_back_at. A changed return type needs DROP +
--     CREATE; both happen in this transaction. Bodies and the staff condition are as in the
--     channel migration.
--   * fulfill_claims, claim_order_fulfill(order), release_order_fulfill(order): one fulfiller or
--     voider per order at a time, like claim_label_box for buying. Fulfill and Void both take it,
--     so two devices can't fulfill one order together, and a Void can't refund a label while
--     Fulfill is emailing its tracking number. A claim older than 2 minutes can be taken over
--     (the calls it guards time out well before that). set_ship_label_held_back changes
--     nothing (returns 0) while the order's claim is fresh.
--   * The UPDATE policy on shipping_labels is dropped and UPDATE revoked from signed-in users:
--     every write to an existing row goes through the SECURITY DEFINER functions (hold back,
--     void, mark fulfilled), so a staff session can no longer rewrite a tracking number or clear a
--     hold-back with a plain UPDATE. INSERT stays: the label endpoint writes the cost row.
-- Check afterwards (SQL editor):
--   select pg_get_function_result('public.ship_labels_pending()'::regprocedure);        -- ends in "held_back_at timestamp with time zone"
--   select pg_get_function_result('public.ship_labels_for_order(text)'::regprocedure);  -- has "weight_lb numeric" and "held_back_at ..."
--   select count(*) from public.shipping_labels where held_back_at is not null;         -- 0
--   select policyname, cmd from pg_policies where tablename = 'shipping_labels';        -- no UPDATE policy
-- Undo: db/2026-10-20-label-held-back-rollback.sql (turn buying off first).

begin;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'shipping_labels' and column_name = 'channel') then
    raise exception 'shipping_labels.channel is missing: apply db/2026-10-19-label-channel.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'shipping_labels' and column_name = 'voided_at') then
    raise exception 'shipping_labels.voided_at is missing: apply db/2026-10-19-label-void.sql first.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'shipping_labels' and column_name = 'held_back_at') then
    raise exception 'shipping_labels.held_back_at already exists: this migration has run.';
  end if;
end $$;

alter table public.shipping_labels add column held_back_at timestamptz;

create table public.fulfill_claims (
  order_id   text primary key,
  claimed_at timestamptz not null default now()
);
alter table public.fulfill_claims enable row level security;
revoke all on public.fulfill_claims from public, anon, authenticated;

create function public.claim_order_fulfill(p_order_id text)
 returns boolean
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return false;
  end if;
  insert into public.fulfill_claims (order_id) values (p_order_id)
  on conflict (order_id) do update set claimed_at = now()
    where public.fulfill_claims.claimed_at < now() - interval '2 minutes';
  get diagnostics n = row_count;
  return n = 1;
end
$function$;

create function public.release_order_fulfill(p_order_id text)
 returns boolean
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return false;
  end if;
  delete from public.fulfill_claims where order_id = p_order_id;
  get diagnostics n = row_count;
  return n = 1;
end
$function$;

create function public.set_ship_label_held_back(p_order_id text, p_held boolean)
 returns integer
 language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return 0;
  end if;
  -- Someone is fulfilling or voiding this order right now: change nothing.
  if exists (select 1 from public.fulfill_claims fc where fc.order_id = p_order_id and fc.claimed_at > now() - interval '2 minutes') then
    return 0;
  end if;
  update public.shipping_labels sl
     set held_back_at = case when p_held then now() else null end
   where sl.order_id = p_order_id
     and sl.channel = 'retail'
     and sl.status = 'purchased';
  get diagnostics n = row_count;
  return n;
end
$function$;

drop function public.ship_labels_for_order(text);
create function public.ship_labels_for_order(p_order_id text)
 returns table(order_id text, order_name text, box_index integer, box_count integer, tracking_number text, tracking_url text, label_url text, shippo_object_id text, status text, created_at timestamp with time zone, channel text, weight_lb numeric, held_back_at timestamp with time zone, dest_zip text)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id, sl.order_name, sl.box_index, sl.box_count,
         sl.tracking_number, sl.tracking_url, sl.label_url,
         sl.shippo_object_id, sl.status, sl.created_at, sl.channel,
         sl.weight_lb, sl.held_back_at, sl.dest_zip
  from public.shipping_labels sl
  where sl.order_id = p_order_id
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  order by sl.box_index
$function$;

drop function public.ship_labels_pending();
create function public.ship_labels_pending()
 returns table(order_id text, order_name text, labels_bought bigint, box_count integer, bought_at timestamp with time zone, channel text, held_back_at timestamp with time zone)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id,
         min(sl.order_name) as order_name,
         count(*) as labels_bought,
         max(sl.box_count) as box_count,
         max(sl.created_at) as bought_at,
         sl.channel,
         max(sl.held_back_at) as held_back_at
  from public.shipping_labels sl
  where sl.status = 'purchased'
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  group by sl.order_id, sl.channel
$function$;

-- A plain UPDATE on a label row is no longer allowed for signed-in users (see the header).
drop policy if exists "authenticated update shipping_labels" on public.shipping_labels;
drop policy if exists "update shipping_labels" on public.shipping_labels;
revoke update on public.shipping_labels from authenticated;

revoke execute on function public.set_ship_label_held_back(text, boolean) from public, anon;
grant execute on function public.set_ship_label_held_back(text, boolean) to authenticated;
revoke execute on function public.claim_order_fulfill(text), public.release_order_fulfill(text) from public, anon;
grant execute on function public.claim_order_fulfill(text), public.release_order_fulfill(text) to authenticated;
revoke execute on function public.ship_labels_for_order(text) from public, anon;
grant execute on function public.ship_labels_for_order(text) to authenticated;
revoke execute on function public.ship_labels_pending() from public, anon;
grant execute on function public.ship_labels_pending() to authenticated;

-- Postconditions: anything off and nothing above is kept.
do $$
begin
  if pg_get_function_result('public.ship_labels_pending()'::regprocedure) not like '%held_back_at timestamp with time zone%'
     or pg_get_function_result('public.ship_labels_for_order(text)'::regprocedure) not like '%held_back_at timestamp with time zone%'
     or pg_get_function_result('public.ship_labels_for_order(text)'::regprocedure) not like '%weight_lb numeric%'
     or pg_get_function_result('public.ship_labels_for_order(text)'::regprocedure) not like '%dest_zip text%' then
    raise exception 'postcondition: a lookup does not return held_back_at, weight_lb and dest_zip';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shipping_labels' and cmd in ('UPDATE', 'ALL') and policyname <> 'portal staff only')
     or has_table_privilege('authenticated', 'public.shipping_labels', 'update') then
    raise exception 'postcondition: signed-in users can still UPDATE shipping_labels';
  end if;
  if exists (select 1 from pg_proc where proname in ('set_ship_label_held_back', 'claim_order_fulfill', 'release_order_fulfill') and pronamespace = 'public'::regnamespace and not (prosecdef and proconfig is not null)) then
    raise exception 'postcondition: a new function is not SECURITY DEFINER with a fixed search_path';
  end if;
  if has_function_privilege('anon', 'public.ship_labels_pending()', 'execute')
     or has_function_privilege('anon', 'public.ship_labels_for_order(text)', 'execute')
     or has_function_privilege('anon', 'public.set_ship_label_held_back(text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.claim_order_fulfill(text)', 'execute')
     or has_function_privilege('anon', 'public.release_order_fulfill(text)', 'execute') then
    raise exception 'postcondition: anon can run a function';
  end if;
  if not (has_function_privilege('authenticated', 'public.ship_labels_pending()', 'execute')
      and has_function_privilege('authenticated', 'public.ship_labels_for_order(text)', 'execute')
      and has_function_privilege('authenticated', 'public.set_ship_label_held_back(text, boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.claim_order_fulfill(text)', 'execute')
      and has_function_privilege('authenticated', 'public.release_order_fulfill(text)', 'execute')) then
    raise exception 'postcondition: signed-in users cannot run a function';
  end if;
end $$;

commit;
