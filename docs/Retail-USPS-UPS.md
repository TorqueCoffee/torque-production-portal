# Retail shipping switch: USPS to UPS Ground

Oct 16, 2026 · @wombat

Move all Torque shipping, B2B and retail, to UPS Ground bought through the production portal, at about $420 more per month. Phase A (a Claude coworker session) writes the rules and data; Phase B (a Claude Code session) builds them into the portal.

## Decision and cost

All shipping moves to UPS Ground (never Ground Saver) through Shippo labels bought in the portal. All-in label cost is about $2,730 per month on UPS against about $2,310 on USPS. Fellow's one-time volume is excluded.

| Line | USPS today | UPS Ground | Difference |
| --- | --- | --- | --- |
| Retail, non-Fellow (190 orders/mo) | $1,515 | $1,730 | +$215 |
| B2B (about 29 orders/mo) | $796 | $923 | +$127 |
| UPS Smart Pickup ($18/week) | $0 | $78 | +$78 |
| **Total** | **$2,311** | **$2,731** | **+$420** |

If the multi-bag and larger-bag retail boxes bill one pound heavier than modeled, the gap is about +$515 per month. Shippo's rep says UPS direct would not beat Shippo's rates, so there is no discount lever in this plan.

**Pass/fail test at 90 days.** Log every bad retail order (date, order, state, cause, cost). Baseline is 1–2 bad orders per week and 1–2 lost-package replacements (2 bags) per month. If bad orders have not fallen by half or more at day 90, move retail back to USPS and keep B2B on UPS.

## Fixed facts

Both phases use these as given.

| Item | Value |
| --- | --- |
| Ship-from | 3459 El Cajon Blvd, San Diego, CA **92104** (confirmed by Andy). The portal code is right. Any note that says 92105 is wrong (Andy, 2026-10-17: 92104, ignore anything else). The portal's origin phone is 6192305400 (set in B0, 2026-10-17; was the placeholder 6195551234). |
| Service | UPS Ground only (Shippo token `ups_ground`). No Ground Saver (UPS says it "may be delivered by UPS or the USPS"). No fallback to USPS. |
| Label source | Shippo API, UPS carrier account `21db4cf80df74a2cb27fc20948862003`. Shippo rates are reference rates; UPS invoices can differ. |
| UPS billing | Actual weight rounded up to the next whole pound, 1 lb minimum. Dimensional weight applies only at 1,728 in³ or more; every carton below is smaller. |
| Cartons | 8x6x3 (about $1.05; weight not yet measured, 0.15 lb assumed). Uline S-19064 12x8x6 ($0.67, 0.42 lb). Uline S-4144 14x10x10 ($1.12, 0.83 lb). |
| Carton use | 1 × 12 oz bag → 8x6x3. 2–4 × 12 oz bags or one 5 lb bag → 12x8x6. A single 2 lb bag is assumed to fit; A3 confirms. Larger orders: rule to be set in Phase A. |
| Packed weight | One 12 oz bag in the 8x6x3 is about 12.6 oz, billed as 1 lb. A 2-bag box is about 2 lb, right on a billing line; measure it. |
| Pickup | UPS Smart Pickup, $18 per week. |
| Customer email | Sent only by Shopify on fulfillment. The portal passes no recipient email to Shippo. |
| Pickup orders | Orders marked as pickup in Shopify must not appear in the ship list. |

## Phase A: coworker session (rules and data)

Run in a Claude coworker session with the Shopify, Shippo and Supabase connectors. It writes no portal code. Output is one rules file, `RETAIL_SHIPPING_RULES.md`, plus the data files below, all saved to the portal repo's `docs/` folder by Andy for the Phase B session to read.

