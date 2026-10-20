# 0028 — Retail Buy and print: two taps, no pause, one PDF, and a channel on every label

- **Status**: Accepted
- **Date**: 2026-10-19

## Context

B3a turns on buying in the Retail tab (`docs/RETAIL_UI_HANDOFF.md` 3.2, 3.3, D6–D8). The click budget is two taps from the queue to labels in hand: Select all, then Buy and print. Every label is live money; there is no Shippo test mode in production. The server already refuses the dangerous cases on its own (ADR 0020, 0023, 0025, 0026): a box already bought is handed back, a pack that differs from Shopify's is refused, a price above the quote is refused, a claim row stops two devices buying one box.

Three things were open: what the screen does with an order that has no UPS rate, how the PDF reaches the printer on an iPad (Safari opens a new tab only inside the tap itself), and how the Retail tab tells its bought labels from B2B ones. `ship_labels_pending()` returned every `purchased` row, so the first retail label would have shown on the B2B Ship tab's red "never fulfilled" banner with a Clear button, and the Retail tab couldn't tell its own bought orders apart.

The packing slip (B4, `docs/retail_slip_spec.md`) belongs in the same PDF, so it was built in this slice (Andy, 2026-10-19).

## Options considered

- **No-rate orders:**
  - Pause the batch on a Review screen until a third tap. It holds up every order for one bad address.
  - **Buy the rated ones at once, then show the no-rate rows with Open in Shopify and Re-rate (chosen, Andy).**
- **The PDF tab:**
  - **Open a placeholder tab inside the Buy tap and fill it when buying ends (chosen, Andy).** Safari switches to it; the operator switches back to watch.
  - No auto-open; an Open PDF button at the end. Three taps.
- **Speed:** one label at a time (about 2 minutes for 25), or **three at a time, dropping to one on a 429 (chosen, Andy)** (about 40 s).
- **Which tab a label belongs to:**
  - Guess from the order on the page. The B2B tab doesn't load the retail list, and an order can't be told apart by its label row.
  - **A `channel` column on `shipping_labels` (chosen, Andy).** It is the column `cost_report_spec.md` asks for (B5), added early.
- **The slip:** labels only now and B4 later, or **the slip in this slice (chosen, Andy).**
- **Which address a retail label goes to** (found in review): the page's, from when the list loaded (then "fix it in Shopify and Re-rate" can't work, and an edit made since gets a label to the old address); compare the page's with Shopify's and refuse a difference (one more refusal to explain); or **Shopify's current one, read with the order the server already reads for the pack check (chosen)**, with the ship-to it used (no street) sent back for the screen and the slip.

## Decision

- **Buy and print** (`retailBuyAndPrint` in `index.html`): the page opens the PDF tab, sorts the ticked orders into packing order (carton 8x6x3, 12x8x6, 14x10x10, then oldest), and runs each one through quote, then buy, three at a time. Every rate and label request carries `kind: 'retail'` and `order_id`; label requests carry `box 1 of 1`, the list's `pack_sig` (the server's own `packSignature`, returned by `?type=retail-ship`) and the quote as `expected_amount`. No confirm dialog: the total spent shows on the Buying screen as it goes.
- **Address from Shopify:** for retail, the label endpoint quotes (when `order_id` is sent) and buys at the address Shopify has now, read with the order it already reads for the pack check, not the page's `address_to`. "Fix the address in Shopify, then Re-rate" therefore works, and an address edited after the list loaded is the one that gets the label. A P.O. box or a line over 35 there is a 409 `code: 'address'`.
  - The server returns `ship_to` (name, city, state, ZIP) with the quote and the label; the page shows it and prints it on the slip. The cost row takes Shopify's order name.
