# A9 cost_report_spec.md: shipping cost report

Inspected 2026-10-17, read-only. Supabase project `torque-roast-scheduler` (`gblkovtjylrfdotoktkb`), table `public.shipping_labels`. Shopify joins checked against live orders.

## 1. What the table holds today

| Item | Value |
|---|---|
| Rows | 227, 2026-06-30 to 2026-10-16 |
| `usps_ground_advantage`, cubic | 215 rows, $2,009.52, avg $9.35, status `fulfilled` |
| `ups_ground` | 12 rows, $197.16, avg $16.43, 2026-09-24 to 2026-10-09, status `fulfilled`, `zone` empty, weight 20 lb |
| Distinct orders | 102. 85 are in the 90-day order file as company (B2B) orders; 15 are older than the file; 1 Fellow Drops draft (#7341); 1 retail order (#7462) |
| Weights | 20 lb (159 rows), 10 lb (22), the rest 2 to 14.5 lb |
| Rows per month (non-void) | Jun 1, Jul 57, Aug 56, Sep 66, Oct 47 (to the 16th); 19 to 32 orders per month |

The table is the B2B label ledger. Retail labels are bought in Shopify Shipping and are not in it.

## 2. Columns today

`id` uuid, `order_id` text (Shopify GID, e.g. `gid://shopify/Order/18957055918300`), `order_name` text, `box_index` int, `box_count` int, `cost` numeric, `currency` text (default USD), `service` text, `is_cubic` bool, `zone` text, `dest_zip` text, `weight_lb` numeric, `tracking_number` text, `shippo_object_id` text, `status` text (default `purchased`; seen: `fulfilled`), `created_at` timestamptz, `tracking_url` text, `label_url` text.

Gaps against R8:

| R8 needs | Table has | Change |
|---|---|---|
| channel (retail or b2b) | none | add `channel text not null` (`retail`, `b2b`); backfill b2b |
| carton | none | add `carton text` (`8x6x3`, `12x8x6`, `14x10x10`, `b2b-20lb`, `b2b-30lb`) |
| billed pounds | `weight_lb` holds the declared weight | keep; define as the whole-pound billed weight sent to Shippo (R3). Add `net_weight_lb numeric` for the pre-tare weight |
| zone | `zone` empty for UPS (Shippo `zone` is null) | add `dest_group text` filled from `dest_zip` using the A5 destination groups; leave `zone` null |
| void | no `voided` status or refund fields | add status value `voided`, `voided_at`, `refund_status`; report excludes voided rows after refund is confirmed |
| carrier / tracking company | `service` only | add `carrier text` (`ups`, `usps`) |
| invoice reconciliation | none | add `invoice_cost numeric` null until the monthly UPS invoice is matched |
| failure to log never blocks a shipment | n/a | portal behavior, not schema |

## 3. Access (read before building)

- RLS is on. Policies: `insert shipping_labels` (check `true`, all roles) and `update shipping_labels` (using `true`, check `true`, all roles). No SELECT policy, so anon cannot read, which matches ADR 0004.
- Table grants include SELECT, INSERT, UPDATE, DELETE, TRUNCATE to `anon` and `authenticated`. Only the INSERT and UPDATE policies are open, so anyone holding the anon key can insert rows and rewrite `cost`, `status` or `tracking_number` on any row. Not changed (read-only session). Phase B should confirm and decide.
- Report reads: server side only, using the service role key, from a Vercel function. Reader: Andy (and whoever he gives the portal login). No client-side query of this table.

## 4. Join to Shopify shipping charged

Key: `shipping_labels.order_id` = Shopify `Order.id`.

| Field | Shopify source | Note |
|---|---|---|
| Shipping charged | sum of `Order.shippingLines[].discountedPriceSet.shopMoney.amount` | Use discounted, not original. #8337 has original $8.00, discounted $0.00, and `totalShippingPriceSet` $8.00. |
| Shipping refunded | `Order.totalRefundedShippingSet.shopMoney.amount` | #7453 charged $8.00, refunded $8.00 |
| Net charged | charged minus refunded | |
| Delivery method | `fulfillmentOrders[].deliveryMethod.methodType` | filter to SHIPPING |

Multi-box orders (`box_count` > 1): count shipping charged once per order. In the order-level view sum `cost` over labels; in the label-level view put charged on `box_index = 1` only.

## 5. Report

Label-level columns: `created_at` (Pacific date), `order_name`, `channel`, `carrier`, `carton`, `box_index/box_count`, `dest_zip`, `dest_group`, `net_weight_lb`, `weight_lb` (billed), `cost`, `status`, `tracking_number`.

Order-level columns: `order_name`, `channel`, labels, label cost (sum, non-void), shipping charged (net), difference (charged minus cost), carton(s), billed pounds, state.

Monthly summary (Pacific month, `status <> voided`), by channel and in total: orders, labels, label cost, shipping charged (net), difference, difference per order, average cost per label, share of orders with charged $0. Second table by `carton` and by `dest_group`: orders, avg cost, avg charged, avg difference.

Reconciliation row: sum of `cost` vs UPS invoice for the month. Variance above 3% flags tare or packing allowance (plan, ongoing checks).

Day-90 test needs the incident log (runbook), not this table.

## 6. Verification for Phase B (plan B5)

Totals equal the sum of Shippo transactions for a test week. As a baseline, for Sep 2026 the table gives 66 non-void labels, 32 orders, $653.16 (all B2B).
