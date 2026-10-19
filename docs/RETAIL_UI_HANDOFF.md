# Retail shipping UI: handoff spec for Claude Code

Repo: `/Users/andynewbom/Developer/Torque-Projects/torque-production-portal`.
Companion to `docs/PHASE_B_HANDOFF_PROMPT.md`. That file holds the locked rules and session rules. This file holds the approved screens, flow and click budget for the retail UI (slices B1, B3, B6 and the parts of B4 and B7 that touch the screen). Where this file and the plan doc's slice table disagree on screen behavior, this file wins. Where they disagree on rules, `RETAIL_SHIPPING_RULES.md` wins.

Design source (read-only reference, needs the Claude Design runtime to render): `docs/design/retail-ui/*.dc.html` and `canvas.json`. Published canvas: https://claude.ai/artifact/NJ54mJZbNPoWFKphE96Q8K. Process outline doc: https://claude.ai/artifact/FDcsPZ2ubp58yqft6S26A5.

Andy (handle "wombat") co-owns Torque. Style: direct, concise, data first, no affirmations. Verify against live data. Ask when unclear; batch questions.

## 1. What is being built

A Retail tab, separate from the B2B Ship tab. B2B shipping is unchanged. Retail is batch-based: Andy or a packer selects a group of retail orders, one action buys UPS Ground labels (Shippo) and prints label plus slip, packing happens from cards, one confirm writes tracking to Shopify, Shopify sends the customer email, and the orders close.

Click budget (acceptance criterion): from the open Retail tab, **select (or Select all), then Buy and print = 2 clicks** to get labels and slips. After packing, Fulfill is 2 clicks (button, then confirm). No other step is required on the happy path.

## 2. Decisions locked in design review

| # | Decision |
|---|---|
| D1 | The portal never auto-selects orders. Which orders ship needs judgment. A Select all control exists. |
| D2 | The queue shows the coffees on every line (name, size, quantity). Without them nobody can judge whether an order can ship. |
| D3 | No quote, paid or net columns in the queue. No SUBSCRIPTION or COLLECTIVE chips. |
| D4 | Chips appear only when they change what the operator does: REPLACEMENT (with reason), NOTE, order age, address problem. |
| D5 | Address problems that B0 refuses at purchase (P.O. box, street line over 35 characters) are detected at list time and shown in a "Needs a fix" group. Rows there cannot be selected. |
| D6 | Quotes are fetched when Buy and print is tapped, not on a separate Rate step. |
| D7 | Review screen opens only when an order has no UPS rate. If every order has a rate it never shows. Quote amounts are not judged against a norm in this version (out-of-range flagging is deferred, see section 9). |
| D8 | Buying and printing are one step. One PDF (label then slip per order, sorted by carton) opens in a new tab when buying finishes. Open PDF and Reprint remain as fallbacks. Reprint never buys. |
| D9 | Pack cards start fully included. Per card: Reprint and Hold back. No per-card ticking required. |
| D10 | One Fulfill button for the batch, then a confirm: "N of N packed. Send N customer emails?" |
| D11 | A Done screen ends the batch: N shipped, N emails sent, N parcels for pickup, N still open. |
| D12 | A batch left open shows a Resume banner on the queue. |
| D13 | Bagging-to-Retail linkage was dropped. A batch coffee-totals sheet was dropped (the Bagging screen is the pick list). Do not build either. |

## 3. Screens

Header and tab bar follow the existing portal shell. Retail is a tab. Tokens: cream `#FFFEF0`, cream-dark `#EDEAE0`, black `#100000`, orange `#E58825`, amber light `#FDF3DC`, red light `#FBE7E4`, red ink `#7a2a20`, green ink `#0F5A29`. Hepta Slab for display, Helvetica for body. 2px black borders, pill buttons. Match the existing portal CSS where it already defines these.

### 3.1 Queue (`Main.dc.html`)
- Top: Resume banner (only when a batch is open): "Batch in progress: N packed, N to go" with Resume batch.
- Title row: counts (N ready, N need a fix, N on hold), "Synced just now", Refresh orders.
- Action bar: "**N selected** of N ready · N billed lb" and the primary button "**Buy and print N labels · ~$total**". The dollar figure is an estimate. Source for the estimate is open (section 8).
- Table: checkbox column with a header Select all, then Order, Ship to, Coffees, Carton, Check (chips).
- Rows grouped by carton with group headers: 8x6x3 (1 × 12oz), 12x8x6 (2 to 4 × 12oz, single 2lb or 5lb, 2 × 2lb, 12oz + 2lb), 14x10x10 (everything else, one label).
- "Needs a fix" group sits at the top, rows disabled, chip shows the reason and the fix ("Fix in Shopify").
- Hold card at the bottom: "Hold (N)" with Show hold list.
- Default state: nothing selected. The mock shows some rows ticked to illustrate the bar; build it with none ticked.

