# 0018 — Per-customer carrier routing (Best Coffee → UPS Ground)

- **Status**: Accepted
- **Date**: 2026-09-21

## Context

All B2B orders shipped USPS Ground Advantage cubic ([ADR 0002](./0002-cubic-rate-gate-strategy.md)). USPS is failing to deliver to Best Coffee (Pete Smith, admin), so that one account must ship UPS. Everyone else stays on USPS for now. It may later become a per-order choice, or everyone may move to UPS.

## Options considered

- **Global carrier switch** — simplest, but moves every account off the cheap cubic rate before we know UPS pricing.
- **Per-order carrier picker in the UI** — the likely end state, but more UI and a decision nobody has asked for yet.
- **Rule in code keyed on ship-to company** — one small list; no UI, no schema change.
- **Fallback to USPS when UPS returns no rate** — rejected: it would silently ship the account USPS again.

## Decision

`carrierForOrder(order)` in `index.html` returns `ups` when the Shopify ship-to company is exactly "Best Coffee" (trimmed, case-insensitive), else `usps`. The carrier is sent to `api/shippo-label.js`, which maps it to an exact Shippo service token: `usps_ground_advantage` or `ups_ground`. UPS **Ground Saver (`ups_ground_saver`) is never used.** If the required rate is missing, the box shows a red "No rate" plus a UPS-only warning and nothing can be bought. Fulfillment writes `company: 'UPS'` to Shopify. Box rule unchanged: 1 x 20 lb box.

## Consequences

**Positive:** Best Coffee gets a carrier that delivers; other accounts are untouched; one edit point for the future.
**Negative:** UPS Ground is weight/zone/dim-weight priced, with no cubic tier, so it will cost more than ~$9. `is_cubic` is false for UPS. A renamed company ("Best Coffee LLC") silently falls back to USPS.
**When to revisit:** when a second account needs UPS (make it a customer setting or an order-level picker), or when we decide to move everyone to UPS.
