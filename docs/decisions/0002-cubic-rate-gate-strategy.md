# 0002 — Cubic rate gate: certify mechanics on test token, dollar on live token, judge across zone distribution

- **Status**: Accepted — amended by [#0003](./0003-live-dollar-not-a-gate.md) (live dollar reclassified from gate to non-blocking tripwire, 2026-06-29)
- **Date**: 2026-06-29

## Context

The entire economic premise of B2B Cubic Shipping is that USPS Ground Advantage *cubic* pricing for a 14x10x10 box (~$9) beats Shopify Shipping's ~$18-20 on the same parcel. The basis makes the rate gate ("Step 0") the hard precondition for all other work: nothing proceeds until the rate is confirmed.

Two constraints shape how that confirmation can actually happen:

- Shippo's TEST token returns synthetic rates. It can prove the integration mechanics (a `usps_ground_advantage` rate returns, a label buys, tracking + ZPL come back) but it cannot prove the real-world dollar.
- The box sits in the **0.9 cubic tier** (0.81 cu ft, "over 0.80 up to 0.90") — the second-most-expensive cubic tier. Cubic price still varies by USPS zone, so a single near-zone quote does not represent cost across cross-country wholesale accounts.

## Options considered

- **Trust the test-token rate as the gate.** Cheap, but the test dollar is synthetic — certifies nothing about real cost. Rejected as the dollar gate.
- **One live-token quote to a single ZIP.** Confirms a dollar, but only for one zone; misses the zone-distribution risk for distant accounts. Insufficient.
- **Two-phase gate (chosen).** Test token certifies mechanics now; live token certifies the dollar later, evaluated across a near AND far zone against the real B2B account zone mix.

## Decision

Split the gate. (1) The **test token certifies mechanics only** — rate shape, label purchase, tracking, 4x6 ZPL (format token `ZPLII`). Done and passed 2026-06-29. (2) The **live token certifies the dollar**, requested to both a near (SoCal) and a far (East Coast) ZIP, judged against the actual distribution of B2B ship-to zones, before any test→live cutover. The kill condition (materially >~$12 on typical lanes) is evaluated on that live, multi-zone basis.

Corollary: `is_cubic` is **derived** from box dimensions — there is no such field in the Shippo rate object.

## Consequences

**Positive:** The make-or-break economic fact is tested against reality, not a best-case ZIP or a synthetic test rate. Mechanics are de-risked early and for free.

**Negative:** Final go/no-go is blocked on Shippo activating the live token; the dollar premise stays formally unconfirmed until then.

**When to revisit:** If the live multi-zone rate comes back materially above ~$12 on typical lanes, or if the B2B account mix shifts heavily toward distant zones, re-open the economic premise (batch Pirate Ship vs. accept Shopify Shipping for splits).
