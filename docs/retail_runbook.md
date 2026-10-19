# A8 retail_runbook.md: daily retail shipping routine

Status: DRAFT. Sections marked OPEN need Andy's input before go-live. Steps assume the portal built in Phase B (slices B1 to B6).

## 1. Daily batch

1. Open the portal Retail tab. The list shows eligible orders only (rules R1). Pickup orders do not appear. Held orders appear in a separate "Hold" list with the reason.
2. Review the Hold list. For each: fix in Shopify, ship by hand, or leave. Never ship part of an order.
3. Select up to 25 orders (or Select all, which takes the oldest 25). Check each row's carton; the bar shows the total billed lb.
4. Tap Buy and print. Each order is quoted and bought at once (UPS Ground only), at the address Shopify has now; one PDF opens in a new tab, label then slip per order, sorted by carton. Go back to the portal tab to watch the Buying screen. An order with no rate, a price that rose, or a refusal is not bought and shows why: fix the address in Shopify and Re-rate, or Try again. Anything not bought returns to the queue. Open PDF and Reprint print again and never buy; a bought order also has Reprint on the queue. A row that says "Bought, not recorded" must not be bought again: tell Andy. (B3a, ADR 0028.)
5. Pack: pick the carton shown on the slip, pack, apply the label, check the order number on label and slip match.
6. Click Fulfill all after labels are applied. Shopify sends the one customer shipping email.
7. Repeat for the next batch of 25.

Who runs the batch, the daily cutoff and the printer are decided in Claude Design (Andy, 2026-10-17), not here.

## 2. Wrong label (void)

1. Before the label has been scanned, open the order in the portal and click Void (slice B6). The label is voided through Shippo and the cost row is marked voided.
2. Rate and buy again.
3. A void that Shippo refuses (already scanned) is logged as a bad order (section 6) and the label stays on.

## 3. Lost or damaged package

1. Confirm the tracking shows no movement or a UPS exception.
2. File a claim with UPS for the tracking number. OPEN: UPS claim route (ups.com or Shippo) and filing window to be confirmed with the UPS rep.
3. Ship a replacement (section 4) and log the order as bad (section 6).

## 4. Replacement order

1. Create a draft order in Shopify: catalog lines, no company, 100% discount code naming the reason (Missing item, Wrong bag, Re-Ship, and so on), no shipping line, address present.
2. It lists in the Retail tab flagged REPLACEMENT with the reason (A2: 12 in 90 days). Ship as normal.
3. Log in the incident log.

## 5. UPS pickup

OPEN (ask Shippo or UPS before cutover). UPS Daily Pickup is a contracted driver visit at the same time each shipping day. Shipping runs 6 days a week. Undecided: which account the pickup attaches to (labels are bought on Shippo's UPS account, not a Torque-held one), the real weekly fee ($18/week is a placeholder), and whether Saturday is covered at the same fee. Do not rely on a pickup until these are set. Packages stay in the pickup location with labels applied.

## 6. 90-day incident log

One row per bad retail order (wrong item, wrong address, damaged, lost, late claim, replacement). Baseline: 1 to 2 bad orders per week and 1 to 2 lost-package replacements (2 bags) per month. Day-90 test: bad orders have fallen by half or more, otherwise retail moves back to USPS and B2B stays on UPS.

| Date | Order | State | Cause (carrier / address / packing / other) | Cost ($) | Resolution |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## 7. Checks

- Monthly: UPS invoice vs captured label cost. Variance above 3%: review tare and allowance.
- First two weeks: same-day cause note for every bad order.