| # | Task | Source | Output file |
| --- | --- | --- | --- |
| A1 | Catalog audit: every product and variant with vendor, SKU, grams, weight parsed from the title, ships or not, 12 oz bag-equivalents, carton class. Flag any variant with no grams and no oz/lb in its title (the portal marks those unpackable). | Shopify | `retail_catalog.csv` |
| A2 | Order-type audit over the last 90 days: the exact Shopify fields that identify pickup, local delivery, gift, subscription, Fellow Collective, mixed-vendor, international and HI/AK/PR orders, with a count of each. | Shopify | `order_types.md` |
| A3 | Carton weights: Andy weighs an empty 8x6x3, and packed boxes of 1, 2, 3 and 4 × 12 oz, one 2 lb bag and one 5 lb bag. Confirm the 2 lb and 5 lb bags fit the 12x8x6. Set a tare per carton and a packing allowance. | Andy | `carton_weights.csv` |
| A4 | Oversize orders: list every combination from the last 90 days that does not fit the 12x8x6 (about 5% of retail). Propose a rule: ship in the 14x10x10, or split into two labels. Cost of each option by zone. | Shopify, Shippo | `oversize_rule.md` |
| A5 | Rate fixtures: re-quote UPS Ground for 12 destination groups at 1–10 lb and store with the date. The seed table is in Reference data. | Shippo | `ups_ground_fixtures.csv` |
| A6 | Shipping charged vs label cost: compare what customers pay (mostly $5 or $8 flat) with UPS cost by zone and carton. Report the gap; change nothing. | Shopify, Shippo | `shipping_margin.md` |
| A7 | Packing slip spec for a 4x6 page: fields (customer name, order number, line items, gift or order note, subscription marker), layout, one sample built from a real order for Andy to approve. | Andy | `retail_slip_spec.md` |
| A8 | Daily runbook: batch, print, pack, fulfill; voiding a wrong label; lost-package claim; replacement order; UPS pickup; the 90-day incident log template. | Andy | `retail_runbook.md` |
| A9 | Cost report spec: columns, joins to Shopify shipping charged, monthly summary, who can read it. | Supabase | `cost_report_spec.md` |
| A10 | Acceptance fixtures: 30 real recent orders with the expected carton, billed weight and rate range, covering every order type found in A2. | Shopify, Shippo | `acceptance_fixtures.json` |

Phase A is done when the rules file has no open questions, Andy has approved A4 and A7, and the fixtures in A10 are complete.

## Draft rules for Phase A to confirm

Starting positions only. Phase A checks each against real orders and either confirms or changes it.

| Rule | Draft |
| --- | --- |
| R1 Eligible order | Open and unfulfilled, not cancelled, ships to a US address outside HI, AK and PR, delivery method is not pickup or local delivery, no company name on the address (company orders are B2B), and every shippable line is vendor Torque Coffees. |
| R1a Not eligible | Hold in a review list with the reason, never ship partially: mixed-vendor orders, pickup and local delivery, HI/AK/PR and international, lines with no usable weight. |
| R2 Carton | One 12 oz bag → 8x6x3. Two to four 12 oz bags, one 5 lb bag, or one 2 lb bag (fit to be confirmed in A3) → 12x8x6. Anything larger → the oversize rule from A4. Choose by physical fit first, weight second. |
| R3 Billed weight | Net weight + carton tare + packing allowance (0.05 lb), declared to Shippo and shown on screen as the billed pound count. Never declare net weight alone. |
| R4 Service | `ups_ground` only. If no rate comes back, stop and show the error; never buy another service or carrier. |
| R5 Address | Validate through Shippo; residential flag on unless the address has a company; require a phone number or use the Torque phone as fallback. |
| R6 Email | Pass no recipient email to Shippo. Shopify sends the one shipping email. |
| R7 Fulfillment | Write UPS tracking to Shopify with company "UPS" only after the label printed and Andy confirmed. Notify once; a retry never notifies twice. |
| R8 Cost capture | One `shipping_labels` row per label with cost, zone, carton, billed pounds and channel (retail or b2b). Failure to log never blocks a shipment. Reconcile against the UPS invoice monthly. |
| R9 Batching | Up to 25 orders per batch. A failure on one order does not stop the others, and a reload never re-buys a bought label. |
| R10 Fellow and zero-weight lines | Weight comes from Shopify grams, then the oz or lb in the variant title. Zero grams with a usable title is fine; neither is a hard stop. |

## Phase B: Claude Code build slices

