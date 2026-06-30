# 0004 — shipping_labels security model: server-written, no public read, constraint-based dedup

- **Status**: Accepted
- **Date**: 2026-06-30

## Context

`shipping_labels` holds per-label cost / zone / margin data — the source for the Phase 3 P&L view. The app's other tables all grant the anon (publishable) key full CRUD (the whole PWA runs on the public key). Cost/margin data is more business-sensitive than roast progress, and this table is written server-side by the label-buying function at purchase time.

## Options considered

- **Match the other tables (anon CRUD incl. SELECT).** Simplest, but exposes cost/margin data to anyone with the public key.
- **Server-only via a Supabase secret key (RLS, no public policies).** Most secure, but adds a new secret env var + failure mode and diverges from the app's key model; not locally testable without the secret.
- **Anon INSERT + UPDATE, no SELECT (chosen).** Writes work with the already-public publishable key; cost data is not publicly readable; reads deferred to Phase 3.

## Decision

RLS on. Grant **INSERT + UPDATE** to PUBLIC (matching the app's policy style), but **not SELECT or DELETE**. The serverless functions write with the publishable key. Dedup via `unique(shippo_object_id)` + a **plain insert** (not upsert — upsert's conflict-detection read would require a SELECT policy we intentionally don't grant). Cost-capture is non-blocking everywhere: a log failure never blocks the shipment.

## Consequences

**Positive:** cost/margin data isn't exposed to the public key; no new secret to manage; writes use the existing key; consistent-enough with the app's model.
**Negative:** the Phase 3 P&L view can't read client-side with the anon key as-is — it must read server-side or be granted a deliberate SELECT policy then. Upsert isn't available (acceptable; the unique constraint dedups, and a rare retry 409s into the non-blocking guard).
**When to revisit:** building the Phase 3 P&L view (decide read access), or moving to a stricter posture (secret key, server-only) when the company is sold.
