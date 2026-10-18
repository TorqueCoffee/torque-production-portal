# A6 shipping_margin.md: shipping charged vs UPS label cost

Built 2026-10-17. Report only; nothing changed. Retail only. Sources: Shopify `shippingLines[].discountedPriceSet` (net of refunds) for 191 eligible orders 2026-09-17 to 2026-10-17; UPS Ground quotes from Shippo, origin 92104, residential.

## What customers pay (191 eligible orders, 30 days)

| Charged | Orders | Source |
|---|---|---|
| $8.00 | 52 | Standard |
| $5.00 | 79 | Fast Ship 2-4 Days (87 orders carry this title; 8 are discounted to $0 or more) |
| $3.00 | 6 | Express |
| $0.00 | 54 | Automatic discount "Math checks out. Shipping's on us": 100% off shipping, subtotal >= $50.00, active, countries selection |
| Total | $829.00 | $4.34 average per order |

Charged by billed pound (all 191; 11 unmodeled orders have no billed lb):

| Billed lb | Orders | Average charged | Free-shipped |
|---|---|---|---|
| 1 | 83 | $5.52 | 0 |
| 2 | 10 | $6.90 | 0 |
| 3 | 55 | $4.00 | 22 |
| 4 | 14 | $1.14 | 12 |
| 5 | 7 | $1.14 | 6 |
| 6 | 10 | $1.80 | 7 |
| 7 | 1 | $8.00 | 0 |

54 of 191 orders (28%) pay nothing; 25 of the 32 orders billed at 4 lb or more pay nothing.

## Charged vs label cost: 15 fixtures with a quote

Fixtures were chosen to cover order types, not to represent the mix.

| Order | Billed lb | Ship to | Charged | UPS Ground | Difference |
|---|---|---|---|---|---|
| #8331 | 1 | San Diego 92104 | 5.00 | 6.43 | -1.43 |
| #7133 | 1 | Nashville TN | 6.29 | 8.62 | -2.33 |
| #8255 | 1 | Long Grove IL | 8.00 | 8.80 | -0.80 |
| #8333 | 2 | Kew Gardens NY | 8.00 | 9.94 | -1.94 |
| #8322 | 3 | San Diego 92102 | 0.00 | 8.08 | -8.08 |
| #8316 | 3 | Brookline MA | 8.00 | 13.00 | -5.00 |
| #8306 | 3 | Colorado Springs CO | 0.00 | 9.38 | -9.38 |
| #8301 | 4 | Orlando FL | 0.00 | 14.27 | -14.27 |
| #8298 | 4 | Assumption IL | 0.00 | 16.18 | -16.18 |
| #8303 | 4 | Newport OR | 0.00 | 10.18 | -10.18 |
| #7550 | 5 | Richmond TX | 0.00 | 12.68 | -12.68 |
| #8290 | 5 | San Diego 92123 | 0.00 | 8.51 | -8.51 |
| #8289 | 6 | Gaithersburg MD | 0.00 | 17.11 | -17.11 |
| #8275 | 6 | Edmond OK | 0.00 | 16.36 | -16.36 |
| #7388 | 7 | Wayland MA | 8.00 | 18.06 | -10.06 |

Sum: charged $43.29, label cost $177.60, difference -$134.31. Every fixture is below cost. #8291 (replacement draft) is quoted at $7.62 (1 lb, Green Valley AZ) with $0 charged.

## Population estimate: 190 of 191 eligible orders (30 days)

Label cost = A5 fixture rate (`ups_ground_fixtures.csv`) at each order's billed lb, for the destination group its state and ZIP prefix map to. 250 g boxes and xPods are treated as 12 oz bags (Andy, 2026-10-17). Excluded: 1 order billed at 7 lb (no fixture above 6 lb).

| Item | Total | Per order |
|---|---|---|
| Shipping charged | $821.00 | $4.32 |
| UPS Ground label (estimate) | $1,741.19 | $9.16 |
| Charged minus label | -$920.19 | -$4.84 |

By billed lb:

| Billed lb | Orders | Charged | Label | Difference |
|---|---|---|---|---|
| 1 | 83 | $458.00 | $587.02 | -$129.02 |
| 2 | 17 | $93.00 | $152.93 | -$59.93 |
| 3 | 59 | $228.00 | $631.25 | -$403.25 |
| 4 | 14 | $16.00 | $151.09 | -$135.09 |
| 5 | 7 | $8.00 | $83.17 | -$75.17 |
| 6 | 10 | $18.00 | $135.73 | -$117.73 |

By destination group:

| Group | Orders | Charged | Label | Difference |
|---|---|---|---|---|
| G01 San Diego / LA / southern CA | 84 | $365.00 | $596.64 | -$231.64 |
| G04 Fresno / Phoenix / northern CA | 22 | $114.00 | $177.39 | -$63.39 |
| G07 Denver / Portland | 11 | $48.00 | $88.99 | -$40.99 |
| G09 Dallas | 6 | $32.00 | $68.91 | -$36.91 |
| G10 Seattle | 5 | $0.00 | $66.66 | -$66.66 |
| G11 Chicago | 18 | $90.00 | $205.64 | -$115.64 |
| G12 New York / East | 44 | $172.00 | $536.96 | -$364.96 |

The $9.16 average label is close to the plan's $9.11.

Method limits:
- Destination group is assigned from state and ZIP prefix, not quoted per ZIP. ZIP-level quotes differ from the group rate by up to $0.21 (e.g. Newport OR 4 lb $10.18 vs Portland $10.39; Colorado Springs 3 lb $9.38 vs Denver $9.57) and by delivery-area surcharges (Assumption IL 4 lb $16.18 vs Chicago $13.11).
- 13 northern-California Bay Area orders use Fresno rates because the San Francisco rows are unresolved.
- Group G12 includes all eastern states; 5 and 6 lb rates to New York carry a Commercial reclassification caution.
- Scope is retail only; B2B is not included.

## For Andy's decision (rules file Q11)

Customer shipping prices: Andy: $8 until over $50 is OK for now; no change (report only). The gap is -$4.84 per order on 190 orders in 30 days; Andy decides.
