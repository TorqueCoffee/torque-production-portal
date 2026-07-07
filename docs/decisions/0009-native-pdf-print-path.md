# 0009 — Native combined 4x6 PDF, opened in a tab (replaces @page/iframe/PNG print path)

- **Status**: Accepted — supersedes [`0006`](./0006-pdf-label-html-slip-print-mechanism.md), [`0007`](./0007-combined-png-print-document.md), and [`0008`](./0008-same-origin-label-proxy.md)
- **Date**: 2026-07-07

## Context

ADRs 0006–0008 built up an HTML-based print path for the Ship tab: an `@page { size: 4in 6in }` srcdoc, a PNG shipping label embedded as an `<img>`, and a hidden off-screen `<iframe>` whose `contentWindow.print()` was called to trigger printing. After three rounds of iPad Safari fixes (blank labels, tiled labels, blank slips, image-decode races), labels were still printing at roughly 40% size and packing slips were sometimes not printing at all.

Direct verification (not inference) found three independent, unfixable-in-place reasons:

1. **Safari has never supported the `@page` size descriptor**, in any version. The declared 4x6 page geometry is silently ignored — the browser falls back to its default paper size/scale, which is why labels printed small.
2. **AirPrint mis-sizes image-based labels.** A thermal 4x6 label needs to be a native PDF whose MediaBox *is* the physical page. An image goes through AirPrint's scale-to-fit path instead, which does not reliably reproduce a 1:1 4x6 output.
3. **iOS Safari's iframe printing is broken.** `iframe.contentWindow.print()` either prints the parent page or nothing — this is a known, long-standing iOS Safari limitation, not something fixable with load/decode timing (which is what 0007/0008 tried).

None of these are fixable by patching the existing architecture — the architecture itself (`@page` sizing + iframe printing + image labels) cannot produce a correct 4x6 print job on iOS Safari.

## Options considered

- **Keep iterating on the HTML/iframe path** (e.g. different iframe sizing tricks, `window.print()` on the main document instead of an iframe) — rejected: `@page` non-support and AirPrint's image scaling are not workaround-able from HTML/CSS; the iframe issue is a platform bug, not a timing bug.
- **Print via a hidden same-origin `<img>` grid without iframes** — still an image-based label (AirPrint mis-sizing) and still no working way to control the printed page size from the DOM.
- **Build one native 4x6 PDF server-side and open it directly in a Safari tab** — a PDF's MediaBox is a real physical page size that both Safari's PDF viewer and AirPrint respect. iOS's Share > Print sheet on a PDF prints it at its own page size with no `@page` involved at all.

## Decision

- Revert the bought Shippo label back to a native PDF (`label_file_type: 'PDF_4x6'` in `api/shippo-label.js`, both the purchase call and the response field) — Shippo's PDF label already has a correct 4x6 MediaBox, so it can be copied into the combined document unmodified.
- New `api/ship-doc.js`: given an ordered list of boxes, builds ONE `pdf-lib` document — for each box, copy the box's Shippo label PDF page (if `include_labels`), then draw a packing-slip page from scratch with `pdf-lib` (logo, box N of M, weight, contents) at exactly `[288, 432]` pt. No HTML is rendered anywhere in this path. `label_url` is host-allowlisted (`*.goshippo.com` / Shippo's S3 bucket) before the server fetches it, closing the same SSRF surface the old label-proxy guarded.
- `index.html`: one `openShipPdf(boxes, { labels, slips })` helper replaces the whole compose/iframe/print stack. It opens a blank tab **synchronously inside the click handler** (before any `await`), so Safari's popup blocker treats it as user-initiated; once `/api/ship-doc` responds, the tab's `location` is set to a blob URL of the returned PDF. The user then uses iOS's native Share > Print sheet — the same mechanism as opening any PDF link, which iOS Safari reliably supports.
- Deleted `api/label-proxy.js` and all of the 0006–0008 HTML-composition code (`composeContentsSlipHTML`, `composeCombinedPrintHTML`, `composeSingleLabelHTML`, `labelDataUrl`, `printCombinedDoc`, `slipBodyMarkup`, `SLIP_ELEMENT_STYLES`) — none of it is reachable anymore.

## Consequences

**Positive:** the printed output is byte-for-byte a real 4x6 PDF page — no browser CSS page-sizing, no image scaling, no iframe printing anywhere in the path. All three iPad Safari failure modes root-caused above are structurally impossible in this design, not just less likely. The packing slip is now also just page content in the same PDF, so there's no separate print job to race or desync from the label.

**Negative:** each print now costs a full server round-trip to build the merged PDF (previously the client composed HTML locally); "Open + print all" on a large multi-box order waits on that request before the tab shows content. Server-side PDF composition (font embedding, drawing coordinates) is more code than an HTML template, and any layout tweak to the packing slip now means adjusting `pdf-lib` draw calls instead of CSS.

**When to revisit:** if Shippo ever stops offering `PDF_4x6` as a purchasable label format, or if a future non-Safari, non-iOS client needs a different print path where `@page`/iframe printing would actually work correctly.
