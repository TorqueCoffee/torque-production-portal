-- Undo db/2026-10-18-label-claims.sql. Revert the login code first: it refuses to buy a label
-- when it can't claim the box.

begin;

drop function if exists public.claim_label_box(text, integer);
drop function if exists public.release_label_box(text, integer);
drop table if exists public.label_claims;

commit;
