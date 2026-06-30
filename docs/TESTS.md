# TESTS — pre-commit gates

What must pass before committing each step. No CI here (single-file PWA, static deploy) — gates are checked by eye or a node snippet; the automatable ones are actually run.

## Global (any commit touching index.html)
- [ ] Full-script syntax: extract `<script>` blocks and `node --check` → no errors. A paste error breaks the entire app's JS, so this is non-negotiable.

## B2B Cubic Shipping

### Step 0 — rate-test gate · DONE 2026-06-29 (test token)
- [x] `usps_ground_advantage` rate returns for 14x10x10 / 20 lb.
- [x] Label buys (transaction SUCCESS); `tracking_number` + `tracking_url_provider` returned.
- [x] Label is 4x6 ZPL (`ZPLII` format; header `^PW812^LL1219` @ 203 dpi; markup contains `CUBIC`).
- [ ] (live token) Live cubic dollar for a near + far zone — **NOT a gate** (ADR 0003); tripwire only (kill if materially > ~$12 typical).

### Step 1 — box packer · DONE 2026-06-29
Pure function `packBoxes()`; node assertions (20/20):
- [x] 4x5lb → 1 box (20 lb); 6x5lb → 2 boxes ([20,10]).
- [x] Empty / null / zero-qty → 0 boxes, no crash.
- [x] Single unit > cap → unpackable (halt-and-warn), not packed; reason `unit_exceeds_box_cap`.
- [x] Unknown / invalid weight → unpackable; reason `unknown_or_invalid_weight`.
- [x] Mixed sizes pack by weight (FFD); every box ≤ cap.
- [x] Configurable cap (supports the net-vs-gross tare decision).
- Note: volume/fit is NOT modeled by design — the human eyeball-confirm step verifies physical fit.

### Step 2 — Shippo rate+label endpoint · DONE 2026-06-29 (test token)
`api/shippo-label.js`; node integration test vs the real Shippo TEST API (16/16):
- [x] `action=rate` → GA rate, correct zone, `is_cubic` true, `rate_id`; no purchase.
- [x] `action=label` → SUCCESS; `tracking_number`, `tracking_url`, `.zpl` `label_url`, `cost`=amount, `shippo_object_id`.
- [x] No GA rate → 422 with the rates shown (never silently weight-based).
- [x] Guards: missing body → 400; wrong method → 405; OPTIONS → 204 + CORS.
- Deploy gate: `SHIPPO_TOKEN` set in Vercel env before the endpoint works.

