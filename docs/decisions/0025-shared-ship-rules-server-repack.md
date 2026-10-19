# 0025 — One copy of the ship rules; the server repacks before buying

- **Status**: Accepted (amended by [0028](./0028-retail-buy-and-print.md): retail orders are rated and bought at the address Shopify has now, not the page's)
- **Date**: 2026-10-19

## Context

The B2B shipping rules were split across two files. The weight per item (`resolveWeightLb`, R10) and which lines ship lived in `api/shopify-token.js`; the packer, the carton, the measured bag nets and the declared weight lived in `index.html`. The page packed each order and sent the parcel weight; the label endpoint bought whatever weight it was sent, checking only that it was a whole number of pounds.

Retail (B1–B3) adds a second packer and two more cartons. With the rules in two places, the page and the server can drift, and a page that is out of date, edited by hand or acting on an order edited since it was listed could buy a label at the wrong weight. UPS bills the declared weight, and an under-declared box is re-billed later.

The page is a single HTML file with no build step, and the API runs as Node functions on Vercel.

## Options considered

- **Keep two copies, add a test that they agree.** Cheap, but every rule change still has to be made twice, and the server still trusts the page's weight.
- **Move all packing to the server; the page asks for packed boxes.** One source of truth, but an extra API round-trip before anything shows, and the page loses its offline-friendly preview of boxes.
- **One file, loaded by both (chosen).** `lib/ship-rules.js` is a plain script that sets a `ShipRules` global in the browser and `module.exports` in Node. Before buying, the label endpoint fetches the order from Shopify, packs it with the same file, and refuses (409) a parcel whose carton, weight or box count differs.

## Decision

`lib/ship-rules.js` holds the weight resolver, the B2B line filter and item builder (`b2bShipItems`), the SKU overrides, the packer, the measured nets, the tare, the declared weight and `boxParcel`. Its exports are frozen. `index.html` loads it with `<script src="/lib/ship-rules.js">` before its own script and destructures the names it uses; `api/shopify-token.js` and `api/shippo-label.js` `require` it. `.vercelignore` allows `lib/` (ADR 0022 amended).

The page and the server pack a B2B order through one entry point, `packB2BItems(b2bShipItems(lines))`. Quantity is `fulfillable_quantity` (what is still to ship after edits, refunds and partial fulfillments), not the original `quantity`.

On `action=label` the page also sends `pack_sig`, the whole pack as a string (`packSignature`: every box's carton and declared weight, in order). After the "already bought" lookup and before rating, `api/shippo-label.js` fetches the order (`api/_shopify.js`), packs it and compares the whole pack, not just this box. A mismatch, a cancelled or missing order, or an unweighable line returns 409 with `code: 'pack_changed'`, and the page stops buying the rest of the order. Shopify unreachable returns 503. Nothing is claimed or bought in any of these cases. Rating is not checked: it buys nothing, and the label call is. `boxParcel` returns null for a carton it can't read or has no tare for, so a new carton is never shipped at a guessed size.

## Consequences

**Positive:** a rule changes in one place. The server buys only what it packs itself, so a stale or tampered page, or an order edited after it was listed, can't buy at the wrong weight. Retail's `packRetail()` goes in the same file and gets the same check.
**Negative:**
- Buying a label now also needs Shopify to answer (one more call, 5 s timeout). Fulfillment already needed it.
- If `/lib/ship-rules.js` fails to load, shipping is off with a "reload" message; sign-in and the rest of the portal still work. The allowlist test guards the deploy.
- The page and the lib can be cached separately. A page with an older lib packs differently and is refused at the label step with a "reload" message, never charged.
- Everything in `lib/` is public.
- The address is still taken from the page (checked for P.O. boxes and length, not compared with Shopify).
- One Shopify token exchange and order read per box. Fine for one B2B order at a time; B3's batch buying should check each order once (and may cache the token).
- The check knows only the B2B packer. B2 adds a carton table and `packRetail()`; the label request will need to say which packer applies.
**When to revisit:** the page gains a build step (bundle the lib instead), or the label check needs the address and contents too (compare the whole shipment with Shopify).
