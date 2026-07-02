# 0006 — PDF label + HTML contents slip, printed via the system dialog (Rollo)

- **Status**: Superseded by [`0007`](./0007-combined-png-print-document.md) for the label format + the "print all" mechanism; the HTML-slip and print-via-system-dialog decisions still stand
- **Date**: 2026-06-30

## Context

ADR 0005 designed the print step around a bare Zebra printer: both the Shippo shipping label and the contents slip were raw ZPL, downloaded as `.zpl` files for hand-off to the station's print setup, because a browser cannot natively render or spool ZPL.

The actual production hardware is a **Rollo thermal printer**, not a bare Zebra. The Rollo shows up as a normal system printer in macOS/iOS and consumes standard PDFs/HTML at 4x6 — it has no use for raw ZPL at all. ADR 0005's premise (no native ZPL rendering, so download-and-hand-off is the only option) no longer applies: the print artifacts can now go straight through the browser's own print pipeline, with the Rollo selected as the destination in the system print dialog on iPad/Mac Safari.

## Options considered

- **Keep ZPL downloads, rely on the operator to print the `.zpl` file some other way** — wrong shape for the actual hardware; a Rollo doesn't consume ZPL, so this would require a conversion step that doesn't exist.
- **Render both artifacts as images via Labelary, `window.print()` each** — works for the slip, but still puts an external service + order/customer data on every label print, and is redundant once Shippo can hand back a PDF directly.
- **Shippo `label_file_type: PDF_4x6` for the label + a fresh HTML layout for the slip, each printed via the platform's own print path** — the label is cross-origin so it opens in a new tab and the user prints it themselves from the system PDF viewer (Safari/iOS can't `window.print()` into another origin's document); the slip is same-origin generated HTML, so it can be auto-printed via a hidden `<iframe srcdoc>` + `iframe.contentWindow.print()`.

## Decision

- `api/shippo-label.js` requests `label_file_type: "PDF_4x6"` on the Shippo transaction (was `ZPLII`). `label_url` now resolves to a `.pdf`.
- `composeContentsZPL()` is replaced by `composeContentsSlipHTML(box, opts)` — a fresh HTML/CSS layout (`@page { size: 4in 6in; margin: 0; }`), not a transliteration of the ZPL layout.
- The print step is two independent triggers per box, not one combined action: **Open label** opens the Shippo PDF in a new tab (`<a target="_blank">`, no `download` attribute, so it renders in the system PDF viewer) for the user to print themselves; **Print slip** injects `composeContentsSlipHTML`'s output into a hidden `<iframe srcdoc>`, waits for load, and calls `iframe.contentWindow.print()`, then removes the iframe. Label-before-slip stays the presentation order in the UI by convention, but each is its own button — neither blocks the other.
- A one-line, low-key UI note tells the operator that Safari doesn't always auto-apply the CSS `@page` size, so the first slip print may need manual 4x6 selection in the print dialog.

This **locks in PDF_4x6 + HTML-slip-via-iframe** as the print mechanism for this feature. It is a deliberate move away from ZPL, not a temporary one — do not revert toward ZPL in a future session.

## Consequences

**Positive:** Both artifacts print through the platform's native print pipeline, which is what the Rollo actually needs; no SDK, no external rendering service, no raw-protocol hand-off; the label and slip remain independently retriggerable without leaving stale state behind (the iframe is removed after each print).

**Negative:** "Open label" is a manual two-step for the operator (open, then tap print in the PDF viewer) rather than a one-tap spool — there's no cross-origin `window.print()` path around that. Safari's `@page` size support is inconsistent, so the first print of a slip may need a manual paper-size pick — mitigated with the UI hint, not eliminated.

**When to revisit:** If the station hardware changes again (e.g., back to a raw-ZPL printer, or a print-server/SDK gets installed that can spool both artifacts in one tap), re-open this decision rather than layering a second mechanism on top.
