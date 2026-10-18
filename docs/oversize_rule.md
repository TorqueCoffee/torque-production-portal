# A4 oversize_rule.md: orders that do not fit the 12x8x6

Status: APPROVED by Andy, 2026-10-17. Built 2026-10-17 from `order_carton_assignment.csv` (651 ELIGIBLE orders, 90 days) and `carton_weights.csv`.

## Rule

An eligible order is oversize when its contents are not in the 12x8x6 fit list (A3):
2, 3 or 4 x 12 oz; 12 oz + 2 lb; 2 x 12 oz + 2 lb; 1 x 2 lb; 2 x 2 lb; 1 x 5 lb.
(1 x 12 oz goes in the 8x6x3.)

Oversize orders ship as one label in the 14x10x10 (the "20 lb box" until January).

- Billed lb = ceil(net lb + 0.83 tare + 0.05 allowance). Net uses bag weights: 12 oz 0.75, 2 lb 2.03, 5 lb 5.07.
- A 5 lb bag never ships with a 12 oz (Andy). Combinations containing a 5 lb bag plus other bags are oversize and ship in the 14x10x10; confirmed by Andy 2026-10-17 for 1 x 2 lb + 1 x 5 lb.
- Orders above 30 bag-equivalents (12 oz = 1.0) go to the hold list for manual handling.
- The Uline S-12597 and S-4191 boxes are tabled until January. The rule is revisited then.
- No split-label option: Andy chose one carton.

## Combinations seen (90 days: 10 orders; 30 days: 4)

| Contents | Net lb | Billed lb (14x10x10) | Orders 90d | Orders 30d |
|---|---|---|---|---|
| 5 x 12 oz | 3.75 | 5 | 3 | 1 |
| 12 oz + 2 x 2 lb | 4.81 | 6 | 2 | 2 |
| 7 x 12 oz | 5.25 | 7 | 1 | 1 |
| 3 x 2 lb | 6.09 | 7 | 1 | 0 |
| 1 x 2 lb + 1 x 5 lb | 7.10 | 8 | 2 | 0 |
| 3 x 2 lb + 1 x 5 lb | 11.16 | 13 | 1 | 0 |

Billed-lb counts for all oversize orders, 90 days: 5 lb 3, 6 lb 2, 7 lb 2, 8 lb 2, 13 lb 1.
Oversize is 1.5% of eligible orders (10 of 651), below the plan's 5% estimate because 2 lb and 5 lb singles and 2 x 2 lb fit the 12x8x6.

## Cost (UPS Ground, quoted 2026-10-17, origin 92104, residential)

| Fixture | Destination | Carton | Billed lb | Quote |
|---|---|---|---|---|
| #8290 5 x 12 oz | San Diego 92123 | 14x10x10 | 5 | $8.51 |
| #8275 12 oz + 2 x 2 lb | Edmond OK 73025 | 14x10x10 | 6 | $16.36 (alert 112081) |
| #7388 7 x 12 oz | Wayland MA 01778 | 14x10x10 | 7 | $18.06 |
| single parcel | Denver 80209 | 14x10x10 | 7 | $12.33 |

Rates depend on billed lb and destination, not on the carton (no dimensional weight: #8290 at 5 lb to San Diego 92123 quoted $8.51, the same as the 5 lb A5 rate for San Diego). A5 UPS Ground rates by group for the 5 and 6 lb oversize orders:

| Group | 5 lb | 6 lb |
|---|---|---|
| G01 San Diego / LA | 8.51 | 8.77 |
| G03 Goleta | 9.31 | 9.31 |
| G04 Fresno / Phoenix | 10.17 | 10.42 |
| G07 Denver / Portland | 11.11 | 13.20 |
| G09 Dallas / Seattle | 12.68 | 15.78 |
| G11 Chicago | 14.01 | 17.44 |
| G12 New York / East | 15.31 | 17.11 |

A5 covers 1 to 6 lb. Orders billed at 7 lb and above (5 of the 10 oversize orders in 90 days: 7 lb 2, 8 lb 2, 13 lb 1) have no fixture table; the only 7 lb quotes are Denver $12.33 and Wayland MA $18.06. Shippo rates them at label time.

## Open

- Confirmed (Andy, 2026-10-17): the 14x10x10 for orders over 6 lb.
- Decided (Andy, 2026-10-17): a 250 g box and xPods count as a 12 oz bag (0.75 lb net, one bag-equivalent) for carton and billed lb. No eligible order remains unmodeled; combinations that include them follow the normal fit table. The xPods fit in the 8x6x3 is not measured.