### Step 3 — ZPL contents block · SUPERSEDED 2026-06-30 (see Print mechanism correction below)
`composeContentsZPL()`; node assertions (10/10) + Labelary 4x6 render — historical record of the original ZPL build, kept for provenance. The actual hardware is a Rollo (normal PDF/HTML printer), not a bare Zebra — `composeContentsZPL()` was replaced by `composeContentsSlipHTML()`; see the Print mechanism correction block after Step 5 Slice B and ADR 0006.
- [x] (historical) Valid `^XA…^XZ`; `^PW812`/`^LL1219` (4x6 @203 dpi); `^CI28`.
- [x] (historical) Box id ("BOX n OF m"), weight, and per-coffee `qty × name (size)` all present.
- [x] (historical) Busy multi-coffee box renders all lines; long names fit.
- [x] (historical) Control-char (`^`/`~`/`\`) injection in names neutralized.

### Step 4 — Shopify fulfillment write · DONE 2026-06-30 (live-tested on throwaway order #6497)
`api/shopify-fulfill.js` + `fulfillmentCreate`; validated + executed on Torque's store:
- [x] One fulfillment carries BOTH tracking numbers (`numbers[]`+`urls[]`), company USPS.
- [x] `notifyCustomer:true` → SUCCESS, zero userErrors (shipping email dispatched).
- [x] Idempotency: after fulfillment, FO = CLOSED → guard returns `alreadyFulfilled`, no re-notify.
- [x] Test order used a custom $0 line item (no inventory impact); archived after.
- [ ] Andy confirms ONE clean Torque-branded email at info@torquecoffees.com with both tracking links.
- Deploy gate: planner's custom app (`SHOPIFY_CLIENT_ID`) must have `write_merchant_managed_fulfillment_orders`.

### Step 4b — cost capture · DONE 2026-06-30 (e2e tested)
`shipping_labels` table + capture in `shippo-label.js` + status flip in `shopify-fulfill.js`:
- [x] Table created; RLS on; anon INSERT+UPDATE (no SELECT/DELETE); `unique(shippo_object_id)`.
- [x] Label buy writes the cost row (status `purchased`) via publishable key → `cost_logged:true` (e2e).
- [x] Non-blocking: a log failure never blocks the label (response carries `cost_logged`/`cost_log_error`).
- [x] Fulfillment flips the order's rows to `fulfilled` (`cost_updated`).
- Deploy gate: `SUPABASE_URL` + `SUPABASE_ANON_KEY` in Vercel env (public values).

### Step 5 Slice A — per-order payload + weight resolver · DONE 2026-06-30
`shopify-token.js?type=b2b-ship` + `resolveWeightLb`:
- [x] Resolver: grams→lb snapped to 0.25 (2270g→5.0, 908g→2.0, 340g→0.75); variant-title fallback; null if unknown. 12/12.
- [x] Integration: real order #6486 (21×5lb) → packer → 6 boxes (20,20,20,20,20,5), not 7.
- [x] `b2b-ship` payload shape: per-order id/name/shipping_address/items(weight_lb); B2B-only; syntax-checked. (Runs on deploy — uses existing SHOPIFY_* creds.)

### Step 5 Slice B — ship UI flow · DONE 2026-06-30 (preview-verified; live e2e deploy-gated)
The `Ship` tab in `index.html` (open order → pack → confirm rate → buy labels → print label+slip → fulfill → tracking back). Verified in the local preview by stubbing `fetch` to the documented API contracts (the `/api/*` functions don't run under the static server) + the pure helpers run live:

- [x] `node --check` on the extracted inline script — no errors.
- [x] **Helpers:** `toShippoAddress` maps `address1/province_code/country_code`→`street1/state/country` and passes **no email** to Shippo (spec amendment #6); `boxParcel` parses `14x10x10`→dims with a safe fallback.
- [x] **Happy path (multi-box):** #9001 (6×5lb) → list shows "2 boxes" → open packs [20,10] → rate total $17.00 → buy → 2 distinct tracking numbers → fulfill → `fulfilled`, notified once, tracking rendered.
- [x] **Confirm-before-spend:** rates are a deliberate stop; buy shows the visible total **and** a `confirm()` dialog before any label call.
- [x] **Partial failure recoverable (G-U3):** box 2 label fails → `phase:partial`, box 1 kept, retry offered, fulfill blocked; retry buys only the failed box (box 1 tracking unchanged — never re-charged) → all bought → fulfill offered.
- [x] **Already-fulfilled (no double-notify):** `shopify-fulfill` returns `alreadyFulfilled` → calm blue state, `notified:false`, not an error.
- [x] **Fulfill failure keeps labels:** 502 from fulfill → falls back to `bought` with the labels intact + a retry that doesn't re-buy → retry succeeds → `fulfilled`.
- [x] **No-GA-rate (422) blocks the buy:** a box with no Ground Advantage rate shows the message + the returned alternatives, blocks buying, offers Re-rate (never silently weight-based).
- [x] **Halt-and-warn:** an order with a >20 lb item (unpackable) shows the red warning, 0 boxes, "nothing charged", no buy offered.
- [x] **Graceful empty (G-U2):** zero shippable orders → "No shippable B2B orders" + zeroed summary.
- [x] **Graceful load failure (G-U3):** real `/api` 404 (local) → red alert, no crash.
- [x] **Mobile fold (G-U4):** box cards stack, status chips wrap, per-box print + actions reachable.
- [x] **No regression (G-U5):** `Ship` tab added after `B2B` so `.tab[3]` stays `Blends` (stale-warn handler intact); existing B2B reference tab untouched; `#ship` added to the `@media print` hide list.
- [x] No console errors across the full drive.
- [ ] **LIVE e2e (deploy-gated — Andy):** pack→rate→label→fulfill on the Shippo **test token** against a real/throwaway order end to end, same pattern as #6497. WAIVED locally — the serverless functions + `SHIPPO_TOKEN`/`SHOPIFY_*`/`SUPABASE_*` env live on Vercel; can't run under the static preview. Same deploy-gate posture as Steps 4/4b.
- [ ] **On-hardware print (Andy):** label PDF + HTML slip print cleanly on the Rollo (mechanism verified below; physical print pending Andy).

### Print mechanism correction — PDF label + HTML slip (Rollo, not Zebra) · DONE 2026-06-30
The actual hardware is a Rollo (system printer, 4x6 PDF/HTML), not a bare Zebra — see Amendment in [`b2b-cubic-shipping.md`](./b2b-cubic-shipping.md) and ADR [`0006`](./decisions/0006-pdf-label-html-slip-print-mechanism.md) (supersedes ADR 0005). `api/shippo-label.js` now requests `label_file_type: "PDF_4x6"`; `composeContentsZPL()` is replaced by `composeContentsSlipHTML()`; the print step is two independent buttons (Open label / Print slip) instead of one combined download action.

- [x] `node --check api/shippo-label.js` and the extracted `index.html` inline script — both clean.
- [x] `label_file_type: "PDF_4x6"` is the literal value sent on the Shippo transaction body (alongside `rate`/`async`); the response's `label_file_type` field reflects the same value. **Live purchase against the Shippo test token to confirm `label_url` actually resolves to a real, renderable `.pdf` is deploy-gated to Andy** (same posture as the other live-network gates above — `SHIPPO_TOKEN` lives on Vercel, not locally).
- [x] **`composeContentsSlipHTML` — node assertions (15/15):** `@page { size: 4in 6in; margin: 0; }` present; box id / weight / order# / company / qty+name+variant all render; empty contents shows `(no items)`; unknown weight shows `? lb`; no barcode/QR element (the original ZPL slip had none either); HTML-injection in product name and order name is escaped (`<script>`, `onerror=` neutralized) — this matters because the output is injected via `srcdoc`.
- [x] **Rendered in a real browser preview at 4x6 (384×576px @96dpi)** — legible, content fits with room to spare on a 3-item box. **Caught and fixed a real bug**: the slip had no explicit `background:#fff`, so it rendered black-on-near-black under a dark color-scheme default; added `background:#fff` to `html, body`. **Note:** the preview tool's engine is Chromium-based, not WebKit — it confirms layout/legibility and the injection-safety fix, but is not a substitute for an actual Safari render. Checking specifically in Safari on iPad/Mac is **deploy-gated to Andy** (same posture as on-hardware print, above); the one-line UI hint about manually picking 4x6 in the print dialog covers Safari's known `@page` inconsistency in the meantime.
- [x] **Open label / Print slip fire independently, multi-box order:** clicking box 1's "Open label" only set box 1's `labelOpened`; clicking box 2's "Print slip" only set box 2's `printed` — neither blocked the other, both buttons stayed independently clickable (re-)labeled ("Reopen label" / "Reprint slip") per box state.
- [x] **`openLabel` opens, doesn't download:** the anchor has `target="_blank"`, no `download` attribute — opens the PDF in a new tab for the system viewer instead of forcing a file save.
- [x] **`printSlip` iframe lifecycle:** iframe is present in the DOM immediately after the call (synchronous append), `srcdoc` loads, `contentWindow.print()` fires, and the iframe is removed automatically afterward — confirmed empty DOM ~1.5s after a single call; repeated clicks don't accumulate hidden iframes.
- [x] **Mobile fold (G-U4):** both buttons stack cleanly per box on a 375px-wide viewport; the Safari paper-size hint and "Open + print all" stay reachable.
- [x] No console errors across the drive.
- [ ] **On-hardware (Andy, deploy-gated):** label PDF + slip print cleanly from Safari/iPad-Mac with the Rollo selected in the system print dialog.

### Step 6 — live cutover — TBD
Switch `SHIPPO_TOKEN` test→live only after 1–5b pass end to end on deploy. Confirm Shippo funding + live multi-zone $ (near + far) first; planner-app fulfillment scope + all env vars set in Vercel.
