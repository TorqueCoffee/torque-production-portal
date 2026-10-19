-- Undo db/2026-10-19-label-void.sql. Revert the void code first: without the function it
-- refunds in Shippo and then reports the record as not updated.
-- Rows already voided keep status 'voided' (the label lookup still skips them); their
-- voided_at is dropped with the column. mark_ship_labels_fulfilled goes back to the login
-- slice's version, which flips voided rows of an order to 'fulfilled' when it is fulfilled.

begin;

drop function if exists public.mark_ship_label_voided(text, integer, text);

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

alter table public.shipping_labels drop column if exists voided_at;

commit;
