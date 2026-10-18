# A1 retail_catalog_notes.md

File: `retail_catalog.csv`, 576 variants, 22 columns. Built from Shopify products and variants.

## Counts

| ship_status | Variants |
|---|---|
| SHIP | 470 |
| HOLD_NON_TORQUE_VENDOR | 84 |
| NO_SHIP_NOT_PHYSICAL | 13 |
| HOLD_NO_WEIGHT | 9 |

carton_class values: 12x8x6, 8x6x3, MANUAL_OVER_9KG, OVERSIZE_A4. Product status: ARCHIVED 400, ACTIVE 122, DRAFT 48, UNLISTED 6.

## Columns

`eff_g_R10_draft` is the draft rule (grams first). `eff_g_proposed` is the proposed weight (title weight first when it conflicts with grams). `grams_title_conflict` = Y when `grams` and the weight parsed from the title differ.

## Flags

| Flag | Variants | Meaning |
|---|---|---|
| BLANK_SKU | 369 | no SKU |
| GRAMS_TITLE_CONFLICT | 98 | grams differ from title weight |
| DUPLICATE_SKU | 50 | SKU shared by variants |
| NO_GRAMS_NO_TITLE_WEIGHT | 27 | no usable weight; 9 of these are HOLD_NO_WEIGHT, the rest are non-physical or non-Torque vendor |
| XPODS_FIT_UNVERIFIED | 45 | xPods carton fit not measured |
| ZERO_GRAMS_TITLE_USABLE | 28 | grams 0, title gives the weight |

## Use in orders (eligible, 90 days)

- 9 orders contain a grams/title-conflict variant (3 in 30 days); most conflicts are archived variants.
- 39 orders contain a zero-gram variant with a usable title (10 in 30 days).
- xPods and the 250 g box are treated as a 12 oz bag (Andy); no eligible order is unmodeled.
