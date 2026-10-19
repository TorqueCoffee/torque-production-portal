# 0027 — Retail queue: what it shows, what it leaves out, and where the logic lives

- **Status**: Accepted
- **Date**: 2026-10-19

## Context

The Retail tab (docs/RETAIL_UI_HANDOFF.md) starts with the queue (B1 UI): a list of open retail orders grouped by carton, from which a person picks a batch. B1 (the list endpoint) and B2 (the packer) were already deployed; this slice is the screen on top of them. The handoff left six items open and the queue touches four of them. Andy answered "yes" to the proposed defaults on 2026-10-19.

Two things also had to be decided in code: where the P.O. box and 35-character checks run, and what the Buy button does before B3a exists.

## Options considered

- **Dollar estimate in the action bar.** From the A5 fixtures table (a guess, not a quote) or a live quote (a Shippo call per order before the person has chosen anything). Or none.
- **Batch cap.** Stop Select all at 25 with a message, or let it tick everything and fail at buy time.
- **Address problems.** Add a classifier outcome for them, or compute them next to it. Copy the P.O. box pattern into the page, or share it with the label endpoint.
- **Buy button before B3a.** Hide it, or show it disabled.

## Decision

- **No dollar estimate on the queue.** The total shows on the Buying screen (B3a), after real quotes. Out-of-range quote flagging stays deferred.
- **Cap of 25.** Select all takes the oldest 25 ready orders and says so; a 26th tick is refused with a message.
- **Age chip is built but off** (`RETAIL_AGE_CHIP_DAYS = null`) until Andy gives a number of days. *Set to 2 (Andy, 2026-10-19): of the last 100 shipped orders, the slowest retail one shipped at 1.9 days, so the chip marks only an order that is really late.* NOTE reads Shopify's order `note`.
- **Needs a fix is computed beside the classifier, not in it.** `addressProblem()` in `lib/ship-rules.js` runs for LIST orders in the endpoint and returns `fix`; `classifyRetailOrder` and its 30 acceptance fixtures are untouched. The P.O. box pattern, `cleanText` and the 35-character limit moved into `lib/ship-rules.js` from `api/shippo-label.js`, which now imports them, so the queue and the purchase refusal can't drift apart. A LIST order the server could not size also goes to Needs a fix. Neither can be ticked.
- **The page shows; the server decides.** Classification, carton, billed pounds and the fix all come from the endpoint. The page only groups, counts and escapes.
- **Buy is shown disabled with a "turns on in the next release" line** (`RETAIL_BUY_ENABLED = false`), so the layout and the 2-click budget can be seen and B3a only has to wire it.
- **Unpaid orders list like any other** (Andy, 2026-10-19). Shopify shows an order as pending for about an hour after checkout, and those orders are valid. Only refunded and voided orders are excluded (R1); no "not paid" hold.
- **Select all includes NOTE and REPLACEMENT rows** (spec acceptance check 2; the note text shows on the row). The REPLACEMENT flag rule stays as R14 has it (a draft with no shipping line).
- **Needs a fix rows carry an Open in Shopify link**, so the address can be corrected where it lives.
- **Subscription lines** use the existing `applySubscriptionSubstitution`, called once over every line, with the Schedule loaded on demand. If the Schedule can't be read, the plan name shows.

## Consequences

**Positive:** nothing on the screen can buy or write. An address that gets past the queue is one purchase accepts. B3a inherits a working selection model.
**Negative:**
- No cost figure until a batch is bought.
- The age chip does nothing until Andy sets N.
- `lib/` grew by a few lines of address code, public like the rest of it (no secrets in it).
- The queue reads the list when the tab opens (reloaded after 10 minutes) and on Refresh; an order edited in Shopify in between shows stale until then. The label endpoint's own repack check still guards money.
- On a phone-width screen the table scrolls sideways inside its box.
**When to revisit:** Andy wants a cost estimate before buying; the batch size changes; Shopify's address check (or UPS) changes what counts as a P.O. box.
