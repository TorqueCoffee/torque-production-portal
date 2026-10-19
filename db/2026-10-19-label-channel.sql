-- B3a: which tab a label belongs to (docs/decisions/0028-retail-buy-and-print.md).
-- Apply before retail buying is switched on (RETAIL_BUY_ENABLED in index.html).
--
-- Without it, ship_labels_pending() hands every bought, unfulfilled label to both tabs: a retail
-- label shows on the B2B Ship tab's red "never fulfilled" banner (with a Clear button), and the
-- Retail tab can't tell its own bought orders from B2B ones.
--   * shipping_labels.channel: 'b2b' or 'retail', not null, default 'b2b'. Every existing row is
--     B2B (no retail label has been bought through the portal), so the default backfills them.
--     This is the channel column cost_report_spec.md asks for (B5), added early.
--   * ship_labels_pending() and ship_labels_for_order() also return channel. Pending groups by
--     order and channel, so each order shows on its own tab only.
--   * Same staff condition and grants as the login slice (authenticated only). A changed return
--     type needs DROP + CREATE; both happen inside this transaction.
-- The label endpoint writes channel 'retail' for kind 'retail'; B2B rows take the default.
-- Check afterwards (SQL editor): select pg_get_function_result('public.ship_labels_pending()'::regprocedure);
-- ends in "channel text"; select channel, count(*) from public.shipping_labels group by 1; is all b2b.
-- Undo: db/2026-10-19-label-channel-rollback.sql. Roll this back before the login-rls rollback
-- (that file recreates both functions with the old return type).

begin;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'shipping_labels' and column_name = 'channel') then
    raise exception 'shipping_labels.channel already exists: this migration has run.';
  end if;
  if has_function_privilege('anon', 'public.ship_labels_pending()', 'execute') then
    raise exception 'anon can still run ship_labels_pending: apply db/2026-10-18-login-rls.sql first.';
  end if;
end $$;

alter table public.shipping_labels
  add column channel text not null default 'b2b'
  constraint shipping_labels_channel_check check (channel in ('b2b', 'retail'));

drop function public.ship_labels_for_order(text);
create function public.ship_labels_for_order(p_order_id text)
 returns table(order_id text, order_name text, box_index integer, box_count integer, tracking_number text, tracking_url text, label_url text, shippo_object_id text, status text, created_at timestamp with time zone, channel text)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id, sl.order_name, sl.box_index, sl.box_count,
         sl.tracking_number, sl.tracking_url, sl.label_url,
         sl.shippo_object_id, sl.status, sl.created_at, sl.channel
  from public.shipping_labels sl
  where sl.order_id = p_order_id
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  order by sl.box_index
$function$;

drop function public.ship_labels_pending();
create function public.ship_labels_pending()
 returns table(order_id text, order_name text, labels_bought bigint, box_count integer, bought_at timestamp with time zone, channel text)
 language sql stable security definer set search_path to 'public'
as $function$
  select sl.order_id,
         min(sl.order_name) as order_name,
         count(*) as labels_bought,
         max(sl.box_count) as box_count,
         max(sl.created_at) as bought_at,
         sl.channel
  from public.shipping_labels sl
  where sl.status = 'purchased'
    and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false)
  group by sl.order_id, sl.channel
$function$;

revoke execute on function public.ship_labels_for_order(text) from public, anon;
grant execute on function public.ship_labels_for_order(text) to authenticated;
revoke execute on function public.ship_labels_pending() from public, anon;
grant execute on function public.ship_labels_pending() to authenticated;

-- Postconditions: anything off and nothing above is kept.
do $$
begin
  if exists (select 1 from public.shipping_labels where channel is distinct from 'b2b') then
    raise exception 'postcondition: an existing row is not b2b';
  end if;
  if pg_get_function_result('public.ship_labels_pending()'::regprocedure) not like '%channel text%'
     or pg_get_function_result('public.ship_labels_for_order(text)'::regprocedure) not like '%channel text%' then
    raise exception 'postcondition: a lookup does not return channel';
  end if;
  if has_function_privilege('anon', 'public.ship_labels_pending()', 'execute')
     or has_function_privilege('anon', 'public.ship_labels_for_order(text)', 'execute') then
    raise exception 'postcondition: anon can run a lookup';
  end if;
  if not (has_function_privilege('authenticated', 'public.ship_labels_pending()', 'execute')
      and has_function_privilege('authenticated', 'public.ship_labels_for_order(text)', 'execute')) then
    raise exception 'postcondition: signed-in users cannot run a lookup';
  end if;
end $$;

commit;
