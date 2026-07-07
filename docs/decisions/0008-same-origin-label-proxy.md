# 0008 — Same-origin label proxy + inline data: URL for label printing

- **Status**: Accepted — refines the print mechanism from [`0007`](./0007-combined-png-print-document.md)
- **Date**: 2026-07-07

## Context

ADR 0007 switched the bought label from PDF to PNG and combined label+slip into one same-origin print document so "Open + print all" would work under Safari's one-tab-per-gesture rule. In production on iPad Safari, two problems remained:

- **"Open + print all" still printed blank labels.** The combined document embedded the label as a cross-origin `<img src="{shippo label_url}">`. iOS Safari renders a cross-origin image fine on-screen but will not paint it into the print snapshot — the label page came out blank while the slip page printed correctly.
- **The single-label reprint (old "Open label" button) was unusable.** It opened the raw Shippo PNG directly in a tab. A bare image has no page size, so Safari's print dialog tiled it across roughly six sheets at native pixel resolution instead of one 4x6 page.

Both failures trace to the same root cause: the label bytes live on Shippo's CDN, which sends no CORS headers, so the browser can't fetch them client-side and inline them either.

## Options considered

- **Fetch the label with `no-cors` mode client-side** — produces an opaque response; the bytes can't be read or converted to a data URL. Doesn't work.
- **Ask Shippo for a different delivery format (base64 in the API response)** — not offered by the label-purchase endpoint; would require restructuring the buy flow. Out of scope for a print fix.
- **Same-origin server-side proxy** — add a small Vercel function (`api/label-proxy.js`) that fetches the label PNG server-side (no CORS restriction applies there) and re-serves the bytes from our own origin. The client then fetches that same-origin URL, reads it as a `Blob`, and converts it to a `data:` URL with `FileReader`. A same-origin/inline image paints into the print snapshot every time.

## Decision

- New `api/label-proxy.js`: `GET ?url=<shippo label_url>`, validates the host is Shippo (`*.goshippo.com` or an `*.amazonaws.com` host containing `shippo`) and 400s anything else so it can't be used as an open proxy, fetches server-side with `node-fetch`, and streams the bytes back with `Content-Type: image/png`.
- `index.html`: `labelDataUrl(labelUrl)` fetches through that proxy, reads the response as a Blob, and resolves a `data:` URL via `FileReader`; results are cached per `label_url` since a box's label is fetched once but may be printed (or reprinted) multiple times.
- `composeCombinedPrintHTML()` now renders `bw.labelDataUrl` instead of the raw `label_url`; `printAll()` resolves every bought box's data URL (`Promise.all`) before composing the document, and aborts with an alert — printing nothing — if any label fails to load, rather than silently printing a partial job.
- The per-box reprint button is renamed `openLabel(idx)` → `printLabel(idx)`: it resolves that one label's data URL and prints it through a new single-page document, `composeSingleLabelHTML()`, which wraps the image in the same `@page 4in 6in` geometry as the combined doc so a lone reprint is one clean page instead of a multi-sheet tile.
- `printCombinedDoc()` now awaits `img.decode()` on every image (not just `load`) before calling `print()` — decode is what guarantees the bitmap is actually paintable, closing a narrow race where `load` had fired but the image wasn't yet decoded in time for the print snapshot.

## Consequences

**Positive:** both label-print paths (single reprint and combined "print all") now render every time on iPad Safari, because the browser only ever prints same-origin, fully-inlined images — there is no cross-origin image in the print path anymore. The proxy is read-only and host-allowlisted, so it doesn't introduce an open-relay risk.

**Negative:** every label print now costs one extra network round-trip (through our own serverless function) before printing; caching per `label_url` keeps repeat prints of the same label free after the first fetch. The proxy adds one more serverless function to operate, though it needs no environment variables or secrets.

**When to revisit:** if Shippo starts sending CORS headers on label delivery, or offers inline (base64) label bytes in the purchase response, the proxy hop could be dropped in favor of fetching `label_url` directly client-side.
