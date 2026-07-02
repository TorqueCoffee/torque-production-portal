# 0007 — PNG labels + one combined label/slip print document for "Open + print all"

- **Status**: Accepted — supersedes the label-format and "print all" parts of [`0006`](./0006-pdf-label-html-slip-print-mechanism.md)
- **Date**: 2026-07-02

## Context

ADR 0006 bought the shipping label as a cross-origin `PDF_4x6` and printed the label and slip as two independent per-box triggers: "Open label" opened the PDF in a new tab for the operator to print by hand, "Print slip" auto-printed the same-origin slip HTML via a hidden iframe. "Open + print all" looped those two triggers over every box.

That loop cannot work on Safari (iPad/iPhone/Mac — the actual production devices). Safari only permits a script to open a new tab **synchronously inside the originating tap**. In a multi-box "print all", only box 1's label tab opens inside the gesture; every box after the first `await` is either popup-blocked (`window.open`) or, when the tab is a reused named target, simply overwritten — so only the last box's label is ever printable. Andy hit exactly this: on a real order, "Open + print all" printed all the packing slips but only one (or zero) shipping labels.

The root obstacle is that a **cross-origin PDF cannot be pulled into our own print document** and cannot be auto-printed via `window.print()`. That forced the per-tab hand-print, which is what collides with the popup model.

## Options considered

- **Keep PDF, keep opening a tab per label** — fundamentally blocked by Safari's one-tab-per-gesture rule for any multi-box order. No amount of sequencing fixes it.
- **Server-side render the PDF's first page to an image and embed that** — needs a PDF→PNG rasteriser in the Vercel function (pdfium/sharp); heavy dependency and cold-start cost for what Shippo can just hand us directly.
- **Buy the label as a PNG and embed it as an `<img>` in one same-origin combined document** — Shippo returns a 4x6 PNG on request; a cross-origin `<img>` (unlike a cross-origin PDF frame) renders and prints cleanly from inside our own page. We build one document containing label 1, slip 1, label 2, slip 2, … and print it as a single job.

## Decision

- `api/shippo-label.js` buys `label_file_type: "PNG"` (was `PDF_4x6`); `label_url` now resolves to a `.png`.
- `composeCombinedPrintHTML()` builds a single 4x6-per-page document interleaving each box's label PNG (`<img>`, `object-fit: contain`) and its slip, in physical packing order.
- `printAll()` injects that document into one hidden iframe, waits for **all images** (label PNGs + slip logos) to finish loading, then calls `print()` once and resolves on `afterprint` (with a 20s CDN-slowness fallback).
- The per-box buttons are unchanged in spirit: "Open label" opens the PNG in a tab for a single reprint; "Print slip" still auto-prints one slip. The slip HTML/CSS is factored into shared pieces (`SLIP_ELEMENT_STYLES`, `slipBodyMarkup`) so single and combined paths render identically.

## Consequences

**Positive:** "Open + print all" now does exactly what the operator wants — one tap, one print job, output grouped per box (label then slip). It also eliminates both earlier print bugs by construction: no tabs means no popup blocker; one document means no concurrent-iframe race producing blank slips.

**Negative:** the label is now a PNG, so "Open label" shows an image rather than a PDF (prints the same). Changing the bought label format touches the money path, so it requires one live Shippo purchase to re-confirm before it's trusted in production. A very slow Shippo CDN could hit the 20s fallback and print before a label image loads (rare; the operator would see a missing label and re-run).

**When to revisit:** if Shippo's PNG at 4x6 proves lower-quality than the PDF on the Rollo, or if a future device/browser lifts the cross-origin-PDF print restriction, reconsider embedding the PDF directly.
