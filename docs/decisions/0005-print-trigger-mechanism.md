# 0005 — Browser print trigger for label + contents slip

- **Status**: Accepted
- **Date**: 2026-06-30

## Context

Step 5 Slice B wires the ship UI, which must "fire the label print and the `composeContentsZPL` print as two jobs per box, label first." The two artifacts are both ZPL: the Shippo shipping label (a remote `.zpl` at `label_url`) and our contents slip (a ZPL string we generate). The planner is a static single-file PWA with no backend print server and no Zebra Browser Print SDK installed. A browser cannot natively render or spool ZPL; only a raster image renders in a print dialog. On-hardware printing was explicitly deferred to Andy + the actual Zebra in Steps 0–3 (kill-condition: fall back to a paper slip if the Zebra can't render the slip cleanly).

So the UI needs a print *trigger* that (a) preserves label-then-slip ordering, (b) needs no new dependency or external service on the hot path, (c) degrades gracefully, and (d) doesn't claim an on-hardware capability we haven't verified.

## Options considered

- **Zebra Browser Print (localhost SDK)** — the "correct" raw-ZPL-to-Zebra path, but requires installing + running the SDK on the station and adding its script; untestable here, and not yet set up. Premature.
- **Render ZPL→image via Labelary, then `window.print()`** — gives a real print dialog, but puts an external service (and order/customer data) on every print, and adds a network dependency to a money-adjacent flow.
- **`window.open()` each ZPL** — popup-blockers reliably kill the second of two sequential opens, breaking the label-first ordering.
- **Sequential `<a download>` of the two ZPL files (label first, slip second)** — two anchor clicks inside one user gesture are not popup-blocked and preserve order; no new dependency, no external call; the operator sends the `.zpl` to the Zebra via the station's existing setup.

## Decision

`printBox()` fires two ordered jobs per box within the click handler: the Shippo `label_url` first (anchor download, `<order>-box<n>-label.zpl`), then the contents slip from `composeContentsZPL` as a Blob (`<order>-box<n>-slip.zpl`). `printAll()` runs `printBox` over every box that has a label. No SDK, no Labelary, no popups. The actual ZPL-to-Zebra send is the station's print setup and remains Andy's on-hardware verification item.

## Consequences

**Positive:** Zero new dependencies; nothing leaves the browser to a third party; label-then-slip ordering is guaranteed; degrades to "files in Downloads" anywhere; honest about what's verified vs. pending.

**Negative:** It's a download, not a one-tap spool to the printer — the operator does the final send, and true hardware printing is still unproven (carried as a pending gate, not a claim).

**When to revisit:** Once the Zebra is wired with Browser Print (or a print server) on the station — swap `openLabelFile`/`openZplBlob` for a raw-ZPL send behind the same `printBox` call, keeping the ordering and the download as the fallback.
