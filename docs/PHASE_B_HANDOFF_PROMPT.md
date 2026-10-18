# Phase B handoff: build retail UPS Ground into the portal

Run in Claude Code, in the portal repo: `/Users/andynewbom/Developer/Torque-Projects/torque-production-portal`.
Phase A source folder: `/Users/andynewbom/Developer/Torque-Projects/USPStoUPS`.
Andy copies the Phase A files from the source folder into the repo's `docs/` folder before the session (list below). If any are missing from `docs/`, read them from the source folder.

## Context
- Torque Coffee moves all shipping, B2B and retail, from USPS to UPS Ground, bought through the production portal on the Shippo UPS account.
- Phase A (done) wrote the rules and data. You build them. Read `docs/RETAIL_SHIPPING_RULES.md` first (R1 to R14, evidence, resolved decisions). `docs/Retail-USPS-UPS.md` holds the plan, the Phase B slice table, and the test gates and cutover section.
- Andy (handle "wombat") co-owns Torque. Style: direct, concise, data first. No affirmations, no editorializing, no allegories. Verify against live data; ask when unclear; batch questions. Show temperatures in °C and °F.

## Read before coding
1. `docs/RETAIL_SHIPPING_RULES.md`
2. `docs/Retail-USPS-UPS.md` (sections: Phase B slices, Test gates, cutover and rollback)
3. `docs/oversize_rule.md` (A4, approved), `docs/carton_weights.csv` (A3), `docs/retail_catalog.csv` (A1), `docs/order_types.md` (A2)
4. `docs/retail_slip_spec.md` (A7, approved) and `docs/b2b_slip_spec.md`, with `retail_slip_sample.pdf` and `retail_slip_sample_b2b.pdf` as the visual targets
5. `docs/cost_report_spec.md` (A9), `docs/retail_runbook.md` (A8), `docs/shipping_margin.md` (A6)
6. `docs/acceptance_fixtures.json` (A10, 30 orders) and `docs/ups_ground_fixtures.csv` (A5, 72 rows) as the test oracle
7. The repo's own project doc, ADRs (especially 0004, 0011, 0018), test gates and adversarial-review process. Follow them.

## Locked rules (do not reopen)
- UPS Ground only. Billed lb = ceil(net + tare + 0.05), 1 lb minimum. Tares: 8x6x3 0.156, 12x8x6 0.42, 14x10x10 0.83. Net: 12 oz 0.75, 2 lb 2.03, 5 lb 5.07.
- Carton table: 1x12oz -> 8x6x3. 2/3/4 x 12oz, 12oz+2lb, 2x12oz+2lb, 1x2lb, 2x2lb, 1x5lb -> 12x8x6. Everything else -> 14x10x10, including 1x2lb + 1x5lb. A 5 lb bag ships alone. Over 6 lb ships in the 14x10x10. Over 30 bag-equivalents goes to hold.
- 250 g box and xPods count as 12 oz. Ignore gift and `thank-you-note`.
- Collective orders ship from Torque (R1 tests `variant.product.vendor`, not `lineItem.vendor`).
- Replacement and comp drafts are listed with a REPLACEMENT flag.
- Customer shipping prices unchanged ($8, free at $50 and over). Not a code item.
- Daily routine (who, cutoff, printer) is handled in Claude Design, not code.
- Uline boxes are tabled until January. No carton research, dimensional-weight analysis or new-box work.
- Pickup items are open (fee, account, Saturday). Not a blocker.

## Slices (one at a time; each ships on its own)
B0 B2B cutover and safety, B1 retail order list, B2 `packRetail()`, B3 batch ship screen, B4 retail packing slip, B5 cost report, B6 void and refund, B7 retail cutover. Done-when criteria are in the plan doc table.

Order of work: B0 alone first (ships before any retail work). Then B1, B2, B3. B6 must exist before the first full week of live retail.

## Rules for this session
- Before each slice: state the plan and the test gates; wait for Andy's go.
- After each slice: tests pass, then an adversarial review pass, then Andy approves before merge.
- Money and labels: never buy a label outside an explicit test Andy has approved. First live buys follow the cutover steps (3 labels, one per carton, void, confirm refund). Use test mode until B0 confirms the live token.
- Shopify and Supabase: read-only unless a slice says otherwise and Andy approves. Supabase table grants flagged in `cost_report_spec.md` section 4 need an explicit decision from Andy before any change.
- Pure functions (`packRetail()`, R1/R1a filtering, billed-lb math) get unit tests built from `acceptance_fixtures.json`. All 30 fixtures must pass.
- Dry-run quotes must land within $0.05 of A5 fixtures (B7).
- Do not guess. If a rule is missing or conflicts with live data, stop and ask.

## First action
Confirm the `docs/` files are present, read them, then reply with: the B0 plan, the test gates, and any questions in one batch.
