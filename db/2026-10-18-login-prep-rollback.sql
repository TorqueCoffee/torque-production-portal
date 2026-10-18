-- Undo db/2026-10-18-login-prep.sql: activity_log and plan_state back to `to anon` only.
-- Signed-in pages lose Finalize and the activity log after this, so revert the login code too.
-- Not needed to undo the access migration: its rollback returns to the prep state.

begin;

alter policy "anon read activity_log" on public.activity_log to anon;
alter policy "anon write activity_log" on public.activity_log to anon;
alter policy "anon update activity_log" on public.activity_log to anon;
alter policy "anon read plan_state" on public.plan_state to anon;
alter policy "anon write plan_state" on public.plan_state to anon;
alter policy "anon update plan_state" on public.plan_state to anon;

commit;
