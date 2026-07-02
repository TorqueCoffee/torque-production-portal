# Journal

## 2026-07-02 — Re-architect "Open + print all": PNG labels + one combined print document

### Work done

- **Why the previous two fixes couldn't fully work:** the real constraint isn't standalone-PWA mode (an earlier guess) — it's that Safari (iPad/iPhone/Mac, confirmed as Andy's devices, all normal Safari tabs) only lets a script open a new tab **synchronously inside the tap**. Any per-box label tab opened after an `await` is popup-blocked, or — with a reused named tab — overwritten, so only the last box's label is ever printable. Slips (same-origin iframes) printed fine; multi-box labels never could via the tab loop.
- **New architecture (ADR [`0007`](./decisions/0007-combined-png-print-document.md)):** buy the label as a **PNG** and print the whole order as **one combined same-origin document** — label 1, slip 1, label 2, slip 2, … — in a single print job. A cross-origin `<img>` prints cleanly from our own page (a cross-origin PDF can't), so this sidesteps the popup blocker entirely and, as a bonus, kills the earlier blank-slip race (no concurrent iframes anymore).
- **Code:**
  - `api/shippo-label.js`: `label_file_type` `PDF_4x6` → `PNG` (transaction + response).
  - `index.html`: factored the slip into `SLIP_ELEMENT_STYLES` + `slipBodyMarkup()` so single and combined prints render identically; `composeContentsSlipHTML()` (per-box) now wraps those; new `composeCombinedPrintHTML()` builds the interleaved 4x6-per-page doc; `printAll()` rewritten to compose that doc and print once via `printCombinedDoc()`, which waits for every image (label PNGs + logos) to load before printing and resolves on `afterprint` (20s CDN-slowness fallback).
  - Per-box "Open label" / "Print slip" buttons unchanged in purpose (single reprints); help-card copy updated.

### Verification

- `node --check` on `api/shippo-label.js` + both inline `<script>` blocks passes.
- Browser preview: `composeCombinedPrintHTML()` on a 2-box fixture produced exactly 4 pages in order — LABEL 1 → SLIP 1 → LABEL 2 → SLIP 2 — with correct box IDs, item counts, `@page 4in 6in`, and the label-image sizing rule. Rendered visibly at 4x6: label fills the page, page-breaks, slip follows with logo + order sub + box id + weight. No console errors.
- **Not certified, by design:** a **live Shippo PNG purchase** — the format change touches the money path and can't run from local. **Andy to buy one real 4x6 PNG label on the token and confirm** `label_url` resolves to a renderable `.png`, then run "Open + print all" on a 2-3 box order and confirm the Rollo emits label/slip/label/slip in order. (The prior orders were bought as PDF; only new purchases are PNG.)

## 2026-07-02 — Incident: two paid B2B orders stuck UNFULFILLED; "order not found" was a missing app scope

### Work done

- **Symptom (Andy, live):** #6518 (3rd St Market, 3 boxes) showed unfulfilled with no printed-label state; fulfilling #6529 (1 box) errored `Fulfillment didn't complete: order not found`, and retry failed the same way.
- **Ground truth pulled from Shopify + Supabase before touching anything:**
  - `shipping_labels` had all 4 labels safely `purchased` with tracking — #6518 boxes `…589183/…589213/…589251` ($8.50×3), #6529 `…600451` ($8.25). No labels or money lost.
  - Both orders in Shopify were genuinely `UNFULFILLED`, fulfillment orders `OPEN`, zero fulfillments — never fulfilled, not a display glitch. The `order_id`s in the labels table matched Shopify exactly, so the id handed to the fulfill endpoint was correct.
  - A direct `order(id:)` GraphQL query (via the authorized MCP connection) found #6529 fine — so the order exists; the endpoint's own lookup was the thing returning null.
- **Root cause:** the fulfill endpoint's first query reads the order **with its `fulfillmentOrders`** ([`api/shopify-fulfill.js`](../api/shopify-fulfill.js) step 1), which requires `read_merchant_managed_fulfillment_orders`. The planner's custom app has `read_orders` (so listing orders + buying labels works) but appears to lack the fulfillment-order scopes. Shopify rejects the query → `data: null` → the code misreported it as **"Order not found."** The same missing scope would also block `fulfillmentCreate`. This was the exact deploy gate flagged on 2026-06-30 (Step 4) and never closed.
- **Remedy (with Andy's go-ahead — sends customer emails):** fulfilled both orders directly via Admin API `fulfillmentCreate` — one fulfillment per order carrying all box tracking (so #6518's customer got ONE email with all three numbers), `notifyCustomer:true`, `company:USPS`. Both returned `status: SUCCESS`, zero `userErrors`. Then flipped the four `shipping_labels` rows `purchased → fulfilled` to match what the endpoint would have done.
- **Code fix (diagnosability, so this can't masquerade again):** the endpoint now distinguishes a scope/access GraphQL error (→ 502 + a message naming the missing `*_merchant_managed_fulfillment_orders` scopes) from a genuinely absent order (→ 404 "Order not found"); the client (`fulfillOrder`) now appends `data.detail` to the on-screen error instead of showing only the top-line message.

### Detours & fixes

- **#6518's "lost" printed-label state was the in-memory `shipState` limitation, not lost labels.** The ship flow keeps state only in memory (accepted limitation, 2026-06-30 Step 5); this session's two deploys forced a reload that dropped it. But #6518 was never fulfilled regardless, so the remedy was identical to #6529 — the state loss changed nothing material (labels were safe in Shippo + the DB the whole time).

### Still pending — Andy (the real fix)

- **Grant the planner's custom Shopify app `read_merchant_managed_fulfillment_orders` + `write_merchant_managed_fulfillment_orders`, then reinstall/reauthorize.** Until then the in-app Fulfill button will keep failing (now with a legible scope message instead of "order not found"). Direct-API fulfillment (as done here) is the manual fallback in the meantime.

## 2026-07-02 — Fix: "Open + print all" only opened one label and printed blank slips

### Work done

- **Root cause 1 (only one label opened):** `openLabel()` opened the Shippo PDF via `a.target = '_blank'`, and `printAll()` called it once per box in a tight loop. Browsers allow only one new tab/window per user gesture; Safari silently popup-blocked every box after the first.
- **Root cause 2 (blank/missing packing slips):** `printAll()` fired all boxes' `printSlip()` calls synchronously with no waiting between them, so 2-3 hidden print iframes loaded and printed concurrently. Each was force-removed on a flat `setTimeout(1500ms)` regardless of whether the print job had actually captured its content yet — under that concurrent load the timer sometimes won the race and yanked an iframe before its print snapshot finished, producing a blank page.
- **Fix** in [`index.html`](../index.html):
  - `openLabel()` now opens/navigates a single named window (`window.open(url, 'torque-ship-label')`) instead of a fresh `_blank` per call. The first call opens a real tab (spends the click's gesture allowance); every later call just navigates that same tab, which browsers never treat as a new popup.
  - `printSlip()` now returns a Promise that resolves on the iframe's `afterprint` event (with a 5s fallback for iOS Safari, which doesn't always fire `afterprint` inside an iframe), and only removes the iframe once that fires — no more racing a flat timer against the real print job.
  - `printAll()` is now `async` and processes boxes one at a time (`open label → settle → await print slip → next box`), guarded by a `shipState.printingAll` flag so the action-bar button disables itself and shows "Printing…" mid-run instead of allowing re-entrant clicks.
- Updated the Ship-tab help card to describe the new one-box-at-a-time behavior.

### Verification

- `node --check` on both extracted inline `<script>` blocks passes.
- Live-browser test (Chromium preview) with a faked `shipState` of 3 boxes each carrying a bought label: driving the real "Open + print all" button showed `window.open` called 3 times, all targeting the same window name (`torque-ship-label`) — confirming the popup-reuse fix — and each box's `printed`/`labelOpened` flags only flipped in order, one box completing (via its real print job or the fallback) before the next box started. No console errors. `shipState.printingAll` correctly reset to `false` at the end.
- **Not certified, by design:** real Safari/iPad + Rollo behavior for `window.open` tab-reuse and `afterprint` timing — same posture as every prior print-path change on this feature. **Andy to confirm on the real hardware**: click "Open + print all" on a real 2-3 box order and verify all labels appear (in the one reused tab) and every slip has content, in order.

### Detours & fixes

- **Deployed, then Andy reported the opposite regression: every slip printed, but zero labels opened.** The `window.open(url, 'torque-ship-label')` swap (chosen to dodge the popup blocker) is very likely a silent no-op on this iPad, because the planner is used as a home-screen install (standalone display mode — no Safari chrome/tabs to open a window into), whereas a real `<a target="_blank">` click is handled as an actual link tap even in standalone mode and at least worked for box 1 before this session's fix. **Fix:** reverted `openLabel()` to the original `<a>`-click mechanism, changing only `target` from `_blank` (always-new, gets popup-blocked on box 2/3) to a fixed name `torque-ship-label` (reused on repeat clicks, same target-name semantics as `window.open`). This keeps the exact behavior that already worked for box 1 while still fixing the blocked-boxes-2/3 bug. Not yet confirmed on the real device — same "Andy to confirm on real hardware" gate as above.

## 2026-06-30 — Add Torque logo to contents slip

### Work done

- Added the Torque logo (black-on-white, CDN-hosted) to the header of `composeContentsSlipHTML()` in [`index.html`](../index.html), beside the "TORQUE COFFEE" text. `max-width:140px` keeps it modest against the 4x6 page; `onerror="this.style.display='none'"` degrades quietly to text-only if the CDN is unreachable at print time, rather than leaving a broken-image icon.
- Verified in the preview browser at the exact 4x6 print pixel size: logo and header text sit on one line, no overlap with the boxid/contents block below, and the page still fits one print page per box.
- Verified the `onerror` fallback by pointing the `src` at a bad URL — image disappears cleanly, header text reflows to fill the space, no broken-image icon.
- Confirmed the existing Safari print path (`printSlip()`, see the 2026-06-30 blank-page fix above) is unaffected: the iframe's `onload` event — which gates when `print()` fires — only resolves after the framed document's resources (including this image) finish loading or failing, so the logo (or its fallback) is settled before the print snapshot is taken.
- Did not touch `api/shippo-label.js` — the carrier shipping label is a Shippo-rendered PDF and cannot carry custom branding; that's a Shippo label-format constraint, not a settings gap, so no further work should be attempted there. Branding lives on the custom contents slip only.

### Detours & fixes

- Could not drive an actual Safari print dialog from this session — computer-use treats browsers as read-tier (screenshots only; clicks/typing blocked), so Cmd+P couldn't be triggered programmatically. Browser-rendered verification at exact print dimensions was completed instead; **Andy should do one real print-preview pass in Safari on iPad/Mac to fully close out the print-path verification** called for in the task.

## 2026-06-30 — Fix: cost capture silently failing (doubled `/rest/v1` Supabase path)

### Work done

- **Root cause:** Andy noticed an amber "cost not logged" badge on a bought label and asked whether it was a test-token artifact — it wasn't. `SUPABASE_URL` in the Vercel `coffee-planner` project was set to `https://gblkovtjylrfdotoktkb.supabase.co/rest/v1` (with the `/rest/v1` suffix already included). Both `api/shippo-label.js` (cost-row insert at purchase) and `api/shopify-fulfill.js` (status flip to `fulfilled`) append `/rest/v1/shipping_labels` themselves, so every request landed on the doubled path `/rest/v1/rest/v1/shipping_labels` and 404'd.
- **Confirmed three ways before touching anything:** the `shipping_labels` table was completely empty (zero rows, ever — not scoped to test orders); Supabase's own API logs showed the exact doubled-path 404 on recent purchase attempts; RLS policies on the table were verified correct (anon INSERT + UPDATE present), ruling out the more common RLS-blocks-silently failure mode.
- **Fix:** Andy corrected `SUPABASE_URL` in the Vercel dashboard to the bare project URL (no `/rest/v1` suffix) and redeployed. Verified fixed — a real row landed immediately after (`#6500`, $8.43, `status: purchased`).
- **RUNBOOK.md** tightened: the `SUPABASE_URL` line now states explicitly that it must have no `/rest/v1` suffix and how to recognize the doubled-path 404 if this regresses, so the next setup/redeploy doesn't reintroduce it.

### Detours & fixes

- This was a deploy-config error, not a code bug — `index.html`'s client-side `SUPABASE_URL` constant was already correct (bare URL), only the Vercel serverless env var was wrong. No code changes were needed; this is a pure ops/config fix + a RUNBOOK clarification to prevent recurrence.

## 2026-06-30 — Fix: packing slip printed as a blank page in Safari

### Work done

- **Root cause:** `printSlip()`'s hidden print iframe was sized `width:0;height:0`. Chromium decouples an iframe's print rendering from its host element's box size, so the preview testing in the prior session (Chromium-based) showed the print pipeline firing correctly — but Safari/WebKit computes the print canvas for an embedded frame from the frame element's own rendered box, so a 0×0 iframe prints a genuinely blank page even though the `srcdoc` content inside has its own `width:4in;height:6in`. Andy confirmed: printing a slip to PDF from the real app produced a 1-page, ~885-byte PDF — empty.
- **Fix** in `printSlip()` ([`index.html`](../index.html)): the iframe now gets real off-screen dimensions (`width:4in;height:6in`, positioned at `left:-10000px;top:-10000px`) instead of `width:0;height:0`. Also added a 50ms delay between `iframe.onload` firing and calling `contentWindow.print()`, to give Safari layout one more tick to settle before the print snapshot is taken (defensive; the sizing fix is the primary cause).
- This was flagged as an open risk in the prior session's TESTS.md ("Safari-specific rendering is still Andy's to confirm" — the Chromium-based preview tool can't reproduce WebKit-only print bugs) and surfaced on the first real-world test, exactly as expected.

### Still pending

- **Andy to re-verify:** print a slip from the real app in Safari/iPad-Mac and confirm the resulting page/PDF has content, not blank. The "Open label" PDF path is unaffected (it was never the iframe path — different bug surface).

## 2026-06-30 — Casual client-side password gate

### Work done

- Added a simple access gate to the top of `index.html` (purely additive — no existing code changed).
- **CSS** (in `<style>`): `#tqGate` overlay + `html.tq-locked body > *:not(#tqGate){display:none}` so when locked every app element is hidden as it parses (no flash of the real app). Card styled with existing vars (off-white bg, white card, IBM Plex Sans).
- **Markup + script** (right after `<body>`): a `<form>` prompt and an IIFE that runs as soon as the body opens. Reads cookie `tq_access`; if `=granted` it returns and the app renders normally, otherwise it adds the `tq-locked` class. `tqUnlock()` checks the password (`TT`), and on success sets `tq_access=granted` for 30 days (`path=/`) and reloads; on failure shows an "Incorrect" message and clears the field. Form `onsubmit` covers both Enter and button click.

### Decisions captured

- Client-side only by design — casual access control, not security. The correct password (`TT`) and the gate logic are visible in page source; anyone can read or bypass it. Accepted because the goal is to keep the production planner off casual/accidental viewing, not to secure data.
- Gate is additive: the main app `<script>` still executes while locked (CSS `display:none` doesn't stop JS), so `init()`'s Supabase reads still fire in the background. Left untouched to keep the change low-risk; the UI is fully hidden/unusable when locked.

## 2026-06-30 — B2B Cubic Shipping: print mechanism correction — PDF label + HTML slip (Rollo, not Zebra)

### Work done

- **Root cause:** Steps 3 and 5 Slice B were built assuming a bare Zebra printer driven by raw ZPL. The actual production hardware is a **Rollo thermal printer**, which shows up as a normal system printer and consumes standard PDFs/HTML at 4x6 — it has no use for ZPL at all. This session corrects both print artifacts to match the real hardware and re-verifies the print step end to end.
- **`api/shippo-label.js`** — the `?action=label` Shippo transaction call now sets `label_file_type: "PDF_4x6"` (was `ZPLII`); `label_url` resolves to a `.pdf`. One-field addition; rate/purchase/error-handling logic (422 no-GA-rate, 502 purchase failure, non-blocking cost capture) untouched.
- **`composeContentsSlipHTML(box, opts)`** in [`index.html`](../index.html) replaces `composeContentsZPL()` — a fresh HTML/CSS layout (`@page { size: 4in 6in; margin: 0; }`), not a transliteration of the ZPL one. Same inputs/contract (order number, "Box X of Y", line items, total weight); no barcode (the ZPL version had none either).
- **Print step now two independent triggers per box**, not one combined action: **Open label** opens the Shippo PDF in a new tab (`<a target="_blank">`, no `download` — the system PDF viewer handles it, since `window.print()` can't reach a cross-origin PDF); **Print slip** injects the slip HTML into a hidden `<iframe srcdoc>`, waits for load, calls `iframe.contentWindow.print()`, then removes the iframe so repeated clicks don't pile up hidden iframes. Label-before-slip stays the presentation order (per-box buttons, "Open + print all" action bar button) but the two are not coupled — confirmed by driving box 1's "Open label" and box 2's "Print slip" independently and checking neither's state leaked into the other.
- **Safari paper-size hint** — a one-line, low-key note near the print buttons: Safari doesn't always auto-apply the `@page` size, so the first slip print may need a manual 4x6 pick in the print dialog.
- Removed the now-orphaned `composeContentsZPL`, `zEsc`, `openLabelFile`, `openZplBlob`; updated the Ship-tab help-card copy to describe Open label / Print slip instead of "sends... to the Zebra".

### Detours & fixes

- **Slip rendered unreadable in the browser preview** — the slip HTML had no explicit background color, so it inherited the browser's dark color-scheme default and rendered near-black text on a near-black background. Fixed by adding `background:#fff` to `html, body` in the slip's `<style>` block. Caught during the Safari-path legibility check before it reached Andy.
- **Local preview server port conflict** — another session already had `coffee-planner` bound to port 3007 in `~/.claude/launch.json`. Set `autoPort: true` and switched the start command to `$PORT` so concurrent sessions don't collide; doesn't change the deployed Vercel setup.

### Decisions captured

- [`0006-pdf-label-html-slip-print-mechanism.md`](./decisions/0006-pdf-label-html-slip-print-mechanism.md) — locks in PDF_4x6 + HTML-slip-via-iframe as the print mechanism; supersedes [`0005-print-trigger-mechanism.md`](./decisions/0005-print-trigger-mechanism.md) (which assumed a bare Zebra). **This is a deliberate, locked decision — do not revert toward ZPL in a future session.**

### Still pending (deploy gate, unchanged in kind from before this session)

- **LIVE e2e (Andy):** purchase a real label on the Shippo test token and confirm `label_url` resolves to a real, renderable `.pdf` — needs `SHIPPO_TOKEN` on Vercel, can't run from local.
- **On-hardware print (Andy):** label PDF + HTML slip print cleanly from Safari/iPad-Mac with the Rollo selected in the system print dialog. The slip's legibility-at-4x6 and the iframe-print/cleanup mechanics were verified in a Chromium-based preview, not actual Safari/WebKit — Safari-specific rendering is still Andy's to confirm.

## 2026-06-30 — B2B Cubic Shipping, Step 5 (Slice B): the ship UI flow — **closes Step 5**

### Work done

- **New `Ship` tab in [`index.html`](../index.html)** — the planner flow to actually ship a B2B order: open order → pack → confirm rate → buy labels → print label+slip → fulfill → tracking back. It *wires* the Step 1–4b pieces as-is (no re-derivation): `packBoxes()`, `/api/shippo-label` (`?action=rate|label`), `composeContentsZPL()`, `/api/shopify-fulfill`.
- **Order list.** `loadShipOrders()` pulls `/api/shopify-token?type=b2b-ship` and pre-packs every order so the list shows the box count up front (the system does the work; the human confirms). Unpackable orders are flagged in the list, not hidden.
- **Open + pack.** Shows ship-to + per-box contents/weight. Unpackable items (>20 lb single item / unknown weight) raise a red **halt-and-warn** that blocks buying — "nothing has been charged."
- **Confirm rate (deliberate stop).** `getRates()` calls `?action=rate` per box and shows the per-box cost + total. No money moves. A box with no Ground Advantage rate (422) surfaces the message + the returned alternatives and blocks the buy — never silently weight-based.
- **Buy labels (the spend gate).** `buyLabels()` shows the total **and** a `confirm()` dialog, then calls `?action=label` per box. It only ever buys boxes without a label, so a retry never re-charges a bought box. **Partial failure** (e.g. box 2 of 3 fails) lands in a `partial` state that names which bought and which didn't, keeps the good labels, and offers "Retry failed boxes."
- **Print.** `printBox()` fires two ordered ZPL jobs per box — Shippo label first, then the `composeContentsZPL` slip — as downloads (see ADR [`0005`](./decisions/0005-print-trigger-mechanism.md)); `printAll()` covers every bought box.
- **Fulfill + tracking back.** `fulfillOrder()` is enabled only once every box has a label; it calls `/api/shopify-fulfill` ONCE with all tracking numbers. It distinguishes newly-`fulfilled` (one customer email) from `alreadyFulfilled` (calm blue state, no re-notify). A fulfill failure falls back to `bought` with the labels intact and a retry that doesn't re-buy.
- **State model.** In-memory `shipState` (no Supabase table of its own — the durable record is the bought labels + the `shipping_labels` cost rows). The `(TEST)` flag from a test-token label is shown on each box so production can't mistake a test label for a real one. A quiet amber "cost not logged" note shows if `cost_logged:false` comes back (non-blocking — the shipment still succeeded).
- **Doctrine + house style.** Address mapped to Shippo's shape with **no email passed** (the one customer email is Shopify's; spec amendment #6). Tab placed *after* `B2B` so `.tab[3]` stays `Blends` and the stale-warn handler is untouched; `#ship` added to the `@media print` hide list; vanilla globals + `render*`/`load*`/inline-handler conventions per `torque-js-patterns`.

### Detours & fixes

- **Stale preview path.** `~/.claude/launch.json`'s `coffee-planner` config pointed at the deleted `~/CoffeePlannerRepo` loose copy, so the preview would have served the wrong file. Repointed it at the real repo (`…/Torque-Projects/production app/CoffeePlanner`).
- **No `/api` under the static preview.** `python3 -m http.server` doesn't run the serverless functions, so the full pack→rate→label→fulfill drive was verified by stubbing `fetch` to the *documented* API contracts (happy path, partial failure + retry, alreadyFulfilled, fulfill-fail + retry, 422 no-GA, unpackable halt, empty, real-404). The pure helpers (`toShippoAddress`, `boxParcel`, `shipTotal`) ran live. Live end-to-end on the test token stays a deploy-gated item for Andy (same posture as Steps 4/4b).

### Decisions captured

- [`0005-print-trigger-mechanism.md`](./decisions/0005-print-trigger-mechanism.md) — download label-then-slip ZPL within one user gesture; no SDK/Labelary on the hot path; real Zebra-send (Browser Print / print server) deferred behind the same `printBox` call.

### Still pending (deploy gate + Step 6) — Step 5 itself is done

- **LIVE e2e (Andy):** pack→rate→label→fulfill on the Shippo **test token** against a real/throwaway order, end to end on the deployed app — needs `SHIPPO_TOKEN` + `SHOPIFY_*` + `SUPABASE_*` in Vercel env and the planner app's `write_merchant_managed_fulfillment_orders` scope.
- **On-hardware print (Andy):** label + slip ZPL send cleanly to the Zebra (download-trigger today; fallback = paper slip).
- **Step 6 — live cutover:** flip `SHIPPO_TOKEN` test→live only after the above pass; confirm Shippo funding + live near/far-zone $ first.
- **Accepted limitation:** a page reload mid-flow (after buying, before fulfilling) drops `shipState` from memory — the labels stay bought in Shippo and the tracking lives in `shipping_labels`, so recovery is manual via Shippo/Shopify. Persisting in-flight shipments is out of 1.0 scope.

## 2026-06-30 — B2B Cubic Shipping, Step 5 (Slice A): per-order shipping payload + weight resolver

### Work done

- **`api/shopify-token.js?type=b2b-ship`** — new per-ORDER mode (not company-merged) for the cubic flow: returns `order_id` (gid), `order_name`, `fulfillment_status`, `shipping_address`, and `items[]` = `{product_name, variant_title, qty, grams, weight_lb}`. Filters to B2B (company present) with a ship-to address; skips fulfilled line items. Feeds the packer (weight_lb), label endpoint (shipping_address), and fulfill endpoint (order_id).
- **Weight resolver** (`resolveWeightLb`): prefer Shopify per-line `grams` → lb, **snapped to the nearest 0.25 lb**; else parse the variant title; null if unknown (packer flags unpackable). 12/12 unit tests vs the real recon grams + messy titles. Exposed on `module.exports` for testing (Vercel still invokes the handler).
- **node-fetch shim** on `shopify-token.js` line 1 (`globalThis.fetch || require('node-fetch')`) — matches the new endpoints, safer on Vercel, unblocks local testing.

### Detours & fixes

- **Gram-rounding would waste a box + ~$9 label every shipment.** Shopify stores a "5 lb" bag as 2270 g = **5.004 lb**, so 4 bags = 20.016 > the 20 lb cap → the packer split to 3/box → **7 boxes instead of 6** on real order #6486 (21×5lb). Fixed by snapping grams→lb to the nearest 0.25 lb (recovers nominal 5.0; honors the "4×5lb = 20 flat" decision). Integration re-verified: #6486 → 6 boxes (20,20,20,20,20,5).

### Slice B (deferred — the UI)

The visual flow (open order → pack → confirm → buy labels → print label+slip → fulfill → tracking back) is next session's work; every backend piece it wires now exists and is tested.

## 2026-06-30 — B2B Cubic Shipping, Step 4b: cost capture to Supabase (shipping_labels)

### Work done

- **`shipping_labels` table** created in the torque-roast-scheduler Supabase project (migration `create_shipping_labels`): order_id/order_name, box_index/box_count, cost/currency, service, is_cubic, zone/dest_zip, weight_lb, tracking_number, `shippo_object_id` (unique), status, created_at. RLS on; anon **INSERT + UPDATE** policies (matching the app-wide pattern); **no anon SELECT** so cost/margin data isn't publicly readable until the Phase 3 P&L view opens it deliberately. Indexes on order_id + created_at.
- **Capture wired into `api/shippo-label.js`** (`action=label`): after a successful purchase it writes the cost row (status `purchased`) via SUPABASE_URL + SUPABASE_ANON_KEY. **Non-blocking** — a log failure can never block the shipment; response carries `cost_logged` / `cost_log_error`.
- **Status flip wired into `api/shopify-fulfill.js`**: after a successful fulfillment it PATCHes the order's rows to `fulfilled` (non-blocking; response carries `cost_updated`).
- **E2E tested** (real Shippo test label + real Supabase insert via the publishable key through RLS): `cost_logged:true`, row lands with correct cost/zone/is_cubic/tracking. Test rows purged; table left empty.

### Detours & fixes

- **RLS 401 #1 — role clause.** Policies created `TO anon` didn't match the publishable key; the working tables use no role clause (PUBLIC). Recreated as PUBLIC.
- **RLS 401 #2 — upsert needs SELECT.** `Prefer: resolution=ignore-duplicates` (upsert) reads existing rows to detect conflicts → needs a SELECT policy we intentionally don't grant. Switched to a plain insert; dedup via `unique(shippo_object_id)` (a rare retry 409s, swallowed by the non-blocking guard). Both bugs degraded gracefully (label still shipped) and the e2e test caught them pre-deploy.

### Decisions captured

- [`0004-cost-table-security-model.md`](./decisions/0004-cost-table-security-model.md)

### Still pending (deploy gate)

- `SUPABASE_URL` + `SUPABASE_ANON_KEY` (public values, already in index.html) must be set in Vercel env for the serverless functions, or cost-capture no-ops with a warning (label still ships).

## 2026-06-30 — B2B Cubic Shipping, Step 4: Shopify fulfillment write built + live-tested

### Work done

- **`api/shopify-fulfill.js`** — server-side fulfillment write via the modern FulfillmentOrder GraphQL flow (`fulfillmentCreate`). `POST { order_id, tracking:[{number,url}], company, notifyCustomer }` → ONE fulfillment carrying all box tracking numbers (`trackingInfo.numbers[]` + `urls[]`, positionally matched, `company:'USPS'`) and one customer notification. Reuses the client-credentials OAuth from `shopify-token.js`. **Idempotency guard:** queries the order's fulfillment orders, fulfills only OPEN/IN_PROGRESS ones; if already fulfilled → returns `alreadyFulfilled`, does NOT re-notify. On `userErrors` → 502, never claims success.
- **Query + mutation validated** against Torque's live schema; required scopes match the app's grants.
- **Live end-to-end test** (via the authorized Shopify connection — the endpoint can't run locally without the planner's creds):
  1. Draft → completed to throwaway order **#6497** (custom $0 line item = zero real-inventory impact; tagged TEST/cubic-shipping-test; customer email info@torquecoffees.com).
  2. Confirmed one OPEN fulfillment order (single location).
  3. `fulfillmentCreate` with the two real Shippo test tracking numbers + USPS URLs + `notifyCustomer:true` → **SUCCESS**; both tracking numbers on one fulfillment; zero `userErrors`; shipping email dispatched.
  4. Verified order = FULFILLED, FO = CLOSED → confirms the idempotency guard would block a re-notify.
  5. Cleanup: archived #6497 via `orderClose`. (`orderCancel` is blocked by the connection's safety policy; archive is sufficient since the custom line item used no inventory.)

### Still pending

- **Visual email confirmation** (Andy): check info@torquecoffees.com for ONE Torque-branded shipping email with BOTH tracking links and no stray third-party notice. Only Andy can see the inbox.
- **Planner-app scope (deploy gate).** The test ran via the authorized Shopify connection; the production endpoint uses the planner's OWN custom app (`SHOPIFY_CLIENT_ID`) — confirm/grant it `write_merchant_managed_fulfillment_orders` + `read_merchant_managed_fulfillment_orders` before it works deployed.
- **b2b payload extension** (Step 5 prerequisite): per-order ship-to address + order id + grams.
- Andy may want to fully delete test order #6497 (currently archived, $0, tagged TEST).

## 2026-06-30 — B2B Cubic Shipping, Step 3: ZPL contents block built + render-verified

### Work done

- **`composeContentsZPL(box, opts)`** — pure function composing a 4x6 @ 203 dpi ZPL packing slip per box: TORQUE COFFEE header, `order# · company`, a boxed **BOX n OF m** with weight right-aligned, and a CONTENTS list (`qty × product (size)`). Integrated into [`index.html`](../index.html) after the Step 1 packer. It is a SEPARATE 4x6 print per box (printed after the Shippo label on the same roll), not an addition to the shipping-label canvas — this clarifies the basis's "append after the label" wording.
- **Tested 10/10** (node): valid `^XA…^XZ`, `^PW812`/`^LL1219` (4x6 @203), `^CI28` UTF-8, box id / weight / qty / name / size all present, a busy 3-coffee box renders every line, and `^`/`~`/`\` injection in a product name is neutralized (can't break the ZPL stream).
- **Render-verified via Labelary** (8dpmm 4x6): both the busy mixed box and the multi-box "BOX 1 OF 2" case render cleanly and legibly — long names ("Ethiopia Guji Natural Anaerobic (2lb)") fit on one line; layout holds.

### Still pending

- **On-hardware print test** (Andy + the actual thermal printer). Labelary proves the ZPL is well-formed and lays out on 4x6, but the basis kill-condition is about the real Zebra printer. Fallback if it can't render cleanly: a paper contents slip (not a wasted shipping label).

## 2026-06-29 — B2B Cubic Shipping, Step 2: Shippo rate+label endpoint built + tested (test token)

### Work done

- **`api/shippo-label.js`** — server-side USPS Ground Advantage cubic rate + label via Shippo (token stays off the client). `POST ?action=rate` → GA rate only (for the human-confirm step); `POST ?action=label` → buys a ZPL II label and returns `tracking_number`, `tracking_url`, `.zpl` `label_url`, `cost`, `zone`, `is_cubic` (derived from dims), `shippo_object_id` (all the cost-capture row + future void need). Matches the house serverless pattern (`module.exports` handler, CORS, env token); uses `globalThis.fetch || require('node-fetch')` so no node-fetch dependency on modern runtimes.
- **Tested 16/16** (node, against the real Shippo TEST API): rate ($8.43, zone 1, is_cubic true), label buy (tracking `9334…`, `.zpl` url, cost=amount, test=true), plus 400 (missing body), 405 (wrong method), 204+CORS (preflight). Edge cases honored: no GA rate → 422 with the rates shown (never silently weight-based); label failure → 502 without claiming success.

### Decisions captured (resolved by Andy)

- **Net = gross.** A 4×5lb box weighs 20 lb flat, no overage → packer's 20 lb net cap stands, no tare margin.
- **Weight source.** Use Shopify variant grams if present, else parse the variant name. (Resolver lands with the Step 5 wiring.)

### Detours & fixes

- **Shopify b2b payload gap (prerequisite for Steps 4–5).** `api/shopify-token.js?type=b2b` merges items by company across orders and returns **no ship-to address and no order id** — both needed for the label's destination and the fulfillment write. A later step must extend that endpoint (or add a per-order shipping mode) to include `shipping_address`, order `id`/`name`, and per-item `grams`.
- **RUNBOOK:** added the Vercel serverless env section (incl. new `SHIPPO_TOKEN`); fixed the stale run-locally repo path.

## 2026-06-29 — B2B Cubic Shipping, Step 1: box packer built + tested + integrated; real-lane rates captured

### Work done

- **Step 1 packer.** Wrote `packBoxes()` — a pure first-fit-decreasing packer (no side effects): order line items `{product_name, variant_title, qty, weight_lb}` → fewest 14x10x10 boxes, each <=20 lb net, with per-box contents aggregated for the label block. Integrated into [`index.html`](../index.html) after `loadB2B()` (helpers scoped `PACK_BOX`/`packAggregate`; no name collisions; full-script `node --check` passes).
- **Tested 20/20** (node assertions): both basis examples (4x5lb→1 box; 6x5lb→2 boxes [20,10]) plus empty/null, zero-qty, single-unit-over-cap halt-and-warn, unknown/invalid weight, mixed sizes (FFD), the volume-not-modeled light-bag case (30x12oz→2 boxes by weight), partial pack + unpackable, and a configurable cap.
- **Real-lane rate quotes** (test token) for the two supplied B2B accounts: Cala La Jolla 92037 → **zone 1, $8.43**; Lucky Dog, Simi Valley 93063 → **zone 3, $9.22**. Both cubic, both in the expected band — SoCal-heavy mix means small zone-distribution risk.

### Decisions captured

- **Live cubic dollar is NOT a build gate** (Andy, 2026-06-29). Live token needs Shippo staff + ~a day; the build proceeds on the test token and the live $ is checked when the token arrives, without blocking. → [`0003-live-dollar-not-a-gate.md`](./decisions/0003-live-dollar-not-a-gate.md) (amends the gating stance of [`0002`](./decisions/0002-cubic-rate-gate-strategy.md)).

### Detours & fixes

- **Net-vs-gross weight — OPEN decision for Andy.** `BAG_WEIGHTS` are NET coffee weights (5lb=5, 2lb=2, 12oz=0.75). The packer's 20 lb cap is applied to net, so 4x5lb = 20.0 lb net packs into one box with ZERO room for bag + box tare — the real package likely tips ~21 lb and could lose cubic eligibility (the 20 lb cubic ceiling is on ACTUAL weight). Default keeps basis behavior (cap=20 net); the cap is a one-line config (`PACK_BOX.maxWeightLb`) so a tare margin can be set once Andy decides. Logged in the spec's open-decisions.

## 2026-06-29 — B2B Cubic Shipping, Step 0: Shippo rate-test gate cleared (test token)

### Work done

- **New feature kickoff: B2B Cubic Shipping.** A planner page to buy USPS cubic Ground Advantage labels for wholesale orders via Shippo (instead of Shopify Shipping's ~2x markup): pack into 14x10x10 boxes <=20lb, print 4x6 ZPL + contents block, write tracking back to the Shopify order with one customer notification. Full spec: [`b2b-cubic-shipping.md`](./b2b-cubic-shipping.md).
- **Step 0 gate** (the basis blocks all other work on this until it passes): ran the Shippo rate + label mechanics test on the **TEST token**. Origin 3459 El Cajon Blvd, San Diego 92104 → Los Angeles 90012 (zone 2), parcel 14x10x10 in / 20 lb.
  - `POST /shipments/` → `usps_ground_advantage` returned: **$8.50**, `zone: "2"`, est. 2 days, flagged CHEAPEST + BESTVALUE.
  - `POST /transactions/` (buy label) → SUCCESS. `tracking_number 9334620845500000674291` (genuine GA `9334…` prefix), `tracking_url_provider` USPS link returned ready to pass to Shopify, `shippo_object_id bcef9232…`.
  - Label downloaded: valid ZPL (`^XA…^XZ`), header `^PW812^LL1219` = **4.0″×6.0″ @ 203 dpi**, markup contains `^FDCUBIC^FS` → backend applied cubic pricing to the 0.81 cu ft box.

### Verification

- Real calls against api.goshippo.com on the test token (`shippo_test_…`, value NOT committed). HTTP 201 on both shipment and transaction. Mechanics certified end-to-end: rate → buy → tracking → 4x6 ZPLII.
- **NOT certified, by design:** the live cubic dollar. Test rates are synthetic; $8.50 is encouraging (and cubic *was* applied) but live $ confirmation stays a live-token gate before cutover. Kill condition (>~$12 typical) armed.

### Detours & fixes

- **`label_file_type: "ZPL"` → HTTP 400.** Shippo rejects `ZPL`; the valid token is **`ZPLII`**. Retried → success. (Valid list also includes `PDF_W_PSLIP_COLLATED_4X6` — a label+packing-slip option to remember for the contents block.)
- **Pressure-test corrections folded into the basis** (pre-build red-team): rate risk is a **zone-distribution** risk, not one number (box is in the expensive **0.9 cubic tier** — quote near + far zones live); **no `is_cubic` field** in the rate object → derive it; Shippo **returns `zone`** → no derivation needed; **cost-capture ordering contradiction** fixed (capture at purchase with a `status` column, UPDATE after fulfillment); Shopify side is the modern **FulfillmentOrder** flow → confirm `write_merchant_managed_fulfillment_orders` scope + add a double-notify idempotency guard.

### Decisions captured

- [`0002-cubic-rate-gate-strategy.md`](./decisions/0002-cubic-rate-gate-strategy.md)

## 2026-06-26 — Mixing Guide: row reorder, drop sub-info, unify weight typography

### Work done

- Reworked each blend-component row in the Mixing Guide (`index.html`, `renderMixGuide()` + `.mix-*` CSS).
- **Reorder.** Flex row changed from `[pct | name+sub | weight]` to `[pct | weight | name]`. Weight moved from far-right to the middle slot; `.mix-coffee-info` (name) now sits last and flexes to fill. `.mix-weight` `text-align` flipped right→left.
- **Removed sub-info.** Dropped the producer/origin secondary line — deleted the `coffeeSub` variable + its `<div>`, and removed the now-unused `.mix-coffee-sub` CSS rule. Rows show only `coffeeName` (`component_name.split(' - ')[0]`).
- **Typography unified.** `.mix-weight` font-size .88rem→1rem; `.mix-weight-g` (the `/` separator + grams) weight 400→600 and color mid-gray→black, so lbs, `/`, grams, and coffee name all read at 1rem / 600 / black. The grams value is no longer faint. `.mix-pct` (20%, 30%…) untouched. Weight string format (`0.40 lbs / 181g`) and the Total row unchanged.

### Verification

- Visual change only; rendered in Launch preview. No JS logic touched beyond removing the unused `coffeeSub` var.

## 2026-06-20 — Fix: stuck orders / wrong Shopify order filter

### Work done

- **Root cause.** The orders pull used `orders.json?status=unfulfilled`. The REST `status` param only accepts `open`/`closed`/`cancelled`/`any`; `unfulfilled` is not a valid value, so Shopify silently treated it as `any` and returned every open order — including ones that were fulfilled but payment-pending. Those line items kept getting aggregated into the bagging list forever, so they never cleared ("stuck orders").
- **Fix** in `api/shopify-token.js`:
  - Order pull now uses `orders.json?status=open&fulfillment_status=unfulfilled&limit=250` — `fulfillment_status=unfulfilled` is the correct param for "not yet fulfilled."
  - The default ORDERS aggregation loop now skips line items already fulfilled: `if (item.fulfillment_status === 'fulfilled') continue`, so partially-fulfilled orders don't re-bag shipped items.

### Verification

- `node --check api/shopify-token.js` passes. Live behavior depends on Shopify OAuth creds (Vercel env), verified via deploy.

## 2026-06-11 — Fix: Subscription tab coffee dropdowns empty / not changeable

### Work done

- **Root cause.** In `renderSchedule()` the per-week `<select>` option lists were built from the `shopifyProducts` global (`const allCoffees = [...shopifyProducts]`). That global is only populated as a side effect of loading other tabs (Bagging/Blends, lines ~630 and ~1057). When a user opened the Subscriptions tab directly, `shopifyProducts` was still `[]`, so every dropdown rendered with only the placeholder. The current week's stored value still *displayed* (it reads from `subscription_schedule`) but had no options to switch between, and all other/empty weeks showed nothing selectable.
- **Fix.** `loadSchedule()` now fetches the master coffee list directly and independently of any other tab:
  `sb.from('green_coffee_settings').select('component_name').order('component_name')`, mapped into a new module-level array `scheduleCoffeeOptions`. `renderSchedule()` reads `allCoffees` from that array instead of `shopifyProducts`. Options are sourced only from `green_coffee_settings.component_name` — never Shopify products or any other table.
- The per-row select rendering already handled the rest correctly and was left intact: a `<option value="">— select —</option>` placeholder, a controlled `selected` binding to the stored `modernist`/`classicist`/`espressoist` value, and a legacy-mismatch fallback that renders any stored value not present in the master list as its own selectable option so it never silently blanks out. Because every row (current, future, and newly added) reads from the same shared `scheduleCoffeeOptions`, added weeks now render fully populated too.

### Verification

- Live Supabase, anon key, served statically on :3007.
- `green_coffee_settings` returns **27** coffees; current week (`Perla Negra`) renders in an editable `<select>` with the stored value selected.
- An empty future week renders all three dropdowns with 28 options (placeholder + 27).
- Save→reload round-trip: set `2026-06-14` modernist to a real coffee via the real `saveScheduleRow` path, re-fetched from the DB and confirmed it persisted, then restored the row to `null` to leave no test data behind.
- No console errors.

### Detours & fixes

- **Preview launched the wrong app.** The root `~/.claude/launch.json` only had an `arxys-portal` config on port 3000, so `preview_start` served that instead of the planner. Added a `coffee-planner` config (`python3 -m http.server 3007` from the repo) since this project is a static single-file PWA with no build step.
