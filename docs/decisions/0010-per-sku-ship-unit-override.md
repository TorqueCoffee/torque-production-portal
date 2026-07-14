# 0010 — Hardcoded per-SKU ship-unit override, applied before the packer

- **Status**: Accepted
- **Date**: 2026-07-14

## Context

`packBoxes()` (`index.html`) assumes every line item's `weight_lb` is the true physical per-unit weight, and halts with an "unpackable / unit_exceeds_box_cap" warning for any single unit heavier than the 20lb box cap (`PACK_BOX.maxWeightLb`). Per the 2026-06-29 JOURNAL decision, this was believed safe because no B2B SKU priced as one unit ever physically ships as more than one box.

Cocoa Drops xBloom Bulk 40lb Box (SKU `TCCDS-40`) breaks that assumption: it's priced and sold as a single 40lb line item (so the bulk-tier math works), but physically ships as 2x 20lb boxes. Fed straight into `packBoxes()`, a qty-1 order of this SKU trips the over-cap halt instead of packing as two boxes.

## Options considered

- **Loosen or special-case the cap inside `packBoxes()`** — rejected: `packBoxes()` is otherwise a pure, generic bin-packer; teaching it about one specific SKU's physical packaging couples packing math to catalog data and makes the cap meaningless as a safety check for every other SKU.
- **Build a general Supabase-backed "unit override" config table** — rejected: this is currently a single known SKU. A schema, RLS policies, and an editor UI for one row is premature generality with real (if small) build/maintenance cost.
- **Hardcoded SKU-keyed override map, applied at line-item load time, before `packBoxes()` ever sees the items** — chosen: `packBoxes()` stays untouched and keeps enforcing the cap on genuinely-real per-unit weights; the correction lives at the one place that actually needs to know about it.

## Decision

- Added `SHIP_UNIT_OVERRIDES` in `index.html`: a hardcoded `{ [sku]: { units, weight_lb } }` map, currently `{ 'TCCDS-40': { units: 2, weight_lb: 20 } }`.
- Added `expandShipItems(items)`, which maps a line-item list and, for any item whose `sku` matches the override map, replaces `qty`/`weight_lb` with the physical unit count/weight (`qty * override.units` units at `override.weight_lb` each). Items with no match pass through unchanged.
- Wired `expandShipItems()` into `loadShipOrders()` immediately after the `/api/shopify-token?type=b2b-ship` fetch, so `b2bShipOrders` holds already-corrected items everywhere downstream (list view box-count, detail view, packing-slip contents aggregation) — every caller of `packBoxes(order.items)` gets correct units for free, with no change to `packBoxes()` itself.
- Added `sku` to the `b2b-ship` item shape in `api/shopify-token.js` (it previously returned `{product_name, variant_title, qty, grams, weight_lb}` with no SKU) — matching is done on Shopify SKU, not on `product_name`/`variant_title` text, which would be fragile against renames.

## Consequences

**Positive:** `packBoxes()` remains a pure generic packer with no catalog knowledge; the halt-and-warn cap still means what it says for every other SKU. Adding a future priced-as-one/ships-as-many SKU is a one-line map entry, not a schema change.

**Negative:** the override lives in application code, not data — a store admin can't change it without a code deploy. Acceptable for a single known SKU per Andy's call; revisit if this grows past a small handful of entries.

**When to revisit:** if more than ~3–4 SKUs need this treatment, or if the override needs to change without a code deploy (e.g. seasonal packaging changes), move `SHIP_UNIT_OVERRIDES` into a Supabase table.