### 3.2 Review (`Rated.dc.html`)
Only for orders with no rate. Row: order, ship to, coffees, carton, "none", chip "No rate · address not valid", actions Open in Shopify and Re-rate. Bottom bar: "N will be bought" and "Buy and print N labels · $total". Anything not bought returns to the queue. Never buy another service or carrier for a no-rate order.

### 3.3 Buy and print (`Buying.dc.html`)
Progress bar and counts (bought, in progress, not bought). Row statuses: Waiting, Buying, Bought, Not bought with the reason. PDF card: Open PDF, Reprint. One failure does not stop the rest. If UPS now prices a row above the quote shown, the 409 price guard fires: that row is Not bought, Re-rate that row, then Buy again for it alone. The "price changed" row on #8303 in the mock is illustrative.

### 3.4 Pack (`Pack.dc.html`)
Three-column card grid, sorted by carton. Card: order, ship to, carton chip, coffee lines, Reprint, Hold back. A held card is dashed and grey, with "Stays open" and an Include button. Header shows "N packed", "N held back". Fulfill button: "Fulfill N orders". The confirm sheet follows.

### 3.5 Fulfill confirm
"N of N packed. Send N customer emails?" Body: writes UPS tracking to Shopify for N orders, Shopify sends one shipping email each, held-back orders stay open. Buttons Back and "Fulfill and send".

### 3.6 Done (`Done.dc.html`)
Four counts: Shipped, Customer emails sent, Parcels for pickup, Still open. Note for any held-back order with Show in queue. "Done for you" card: tracking written, orders closed, cost rows saved. Buttons: Back to queue, Reprint this batch.

### 3.7 Exceptions (`Exceptions.dc.html`)
- Red banner at the top of the Retail tab when an order is paid and bought but not fulfilled: Retry fulfill, Clear (fulfilled by hand in Shopify).
- Hold list: order, ship to, reason, Open in Shopify, Shipped by hand. Six examples from fixtures: #7482, #6889, #8293, #7297, #7248, #7349.
- Needs a fix, Replacement orders (REPLACEMENT chip with reason from the discount code, unselected like every order).
- Void a label: voids through Shippo, marks the cost row voided, returns the order to the queue. If Shippo refuses because UPS already scanned it, the label stays and the order is flagged for the incident log.
- Held back after buying (proposed, to confirm): see section 8.
- Log a bad order: marked Proposed, not in B1 to B7. Do not build unless Andy asks.

## 4. Order state machine

`listed → selected → quoted → bought → packed → fulfilled` (closed).
Side states: `needs_fix` (address, unselectable), `hold` (R-rule reasons, never partial), `no_rate`, `not_bought` (purchase failed or price guard), `held_back` (bought, not fulfilled, stays open), `voided` (returns to listed).
A reload or second device must show bought labels as bought and never buy again (one label per box; the price guard and existing purchase idempotency already cover the money side). The Resume banner needs persisted batch membership. See section 8.

## 5. Rules the UI must enforce (all from locked docs)

- UPS Ground only. No rate means no label.
- Billed lb = ceil(net + carton tare + 0.05), 1 lb minimum, whole pounds sent to Shippo with `weight_basis`.
- Carton table and tares per `PHASE_B_HANDOFF_PROMPT.md`. Over 30 bag-equivalents goes to hold.
- Max 25 orders per batch (selection cap behavior is an open item).
- No partial shipments: an order with any held line holds whole.
- Pickup, B2B, cancelled and no-shipping orders never list. Replacement drafts list with the REPLACEMENT flag.
- Collective orders ship from Torque (`variant.product.vendor` test).
- Subscription lines are shown with the coffee for the weekly schedule through the existing `applySubscriptionSubstitution`. Verify it can be called from the list path. If it cannot, show the subscription product name and tell Andy.
- Shopify sends the single customer email at fulfillment. The company in tracking is written as "UPS".
- B0 server refusals stay: P.O. boxes, street lines over 35 characters, non-whole-pound weight, missing `weight_basis`. The queue pre-checks the first two so they never reach purchase.

