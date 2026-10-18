# 0020 — Every order ships UPS Ground, at the packed weight

- **Status**: Accepted
- **Date**: 2026-10-17
- **Supersedes**: [0018](./0018-per-customer-carrier-routing.md)

## Context

ADR 0018 routed one account (Best Coffee) to UPS Ground and left every other B2B order on USPS Ground Advantage cubic. Torque has now decided to move all shipping, B2B and retail, to UPS Ground bought through Shippo ([`Retail-USPS-UPS.md`](../Retail-USPS-UPS.md)). Andy, 2026-10-17: "we will ship every order only UPS." This ADR covers B0, the B2B half. Retail follows in slices B1 to B7.

Three facts from live data shaped the build:
- Every Shippo transaction since 2026-09-20 is `test:false`, and the 12 `ups_ground` rows in `shipping_labels` match live transactions. The Vercel `SHIPPO_TOKEN` is already the live token.
- The Shippo login has two UPS accounts, `21db4cf8…` (US, the one used so far) and `588f0f77…` (Canada). The endpoint did not pin either.
- B2B parcels were declared at net coffee weight. All 12 UPS boxes went out declared at 20 lb. A packed 4 x 5 lb box weighs 21.27 lb (A3), and UPS bills actual weight rounded up to the next pound, so each full box was declared about 2 lb light.

## Options considered

- **Keep per-account routing and add every account to the list.** It still fails silently: a new or renamed company falls back to USPS.
- **UPS for everyone on the client only.** A page loaded before the deploy keeps sending `usps`, and nothing on the server stops it.
- **UPS only, enforced on the server (chosen).** The client always sends `ups`, `shippo-label.js` refuses any other carrier, and `shopify-fulfill.js` refuses any tracking company but UPS.
- **For the declared weight: keep net weight** and let UPS correct the invoice afterwards. Rejected: under-declared by design, with possible correction fees and a ledger that doesn't match the invoice.

## Decision

- Every order rates and buys `ups_ground` only. There is no Ground Saver, no USPS and no fallback.
- Shipments are pinned to UPS account `21db4cf80df74a2cb27fc20948862003`, and the rate chosen must carry that account.
- Declared parcel weight = `ceil(measured net + carton tare + 0.05)`, 1 lb minimum (R3). Measured nets: 12 oz 0.75, 2 lb 2.03, 5 lb 5.07. A size with no measured net counts at its nominal weight. The 14x10x10 tare is 0.83. A full 4 x 5 lb box declares 22 lb. The cost row's `weight_lb` holds this declared weight.
- The ship-from phone is 6192305400. A recipient with no phone gets Torque's phone (R5). No recipient email ever reaches Shippo.
- The 20 lb net box cap stays. It began as the USPS cubic ceiling and is now the 14x10x10 box limit.

## Consequences

**Positive:** one carrier with no silent fallback, enforced where the money moves. The declared weight matches what UPS bills, so captured cost should match the invoice. A page loaded before the deploy gets a clear "reload" error instead of buying USPS.
**Negative:** B2B costs more per box. Goleta 20 lb UPS was $16.43, against $10.95 for USPS cubic to La Jolla (plan: about +$127 a month for B2B). The portal can no longer buy a USPS label for anything. A USPS shipment has to be bought by hand in Shippo or Shopify. The cubic code path is gone.
**When to revisit:** the day-90 retail test (if retail returns to USPS, B2B stays on UPS per the plan), new cartons in January (tare table), or a monthly invoice variance above 3%.
