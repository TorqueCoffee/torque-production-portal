# TESTS — pre-commit gates

What must pass before committing each step. No CI here (single-file PWA, static deploy) — gates are checked by eye or a node snippet; the automatable ones are actually run.

## Global (any commit touching index.html)
- [ ] Full-script syntax: extract `<script>` blocks and `node --check` → no errors. A paste error breaks the entire app's JS, so this is non-negotiable. Automated in `tests/syntax.test.js`.
- [ ] `npm test` (`node --test "tests/*.test.js"`) → all pass.

## UPS Ground (Phase B, plan: [`Retail-USPS-UPS.md`](./Retail-USPS-UPS.md))

### B0 — B2B cutover and safety
Every order ships UPS Ground at the packed weight (ADR [`0020`](./decisions/0020-all-orders-ups-ground.md)). `tests/syntax.test.js` + `tests/b0-ups.test.js` (ADR [`0021`](./decisions/0021-node-test-harness.md)), fetch stubbed, no network:
- [x] **G1 syntax:** both inline `<script>` blocks parse; every `api/*.js` passes `node --check`.
- [x] **G2 weight (`resolveWeightLb`):**
  - Title first, then grams (R10). La Mora 5lb at 340 g → 5 lb; 4 bags → one box declared 22.
  - Units lb, oz, g, kg ("900g" → 1.984). xPods and 250 g → 0.75 (R3), but an explicit size wins ("xPods Bulk 45lb Box" → 45).
  - Multipacks ("2 x 12oz", "12oz × 2", "6 pack") and fractions ("1/2 lb") → held (null).
  - Sweep over all 470 shippable variants in `retail_catalog.csv`: every difference from A1's weight is explained by a named exception (held multipack, R3, the Cascara 8oz title, the grams snap when no title size exists).
  - "weight for shipping" fillers are left out of the B2B ship list.
- [x] **G2 declared weight:**
  - `declaredWeightLb`: 4x5 lb → 22, 3x5 → 17, 1x5 → 6, 10x2 lb → 22, 26x12 oz → 21, mixed → 21, TCCDS-40 half → 21, exact 2.00 → 2.
  - Unknown carton, empty box, bad weight, zero qty or no box → null.
  - #6486 (21x5 lb) → [22,22,22,22,22,6].
