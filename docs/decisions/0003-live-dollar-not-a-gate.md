# 0003 — Live cubic dollar confirmation is not a build gate

- **Status**: Accepted
- **Date**: 2026-06-29

## Context

ADR [0002](./0002-cubic-rate-gate-strategy.md) split the rate gate into mechanics (test token, done) and the live dollar (live token), and framed the live dollar as a gate to clear before the test→live cutover. Activating the Shippo live token requires Shippo staff and roughly a day of lead time.

Blocking the build on that lead time would stall work that is fully doable on the test token: packing, label mechanics, the ZPL contents block, the Shopify fulfillment write against a draft order, and the UI. The economic premise is also better supported now — test-token cubic rates for the two real B2B lanes came back $8.43 (La Jolla, zone 1) and $9.22 (Simi Valley, zone 3), in line with the ~$9 assumption, and the real account mix looks SoCal-heavy.

## Options considered

- **Keep live $ as a gate (0002 as written).** Safest economically, but idles all build work for ~a day of Shippo lead time. Rejected.
- **Drop the live check entirely.** Cheap, but throws away the one real-money signal. Rejected — the kill condition matters.
- **Reclassify live $ from gate to non-blocking tripwire (chosen).** Build proceeds on the test token; the live dollar is checked when the token activates, without blocking.

## Decision

The live cubic dollar is **not a gate** (decided by Andy, 2026-06-29). The build proceeds end-to-end on the test token. The live dollar is confirmed when the live token is activated — a check we run, not a precondition for the build or the cutover. The kill condition (materially above ~$12 on typical lanes) stays **armed as a tripwire**: a bad live number re-opens the economics, but we do not wait on it to keep building. The mechanics-on-test / dollar-on-live split from 0002 otherwise stands.

## Consequences

**Positive:** No idle time waiting on Shippo activation; all test-token-doable work (Steps 1–5) proceeds now.

**Negative:** The live dollar stays formally unconfirmed deeper into the build; a bad live rate discovered late means more rework than catching it at a gate. Mitigated by the strong test-token signal on the two real lanes.

**When to revisit:** If the activated live rate is materially above ~$12 on typical SoCal lanes, re-open the economic premise (basis kill condition).
