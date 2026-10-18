# 0020 — Every order ships UPS Ground, at the packed weight

- **Status**: Accepted
- **Date**: 2026-10-17
- **Supersedes**: [0018](./0018-per-customer-carrier-routing.md)

## Context

ADR 0018 routed one account (Best Coffee) to UPS Ground and left every other B2B order on USPS Ground Advantage cubic. Torque has now decided to move all shipping, B2B and retail, to UPS Ground bought through Shippo ([`Retail-USPS-UPS.md`](../Retail-USPS-UPS.md)). Andy, 2026-10-17: "we will ship every order only UPS." This ADR covers B0, the B2B half. Retail follows in slices B1 to B7.

Facts from live data that shaped the build:
- Every Shippo transaction since 2026-09-20 is `test:false`, so the Vercel `SHIPPO_TOKEN` is already live.
- The Shippo login has two UPS accounts: `21db4cf8…` (US, the one used so far) and `588f0f77…` (Canada). The endpoint pinned neither.
- B2B parcels were declared at net coffee weight. All 12 UPS boxes went out at 20 lb, while a packed 4 x 5 lb box weighs 21.27 lb (A3). UPS bills actual weight rounded up to the next pound.
- Under USPS cubic the price ignored weight up to 20 lb, so wrong Shopify grams did no harm. Under UPS they do. 98 of 576 variants carry grams that disagree with the title; La Mora 5lb, for example, stores 340 g.

This reverses two decisions Andy marked RESOLVED on 2026-06-29 in [`b2b-cubic-shipping.md`](../b2b-cubic-shipping.md):
- **"Net-vs-gross: 4×5lb is 20 lb flat, no tare margin."** That held for cubic pricing. UPS bills the packed weight.
- **"Weight source: prefer Shopify variant grams."** Phase A's R10 found grams wrong too often. The title now comes first.

## Options considered

- **Keep per-account routing and list every account.** Still fails silently: a new or renamed company falls back to USPS.
- **UPS for everyone, client only.** A page loaded before the deploy keeps buying what it always did.
- **UPS only, enforced on the server (chosen).** The client sends `ups` and `weight_basis: 'packed'`. The label endpoint refuses any other carrier, a missing basis (an old page sending net weight), a non-integer weight, and a P.O. box. Fulfillment refuses any tracking number that isn't UPS.
- **Declared weight: keep net weight** and let UPS correct the invoice. Rejected: it under-declares by design.
- **Declared weight: compute it on the server from the box contents.** Stronger, but it needs the packing rules shared between page and server. That is plan row B2a.
- **Price drift between quote and purchase.** Options:
  - buy whatever the re-rate returns (the old behavior)
  - buy the quoted `rate_id` after checking its account and service on the server
  - re-rate and refuse a higher price (chosen: no second lookup to get right, and any price rise goes back to the operator)

## Decision

- Every order rates and buys `ups_ground` on UPS account `21db4cf80df74a2cb27fc20948862003`. The account is pinned on every shipment, and the chosen rate must carry it. There is no Ground Saver, no USPS and no fallback.
- **Weight per bag (R10, R3):** taken from the variant title first, then the product title, then Shopify grams. Units: lb, oz, g, kg. A title naming several bags ("2 x 12oz", "6 pack") or a fraction is held (unpackable), not guessed. xPods and the 250 g box count as 12 oz only when the title gives no other size.
- **Declared parcel weight (R3):** `ceil(measured net + carton tare + 0.05)`, 1 lb minimum.
  - Nets: 12 oz 0.75, 2 lb 2.03, 5 lb 5.07. Any other size counts at its nominal weight.
  - The 14x10x10 tare is 0.83, the Uline spec.
  - A full 4 x 5 lb box declares 22 lb.
  - The page computes the weight. The server accepts only a whole pound of at least 1, sent with `weight_basis: 'packed'`. **B0 does not verify the weight on the server; `weight_basis` only detects stale pages.**
  - `shipping_labels.weight_lb` holds this declared weight from the deploy on. Rows before the deploy hold net weight.
