# 0026 — The label request names its packer; voids go through Shippo first, then an RPC

- **Status**: Accepted (amended by [0028](./0028-retail-buy-and-print.md): retail takes Shopify's address and order name; every label and void call uses the `gid://shopify/Order/<n>` spelling; a retail quote needs a signed-in user)
- **Date**: 2026-10-19

## Context

Since B2a (ADR 0025) the label endpoint repacks every order from Shopify before buying, but only with the B2B packer over the REST order. A retail order packs differently (one carton from the R2 fit table, B2) and must still pass the B1 list rules (R1, R1a) at the moment of buying. The endpoint needs to know which rules apply.

B3 buys up to 25 orders in one go (R9). Each label call did its own Shopify token exchange.

B6 voids an unused label. `shipping_labels` has no SELECT policy (ADR 0004), so a PATCH can't change a row, and a label that reached the customer as tracking must never be voided.

## Options considered

- **Packer from the order itself** (company → B2B, else retail). No page change, but the B2B list picks orders by company and the retail rules exclude companies: a guess on the server would be a second copy of that split, and an order that changed sides would buy under the other packer's rules.
- **A `kind` field in the request (chosen).** `'b2b' | 'retail'`, absent = `'b2b'`, so every page from before B3 keeps working unchanged. Retail reads the order through GraphQL with the list's own fields, must classify LIST (else 409 `not_listed` with the class), and packs with `packRetail`. A page that sends the wrong kind gets a pack it can't match: 409, nothing bought.
- **A separate retail endpoint.** Duplicates the address, rate, price-guard, claim and buy steps that must stay identical.
- Token: **cache per function instance until 5 minutes before `expires_in` (chosen)**, dropped on a 401 with one retry; against a cache in Supabase (another network call per label, and the app token in a table).
- Void: **Shippo refund first, then a SECURITY DEFINER RPC that marks the one matching row (chosen)**, against marking first (a row marked voided while the label is still live lets the box be rebought) or a PATCH (matches nothing under RLS, ADR 0011).

## Decision

- `api/shippo-label.js` takes `kind`. The order of checks stays: already-bought lookup → pack check (per `kind`) → rate → price guard → claim → buy.
- The Shopify token is cached in `api/_shopify.js` as above; only a token that states its lifetime is kept.
- `action=void` (same endpoint: it shares the Shippo auth, the lookup and `confirmWithShippo`): signed-in staff only; the row must be `purchased`; the Shopify order must show no fulfillment of any part; Shippo must confirm the transaction; then `POST /refunds/`; then `mark_ship_label_voided(order, box, shippo id)` flips that row to `voided`, sets `voided_at`, and frees the box's claim. `mark_ship_labels_fulfilled` no longer flips voided rows.

## Consequences

**Positive:** retail labels get the same server-side pack check as B2B, plus the list rules at buy time; old pages are unaffected; a batch of 25 makes one token exchange; a void can't hit a shipped order, and a voided box can be rebought at once.
**Negative:** the page must send `kind: 'retail'` (B3 screen). A refund that succeeds while the row update fails leaves the box reading as bought: the endpoint says so (`row_marked: false`) and Andy fixes the row by hand. Shippo's refund is asynchronous (`QUEUED`); the row says voided before UPS confirms the refund.
**When to revisit:** a third packer, a Shippo refund that comes back `ERROR` after being queued (would need a refund-status check), or more than one Vercel region/instance making the token exchange a rate-limit problem.
