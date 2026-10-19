-- B6: void a label (docs/Retail-USPS-UPS.md). Apply before the void code deploys: without it
-- the void endpoint refunds the label in Shippo but can't mark the row (it says so, and the box
-- still reads as bought).
--
-- shipping_labels has no SELECT policy (ADR 0004), so a PATCH can't flip a row (RUNBOOK); the
-- flip goes through a SECURITY DEFINER function, like mark_ship_labels_fulfilled (ADR 0011).
--   * mark_ship_label_voided(order, box, shippo id): the one 'purchased' row with that Shippo
--     transaction becomes 'voided' with voided_at, and the box's claim (label_claims) is freed
--     so it can be bought again at once. Returns the rows changed (0 or 1). Never touches a
--     fulfilled row. Returns 0 for anyone who is not portal staff.
--   * mark_ship_labels_fulfilled no longer flips voided rows to 'fulfilled': a voided label is
--     not on the box that shipped.
-- Needs the login slice's step 0 (label_claims). Undo: db/2026-10-19-label-void-rollback.sql.

begin;

do $$
begin
  if to_regclass('public.label_claims') is null then
    raise exception 'label_claims is missing: apply db/2026-10-18-label-claims.sql first.';
  end if;
end $$;

alter table public.shipping_labels add column voided_at timestamptz;

create function public.mark_ship_label_voided(p_order_id text, p_box_index integer, p_shippo_object_id text)
 returns integer
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return 0;
  end if;
  update public.shipping_labels sl
     set status = 'voided', voided_at = now()
   where sl.order_id = p_order_id
     and sl.box_index = p_box_index
     and sl.shippo_object_id = p_shippo_object_id
     and sl.status = 'purchased';
  get diagnostics n = row_count;
  if n > 0 then
    delete from public.label_claims where order_id = p_order_id and box_index = p_box_index;
  end if;
  return n;
end
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
     and sl.status is distinct from 'fulfilled'
     and sl.status is distinct from 'voided';
  get diagnostics n = row_count;
  return n;
end
$function$;

revoke execute on function public.mark_ship_label_voided(text, integer, text) from public, anon;
grant execute on function public.mark_ship_label_voided(text, integer, text) to authenticated;
revoke execute on function public.mark_ship_labels_fulfilled(text) from public, anon;
grant execute on function public.mark_ship_labels_fulfilled(text) to authenticated;

commit;