- **Price guard:** the label step re-rates. Nothing is bought (409) when UPS now charges more than the confirmed price, or when the price can't be read or isn't in USD; the box goes back to the rate step, and the buy stops. A lower price buys without asking. The 0.005 tolerance only absorbs float noise.
- **Fulfillment:**
  - The tracking company is always UPS, every number must be `1Z` + 16, and no tracking URL is sent (Shopify builds the UPS link).
  - An order counts as already fulfilled only when Shopify shows it FULFILLED with every fulfillment order CLOSED. Held, scheduled, incomplete, cancelled and invisible orders get a 409 that says what to do, and their label rows stay pending.
  - A USPS label bought before the deploy is fulfilled by hand in Shopify. Then either tap Fulfill order again on the open screen, or tap Clear on the red banner (shown for pending orders no longer in the list). Both take the already-fulfilled path, which clears the "paid, not fulfilled" flag.
- **One label per box:** before buying, the server looks up the order's existing labels (the ADR 0011 RPC). If this `box_index` already has one, it hands that label back (409 "Already bought") instead of charging again. If the lookup fails, the buy goes ahead (R8). *Changed by ADR [0023](./0023-supabase-auth-logins.md): a failed or refused lookup now buys nothing (503).* The page also blocks leaving or reopening an order while a buy is running.
- **Address lines:** street 1, street 2 and city longer than 35 characters are refused with a message to shorten them in Shopify, never cut. Name and company are cut to 35. Fields over 200 characters are refused before any processing.
- **Rate step:** a price that can't be read or isn't in USD is refused (422) at rate time too, so it's never shown as buyable.
- **Addresses:** the ship-from phone is 6192305400. A recipient with no phone gets Torque's phone (R5). Shippo receives only the known address fields, and never a recipient email (R6).
- **Box cap:** the 20 lb net cap stays. It began as the USPS cubic ceiling; `b2b_slip_spec.md` keeps box splitting unchanged, and A3 measured that 4 x 5 lb fits the 14x10x10.

## Consequences

**Positive:**
- One carrier with no silent fallback, enforced where the money moves.
- A page loaded before the deploy is refused with "reload" instead of buying USPS or buying at net weight.
- Wrong Shopify grams no longer shrink a box.
- A price jump between quote and purchase can't be bought without a fresh confirmation.

**Negative:**
- B2B costs more per box. The plan's +$127 a month comes from its 2026-10-16 quotes, from 92105 and at net weight. With tare, full boxes bill 22 lb, so expect somewhat more. The first invoices will say.
- The portal can no longer buy a USPS label. A USPS label bought before the deploy and not yet fulfilled must be fulfilled by hand in Shopify.
- xPods now pack and declare at 0.75 lb each (R3). In B2B that over-declares: 26 xPods boxes declare 21 lb against about 9 lb real, so a large xPods order uses more boxes and pays for weight it doesn't have. Confirmed by Andy, 2026-10-18: R3 applies to B2B, and the 14x10x10 tare stays 0.83.
- A3's packed box (21.27 lb) is 0.11 lb heavier than the model (20.28 + 0.83 + 0.05 = 21.16). Boxes near a pound line may still bill 1 lb over the declared weight, for example a single 5 lb bag (5.95 declared as 6, about 6.06 packed).

**When to revisit:**
- Before B2 (plan row B2a): move the weight resolver, carton tares, bag nets and billed-lb rule into `lib/ship-rules.js`, loaded by the page and `require`d by the API. The label endpoint can then re-pack the order and refuse a weight that doesn't match.
- The monthly invoice check shows variance above 3%, or the tare is re-measured.
- New cartons arrive in January.
- The day-90 retail test (if retail returns to USPS, B2B stays on UPS).
