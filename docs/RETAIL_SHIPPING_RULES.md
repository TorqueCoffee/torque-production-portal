# RETAIL_SHIPPING_RULES.md: retail UPS Ground rules for Phase B

Built 2026-10-17. Evidence files in the same folder. Counts are 90 days (2026-07-19 to 2026-10-17) / 30 days, Fellow excluded, from Shopify via `all_orders.txt` and live queries.

Fixed facts (plan doc): ship-from 3459 El Cajon Blvd, San Diego CA 92104; service `ups_ground` only; Shippo UPS account `21db4cf80df74a2cb27fc20948862003`; UPS bills actual weight rounded up to the next pound, 1 lb minimum; customer email sent only by Shopify on fulfillment.

## Rules

**R1 Eligible order (changed).** Test live Shopify values at list time:
- `cancelledAt` null; `displayFulfillmentStatus` UNFULFILLED; `displayFinancialStatus` not REFUNDED (#7453 is unfulfilled and refunded).
- `fulfillmentOrders.deliveryMethod.methodType` = SHIPPING (not PICK_UP, NONE, LOCAL).
- `shippingAddress.countryCodeV2` US and `provinceCode` not HI, AK, PR, AA, AE, AP.
- `shippingAddress.company` empty (company orders are B2B), tag not `Fellow`, source not 349022519297 (Siip).
- Every shippable line has a variant, and `variant.product.vendor` = Torque Coffees.
- Order is at most 30 bag-equivalents.

Change from draft: vendor is tested on `variant.product.vendor`, not `lineItem.vendor`. Collective lines carry "Nectarous Coffee" (74 orders) or "xBloom" (44) as line vendor while the product vendor is Torque Coffees and the order ships from the Torque roastery (fulfillments #6696, #6699, #7053, #7054). Effect: 117 orders in 90 days. Confirmed by Andy 2026-10-17: Collective one-time orders ship from Torque; they may not recur.
Result: ELIGIBLE 651 / 191.

**R1a Hold list (reason shown, no partial shipments).**

| Reason | Orders 90d / 30d |
|---|---|
| NON_TORQUE_VENDOR (grinders, machines; no catalog weight) | 6 / 2 |
| CUSTOM_LINE_NO_VARIANT | 2 / 1 |
| DRAFT_CUSTOM_LINE (no company; 6 of 7 ship to HI) | 7 / 2 |
| HI / AK / PR / APO | 7 / 2 |

Not listed and not shipped by this flow: PICKUP 105 / 35, NO_SHIPPING 52 / 20, COMPANY_B2B 114 / 35, CANCELLED 5 / 0, SIIP_FULFILLMENT 4 / 1, FELLOW_DROPS_COMPANY 4 / 0.
Replacement and comp drafts (no company, catalog lines, 100% discount code naming the reason, no shipping line, address present) are listed flagged REPLACEMENT: 12 / 4 (confirmed by Andy 2026-10-17). They are not ELIGIBLE in the count above.

**R2 Carton (changed to a fit table).**

| Contents | Carton |
|---|---|
| 1 x 12 oz (a 250 g box or xPods counts as a 12 oz bag) | 8x6x3 |
| 2, 3 or 4 x 12 oz; 12 oz + 2 lb; 2 x 12 oz + 2 lb; 1 x 2 lb; 2 x 2 lb; 1 x 5 lb | 12x8x6 |
| Anything else (see `oversize_rule.md`) | 14x10x10 |

A 5 lb bag ships alone. Carton assignment, 90 days: 8x6x3 315, 12x8x6 326, 14x10x10 10. File: `order_carton_assignment.csv`.
Change reason: the plan's "one 2 lb bag assumed to fit" is confirmed by A3, and 2 x 2 lb is in A3 and confirmed by Andy.

**R3 Billed weight (unchanged formula, tares fixed).** Declared parcel weight = ceil(net lb + tare + 0.05). Tare: 8x6x3 0.156, 12x8x6 0.42, 14x10x10 0.83. Net: 12 oz 0.75 lb (also a 250 g box and xPods, per Andy), 2 lb 2.03, 5 lb 5.07. Billed distribution, 90 days: 1 lb 315, 2 lb 80, 3 lb 176, 4 lb 41, 5 lb 10, 6 lb 24, 7 lb 2, 8 lb 2, 13 lb 1. 2 x 12 oz and 2 x 12 oz + 2 lb sit at the boundary and are assumed under it (billed 2 and 4 lb), per Andy.

**R4 Service.** `ups_ground` only. No rate returned: stop and show the error. Shippo returns every UPS service on each shipment; select by token.

**R5 Address.** Residential true (company orders are excluded). Validate through Shippo. UPS may reclassify an address to Commercial or add a Delivery Area surcharge (alert 112081; seen at Chicago 60601, Assumption IL, Edmond OK, Green Valley AZ); show the quoted price at buy time. Phone: customer phone, else Torque phone. Origin phone is 6192305400 (Andy, 2026-10-17; set in B0).

**R6 Email.** Pass no recipient email to Shippo.

**R7 Fulfillment.** Write UPS tracking to Shopify with company "UPS" only after the label printed and Andy confirmed; notify once; retries never notify twice.

**R8 Cost capture.** One `shipping_labels` row per label. Required new columns and read path: `cost_report_spec.md`. Failure to log never blocks a shipment.

**R9 Batching.** Up to 25 orders per batch; one failure does not stop the rest; reload never re-buys a label.

**R10 Weight source (changed).** Weight comes from the weight in the variant title (or product title), then Shopify grams. Grams first is wrong for 98 of 576 variants (grams and title disagree; mostly archived variants; 9 eligible orders in 90 days, 3 in 30 days). 28 variants have zero grams with a usable title (39 eligible orders, 10 in 30 days). No grams and no title weight: hold (27 variants). Built in B0 (`resolveWeightLb`): lb, oz, g and kg are read from titles; a title naming several bags ("2 x 12oz", "6 pack", "case of") or a fraction ("1/2 lb") holds rather than guesses; xPods and 250 g count as 12 oz only when the title gives no other size.
Fellow orders (if they return) record weight zero in Shopify; the title weight applies.

## New rules

**R11 Free shipping and charged amount.** Shipping charged = `shippingLines[].discountedPriceSet` minus `totalRefundedShippingSet`. Automatic discount "Math checks out. Shipping's on us" gives 100% off shipping at subtotal >= $50 (54 of 191 orders in 30 days). Display only.

Customer shipping prices in Shopify (verified 2026-10-17): Standard $8.00 on the General profile for US (non-subscription retail); Fast Ship 2-4 Days $5.00 (profile "Subscribers Rock"); Express $3.00 (profile "Subscriptions"); Express $6.99 (Collective and Espresso parts profiles). Free shipping at subtotal >= $50 (automatic discount). Andy: $8 until over $50 is acceptable for now; no price change.

**R12 Subscription orders.** Identify by tag `appstle_subscription_recurring_order` / `appstle_subscription_first_order` or line property `__appstle-selected-selling-plan`. Print the marker on the slip. 274 eligible orders in 90 days.

**R13 Pickup and no-shipping.** `methodType` PICK_UP or NONE never lists. #7051 is a pickup order with an $18 charge; it stays excluded.

**R14 Draft orders.** Drafts with a company are B2B; drafts with a custom line hold; replacement drafts list flagged.

## Evidence and fixtures

`acceptance_fixtures.json`: 30 orders (16 LIST, 6 HOLD, 8 EXCLUDE) with carton, billed lb and UPS Ground quote for each LIST order. Fixture #8255 (xPods) is counted as one 12 oz bag (Andy).

## Resolved decisions (from the plan's open list)

| # | Decision | Outcome |
|---|---|---|
| 1 | Oversize | One label in the 14x10x10 (Andy). Taller boxes tabled until January. `oversize_rule.md` |
| 2 | Mixed-vendor | Hold the whole order. 6 orders in 90 days contain a non-Torque vendor line; 1 (#6764) is mixed with a Torque line. Collective orders are not mixed-vendor (R1). |
| 3 | Local delivery | None exists (0 orders with `methodType` LOCAL). Nothing to build. |
| 4 | Customer shipping prices | Andy: $8 until over $50 is OK for now; no change. 190 orders in 30 days (retail only): charged $821.00 ($4.32 per order) vs estimated UPS Ground label $1,741.19 ($9.16 per order); difference -$4.84 per order (`shipping_margin.md`). Andy decides (Q11). |
| 5 | Fellow if it returns | Same flow; tag `Fellow` excluded now; weight from title. |
| 6 | Daily routine | Moved out of Phase A: to be worked in Claude Design (Andy, 2026-10-17). |

## Open

Pickup items (allowed open; Andy is still determining the UPS pickup cost; ask Shippo or UPS before cutover): UPS Daily Pickup real weekly fee ($18/week is a placeholder), which account the pickup attaches to (labels are bought on Shippo's UPS account, not a Torque-held one), and whether Saturday is covered at the same fee (shipping runs 6 days a week).

Pending Andy (sent as one batch):
1. `ups_ground_fixtures.csv` received and saved (72 rows). `notes_origin.txt` not received; not needed for any file.
2. Dropped (Andy). San Francisco rows in `ups_ground_fixtures.csv` stay `invalid_reclassified`; SF orders are estimated at Fresno rates.
3. Resolved (Andy): 1 x 2 lb + 1 x 5 lb does not fit the 12x8x6. It ships in the 14x10x10 (already the 'everything else' row of the carton table).
4. Dropped (Andy): ignore alert 112237 for now.
5. Resolved (Andy): the 14x10x10 for orders over 6 lb; 2 x 2 lb and 2 x xPods fit the 12x8x6.
6. Resolved (Andy): 250 g box and xPods are treated as 12 oz.
7. Resolved (Andy): Collective orders ship from Torque (R1 vendor test stands).
8. Resolved (Andy): replacement and comp drafts are listed with a flag.
9. Resolved (Andy): ignore gift and `thank-you-note`. No gift handling in the slip or rules.
10. Daily routine (who, cutoff, printer): Andy: likely needs work in Claude Design more than code. Not a Phase B code item; outside this rules file.
11. Resolved (Andy): $8 until over $50 stays for now. Subscription profiles ($5 Fast Ship, $3 Express) and Collective Express ($6.99) are separate prices in Shopify; Andy to say if those should change.
12. A4 and A7 approved (Andy, 2026-10-17). B2B slip sample approved (`b2b_slip_spec.md`).