Run in a Claude Code session in the `torque-production-portal` repo after Phase A is done. Read `RETAIL_SHIPPING_RULES.md` and the Phase A data files first, then follow the repo's own process (project doc, test gates, adversarial review before each merge). Build one slice at a time; each slice ships on its own.

| # | Slice | What changes | Done when |
| --- | --- | --- | --- |
| B0 | B2B cutover and safety | Built 2026-10-17 (ADR 0020): live token confirmed; real origin phone; every order UPS Ground on the pinned US account, enforced on the server; B2B declared weight = ceil(net + 0.83 + 0.05); weight from title before grams (R10); price guard on purchase; fulfillment only with 1Z numbers; `.vercelignore` allowlist (ADR 0022); `node --test` harness (ADR 0021). ADR 0018 superseded. | A real B2B order rates and buys UPS Ground; rate matches Shippo quote. |
| B1 | Retail order list | New `type=retail-ship` in `api/shopify-token.js`, applying R1 and R1a. Return delivery method, shipping charged and the hold reason. | Fixture orders from A10 list or hold exactly as expected, including pickup. |
| B2a | Shared ship rules | Create `lib/ship-rules.js`, written to load both as a browser `<script src="/lib/ship-rules.js">` (a `ShipRules` global) and through `require('../lib/ship-rules.js')` (CommonJS). Move into it: `resolveWeightLb`/`weightFromTitle` and `isShippableB2BLine` from `api/shopify-token.js`; `PACK_BOX`, `SHIP_UNIT_OVERRIDES`, `expandShipItems`, `packBoxes`, `packAggregate`, `MEASURED_NET_LB`, `CARTON_TARE_LB`, `PACK_ALLOWANCE_LB` and `declaredWeightLb` from `index.html`. Then: add `!lib` to `.vercelignore` and amend ADR 0022; have `tests/syntax.test.js` cover `lib/`; teach `tests/helpers/index-html.js` to load `lib/` so page tests keep working; have `api/shippo-label.js` fetch the order from Shopify by `order_id`, re-pack it, and refuse a label whose weight doesn't match its `box_index`. | One copy of each rule; the server refuses a page-sent weight that differs from its own. |
| B2 | Retail packer | New pure function `packRetail()` for R2, R3 and the oversize rule, in `lib/ship-rules.js` (B2a). `packBoxes()` (moved to lib in B2a) stays the B2B packer. B2B tare is already done (B0); the retail cartons (8x6x3 0.156, 12x8x6 0.42) remain. | Unit tests pass for all 30 fixture orders: carton, billed pounds. |
| B3 | Batch ship screen | Retail tab: list with carton, billed pounds, estimated cost; multi-select; rate all; buy all; one combined PDF in packing order; fulfill all. Reuse the in-flight recovery from ADR 0011 per order. | 25 orders move through rate, buy, print and fulfill with one forced failure that does not stop the rest. |
| B4 | Retail packing slip | New slip layout in `api/ship-doc.js` per A7, label and slip interleaved per order. | Andy approves a printed sample on the Rollo or AirPrint printer. |
| B5 | Cost report | Server-side read of `shipping_labels` (ADR 0004 blocks public reads). Add carton, billed pounds and channel columns. Join Shopify shipping charged. Monthly summary of label cost, shipping charged and difference per order. | Report totals match the sum of Shippo transactions for a test week. |
| B6 | Void and refund | Endpoint and button to void an unused label through Shippo and mark the row voided. | A bought test label is voided and refunded. |
| B7 | Retail cutover | Rate-only dry run on 50 recent orders, then live per the next section. | Dry-run quotes within $0.05 of A5 fixtures. |

B0 can ship before any retail work. B1 to B3 are the core; B4 to B6 can follow in any order, but B6 should exist before the first full week of live retail.

## Test gates, cutover and rollback

Retail goes live in four steps, each gated by the one before it.

