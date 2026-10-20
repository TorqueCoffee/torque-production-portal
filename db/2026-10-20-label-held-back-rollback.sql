-- Undo db/2026-10-20-label-held-back.sql. Switch retail buying off first (RETAIL_BUY_ENABLED) and
-- deploy the page from before B3b: without the column, Hold back and Include stop working and
-- every bought retail label counts as an open batch again.
-- The held-back marks are dropped with the column; the rows stay. Save which orders were held
-- first, or nothing will say so afterwards:
--   select order_id, order_name, held_back_at from public.shipping_labels where held_back_at is not null;
-- Also reopens UPDATE on shipping_labels (the policy and grant the migration removed).
-- Restores the channel-era signatures (db/2026-10-19-label-channel.sql) of both lookups.

begin;

drop function if exists public.set_ship_label_held_back(text, boolean);
drop function if exists public.claim_order_fulfill(text);
drop function if exists public.release_order_fulfill(text);
drop table if exists public.fulfill_claims;

-- The UPDATE door the migration closed, as login-rls left it.
grant update on public.shipping_labels to authenticated;
create policy "authenticated update shipping_labels" on public.shipping_labels for update to authenticated using (true) with check (true);

drop function if exists public.ship_labels_for_order(text);
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

drop function if exists public.ship_labels_pending();
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

alter table public.shipping_labels drop column if exists held_back_at;

commit;
