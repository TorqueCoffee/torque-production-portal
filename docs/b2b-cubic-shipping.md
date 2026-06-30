# B2B Cubic Shipping — Project Basis

_Created: 2026-06-29 · Last updated: 2026-06-30 · Status: building (Steps 0–5 done — both Step 5 slices complete; remaining: live e2e + on-hardware print + Step 6 cutover, all deploy-gated to Andy)_

> Provenance: authored in the prebuild intake. This file is the canonical spec for the feature.
> See the **Amendments** section at the end for corrections from the Step 0 gate + pre-build pressure-test.

A page in the Torque production planner (production.torque.coffee, static single-file PWA + `api/shopify-token.js` on Vercel + Supabase) that lets production buy USPS cubic Ground Advantage labels for wholesale orders via Shippo, instead of paying Shopify Shipping's ~2x markup on the same box.

## MVP 1.0
Production opens a B2B wholesale Shopify order in the planner; the system packs it into the fewest 14x10x10 boxes at <=20lb each, buys a USPS cubic Ground Advantage label per box via the Shippo API, prints each label as 4x6 thermal (ZPL) with a contents block (coffee / size / qty) and box ID, and writes all tracking numbers back to the Shopify order with one customer notification.

**Must do:** Buy the cubic GA label at the verified rate AND get tracking onto the Shopify order with one clean customer notification.

**IN 1.0 (cheap, do it now):**
- **Cost capture.** Every label purchase writes a cost row to Supabase (actual charged amount + context). The P&L *view* is deferred, but the *data* is captured from label one so the later view has history instead of starting cold. See "Cost capture" section below.

**Explicitly NOT in 1.0:**
- Retail orders (up-to-4-coffees lists) — Phase 2
- Shipping P&L *view/dashboard* — Phase 3 (data captured in 1.0; only the view is deferred)
- Cubic-guardrail auto-resplit — Phase 4 (1.0 gets halt-and-warn only)
- Manifest / SCAN-form close-out — later
- Reprint / void from planner — later
- Address-validation surfacing in UI — later

**Allowed to do badly/manually in 1.0:**
- Production eyeball-confirms the box split before buying labels (manual proof/backstop; first-fit-decreasing is close enough with a human check).
- Retail orders route to the existing/old shipping method until Phase 2.