## 6. Mapping to slices (proposed; confirm against the plan doc table)

| Slice | UI content |
|---|---|
| B1 retail order list | Queue (3.1): list, coffee lines, carton groups, Hold list, Needs a fix group, chips, Select all, selected count and billed lb, Refresh. No buying. |
| B2a, B2 | Pure functions. No screen. Chips and group headers read their output. |
| B3 batch ship screen | Split in two. B3a: Buy and print, Buying screen, PDF open and Reprint, Review for no-rate. B3b: Pack, Hold back, Fulfill confirm, Done, Resume banner, Retry fulfill banner. |
| B4 slip | The PDF contents (label then slip per order, sorted by carton). Layout per `retail_slip_spec.md`. |
| B5 cost report | Cost row written per purchased label (shown on Done as "cost rows saved"). |
| B6 void and refund | Void a label (3.7), per-card Reprint, Retry fulfill. Must exist before the first full week of live retail. |
| B7 cutover | Dry-run quotes within $0.05 of A5 fixtures, then the 3-label live test. |

## 7. Test fixtures used in the mock screens

Real orders: #8331 (subscription), #7133 (Collective), #8255 (xPods), #8291 (replacement, Mis ship), #8333, #8322, #8301 (the no-rate example), #8316, #8289, #8298, #8303, #7550, #8306, #8290, #7388, #8275. Hold: #7482, #6889, #8293, #7297, #7248, #7349. Rows marked `[example]` in the mock stand in for states the fixtures do not contain (NOTE, order age, P.O. box, street over 35 characters). Build real test cases for those from synthetic orders, not from the placeholders.

## 8. Open items (decide before or during the slice; do not guess)

1. **Batch persistence.** The Resume banner and "N packed, N to go" need batch membership stored. Confirm with Andy where (new Supabase table or existing cost rows) before B3b. Table grants in `cost_report_spec.md` section 4 still need Andy's explicit decision.
2. **Held back after buying.** Proposed: the label stays bought, the order stays open, shows in the queue as bought, not fulfilled, and ships next batch without a second purchase. Confirm with Andy.
3. **25-order cap.** Select all and ticking past 25: proposed behavior is to stop at 25 with a visible message. Confirm.
4. **Age chip threshold.** "Older than N days": N not set. Ask Andy.
5. **NOTE chip source.** Proposed: Shopify order note present. Confirm the field.
6. **Estimate in the action bar.** Source for the ~$ total (A5 fixtures table versus a live quote) is not decided. If no good source exists before quotes, drop the dollar figure from the queue and show the total on Buying.
7. **Daily routine** (who runs it, cutoff, Rollo versus AirPrint, UPS pickup fee, account, Saturday coverage) is Andy's decision, handled outside code. Not a blocker. Printer choice affects only PDF page size.

## 9. Deferred (do not build now)

- Out-of-range quote flagging (Andy: ignore for now). Do not add quote tolerance, norm tables or surcharge chips.
- Quote, paid and net columns, and profit display on the queue.
- Scan-to-pack verification.
- Log a bad order screen.
- Bagging-to-Retail grouping and a batch coffee-totals sheet (dropped).

## 10. Acceptance checks for the UI

1. Fresh load: no row selected, Buy and print disabled until at least one is selected.
2. Select all ticks every selectable ready row, not Needs a fix rows and not Hold rows (subject to open item 3).
3. Open to labels in hand: open tab, Select all, Buy and print (2 clicks) opens one PDF with a label then slip per order, sorted by carton.
4. A P.O. box or 36-character street line appears under Needs a fix, unselectable, and never reaches Shippo.
5. A no-rate order opens Review with only that row; every other order is already queued to buy.
6. Reload mid-batch shows bought labels as bought and buys nothing twice.
7. Hold back leaves an order open with its label intact. Fulfill N of N writes tracking for exactly the included orders and sends no second email on retry.
8. Done counts equal the actual Shopify fulfillments.
9. Void before scan returns the order to the queue and marks the cost row voided.
10. All 30 `acceptance_fixtures.json` fixtures still pass; B2B Ship tab behavior is unchanged.

## 11. First action in Claude Code

Read `PHASE_B_HANDOFF_PROMPT.md`, this file and the design files in `docs/design/retail-ui/`. Reply with the B1 plan, test gates and one batch of questions drawn from section 8. Do not start code until Andy says go. Session rules (plan before slice, tests then adversarial review then approval, no label purchase outside an approved test) are in `PHASE_B_HANDOFF_PROMPT.md`.