- **Shippo busy or down:** a Shippo 429 (rate or buy) comes back as 429 and a rate 5xx as 502, never as "No UPS Ground rate", so the operator isn't sent to fix a good address. The page drops to one at a time on a 429 and tries that order again after 1.5, 3 and 4.5 s, three times at most. A Shopify throttle comes back as 503 ("try again") and does not slow the batch.
- **Shippo still working, or no clear answer:** the box's claim is freed only when Shippo says plainly that nothing was bought (status ERROR or a 4xx). QUEUED, WAITING, SUCCESS with no tracking number, a 5xx or an unreadable answer keep the claim and return `label_pending` ("don't buy it again, check Shippo"); that row gets no Try again.
- **Not recorded:** a label bought whose cost row couldn't be written (`cost_logged: false`, after one retry on a network error or a 5xx; a retry that finds the row already there counts as written) is flagged on the row and above the table: "do not buy again, tell Andy". This device also keeps the order (localStorage, a week) and shows it in Bought, "not recorded", after Back, a reload or a new load (even when the label lookup fails), until the DB has its row. The same goes for a label Shippo may have bought (`label_pending`, a 5xx) and for a buy with no answer, which a retry clears once it settles. A "Shippo shows none" button, after a confirm, puts the order back in the queue. Another device doesn't know.
- **One spelling of an order id:** every label and void call turns `order_id` into `gid://shopify/Order/<n>` (all 231 live rows use it) before the lookup, the claim and the cost row, so "8333" can't miss the row for the same order.
- **A retail quote needs a signed-in user,** like a purchase, whatever `PORTAL_AUTH_ENFORCE` says: it reads the customer's order from Shopify.
- **Rows:** Waiting, Quoting, Buying, Bought, No rate, Price changed, Not bought. "Already bought" counts as bought and costs nothing. A no-answer error is "Not bought, try again": the server never buys a box twice, so trying again is safe. Once the batch has run, a row offers Open in Shopify and Re-rate (no rate), Re-rate (price rose), Buy at the new quote, or Try again. Anything not bought returns to the queue.
- **Lock:** while buying, and while the PDF is made, ticking, Refresh, Back, Sign out, a second Buy, Open PDF, Reprint and the row actions do nothing, and the screen shows no Back or row buttons. Buy also waits for a list load still running. A row whose order changed in Shopify (`pack_changed`, `not_listed`) gets no Try again: it needs Refresh orders.
- **PDF:** `api/ship-doc.js` takes `{ kind: 'retail', orders: [{ label_url, slip }] }`, at most 30, and writes each order's label then its slip (`api/_retail-slip.js`, per `retail_slip_spec.md`). Labels are fetched five at a time, 10 s each, only from `https://deliver.goshippo.com` (no port, no redirect), PDF only, 2 MB at most. Text the PDF font can't draw becomes the base letter or "?". Open PDF reuses the PDF made last (a new one if labels were bought since, or after the made one is freed at 10 minutes); Reprint always makes a new one. Neither buys. The queue's Reprint prints the order's one live label from the DB (not checked with Shippo); two live labels on record are refused, not chosen between.
- **Slip, where the code reads the approved spec** (approved by Andy, 2026-10-19, with the printed sample): 11 rows on a page when there is a note (a 12th row would sit inside the note box); the date is the order's Pacific day; the note and pack-in boxes repeat on page 2; the subscription box also shows for an order flagged by the Appstle line attribute, not only the tags; a subscription line with no coffee set prints "(NO COFFEE SET)".
- **Queue after buying:** orders with a retail label bought and not fulfilled (from `ship_labels_pending`, `channel = 'retail'`) sit in "Bought, not fulfilled" with Reprint, can't be ticked, and are never sent to Buy. A reload or a second device sees the same thing.
- **Channel** (`db/2026-10-19-label-channel.sql`): `shipping_labels.channel` `'b2b' | 'retail'`, not null, default `'b2b'`; `ship_labels_pending()` and `ship_labels_for_order()` return it. The label endpoint sends `channel: 'retail'` for retail only; B2B rows take the default, so B2B works the same before and after the migration. If the column isn't there, the retail row is written without it rather than lost. The B2B banner skips retail rows.
- **Quantity** (`api/_retail.js`): `min(unfulfilledQuantity, currentQuantity)`. A NO_RESTOCK refund can leave `unfulfilledQuantity` at 1 with `currentQuantity` 0 (#3341, #3074).
- **Off until B3b:** `RETAIL_BUY_ENABLED` stays `false` until B3b (Pack, Fulfill) is merged, the channel and void migrations are applied, and Andy says go. The first push with it on is the supervised 3-label live test (RUNBOOK).

## Consequences

**Positive:** two taps to labels in hand; one bad address doesn't hold up the rest; a reload or a second device can't buy twice and shows what's paid for; the B2B tab stays B2B; the cost report gets its channel column.
**Negative:**
- Money moves with no total shown first (Andy's call). The Buying screen shows the running total.
- Each retail quote also reads the order from Shopify (one more call per order, token cached).
- The batch exists only in the page: Back to queue or a reload drops the Buying screen. The labels stay in the DB and the orders show in Bought. B3b's Pack and Resume read from the DB, not from this state. *Amended by [`0029`](./0029-retail-pack-and-fulfill.md): after a batch the screen goes to Pack (or "Pack and fulfill" on a mixed run) instead of Back to queue.*
- Scope cut: a bought order Shopify no longer lists ("Not open in Shopify any more") has no Clear or Void button yet (B3b, B6). *Closed by [`0029`](./0029-retail-pack-and-fulfill.md): the red banner has Clear and Void.*
- If the channel migration is rolled back and applied again, every row reads `b2b` again (the default backfills); retail rows must be re-marked by hand (RUNBOOK).
- `cost_report_spec.md` also wants a `carton` column; not added here (B5).
- On an iPad the placeholder tab takes the screen while buying runs; the operator switches back to watch.
- A label bought after the PDF was made isn't in it until Reprint (the screen says so).
- The slip text comes from the page, not from Shopify (as the B2B slip does). The server only bounds it.
- The B2B slip path still uses the standard font without the character fallback; a name with an emoji would fail a B2B print. Not changed here.
- Accepted risks, staff only (every caller is a signed-in staff account): the queue's Reprint trusts the one live label row without asking Shippo, so a row planted by a staff account would print another label with this order's slip; a retail order sent with `kind: 'b2b'` skips the retail list rules and buys at the page's address (the page never does this).
- The page still sends `address_to` for retail and the server still checks it, though it then uses Shopify's; kept so one request shape serves both kinds.
**When to revisit:** Andy wants a total before buying; UPS or Shippo rate limits bite at three; Safari's popup rule changes; B3b's Pack screen replaces "Back to queue" after a batch.