## Success signal
Production prints a cubic GA label for a real B2B order from inside the planner, the label cost matches the verified ~cubic rate (not Shopify's ~$18-20), tracking appears on the Shopify order, and the customer gets one Torque-branded Shopify shipping email (no stray USPS/third-party notice).
**Done for 1.0 looks like:** the above works end-to-end for a multi-box B2B order (e.g. 4x 5lb bags = 1 box; 6x 5lb = 2 boxes) with both tracking numbers on the order and contents blocks correct per box.

## The line we won't cross
1.0 ships ONLY orders that exist in Shopify. No off-platform / draft-order creation path in 1.0. No buying a label for a box the system flags as over 20lb without explicit human override.

## Assumptions
- [x] CHECKED — Shippo offers USPS cubic Ground Advantage at first label, no volume threshold _(Shippo docs + USPS GA cubic cheat-sheet, 2026-06-29)_
- [x] CHECKED — The 14x10x10 box qualifies for cubic GA _(0.81 cu ft < 1.0; longest side 14" < 18"; <20lb — all pass)_ — **re-verified 2026-06-29: GA Cubic ceiling is 1.0 cu ft (Priority Mail Cubic is the 0.50 cap; do not conflate). Box sits in the 0.9 tier.**
- [x] CHECKED — GA service token is `usps_ground_advantage` _(confirmed live on test token, 2026-06-29)_
- [x] CHECKED — Every coffee has an accurate weight in Shopify product data _(user-confirmed)_
- [x] CHECKED — All B2B wholesale orders are real Shopify orders _(user-confirmed)_
- [x] CHECKED — Planner already pulls orders live from Shopify via `api/shopify-token.js` _(JOURNAL 2026-06-20)_
- [x] CHECKED — Only one box SKU holds >2x 5lb bags: the 14x10x10. Volume eligibility structurally guaranteed (box always 0.81 cu ft <= 1.0).
- [ ] UNCHECKED (PROCEEDING ON ASSUMPTION) — Shippo's LIVE cubic $ rate matches the ~$9 already obtained from USPS/Pirate Ship/ShipStation for 14x10x10 @ <=20lb. Test token confirms mechanics only (test $8.50 returned, cubic applied — but synthetic). Kill condition armed: if activated live rate is materially >~$9-12, stop before going live.
- [ ] UNCHECKED — Shippo account funding/payment mechanism for live label purchase is set up _(confirm before first live label)_

## Still to verify (carried forward — THE GATE)
- [x] DONE (test token, 2026-06-29) — MECHANICS confirmed: 14x10x10 / 20lb, San Diego 92104 → LA 90012 returned `usps_ground_advantage` @ $8.50, zone 2; Instalabel produced a 4x6 ZPLII label with tracking. Cubic pricing was applied (label markup contains `CUBIC`). Rate object shape captured (see Amendments).
- [ ] DEFERRED TO LIVE-TOKEN — Confirm the actual ~$9 live dollar across a NEAR and a FAR zone. **NOT a gate** (ADR 0003); a tripwire only — kill if materially >~$12 on typical lanes. Test-token real-lane signal: La Jolla 92037 = zone 1 / $8.43; Simi Valley 93063 = zone 3 / $9.22.
- [ ] Confirm how the Shippo balance is funded so production isn't blocked at first live label.

## Dependencies (don't control)
- **Shippo API** — capability VERIFIED end-to-end on test token (cubic GA, token, rate, label, tracking, ZPLII). Live $ value still ASSUMED. Node SDK = current `new Shippo({apiKeyHeader})` style, NOT legacy `shippo(token)`.
- **Shopify Admin API** — used today for order pull; 1.0 ADDS fulfillment-write (create fulfillment with tracking, notify customer). Modern FulfillmentOrder GraphQL flow — confirm `write_merchant_managed_fulfillment_orders` scope.
- **USPS rate environment** — temporary 8% increase Apr 26 2026 → Jan 17 2027. DIM divisor 166→139 on Jul 12 2026 does NOT affect us (>1 cu ft only). Longest-side cubic limit reportedly rising 18"→22" Jul 2026 (irrelevant to 14" box; free headroom).

## What this touches / overwrites
New page in the existing planner PWA, beside the Bagging/Blends/Subscriptions tabs. Adds fulfillment-WRITE to Shopify (planner currently only reads orders). Parallel to, not replacing, retail shipping. Risk: writing a fulfillment marks the order fulfilled in Shopify — must not collide with any other fulfillment path or double-notify.

## Reuse vs build
**Core (label purchase):** REUSE Shippo API + Node SDK. Nothing hand-rolled for carrier/rate/label.
- Coffee list / weights: REUSE Shopify product data. NOT a new Supabase table.
- Order pull: REUSE existing `api/shopify-token.js` pattern.
- Bin-packing: BUILD — small bespoke 1D first-fit-decreasing; one fixed box + weight ceiling.
- ZPL contents block: BUILD — compose ZPL text block, printed on same thermal roll.

## Single source of truth
- Coffee identity + weight → Shopify product data (canonical).
- Order + line items → Shopify order (pulled live).
- Tracking → written to the Shopify order (one home).
- Box spec (14x10x10, 20lb cap) → one constant in the page config.
- Label cost (for future P&L) → written once to Supabase per label at purchase time (the ONLY home for cost analytics — not Shopify metafields).

## Cost capture (IN 1.0)
The actual label cost exists only in the Shippo transaction response at purchase time. Capture it then or lose it forever.

**Home:** new Supabase table (e.g. `shipping_labels`), written by the same serverless function that buys the label. NOT Shopify.

**Capture per label:**
- `order_id` / order name
- `box_index` + `box_count`
- `cost` (actual charged amount from Shippo transaction)
- `currency`
- `service` (e.g. `usps_ground_advantage`)
- `is_cubic` (DERIVED — see Amendments; no Shippo field for this)
- `zone` / destination ZIP (Shippo returns `zone` in the rate — see Amendments)
- `weight_lb`
- `tracking_number`
- `shippo_object_id` (transaction id, for later void/reconcile)
- `created_at`
- `status` (fulfillment_pending → fulfilled — see Amendments)

**Ordering rule (REVISED — see Amendments):** write the cost row immediately AFTER the label purchase succeeds (capture-at-purchase wins), with a `status` column; UPDATE after the Shopify fulfillment write succeeds. A failed cost-log must NOT block the shipment — warn and move on. Shipment success is the priority; cost capture is the passenger.

## User & context branch
User = Torque production staff (not Andy). Must be runnable without Andy present (that IS the success condition). Single state — production opens an order, confirms the split, prints.

## Edge cases & graceful behavior
- Box packs >20lb → **halt-and-warn**. Do not buy. Require human resplit/override. (Also fire on any SINGLE item > cap, not just box-sum — see Amendments.)
- Shippo rate call returns no cubic rate (box disqualified) → show returned rates, do not silently buy weight-based; warn.
- Shippo label purchase fails → surface error, do not mark order fulfilled, do not notify.
- Shopify fulfillment write fails after label bought → surface clearly so production can retry the fulfillment write without re-buying the label (don't double-buy). Guard against double-notify on retry (idempotency — see Amendments).
- Empty/zero-qty order or no shippable line items → coherent "nothing to pack" state, no crash.
- Supabase empty/null return → `|| []`.

## Reversibility & blast radius
Money + customer-facing. Blast radius is one order at a time. Mitigations: build/test on Shippo TEST token first; test Shopify fulfillment write on a test/draft order first; halt-and-warn protects the cubic rate. Rollback: a wrongly-bought label can be voided within USPS's window — in 1.0 a misbuy is handled manually via the Shippo dashboard.

## Build sequence (destination-first, test-token throughout)
0. **GATE: rate test.** ✅ DONE 2026-06-29 (test token) — mechanics certified. Live $ is NOT a gate (ADR 0003); confirmed when the live token activates.
1. **Bin-packing (pure function, no side effects).** ✅ DONE 2026-06-29 — `packBoxes()` in index.html, 20/20 node tests. Order line items + Shopify weights → fewest boxes each <=20lb; >20lb / single-item-over-cap → halt-and-warn.
2. **Shippo rate+label on TEST token.** ✅ DONE 2026-06-29 — `api/shippo-label.js` (`?action=rate` | `label`), 16/16 node tests vs the real Shippo test API. Returns rate / tracking / ZPL label / cost / shippo_object_id. Deploy needs `SHIPPO_TOKEN` env.
3. **ZPL contents block.** ✅ DONE 2026-06-30 — `composeContentsZPL()` in index.html, 10/10 tests + Labelary 4x6 render. Separate 4x6 print per box. PENDING: on-hardware print test (Andy); fallback = paper slip.
4. **Shopify fulfillment write** (riskiest). ✅ DONE 2026-06-30 — `api/shopify-fulfill.js` (`fulfillmentCreate`, one fulfillment w/ all tracking, idempotent). Live-tested on throwaway order #6497: SUCCESS, both tracking on one fulfillment, email dispatched. PENDING: Andy confirms the email; grant the planner app the fulfillment scope before deploy.
4b. **Cost capture write.** ✅ DONE 2026-06-30 — `shipping_labels` table (RLS, anon insert/update, no public read; `unique(shippo_object_id)`). Capture-at-purchase in `api/shippo-label.js` (status `purchased`), status flip to `fulfilled` in `api/shopify-fulfill.js`. Non-blocking; e2e tested. See ADR [`0004`](./decisions/0004-cost-table-security-model.md). Deploy needs `SUPABASE_URL` + `SUPABASE_ANON_KEY` env.
5. **Wire the planner page UI** (open order → see split → confirm → print all → tracking back). Manual confirm = 1.0 backstop. ✅ DONE 2026-06-30 — **Slice A**: `?type=b2b-ship` per-order payload + weight resolver (grams→lb snapped to 0.25), integration-tested on #6486 → 6 boxes. **Slice B**: the `Ship` tab in `index.html` — open→pack→confirm rate→buy labels (partial-failure-safe, no double-buy)→print label+slip→fulfill (one email; `alreadyFulfilled`-aware)→tracking back. Preview-verified end to end against the documented API contracts (stubbed `fetch`); live token e2e + on-hardware print deploy-gated to Andy. Print mechanism → ADR [`0005`](./decisions/0005-print-trigger-mechanism.md).
6. **Switch from test token to live** only after 1-5 pass end to end. Confirm funding + live multi-zone $ first.

## Kill conditions
- Cubic rate comes back materially above ~$9-12 for typical SoCal zones → savings premise weakens; stop and re-evaluate vs. batching Pirate Ship + ShipStation for splits.
- Existing Shopify token lacks fulfillment-write scope AND re-scoping is blocked → the tracking-back half can't ship; rethink.
- Thermal printer can't render the appended ZPL contents block cleanly → fall back to a cheap paper contents slip.

---

## Amendments from Step 0 gate + pressure-test (2026-06-29)

These supersede or sharpen the body above; the body is left intact for provenance.

### Verified live on the Shippo TEST token
- **GA Cubic ceiling = 1.0 cu ft** (confirmed; Priority Mail Cubic's 0.50 cap is the easy-to-conflate trap). The 0.81 cu ft box qualifies on every order.
- **Rate object shape:** `object_id`, `amount`, `currency`, `provider`, `servicelevel.{token,name}`, `zone`, `estimated_days`, `duration_terms`, `attributes` (e.g. `CHEAPEST`/`BESTVALUE`), `carrier_account`, `test`. To buy a label: `POST /transactions/` with `rate` = the rate `object_id`.
- **`zone` IS returned** in the rate object → cost-capture `zone` needs no derivation.
- **Label format token is `ZPLII`** (not `ZPL` — that 400s). Label downloads as `.zpl`, valid `^XA…^XZ`, `^PW812^LL1219` = 4.0″×6.0″ @ 203 dpi. Markup contained `^FDCUBIC^FS` (backend applied cubic).
- **`tracking_url_provider`** (USPS tracking URL) is returned ready to pass into the Shopify fulfillment `url` field.

### Corrections to the plan
1. **Rate gate is a zone-distribution risk, not one number.** Box is in the **0.9 cubic tier** (expensive end). Live gate must quote a NEAR and a FAR zone against the real B2B account zone mix; judge the kill condition on that. See ADR [`0002`](./decisions/0002-cubic-rate-gate-strategy.md).
2. **`is_cubic` is DERIVED, not read** — no such field in the Shippo rate object. Compute from box dims (you own them); optional cross-check: grep the ZPL for "CUBIC".
3. **Cost-capture ordering fixed.** "Log only after fulfillment" contradicted "capture at purchase or lose forever." Resolution: write the row at purchase with `status: fulfillment_pending`, UPDATE to `fulfilled` after the Shopify write.
4. **Shopify = modern FulfillmentOrder GraphQL flow** (`fulfillmentCreate` against `fulfillmentOrderId`; REST `/fulfillments` deprecated). Confirm scope `write_merchant_managed_fulfillment_orders` (not just `write_fulfillments`). Multi-location inventory → multiple fulfillment orders → verify a real B2B order resolves to one before relying on "one email."
5. **Idempotency / double-notify guard.** Before writing/notifying, check whether the order is already fulfilled (covers the timed-out-but-succeeded retry case).
6. **"Stray USPS notice" is a Shippo account setting**, not code: don't pass the recipient email to Shippo and/or disable Shippo notifications. (USPS Informed Delivery is separate and uncontrollable.)
7. **Packer optimizes weight, not fit** — state plainly; human eyeball-confirm is the fit backstop. Halt-and-warn must also fire on any single item heavier than the cap.
8. **Concurrency:** two staff on one order → double label buy ($) + double fulfillment. One-printer MVP makes this low-risk; a cheap "already has labels?" check before buying closes it.

### Open decisions for Andy
- **Live cubic dollar: NOT a gate** (decided 2026-06-29, ADR 0003). Build proceeds on the test token; live $ is a tripwire checked at activation.
- **Net-vs-gross weight: RESOLVED** (Andy, 2026-06-29). A box of 4×5lb bags is **20 lb flat, no overage** — net = gross in practice. The packer's 20 lb cap on net weight stands; no tare margin. (`PACK_BOX.maxWeightLb` remains configurable if this ever changes.)
- **Weight source: RESOLVED** (Andy, 2026-06-29). Use Shopify's weight if present, else derive from the variant name. Resolver: prefer Shopify variant grams from the payload; fall back to `variantSortWeight(variant_title)` (handles "5lb"/"2lb"/"12oz").

### Known prerequisite (Steps 4–5) — ✅ RESOLVED 2026-06-30
- **Extend the Shopify b2b payload.** ✅ DONE — added `api/shopify-token.js?type=b2b-ship`: per-ORDER (not company-merged) with `order_id`/`order_name`, `shipping_address`, and `items[]` carrying `grams` + resolved `weight_lb` (grams→lb snapped to 0.25, variant-title fallback). Feeds packer + label + fulfill.

## Amendment — actual hardware is a Rollo, not a bare Zebra (2026-06-30)

Step 3 and Step 5 Slice B above describe ZPL printed via download/hand-off to a raw-ZPL Zebra (ADR 0005). The actual production hardware is a **Rollo thermal printer**, which shows up as a normal system printer and consumes standard PDFs/HTML at 4x6 — it does not need raw ZPL streamed to it. This corrects both print artifacts; **it is a locked decision, not a temporary one — do not revert toward ZPL in a future session.**

- **Shippo label is now PDF, not ZPL.** `api/shippo-label.js` requests `label_file_type: "PDF_4x6"` (was `ZPLII`); `label_url` resolves to a `.pdf`.
- **Contents slip is now HTML, not ZPL.** `composeContentsZPL()` is replaced by `composeContentsSlipHTML(box, opts)` — a fresh HTML/CSS layout (`@page { size: 4in 6in; margin: 0; }`), not a transliteration of the old ZPL layout.
- **Print step is two independent triggers per box**, not one combined action: **Open label** opens the Shippo PDF in a new tab — cross-origin, so the user prints it themselves from the system PDF viewer, picking the Rollo. **Print slip** injects the slip HTML into a hidden `<iframe srcdoc>` and calls `iframe.contentWindow.print()`, then removes the iframe. Label-before-slip stays the presentation order in the UI by convention; the two are not coupled.
- A low-key UI note tells the operator that Safari doesn't always auto-apply the `@page` size, so the first slip print may need a manual 4x6 pick in the print dialog.
- **Kill condition #3 ("thermal printer can't render ZPL cleanly → fall back to paper slip") is moot** — the Rollo never needed ZPL in the first place.

See ADR [`0006`](./decisions/0006-pdf-label-html-slip-print-mechanism.md), which supersedes ADR [`0005`](./decisions/0005-print-trigger-mechanism.md).
