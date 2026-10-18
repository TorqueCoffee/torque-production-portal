# A2 order_types.md: retail order types, Shopify identifiers, counts

Built 2026-10-17. Source: `all_orders.txt` (969 orders, #6692 to #8337, 2026-07-19 to 2026-10-17, Fellow-tagged orders excluded) plus live Shopify Admin queries. Per-order labels: `order_classification.csv`.

## 1. Verification against Shopify (2026-10-17)

| Check | Shopify | File | Result |
|---|---|---|---|
| Orders since 2026-07-19, tag Fellow excluded | 972 | 969 | Difference is #8338, #8339, #8340, created after the file snapshot. File range has no other gaps except Fellow-tagged numbers. |
| Orders tagged Fellow since 2026-07-19 | 676 | 0 | All 676 fall in the last 30 days (Shopify 30-day total 969 = 293 in file for that window + 676). |
| Tag `Shopify Collective` | 794 | 118 | 794 = 676 Fellow + 118 non-Fellow. Fellow is a Collective order. |
| delivery_method:shipping / pick-up / none / local | 815 / 105 / 52 / 0 | 812 / 105 / 52 / 0 | Shipping differs by the 3 new orders. |
| Cancelled | 5 | 5 | Match. |

The file's 969 equals Shopify's 30-day total (with Fellow) by coincidence. The two reconcile separately as above.

## 2. File field map (confirmed against Shopify)

`order|date|source|delivery|shipping title|shipping price|country|state|zip|company|tags|note|fulfil|lines`

| Field | Values | Shopify source |
|---|---|---|
| source | `web`, `sub`, `draft`, `col`, `3890849`, `349022519297` | `sourceName`: web; subscription_contract_checkout_one; shopify_draft_order; shopify-collective-automatic-payments; numeric app ids |
| delivery | `S` ship, `P` pickup, `N` none | `fulfillmentOrders.deliveryMethod.methodType`: SHIPPING, PICK_UP, NONE |
| fulfil | `F` fulfilled, `U` unfulfilled, `C` cancelled, `R` ready for pickup | `displayFulfillmentStatus`, `cancelledAt` (snapshot time; #8318 and #8328 have since moved) |
| line | `variantId:qty:vendor:sub` | vendor `T` = line vendor Torque Coffees; sub `1` = line has `__appstle-selected-selling-plan` |

## 3. Counts by type (first match wins; each order has one class)

| Class | 90 days | 30 days | Identifier | Retail ship list |
|---|---|---|---|---|
| ELIGIBLE | 651 | 191 | passes every test below | Yes |
| COMPANY_B2B | 114 | 35 | `shippingAddress.company` not empty (86 draft, 27 web, 1 Collective); shipping titles Standard 45, CA PARTNER 10+ LBS 44, blank 13, wholesale 8, free 5 | No (B2B flow) |
| PICKUP | 105 | 35 | `deliveryMethod.methodType = PICK_UP`; shipping title "Coffee roastery and shop"; no address | No |
| NO_SHIPPING | 52 | 20 | `methodType = NONE`; 47 carry a subscription line (Bean & Bottle Society); 5 other (4 draft, 1 web). Gift cards would fall here (none ordered in window) | No |
| DRAFT_COMP_OR_REPLACEMENT | 12 | 4 | `shopify_draft_order`, no company, catalog lines only, total $0 (one paid $18.80), no shipping line, address present. Discount code names the reason: Missing item, Wrong bag, wrong bag size, Mis ship, Re-Ship - stuck in USPS Hell, samples, WHOLESALE ESPRESSO SAMPLES, Custom discount | Yes, flagged (see finding 4) |
| DRAFT_CUSTOM_LINE | 7 | 2 | draft, no company, a custom line with no variant (e.g. "30lbs Sumatra", "green goodies", "invoice 06/01-06/15/26"); 6 of the 7 ship to HI | No (hold, no weight) |
| HI_AK_PR_APO | 7 | 2 | `shippingAddress.provinceCode` in HI, AK, PR, AA, AE, AP | No |
| NON_TORQUE_VENDOR | 6 | 2 | `variant.product.vendor` not Torque Coffees (Baratza, Planetary Design, Synesso, Compak, Nuova Simonelli) | Hold |
| CANCELLED | 5 | 0 | `cancelledAt` set | No |
| FELLOW_DROPS_COMPANY | 4 | 0 | company "Fellow Drops", draft, custom lines | No |
| SIIP_FULFILLMENT | 4 | 1 | source 349022519297, tags `siip_external_order`, `siip_fulfillment_only`, shipping NA | No |
| CUSTOM_LINE_NO_VARIANT | 2 | 1 | line with no variant (custom item), both subscription orders | Hold (no weight) |
| Total | 969 | 293 | | |

191 eligible in 30 days matches the plan's ~190/month (44/week).

## 4. Identifiers by type

| Type | Exact Shopify test | Count in window (all classes) |
|---|---|---|
| Pickup | `fulfillmentOrders[].deliveryMethod.methodType = PICK_UP` (also `displayFulfillmentStatus = READY_FOR_PICKUP` while waiting) | 105. 104 at $0; #7051 carries $18 (title "Coffee roastery and shop and CA PARTNER 10+ LBS"). Titles match methodType 1:1. |
| Local delivery | `methodType = LOCAL` | 0. No local delivery shipping title exists. |
| Digital / no shipping | `methodType = NONE` or `lineItem.requiresShipping = false` | 52 |
| Subscription | tag `appstle_subscription_recurring_order` (286) or `appstle_subscription_first_order` (52); source `subscription_contract_checkout_one`; line property `__appstle-selected-selling-plan` | 338 orders with a subscription line: 274 eligible, 47 no-shipping, 11 pickup, 4 HI/AK/APO, 2 custom line |
| Fellow Collective | tag `Fellow` | 676 (not in file) |
| Other Collective | source `shopify-collective-automatic-payments`, tag `Shopify Collective`, shipping title "Collective" ($6.29, 74 Nectarous orders) or "Standard" ($7/$8, 44 xBloom orders) | 118. 117 eligible, 1 B2B. |
| Mixed vendor | any shippable line where `variant.product.vendor` is not Torque Coffees, or a line with no variant (custom item) | 6 orders with a non-Torque-vendor line, 1 of them (#6764, Planetary Design) mixed with a Torque line. 8 more mix a custom line with Torque lines (#6755, #6847, #6895, #6930, #6936, #6956, #7135, #8294); all 8 have a company and fall in COMPANY_B2B. |
| International | `shippingAddress.countryCodeV2` not US | 0 |
| HI / AK / PR / APO | `shippingAddress.provinceCode` | 13 orders: HI 8, AK 4, AE 1. 7 in HI_AK_PR_APO, 6 HI in DRAFT_CUSTOM_LINE. |
| Company / B2B | `shippingAddress.company` not empty | 120 with delivery S; 114 after earlier classes |
| Gift | No gift flag, note or attribute found (below). Free comps exist as $0 drafts with a discount-code reason. | 0 gift orders identified |
| Siip | source 349022519297 | 4 |

## 5. Findings that change the draft rules

1. **Collective orders ship from Torque and fail R1 as written.** The line `vendor` is stamped "Nectarous Coffee" (74 orders) or "xBloom" (44 orders). `product.vendor` on every one of those variants is Torque Coffees. Fulfillments show location "Coffee roastery and shop", USPS tracking (#6696, #6699, #7053, #7054). R1 should test `variant.product.vendor`, not `lineItem.vendor`. 117 orders in 90 days depend on this.
2. **Non-Torque vendors ship from Torque too.** #6748 (Baratza grinder, Shop app) was fulfilled from "Coffee roastery and shop" with UPS tracking. Hold stays correct because catalog weight is zero for these variants.
3. **Source `3890849` orders are retail** (47 orders, Shop Cash and campaign tags). They pass R1 unless a line has a non-Torque vendor (4 of 47).
4. **Draft orders are not one type, and the no-company drafts are the replacement mechanism.** 189 drafts: 86 company, 72 pickup, 12 comp or replacement, 7 custom line, 4 cancelled, 4 Fellow Drops, 4 no-shipping. Replacements and mis-ship resends are drafts with a 100% discount code that names the reason, catalog lines, no shipping line; all 12 shipped USPS (checked on #7155, #7173, #7287, #7339, #7463, #8246, #8273, #8291). They pass every R1 test except "shipping line present". 12 in 90 days, 4 in 30 days. Five carry an error reason (#6802 Wrong bag, #7155 Missing item, #7293 wrong bag size, #7463 Re-Ship, #8291 Mis ship); 3 say Custom discount (#6709, #8246, #8273), reason not recorded.
5. **`fulfil = U` is a snapshot.** Use live `displayFulfillmentStatus = UNFULFILLED` and `cancelledAt = null`. 4 orders are open and unfulfilled in Shopify now (excluding pickup).
6. **#7453 is unfulfilled and `displayFinancialStatus = REFUNDED`.** R1 needs a financial-status test.

## 6. Open items

- **Gift mechanism:** none identified. No gift tag, note, order attribute or line property found. Notes: 13 non-empty in 969 orders, none mention a gift. Order and line attributes checked on 50 recent web orders only (appstle, upsell and utm keys only). Tag `thank-you-note` is on 100 orders (74 subscription, 18 web, 6 draft, 2 other), all dated 2026-06-27 to 2026-08-15 with none after; no event history shows who applied it; its meaning is not established from Shopify data.
- **Fellow tag vs text:** 676 tagged. In the file, 4 draft orders carry company "Fellow Drops" without the tag (#6861, #6862, #7341, #7342). This explains 4 of the 5-order gap to 681 text matches; 1 is unexplained.
- **Local delivery:** 0 in Shopify. Nothing to build.
