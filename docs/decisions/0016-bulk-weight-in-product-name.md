# 0016 — Bulk weight in the product name counts on Roasting, not on Lbs Needed

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

`variantToLbs()` reads a line's weight out of its `variant_title` — `12oz Bag`,
`5lb Bulk`, `2Lb BULK Bags`. That covers every retail SKU, because Shopify puts
the size in the variant.

It does not cover `Cocoa Drops xBloom Bulk 40lb Box`, whose only variant is
`Default Title`. The 40 lbs live in the *product name*. `variantToLbs` returned
0, so an order for the box contributed nothing to the roasting plan — 40 lbs of
coffee that has to go through the drum, invisible on the tab that tells the
roaster what to roast.

The fix looks like it belongs in `variantToLbs`, since both tabs call it. It
does not, because the two tabs want different answers here. Roasting asks *what
goes in the drum today*, and the box goes in the drum. Lbs Needed asks *is there
enough roasted coffee in the bins to fill today's bagging list*, and the box is
xBloom — planned separately, not filled off the bagging list, and excluded from
that tab by design (ADR [`0015`](./0015-lbs-needed-tab.md)). Making
`variantToLbs` return 40 would have been the smaller diff and would have put the
box on the wrong tab.

A name parse also has to be narrow. The catalog contains an unlisted
`5 lb weight for shipping` — a filler used to pad shipping weight, not coffee.
A regex over product names that isn't guarded would turn it into 5 lbs of
roasted coffee.

## Options considered

- **Parse the name inside `variantToLbs`** — one line, and both tabs pick it up. Wrong: puts an xBloom box on the bins tab.
- **A `grams` column on `daily_plan` fed from Shopify's line item** — accurate for everything, but a schema change, a migration, and a Pull Orders rewrite for one SKU.
- **Rename the Shopify variant to `40lb Box`** — fixes it at the source with no code, but depends on a catalog edit holding forever, and silently regresses to 0 the day someone renames it back.
- **A separate `bulkNameToLbs()` used only by `renderRoasting()`** — keeps the asymmetry explicit and visible at the call site.

## Decision

`bulkNameToLbs(productName)`, called **only** from `renderRoasting()`, as a
fallback when the variant yields nothing:

```js
const lbs = (variantToLbs(row.variant_title) || bulkNameToLbs(row.product_name)) * qtyRemaining(row)
```

It returns 0 unless the name contains `bulk` *and* carries an `lb`/`pound`
figure. The `bulk` guard is what keeps `5 lb weight for shipping` out.
`computeRoastedNeeded()` is untouched and still sees 0, so the box stays off Lbs
Needed exactly as ADR 0015 specifies.

Alongside it, two `blend_matrix` data fixes so the box's 40 lbs land on real
coffees rather than on a row named after the box:

- **`Bridge Blend - Grondin Community Bridge Composition` had no recipe at all**
  and rendered as its own row on both tabs. It is the same blend as Cocoa Drop,
  so it now carries Cocoa Drop's components (Ntwari 20 / San Augustine 60 /
  Worka 20).
- **`Cocoa Drops xBloom Bulk 45lb Box` was filed under a name no live product
  has** — Shopify sells a **40lb** box — and recorded a 70/30 Nayarit plus /
  San Augustine split. Replaced with `Cocoa Drops xBloom Bulk 40lb Box` on Cocoa
  Drop's recipe. It is Cocoa Drops in a bulk box, so it is Cocoa Drop's split.

## Consequences

**Positive:** The roasting plan stops under-counting by 40 lbs a box. Both
compositions explode into real single origins instead of producing a
plausible-looking row named after a blend. The asymmetry is one guarded function
with one caller, so which tab counts what is readable at the call site.

**Negative:** A third place now derives a line's weight, and the `bulk` keyword
is load-bearing — a bulk SKU named without it goes back to counting 0, silently.
Anyone adding a weight-in-the-name product has to know the convention.

**When to revisit:** if a second SKU turns up with its weight in the name and no
`bulk` in it, stop pattern-matching on names and carry Shopify's per-line
`grams` into `daily_plan` — the option deferred above. `api/shopify-token.js`
already resolves grams for B2B cubic shipping, so the value is in hand.

**Note (2026-10-17):** B2B shipping now resolves weight from the title first and
grams last (R10, [ADR 0020](./0020-all-orders-ups-ground.md)), because grams are wrong
for 98 of 576 variants. Don't carry raw grams into `daily_plan` on the strength of the
line above; use the same resolver. The shipping-weight fillers this ADR warns about are
now left out of the B2B ship list.
