-- One buyer per box (ADR 0023). Login slice, step 0: apply before the login code deploys.
--
-- The label endpoint looks up a box's existing label before buying (ADR 0020), but two devices
-- that both tap Buy within the same second both pass that lookup and both get charged. Now the
-- endpoint claims the box first: one row per (order, box), so only one claim succeeds.
--   * A failed purchase releases the claim, so the box can be tried again at once.
--   * A claim older than 10 minutes can be taken over: by then a box that was really bought
--     has its shipping_labels row, which the lookup finds first. (If the purchase call itself
--     errored, Shippo may have bought it; the claim blocks a re-buy for those 10 minutes.)
-- Only the two SECURITY DEFINER functions touch the table: no grants, no policies. Both return
-- false for anyone who is not portal staff (app_metadata.portal_staff, RUNBOOK step 0).
-- Undo: db/2026-10-18-label-claims-rollback.sql (with the login code reverted: the code refuses
-- to buy when it can't claim).

begin;

create table public.label_claims (
  order_id   text not null,
  box_index  integer not null,
  claimed_at timestamptz not null default now(),
  primary key (order_id, box_index)
);
alter table public.label_claims enable row level security;
revoke all on public.label_claims from public, anon, authenticated;

create function public.claim_label_box(p_order_id text, p_box_index integer)
 returns boolean
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return false;
  end if;
  insert into public.label_claims (order_id, box_index) values (p_order_id, p_box_index)
  on conflict (order_id, box_index) do update set claimed_at = now()
    where public.label_claims.claimed_at < now() - interval '10 minutes';
  get diagnostics n = row_count;
  return n = 1;
end
$function$;

create function public.release_label_box(p_order_id text, p_box_index integer)
 returns boolean
 language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if not coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'portal_staff')::boolean, false) then
    return false;
  end if;
  delete from public.label_claims where order_id = p_order_id and box_index = p_box_index;
  get diagnostics n = row_count;
  return n = 1;
end
$function$;

revoke execute on function public.claim_label_box(text, integer), public.release_label_box(text, integer) from public, anon;
grant execute on function public.claim_label_box(text, integer), public.release_label_box(text, integer) to authenticated;

commit;
