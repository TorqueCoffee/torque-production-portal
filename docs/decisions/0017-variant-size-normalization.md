# 0017 — Group production rows by canonical bag size, not SKU or raw variant text

- **Status**: Accepted
- **Date**: 2026-09-13

## Context

The Bagging/Roasting/Lbs Needed tabs are built from `api/shopify-token.js` aggregating
open Shopify line items into one row per (product, variant). The aggregation key was
`${item.sku || item.title}||${item.variant_title || 'Default'}`.

Two problems compounded:

1. **Variant text had drifted.** Across relaunches, the same physical bag size existed
   under many spellings — `12oz Coffee Bag`, `12oz Bag`, `12 oz bag / In Stock`, etc.
   (11 distinct strings just for the 12oz size, pulled live from Shopify). Any trailing-word
   difference produced a new row.
2. **SKU was the primary key.** Several coffees (Gum Drop, Dark Drop, BomBón, Decaf Drop)
   exist as two separate Shopify product records — an old listing and a relaunch — sharing
   the same title but carrying *different SKUs* for what is the same physical size. Keying
   on SKU first meant these split into two production rows even when variant text matched,
   and would have kept splitting even after text normalization alone.

Only 4 sizes exist across the whole coffee catalog: 12oz, 2lb, 5lb, 8 xPods. The one
deliberate exception is the xBloom bulk boxes (`Cocoa Drops xBloom Bulk 40lb Box` and
the 45lb Bombon equivalent), which carry their weight in the product name under a
`Default Title` variant and are handled separately by `bulkNameToLbs()` (ADR 0016) — out
of scope here, left untouched.

## Options considered

- **Normalize variant text in code only.** Fixes future drift and doesn't touch the live
  storefront, but old-listing/new-listing pairs still split on SKU regardless of text.
- **Rename the Shopify catalog only.** Gives every *future* order clean, consistent variant
  text, but Shopify line items snapshot `variant_title` at time of purchase — it does
  nothing for orders already open when the rename runs, and nothing for the next naming
  drift that inevitably happens at the next relaunch.
- **Both: normalize in code, key on title + canonical size, and clean up the catalog.**
  The code fix is the one that actually makes the tabs correct today and stays correct
  going forward; the catalog cleanup is customer-facing polish and reduces future drift,
  but isn't load-bearing for correctness.

## Decision

Do both.

- `canonicalVariant()` in `api/shopify-token.js` buckets any variant string into one of
  4 labels (`12oz`, `2lb`, `5lb`, `8 xPods`) by matching a prefix regex tolerant of
  spacing/case/trailing words. Anything that doesn't match (bulk-box `Default Title`,
  gift cards, shirt sizes) passes through unchanged.
- The orders aggregation and the B2B company view now key on
  `` `${item.title}||${canonicalVariant(item.variant_title)}` `` — product title + size,
  not SKU. SKU is kept only as a display/tracking field on the merged row (first
  non-empty SKU seen for that group), never as part of the identity.
- Shopify's `Size` option value was renamed to the same 4 labels (`12oz`, `2lb`, `5lb`,
  `8 xPods`) across all 40 active/draft coffee products via `productOptionUpdate`, one
  call per product (batching every value under a product's option into a single call).
  This only renames the option value — price, inventory, SKU, and variant ID are
  untouched, and existing orders are unaffected since Shopify references variants by ID,
  not by title text.
- `Cocoa Drops xBloom Bulk 40lb Box` (and the 45lb Bombon bulk box) were explicitly left
  out of the rename — they don't carry a size-option value to rename, and the code-side
  exclusion in `canonicalVariant()`/`bulkNameToLbs()` already handles them correctly.

## Consequences

**Positive:** Bagging/Roasting/Lbs Needed rows merge correctly regardless of which
product record or historical wording an order came through; the fix is retroactive for
every open order, not just future ones. The live catalog now also shows one consistent
set of size labels to customers.

**Negative:** The grouping key no longer treats different SKUs as different rows by
design — if a future product genuinely needs to track two *different* physical items
under the same title and canonical size, this aggregation will merge them. None of the
current catalog does this.

**When to revisit:** If a 5th bag size is ever introduced, or if a coffee needs two
truly distinct SKUs at the same nominal size tracked separately on the production tabs.
