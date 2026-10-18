# A7 retail_slip_spec.md: 4x6 packing slip

Status: APPROVED by Andy, 2026-10-17. Updated per Andy (line format `Nx | size | Coffee Name`; pack-in box smaller and at the bottom). Sample: `retail_slip_sample.pdf` (3 pages: #8303, #7388, #8290; real orders, customer name is a placeholder). Generator: `build_slip_sample.py`.

## Page

4 x 6 in portrait, one page per order, printed after (interleaved with) that order's UPS label. Black on white, no images. 0.25 in margins.

## Fields (top to bottom)

| # | Field | Source | Rule |
|---|---|---|---|
| 1 | Order number | `order.name` | 18 pt bold, top left. |
| 2 | Subscription marker | tag `appstle_subscription_recurring_order` or `appstle_subscription_first_order` | Top right box "SUBSCRIPTION" (recurring) or "SUBSCRIPTION - FIRST" (first order). Omitted otherwise. |
| 3 | Order date | `createdAt` | `YYYY-MM-DD`, 10 pt. |
| 4 | Customer name | `shippingAddress.name` | 11 pt bold. |
| 5 | Ship-to | `shippingAddress` | City, state, ZIP only (the street is on the label). 10 pt. |
| 6 | Pack-in box | portal packer | Small boxed band at the bottom of the page (0.34 in tall): "PACK IN" label, carton in 13 pt bold (`8x6x3`, `12x8x6`, or `14x10x10` with "20 lb box" beside it), "bill N lb" at the right in 8 pt. |
| 7 | Line items | `lineItems` | One line per item, exactly: `2x | 12oz | Coffee Name - Producer, Origin` (see below). |
| 8 | Order note | `order.note` | Boxed "NOTE" above the pack-in box when not empty. |
| 9 | Replacement flag | class DRAFT_COMP_OR_REPLACEMENT | "REPLACEMENT" box with the discount-code reason. |

Not printed: prices, discount codes (other than the replacement reason), customer email or phone, shipping charged.

## Line item format

`Nx | size | Coffee Name - Producer, Origin`

- **Qty:** `2x`, 11 pt bold. Every line shows its quantity, including `1x`.
- **Size:** 10 pt bold, from the weight in the variant title: `12oz`, `2lb`, `5lb`, `250g`. xPods show `8 xPods`. A variant titled "Default Title" (Filter Coffee Explorer Subscription) shows `12oz`.
- **Name:** Shopify `product.title`, which already reads `Coffee Name - Producer, Origin`. Products without a producer in the title (Cocoa Drop, Dark Drop) print the title only.
- **One line, never wraps.** The name column is 2.45 in. Font steps down 10, 9, 8.5, 8 pt until the name fits. If it still does not fit at 8 pt: drop the text after the last comma (the country), then truncate with "..." at the end. Coffee name (text before " - ") is never cut.
- Check against the 75 variants on eligible orders in 90 days: 49 fit at 10 pt, 12 at 9 pt, 5 at 8.5 pt, 7 print without the country, 2 (Bridge Blend, "Grondin Community Bridge Composition") print truncated after the producer. No name wraps.
- 12 lines fit on the page (0.30 in per row from 1.75 in down). More than 12 lines: second page of the same slip, header repeated, "page 2 of 2".

## Layout (inches from top)

- 0.30 to 0.65: order number (left), subscription box (right).
- 0.75 to 1.35: date, customer name, city/state/ZIP.
- 1.75 down: line items, 0.30 in per row (12 rows fit before the note box).
- 4.85 to 5.30: note box when present.
- 5.41 to 5.75: pack-in box.

## Open

- Printer and stock (Rollo thermal or AirPrint) are decided with the daily routine in Claude Design; layout above is printer-neutral.