1. **B2B first.** B0 ships alone. Watch the first 5 B2B UPS shipments for tracking, the Shopify email and the cost row.
2. **Dry run.** Rate 50 recent retail orders through the portal without buying. Compare carton, billed pounds and quote to the A10 fixtures and A5 rates. Any mismatch is fixed before a label is bought.
3. **First live labels.** Buy 3 labels (one of each carton), print on the real printer, void them, and confirm the refund and the cost row. Then fulfill one internal $0 order to check tracking and the email.
4. **Live.** Ship retail through the portal for one week while Shopify Shipping remains available. After that, stop using Shopify Shipping labels for retail.

**Rollback.** Shopify Shipping USPS labels stay available. Reverting retail is a process change, not a code change. B2B stays on UPS in any case.

**Ongoing checks.**

- Monthly: compare the UPS invoice to the captured label costs. Variance above 3% means the tare or packing allowance is wrong.
- Day 90: the pass/fail test in the first section, using the incident log from the runbook.
- Any bad retail order in the first two weeks gets a same-day note on cause (carrier, address, packing).

## Reference data

**UPS Ground quotes (USD), Shippo, 2026-10-16.** Quoted from ZIP 92105, to a residential address. Phase A re-quotes from 92104. A dash means not quoted. 1 lb is the 8x6x3 carton, 2–5 lb the 12x8x6, 10 lb the 14x10x10. These are reference rates.

| Destination | 1 lb | 2 lb | 3 lb | 4 lb | 5 lb | 10 lb |
| --- | --- | --- | --- | --- | --- | --- |
| San Diego 92101 | 6.56 | 7.56 | – | – | 8.68 | – |
| Los Angeles 90012 | 6.56 | 7.56 | 8.24 | 8.37 | 8.68 | 8.79 |
| Goleta 93117 | 6.68 | 7.69 | – | – | 9.31 | – |
| Fresno 93722 | 7.01 | 7.93 | – | – | 10.38 | – |
| San Francisco 94105 | 7.12 | – | – | – | – | – |
| Denver 80202 | 7.67 | 8.17 | 9.57 | 10.39 | 11.11 | 13.87 |
| Dallas 75201 | 8.53 | 9.50 | 11.21 | 11.98 | 12.68 | 16.50 |
| Chicago 60601 | 8.80 | 9.93 | 11.88 | 13.11 | 14.01 | 19.00 |
| New York 10001 | 9.34 | 10.79 | 13.00 | 14.27 | 15.31 | 20.71 |

Other cities that price the same at 1 lb: Phoenix and Las Vegas as Fresno ($7.01); Portland as Denver; Seattle and Oklahoma City as Dallas; Minneapolis and Nashville as Chicago; Orlando, Atlanta, Boston, Detroit, Columbus and Charlotte as New York.

**Retail mix, Sep 16 to Oct 16 (non-Fellow).**

| Order type | Orders | Carton |
| --- | --- | --- |
| One 12 oz bag | 84 | 8x6x3 |
| Two to four 12 oz bags | 52 | 12x8x6 |
| One 2 lb or 5 lb bag (38 are 2 lb) | 44 | 12x8x6 |
| Heavier (1.4–2.4 kg net) | 10 | oversize rule |
| Excluded: over 9 kg (3), HI or AK (2) | 5 | manual |

California is 99 of the 190 modeled orders. Andy's carton rule names the 5 lb bag; most single-bag orders are 2 lb bags, so Phase A must confirm a 2 lb bag fits the 12x8x6.

**Fellow Collective** (one-time): 676 orders in 30 days, 89.5% one bag, flat $6.29 shipping paid by Fellow, order weight recorded as zero in Shopify.

## Open decisions for Andy

1. **Oversize orders (about 5%).** Ship in the 14x10x10, or split into two labels? Phase A prices both in A4.
2. **Mixed-vendor orders.** Hold for manual handling (the draft rule), or ship the coffee lines and handle the rest separately?
3. **Local delivery.** Pickup orders are excluded. Does any local delivery run through Shopify? A2 will look.
4. **Customer shipping prices.** Retail customers mostly pay $5 or $8; the UPS label averages $9.11. Decide after A6 whether to change the rates.
5. **Fellow Collective if it returns.** Ship through the same flow, with weight taken from the variant title?
6. **Daily routine.** Who runs the batch, at what cutoff time before the UPS pickup, and on which printer?