- [x] **G2 client flow** (real `getRates`/`reRate`/`buyLabels`/`renderShipActions`/`fulfillOrder` in a sandbox):
  - Rate and label requests carry `carrier:'ups'`, `weight_basis:'packed'` and the same declared weights. The label request carries the confirmed price as `"16.43"`.
  - **A 409 stops the buy after that box.** The box shows "Price changed" (not "No rate") and the action bar offers Re-rate, not Buy.
  - **While buying, the action bar has no buttons.** Taps on Buy, Re-rate or Get rates mid-buy start nothing, so each box is bought at most once.
  - Re-rating skips boxes with a label. The buy button counts only boxes still to buy.
  - Shippo's reason and fulfill errors are HTML-escaped. There is exactly one `escHtml`, and it escapes `& < > " '`.
  - Fulfill sends `company:'UPS'` (rollback safety).
  - No `carrierForOrder`, `UPS_COMPANIES` or `'usps'` is left in the page.
- [x] **G3 label endpoint, accepted path:**
  - The request pins `carrier_accounts [21db4cf8…]`, origin phone 6192305400 and ZIP 92104.
  - The recipient address is 9 known string fields: email, extras and non-strings dropped; control characters and zero-width characters removed; cut to 35 characters by code point; the phone falls back to Torque's.
  - From Saver, USPS, CA-account UPS and US-account UPS rates it picks the US-account `ups_ground`.
  - "1 Pobox Way" still ships.
- [x] **G3 label endpoint, refused with 400 before any Shippo call:**
  - carrier usps/USPS/fedex, at rate and at label
  - no `weight_basis`, at rate and at label
  - a weight that is not a whole-pound number (20.5, `'22'`, `true`, 0), or string dims
  - an address that is not an object
  - a P.O. box (P.O. Box, PO BOX, POB, P.O.B., P0 Box, PO + zero-width + Box)
  - a label request with no confirmed price, or one not in `"16.43"` form (`1e308`, `[16.43]`, `true`, `16.431`, `0`, `-1`)
  - `action` Rates, `[rate,rate]`, void
  - No error echoes caller input.
- [x] **G3 label endpoint, purchase path:**
  - No US-account `ups_ground` rate → 422, nothing bought. The response labels rates `torque-us`/`other` and carries no account ids.
  - A fresh price higher than confirmed, even by a cent (16.44 vs 16.43) → 409 with both prices, nothing bought.
  - An unreadable price (`''`, `N/A`, null, 0) or a non-USD one → 409, nothing bought.
  - The same or a lower price buys; the confirmed price may be a number.
  - A purchase logs `ups_ground`, `is_cubic false`, `weight_lb 22`.
  - A failed purchase → 502, no cost row.
- [x] **G3 fulfill:**
  - The tracking company is UPS whatever the page sends.
  - A box with no tracking number (empty, missing, null, an array) → 400 with zero Shopify calls.
  - An open order with a USPS or malformed number → 400 "fulfill by hand", and nothing is created.
  - An already-fulfilled order (e.g. fulfilled by hand) → 200 `alreadyFulfilled`, no notification, label rows flipped to fulfilled.
- [ ] **G4 rate match (no purchase):** after deploy, open one B2B order and tap Get rates.
  - Then quote the same parcel directly in Shippo: account `21db4cf80df74a2cb27fc20948862003`, 14x10x10 in, the "bills N lb" weight from the box header, the order's ship-to address, origin 3459 El Cajon Blvd 92104, residential flag unset.
  - Pass: the amounts are equal.
- [ ] **G5 live buy (Andy):** the next real B2B order goes through the portal. Check by read:
  - Shippo `test:false`, account `21db4cf8…`, `ups_ground`, parcel weight = "bills N lb"
  - cost row = label amount
  - Shopify fulfillment company UPS with a 1Z number
  - one customer email
- [ ] **G6 cutover step 1:** the first 5 B2B UPS shipments. For each: tracking, Shopify email, cost row, and UPS billed weight against declared (A3's tare gap, ADR 0020). Logged in the run log below.
- [ ] **G7 merge (in this order):**
  1. Adversarial review is done and Andy approves.
  2. **Never push `main` on its own.** fc0f43c (the Phase A docs) ships only in the same push as the `.vercelignore` commit. `main` is fast-forwarded to `b0-b2b-ups`, then pushed once.
  3. **Immediately before the push**, in the Supabase SQL editor (anon has no SELECT, ADR 0004): `select order_id, order_name, service, count(*) from public.shipping_labels where status = 'purchased' group by 1, 2, 3;` returns no rows. For each row it does return, the order is fulfilled (by hand in Shopify if its labels are USPS), then `select public.mark_ship_labels_fulfilled('gid://shopify/Order/<id>');`, and the query is re-run.
  4. After deploy:
     - `/docs/RUNBOOK.md` and `/db/2026-07-25-ship-label-recovery.sql` return 404 (ADR [`0022`](./decisions/0022-deploy-allowlist.md)).
     - `/api/shopify-token?type=products` returns 200, and the app loads.
     - Record the deployment time in the JOURNAL B0 entry: `shipping_labels.weight_lb` is declared weight from then on.
  5. Andy checks in the Vercel dashboard whether Deployment Protection covers old `*.vercel.app` deployment URLs, which still serve `/docs` from before the allowlist.

**Run log:**
- 2026-10-17: G1–G3 PASS, 18/18 (`node --test "tests/*.test.js"`, Node 25.8.1).
- 2026-10-17: adversarial review round 1. Accepted fixes landed (see JOURNAL). G1–G3 PASS, 25/25.
- 2026-10-17: adversarial review round 2. Accepted fixes landed (see JOURNAL). G1–G3 PASS, 38/38 (`npm test`).

## B2B Cubic Shipping

> Carrier-specific gates below (cubic GA rate, `is_cubic` true, company USPS, the grams-first resolver) are superseded by B0 above (ADR [`0020`](./decisions/0020-all-orders-ups-ground.md)). They stay as the record of what was tested at the time.

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

**Run log:**
- 2026-06-30: Deploy gate **FAIL** in production — `SUPABASE_URL` in Vercel had a `/rest/v1` suffix already on it; both functions append `/rest/v1/shipping_labels` themselves, so every cost-row write 404'd on the doubled path (`shipping_labels` table was empty, zero rows). Caught when Andy noticed the "cost not logged" badge on a real bought label. Fixed by correcting the env var in the Vercel dashboard + redeploy; confirmed PASS — a real row landed immediately after (`#6500`, $8.43, `purchased`). See JOURNAL "Fix: cost capture silently failing" and the tightened `SUPABASE_URL` guidance in RUNBOOK.md.

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

**Run log:**
- 2026-06-30: On-hardware gate **FAIL** (Andy) — printed slip came back as a 1-page, ~885-byte (effectively blank) PDF in Safari. Root cause: the print iframe was sized `width:0;height:0`; Chromium prints a 0×0 iframe's content fine (why the preview-tool check above missed it), but Safari computes the print canvas from the iframe's own rendered box, so a 0×0 frame yields a blank page regardless of the `srcdoc` content's own size. Fixed: real off-screen dimensions (`width:4in;height:6in`, `left/top:-10000px` instead of `width/height:0`) + a 50ms settle delay before calling `print()`. See JOURNAL "Fix: packing slip printed as a blank page in Safari". **Re-run by Andy still pending** — this exact gate is what caught the bug, so it's the one that must re-PASS before calling this closed.
### Step 6 — live cutover · OVERTAKEN
Live token found in use since 2026-09-20 (every Shippo transaction since then is `test:false`, and the `shipping_labels` rows match them). The preconditions above (1–5b end to end on deploy, funding, live multi-zone $) were never recorded as passing. The carrier cutover itself is B0 above.
