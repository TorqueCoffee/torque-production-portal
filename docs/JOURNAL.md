# Journal

## 2026-09-21 — Best Coffee ships UPS Ground

### Work done

- USPS was failing to deliver to Best Coffee, so that account now buys **UPS Ground** labels via Shippo; all other B2B accounts stay on USPS Ground Advantage cubic.
- `index.html`: `carrierForOrder()` (exact company "Best Coffee") drives the rate call, label call and Shopify fulfillment carrier (`UPS` vs `USPS`). Ship list shows a "UPS Ground" badge; summary, step text and help card name the right service.
- `api/shippo-label.js`: new `carrier` param (`usps` default | `ups`) mapped to an exact service token; `ups_ground` only, never `ups_ground_saver`. `is_cubic` is false for UPS. Cost-log row records the real service.
- No UPS Ground rate → 422 → red "No rate" chip, error with the services Shippo did return, and a "UPS-only, do NOT ship USPS" warning. No fallback.
- Checked with a mocked Shippo response: UPS picks `ups_ground` over Saver and USPS; default is unchanged; Saver-only response yields the 422. Not yet exercised against live Shippo.

### Decisions captured

- [`0018-per-customer-carrier-routing.md`](./decisions/0018-per-customer-carrier-routing.md)

## 2026-09-13 — Fix: coffee grouping by variant size

### Work done

- **Root cause.** `api/shopify-token.js` aggregated Shopify order line items into
  production rows keyed on `${item.sku || item.title}||${item.variant_title || 'Default'}`.
  Variant text had drifted across relaunches — the same 12oz bag existed under 11+
  spellings (`12oz Coffee Bag`, `12oz Bag`, `12 oz bag / In Stock`, …), each producing a
  separate row. Worse, several coffees (Gum Drop, Dark Drop, BomBón, Decaf Drop) exist as
  two Shopify product records — old listing + relaunch — sharing a title but carrying
  *different SKUs* for the same physical size, so keying on SKU first split them
  regardless of variant text.
- **Fix.** New `canonicalVariant()` buckets any variant string into one of the 4 real
  sizes (`12oz`, `2lb`, `5lb`, `8 xPods`) by prefix match, tolerant of spacing/case/
  trailing words; anything else (bulk-box `Default Title`, gift cards, shirts) passes
  through unchanged. The orders aggregation and the B2B company view now key on
  `title + canonicalVariant(...)`, not SKU — SKU is kept only as a display field,
  upgraded to a real value the first time one shows up in the group.
- **Shopify catalog cleanup.** Renamed the `Size` option value to the same 4 labels
  across all 40 active/draft coffee products via `productOptionUpdate` (one call per
  product, batching every value on that product's option together) — pure label rename,
  verified to leave price/inventory/SKU/variant ID untouched. `Cocoa Drops xBloom Bulk
  40lb Box` (and its 45lb Bombon equivalent) were deliberately left alone — no
  size-option to rename, already excluded from bucketing by design (ADR 0016).
- Confirmed against a live pull of every distinct variant string in the catalog (26
  strings) that `canonicalVariant()` buckets all of them correctly with no misses.

### Verification

- `node --check api/shopify-token.js` passes.
- Ran `canonicalVariant()` against all 26 real variant strings pulled from Shopify
  (active + draft, vendor Torque Coffees) — every 12oz/2lb/5lb/8xPods spelling bucketed
  correctly; `Default Title`, gift-card denominations, and shirt sizes passed through
  unchanged.
- All 40 `productOptionUpdate` calls returned empty `userErrors`; spot-checked returned
  `product.options` on the first 8 calls, all showing the new labels.

### Decisions captured

- [`0017-variant-size-normalization.md`](./decisions/0017-variant-size-normalization.md)

## 2026-09-03 — Step: Bridge Blend gets a recipe, and bulk boxes reach the drum

### Work done

- **`Bridge Blend - Grondin Community Bridge Composition` now explodes into single origins.** It had no `blend_matrix` rows at all, so both Roasting and Lbs Needed fell to the single-origin branch and rendered a row named after the blend — plausible-looking and wrong, the exact shape ADR 0015 worries about. It is the same blend as Cocoa Drop, so it now carries Cocoa Drop's components (Ntwari 20 / San Augustine 60 / Worka 20). Data fix, no code: `blend_matrix` rows are ordinary app data, editable in the Blends tab.
- **The 40lb xBloom bulk box now counts on the roasting plan.** `Cocoa Drops xBloom Bulk 40lb Box` has one variant, `Default Title` — its weight lives in the *product name*, so `variantToLbs()` returned 0 and 40 lbs of coffee that has to go through the drum was invisible to the roaster. New `bulkNameToLbs()`, called **only** from `renderRoasting()` as a fallback when the variant yields nothing.
- **Lbs Needed deliberately still shows nothing for it.** `computeRoastedNeeded()` does not call the new helper, so the box stays excluded there exactly as ADR 0015 specifies — xBloom is planned separately and is not filled off the bagging list. Roasting asks what goes in the drum; Lbs Needed asks what is in the bins. ADR [`0016`](./decisions/0016-bulk-weight-in-product-name.md) records why this is one function with one caller rather than a fix inside `variantToLbs`.
- **`Cocoa Drops xBloom Bulk 45lb Box` retired.** No 45lb product exists in Shopify — the live SKU is the **40lb** box (`cocoa-drops-xbloom`, `TCCDS-40`), so that recipe could never match anything. Replaced with `Cocoa Drops xBloom Bulk 40lb Box` (with the S, matching Shopify exactly) on Cocoa Drop's split, in place of the 70/30 Nayarit plus / San Augustine it used to record.

### Detours & fixes

- **The obvious fix was the wrong one.** Teaching `variantToLbs()` to read the product name is one line and both tabs pick it up for free — which is precisely the bug, because it would put an xBloom box onto the bins tab. The asymmetry is the point, so the fallback lives in a separate function with a single visible caller.
- **A bare name parse would have invented coffee.** The catalog carries an unlisted `5 lb weight for shipping`, a filler used to pad shipping weight. An unguarded regex over product names turns it into 5 lbs of roasted coffee. `bulkNameToLbs` returns 0 unless the name says `bulk` *and* carries an lb figure; verified the filler returns 0 while `Cocoa Drops xBloom Bulk 40lb Box` → 40 and the archived `… - BULK 2lbs` shapes → 2.

### Verification

- Browser, live Supabase data. Bridge Blend's 2.25 lbs now splits Ntwari 0.45 / San Augustine 1.35 / Worka 0.45 on Lbs Needed, and its own row is gone from both tabs.
- One simulated 40lb box (in memory — the production plan was in active use) adds exactly Ntwari +8.0, San Augustine +24.0, Worka +8.0 = 40 lbs on Roasting, with **no** leftover row named after the box. Lbs Needed is byte-identical with and without it, and grows no xBloom row.
- Both cards render on the Blends tab under the right names with the right ratios.
- All three inline `<script>` blocks parse; no positional `.tab[n]` lookups; console clean.
- **Noticed mid-session: someone ran Pull Orders at 17:03Z**, which changed the plan under this session (a Rotheca Decaf line dropped, Nayarit plus fell, BomBón doubled, two rows now bagged). Totals in the entry above this one were taken before that pull and no longer match the live plan. Nothing to do with these changes — worth knowing when reading the two entries side by side.

### Decisions captured

- [`0016-bulk-weight-in-product-name.md`](./decisions/0016-bulk-weight-in-product-name.md)

## 2026-09-03 — Step: "Lbs Needed" tab — the pre-bagging inventory check

### Work done

- **New read-only tab, "Lbs Needed"**, sitting between Bagging and Roasting. It answers the one question asked before bagging starts: how many pounds of **roasted** coffee does each single origin have to supply today. Every Drop is split into its components by `blend_matrix.ratio`, so a coffee that only ever appears inside a blend still gets a line. Three columns — Coffee / Roasted lbs / Where it goes — plus a total row. Nothing on it writes, edits, locks or counts.
- **`computeRoastedNeeded()`** is deliberately *not* `renderRoasting()`'s math (ADR [`0015`](./decisions/0015-lbs-needed-tab.md)): it sums `qty_needed` rather than `qtyRemaining` (the figure must not shrink as people bag, or the 7am comparison against the bins stops meaning anything), stops at roasted lbs with no shrink/green conversion, and ignores `roastLocks` freezes and `plan_state.finalized_at` entirely — this is a physical question, not a plan question. The tab says so in a subhead, because the two tabs now legitimately show different numbers for the same coffee.
- **xBloom excluded**, both the pod SKUs and the rare `Cocoa Drops xBloom Bulk 40lb Box` — planned separately, not filled off the daily bagging list. `/xbloom|xpod/i` against product name and variant title.
- **Broken blend ratios raise a red banner on this tab too.** Roasting already warns, but every component figure under a blend that doesn't total 100% is wrong, and this is the list someone acts on.
- **No schema change, no new Supabase call.** It renders off `planData` and `blendMatrix`, already in memory; `loadPlan()` gained a `renderLbsNeeded()` call so the tab is current after a pull, an Add Order or a realtime `daily_plan` event.

### Detours & fixes

- **A ninth tab would have wrapped the tab row onto a second line on the iPad.** Andy's suggestion — move Help up beside Activity — works and costs nothing: `.activity-btn` and `.tab` were already the same pill (same padding, same `rgba(255,254,240,.08)` fill, same `.25` border), so it needed one new rule for the active state. Tab row stays at nine, on one line.
- **Two callers looked the Blends tab up by position** — `document.querySelectorAll('.tab')[3]` in the blend-issue banner and `tabs[3]` in `gotoBatchSizes()`. Both mean "Blends". Inserting the new tab before it would have shifted index 3 to B2B and sent both to the wrong screen **with no error**. Fixed before touching the tab bar: every tab now carries `data-tab`, and a `gotoTab(name)` helper resolves by name.
- **First cut of the "not counted" note was dishonest.** It listed the excluded *product*, so a coffee with both an xPod variant and ordinary 12oz bags would read "Ethiopia Guji not counted" while its bag lines were in fact counted. Exclusion is per line; the note now names the line (`product (variant)`) and lists only lines that carried real weight — pod-count variants have no `lb|oz` unit and were already contributing zero.

### Verification

- All three inline `<script>` blocks parse (`new Function(src)`).
- `computeRoastedNeeded()` driven headless against synthetic data and checked against hand math: Dark Drop at 8x12oz + 2x5lb = 16.0 lbs, split 60/40 into Balboa and Sumatra, with 3x2lb of Balboa sold direct on top → Balboa 15.6, Sumatra 6.4, grand total 22.0. Matches.
- Confirmed the figure is unchanged when every row is flipped to fully bagged, done and locked — i.e. it really is total demand, not remaining.
- Confirmed the ratio guard fires on a 60/30 blend, that both xBloom shapes are dropped, and that a coffee with an xPod variant keeps its ordinary bag lines.
- `grep` confirms no positional `.tab[n]` lookups remain.
- **Rendered and driven in a real browser** (later the same day, `python3 -m http.server 3007`, live Supabase data — 21 `daily_plan` lines, 17 `blend_matrix` rows, nothing bagged, no roast freezes, `finalized_at` null). The earlier "not rendered in a browser" caveat is now closed. Eleven-item checklist, all PASS:
  - **Tab row on one line** at 1024px and 820px — nine tabs, one distinct `getBoundingClientRect().top`, no horizontal body scroll. Help sits in the header (`top: 14`) above the tab row (`top: 59`).
  - **Help** opens the Help view, takes `.activity-btn.is-on`, and clears it on switching to any tab. No `.tab` shows active while Help is open, which is correct — it is not in the row.
  - **Long names wrap, never truncate.** At 375px every one of the eleven names wraps and none is clipped (`scrollWidth <= clientWidth` on all); the grid scrolls inside itself (560px content in a 343px box) and the page body does not scroll sideways.
  - **Both de-positioned links land on Blends.** The `⚠ Blend issue` banner (forced visible by feeding `validateBlends()` a stub Shopify list, not by editing production `blend_matrix`) and Roasting's `Batch sizes →` both switch to `blends` and the latter scrolls `#originSettings` into view.
  - **Numbers agree with Roasting's roasted-lbs demand for all eleven coffees**, to three decimals, checked against `liveRoastedLbs` — including `Worka Chelbessa`, which only ever appears inside Cocoa Drop. Hand-checked independently: the eleven rows sum to 89.75 lbs, exactly the sum of every weighted line, so the blend explosion conserves weight. Cocoa Drop's three components sum to its 24.25 lbs; Dark Drop's three to its 7.0.
  - **The figure does not move when you bag.** Simulated the `+` taps in memory rather than writing to the production plan and the un-erasable `activity_log`: three increments on a Balboa row, then every row flipped to fully bagged + done + locked — the per-coffee map is byte-identical both times, total stays 89.7.
  - **Empty state** before Pull Orders reads "Click “Pull Orders” to load", no blank box, no throw.
  - **Print** hides the tab. `@media print` resolves to `.header, .toolbar, #bagging, #lbsneeded, … { display: none !important }` with `#roasting { display: block !important }`; the Print button is a bare `window.print()`, so the stylesheet is the whole story.
  - **Console clean** on load and across every tab switch. The only two errors are the local-only `404` on `/api/shopify-token?type=products` and the JSON-parse rejection that follows it — `python -m http.server` serves no serverless functions. Neither comes from the new code, and **Pull Orders itself could not be exercised locally** for the same reason.
- **Failure states hold** (test-gates G-U3). `blendMatrix = []` — Drops render as their own rows, no crash. A row with `variant_title: null` and `qty_needed: null` — dropped silently, no throw, and `escHtml` neutralises a `<script>` in a product name. A component with `ratio: null` — the red banner fires and the row reads 0.0, so it is visibly wrong *and* flagged rather than quietly plausible.
- **test-gates run** (universal + PWA blocks; Shopify blocks N/A). G-U1–U7 and G-PWA1/2/3/6 PASS or N/A: served file's md5 matches the working copy, empty and failure states graceful, mobile fold fine at 375px, Bagging/Roasting/Blends/Help all still work, diff traces line-for-line to ADR 0015, `planData = data || []` and `blendMatrix = bm || []` already guard the Supabase-null case, and `renderLbsNeeded()` sits after the awaits in `loadPlan()`. G-PWA4/5 N/A — the tab has no dropdown and no writes. There is no `TESTS.md` in this repo; the gates were run and recorded here instead.

#### Live-data checks — three findings, no code changed

- **The xBloom regex has no false positives, and three false negatives it cannot fix.** Checked `/xbloom|xpod/i` against all 36 active `Torque Coffees` products and every variant. Every string it matches is genuinely an xBloom SKU. But three products carry the `xBloom` tag and an xBloom handle while their title *and* variant title are indistinguishable from the ordinary retail product: `Gum Drop` (`gum-drop-xbloom`, `12 oz bag / In Stock`, `TCCDB-1`), `Dark Drop` (`dark-drop-xbloom`, `12 oz bag / In Stock`, `TCDDB-1`) and `BomBón - Jhoan Vergara, Colombia` (`bombon-jhoan-vergara-colombia-copy`, `12 oz bag / In stock`, no SKU). Fed one through, an order for the xBloom `Gum Drop` counts as 3.0 lbs of ordinary Gum Drop and explodes into Balboa/BomBón/La Mora. **No regex over `product_name` and `variant_title` can separate these from their twins** — the strings are identical — so the regex was left alone. The fix is a catalog rename, adding `xBloom` to those three titles the way `Worka Chelbessa … xBloom` and `Ntwari Natural … xBloom` already are. Andy's call, outside this tab.
- **`variantToLbs` zeroes nothing that carries weight in the variant.** Every distinct `variant_title` in `daily_plan` resolves correctly (`12oz Bag`, `12 oz bag`, `12oz Coffee Bag` → 0.75; `2lb Bag`, `2lb Bulk` → 2; `5lb Bag`, `5lb Bulk`, `5lb Bulk Bag` → 5), as does every shape the live catalog can produce (`2LBS Bulk Bags`, `2Lb BULK Bags`, `12oz Retail bag`, `12oz Box`, `12 oz / In stock`). Pod variants (`8 xPods`, `xBloom xPods`) return 0, which is correct. The one genuine zero is `Cocoa Drops xBloom Bulk 40lb Box`, whose variant is `Default Title` — its 40 lbs live in the *product name*, so there is no weight string in the variant to parse. It is xBloom and excluded here by design; a side effect is that it computes to 0 and therefore never appears in the "not counted" note, which only lists lines with real weight. Not fixed: the variant genuinely carries no weight, so this is a naming problem, not a `variantToLbs` bug, and it belongs to Roasting (where the box would silently contribute 0 green lbs) rather than to this tab.
- **Blend name matching has no near-misses, but `Bridge Blend` has no recipe at all.** Compared every `daily_plan.product_name` against every `blend_matrix.product_name`: zero case-, whitespace- or punctuation-only mismatches, and no stray leading/trailing whitespace on either side. `BomBón`/`Cuarenteño` merge correctly across the two tables, so their unicode normalisation agrees. But `Bridge Blend - Grondin Community Bridge Composition` — a composition, sold in 12oz/2lb/5lb — has **no `blend_matrix` rows whatsoever**, so it falls to the single-origin branch and renders as a 2.3 lb row named after the blend. That is exactly the plausible-looking-and-wrong shape ADR 0015 worries about, but the cause is missing data, not the match, and **Roasting shows the same row** (2.3 roasted / 2.6 green). Also noted: `blend_matrix` calls the bulk box `Cocoa Drops xBloom Bulk 45lb Box` while Shopify calls it `… 40lb Box`, so that recipe can never match either. Both are data gaps for Andy; no code touched.

### Decisions captured

- [`0015-lbs-needed-tab.md`](./decisions/0015-lbs-needed-tab.md)

### Still pending — Andy

- Verified in a desktop browser at iPad widths (1024px and 820px), not on the iPad itself. Worth one look on the device, plus the one check no browser can make: do the numbers match a physical count of the bins?
- **Rename the three untagged xBloom products in Shopify** (`gum-drop-xbloom`, `dark-drop-xbloom`, `bombon-jhoan-vergara-colombia-copy`) so their titles carry `xBloom`. Until then their orders count as ordinary demand on this tab.
- ~~**Add `Bridge Blend - Grondin Community Bridge Composition` to `blend_matrix`**~~ — done the same day; it is the same blend as Cocoa Drop and now carries its recipe. See the entry above.
- ~~**Reconcile `Cocoa Drops xBloom Bulk 45lb Box` (blend_matrix) with `… 40lb Box` (Shopify).**~~ — done the same day; the 45lb rows are retired and the box now counts on Roasting. See the entry above.

## 2026-08-28 — Step: Bagging tab → spreadsheet grid

### Work done

- **Bagging list: card layout → spreadsheet-style grid.** `renderBagging()` now emits a single `.bag-grid` with a fixed header row (Coffee / Bag size / Source / Qty) and data rows that share one `grid-template-columns` (`24px minmax(200px,1fr) 100px 96px 132px 78px 64px`), so name, chip, source and count line up vertically. Removed the per-row progress bar and percentage. Rows are ~44px, so 8+ coffees are visible on an iPad before scrolling. Name cell uses `overflow-wrap:anywhere` and never truncates — long single-origin names ("Balboa Cauca - Auction Lot, Colombia") wrap to a second line.
- **Stat totals + Sort by merged into one slim toolbar strip** (`.bag-toolbar`, cream-hi, 2px ink). The four separate summary cards and the standalone sort row are gone; numbers now sit inline with their labels (`34 needed  1 bagged  33 remaining  0/13 lines done`).
- Bag size renders as a small outlined chip centered in its column; Source pill + the stale-order warning chip (`⚠ <date>`) stack centered in their own column; Qty is `{done} / {needed} (remaining left)` on one line, done/needed full-contrast black.
- No data-flow changes: `sortPlan`, `adjustBagged`, `toggleDone`, `toggleLock`, `qtyRemaining` and every Supabase call are untouched. All five existing sort options kept.
- Reviewed the rest of the V2 handoff (`V2 update/handoff/CLAUDE_CODE_PROMPT.md`) tab by tab against `index.html`: Roasting (per-row Primo/Probat toggle + split summary cards), Blends (display-type names + Single Origin Batch Sizes by roaster), B2B (compact single-line order lines), Add Order (`min-width:0` flex row), Mix Guide (30px bold weights, explicit black qty inputs) and Subscriptions (stacked label+select pickers persisting to `subscription_schedule`) were all already implemented in the V2 + Phase 2 passes. No schema change needed — `subscription_schedule.modernist/classicist/espressoist` already back the per-week overrides.

### Detours & fixes

- **The handoff PNG contradicts the `.dc.html` prototype for Bagging.** The prototype still shows the V2 card layout (progress bar, trust line, four stat cards); `handoff/bagging-redesign.png` and the newer written spec call for the grid. Followed the PNG + written spec as the later source of truth. See ADR 0014.
- Not verified in a live browser this session (no Chrome extension, no Supabase data locally). `node`-parsed the full script block; grid math checked by hand.

### Decisions captured

- [`0014-bagging-spreadsheet-grid.md`](./decisions/0014-bagging-spreadsheet-grid.md)

## 2026-08-27 — Step: Phase 2 — the roasting plan holds still

### Work done

- **Fixed: locking a Roasting row deleted it.** `renderRoasting()` built its rows from `coffeeNeeded` and both branches did `if (roastLocks[key]) continue`, so locking a coffee dropped it from the map and the row was never rendered — taking its own Unlock button with it. `roastLocks` was memory-only, so only a refresh brought it back. **Predates V2** (identical in `f6c79b6`); the card layout just made the disappearance obvious.
- **Lock now means freeze, not exclude.** First pass got the semantics backwards — it kept the row visible but pulled it out of the totals. Andy: *"locking a row that needs roasting should make it NOT be edited by new coffee adds to bagging. NOT make it not be counted in total. the roasting page is the TOTAL that needs roasting."* A locked row now freezes its roasted-lbs demand and still counts in green lbs, batches done, and its machine's needed total. Machine and shrink edits still recalculate it — those are deliberate, not incoming demand.
- **The freeze persists** in `roasting_progress.locked_roasted_lbs`, so it survives a refresh and is shared across devices. A frozen coffee also stays listed when its live demand falls to zero — otherwise clearing its bagging lines would make the locked row vanish again, the same bug wearing a different hat.
- **Finalize / Reopen the day.** New `plan_state` table stamps `finalized_at` per team per day. The Roasting tab carries a banner: open (amber, with Finalize) or finalized (green, with Reopen and the time).
- **Late orders.** `daily_plan` gained a real `created_at` — `updated_at` moves every time someone taps `+`, so it could never answer "did this arrive after we finalized?". Lines created after `finalized_at` render in a "Came in after lock — not on today's plan" section, are excluded from the roast math, and can be pulled in with "Add to today anyway" (which backdates the line to just before the lock).
- **Activity drawer with Undo.** Append-only `activity_log`, newest first, opened from the header. Counter changes carry an `{table,id,column,prev}` payload and get an Undo button; pulls, finalization and lock toggles are recorded but not undoable. Undo flags the row `undone` rather than deleting it, and the table has no anon DELETE policy.
- **Sync-status pill** in the header. On a failed pull it says "Sync failed — showing 7:12am" and the tooltip states plainly that nothing was changed or overwritten.
- **Realtime** added for `plan_state` and `activity_log`, so finalizing on one iPad shows up on the others.

### Detours & fixes

- **The migration could not be applied from here.** The Supabase migration tool was blocked by the permission classifier, so `db/2026-08-27-phase2-plan-state.sql` was run by hand. Until it is applied the new code degrades quietly rather than crashing: `planState` stays null (banner reads "Plan is open") and the activity list stays empty.
- **Verified in the browser by Andy on 2026-08-27**, after the migration was applied by hand. Freeze, finalize, late-order rollover, the activity drawer and Undo all behave. (Claude could not render it — the Chrome extension was unavailable both sessions — so `node --check` and numeric checks on the batch math were the only automated gates.)
- **Known limits, deliberately accepted** (see ADR 0013): `activity_log` grows unbounded with no retention policy; Undo is single-step per event and does not compose — undoing an older event after newer ones touched the same row writes a stale value back; and the log records *what* changed, not *who*, because the app has no user identity. The drawer's "who changed what" heading currently oversells it.

### Decisions captured

- [`0013-plan-finalization-and-activity-log.md`](./decisions/0013-plan-finalization-and-activity-log.md)

## 2026-08-27 — Step: Production Portal V2 — Torque design system re-skin + the Probat

### Work done

- **Implemented the V2 redesign** from `Production Portal Redesign.dc.html` (design reference in `torque-green-planner/V2 update/`) across all 8 tabs of `index.html`. UI/UX only — the Shopify → Supabase pipeline, order pull, Shippo label code and everything in `api/` were not touched.
- **Full re-skin to the Torque design system.** The prompt said the tokens were "already in our CSS"; they were not. The app was IBM Plex Mono/Sans on `#f5f4ef`/`#111110` with 1px `#d8d7d2` borders and 4px radii. The whole `<style>` block was replaced with cream `#FFFEF0`/`#EDEAE0`, ink `#100000`, brown `#30231A`, orange `#E58825`, 2px ink borders, 14px card radii, round pills, Hepta Slab (700–800) for names/headings/glanceable numbers, Helvetica Neue for body. Class names were all preserved, so the markup churn stayed contained.
- **Bagging** — table → card list (the spec's "chip beside the coffee name" and single "3 / 12" count only exist in a card layout). Stat cards are now number-and-label on one line so the coffee list starts higher; the variant is a plain outlined box one size down from the name; both numbers in the count render at 24px full-contrast black.
- **Roasting** — table → card list with a per-row Primo/Probat toggle, inline batch/shrink editors per machine that persist, an expandable show-the-math panel, a "Batch sizes →" jump to Blends, and summary cards split into **Needed on Primo** / **Needed on Probat** as live sums over rows currently set to each machine.
- **Blends** — names at 19px Hepta Slab 800; the Single Origin table became Coffee / Primo batch / Primo shrink / Probat batch / Probat shrink, editing the same rows Roasting reads.
- **B2B** — three-column line items → compact single lines (`2x Dark Drop - 5lb Bulk Bag`), medium weight, more space between companies.
- **Add Order** — restacked into three rows with `min-width:0` on the flex children; the old fixed pixel widths were what forced the overflow.
- **Mix Guide** — lb/g output to 30px/20px Hepta Slab 800 in black, right-aligned after the coffee name; qty inputs pinned to explicit black-on-cream with `-webkit-text-fill-color` so they can never inherit a transparent state.
- **Subscriptions** — three side-by-side selects → label + full-width select stacked per role (long single-origin names like "Balboa Cauca - Auction Lot, Colombia" were truncating). Newest week first; past weeks read-only with a LOCKED badge; "This week" bar kept.
- **Shrink now drives the math.** `renderRoasting()` had a hardcoded `SHRINKAGE = 1.176` applied to every coffee while the editable `shrinkage_pct` column did nothing. Green lbs is now `roasted / (1 - shrink/100)` for the selected machine.
- **Migration `db/2026-08-27-probat-machine.sql` applied** to `gblkovtjylrfdotoktkb`: adds `probat_batch_lbs` (nullable), `probat_shrink_pct` (default 15), `roast_machine` (default `primo`, checked). Verified after: 25 coffees, all defaults correct.

### Detours & fixes

- **The prototype contains four features the written spec does not**: a header sync-status pill, an Activity drawer with per-event Undo, Finalize/Reopen-the-day with late-order rollover, and a connection-error banner. Activity and Finalize need new tables and real logic — this would have stopped being a UI pass. Scoped out with Andy; the cheap visual extras (row progress bars, old-order flags, show-the-math) were kept. Deferred, not rejected.
- **"Auto-resolved coffee" in Subscriptions was dropped.** The spec asked pickers to default to an auto-resolved coffee, but no such resolution exists in the code — new weeks insert as null. Andy confirmed the intent is to keep adding a week and choosing manually, so this became a pure layout change.
- **Probat batch size is nullable on purpose.** Copying Primo's batch size as a starting value would have produced confident, wrong batch counts on a 33 lb drum. An unset row shows a red prompt and `—` instead.
- **Could not verify in a browser during the build.** The Chrome extension was not connected, so the page was never rendered by Claude; `node --check` and numeric checks on the batch math were the only automated gates. Andy confirmed all 8 tabs in the browser on 2026-08-27, after the phase 2 work landed.

### Decisions captured

- [`0012-two-roasters-primo-probat.md`](./decisions/0012-two-roasters-primo-probat.md)

## 2026-08-27 — Incident: #7034 shipped with no tracking pushed — the 2026-07-25 fix was never deployed or migrated

### Work done

- **Symptom (Andy, live):** B2B order #7034 (Best Coffee, Goleta CA, 2 boxes) had both USPS labels bought via Shippo on 2026-08-25 14:51 UTC ($9.22 each) but Shopify showed it unfulfilled with no tracking — no customer email. #7040 (Cala La Jolla), bought 36 min later, *was* fulfilled with tracking at 17:50. Andy added #7034's two tracking numbers to the Shopify fulfillment by hand on 2026-08-27.
- **Investigation (tracking numbers → Supabase → Shopify):**
  - All four numbers live in `shipping_labels`; the table has no customer/company field, so ship-to was recovered by joining `order_id` to Shopify: `#7034` → Best Coffee, `#7040` → Cala La Jolla.
  - **The 2026-07-25 recovery fix (commit `6c16422`, ADR 0011) is not in production.** `main` is **ahead of `origin/main` by 1** — the commit was never pushed. Deployed code is `d4fa4e7`.
  - **The migration `db/2026-07-25-ship-label-recovery.sql` was never applied** to `torque-roast-scheduler`. Verified against the live DB: columns `tracking_url` / `label_url` absent; functions `ship_labels_for_order`, `ship_labels_pending`, `mark_ship_labels_fulfilled` all absent.
  - So for a month, B2B shipping has run on the pre-fix path with **zero recovery net**: no "⚠ labels bought · NOT fulfilled" flag, no "Finish →", no DB rehydrate. `shipState` and `shipPending` are both memory-only without the RPCs.
- **Root cause of #7034:** unchanged from the 2026-07-25 incident — the fulfill request never left the iPad. Buy + print and Fulfill are separate manual taps; printing opens the label PDF in a second Safari tab; iPadOS discards the portal page; the operator returns to a clean list with nothing showing that 2 paid labels exist for #7034 and never taps Fulfill. #7040 survived because the operator got back to it and fulfilled it (manually or in-app) that afternoon.
- **Audit of every `status='purchased'` order (49 distinct) against Shopify `displayFulfillmentStatus` + `fulfillments.trackingInfo`:**
  - `shipping_labels.status` is currently **meaningless in production** — 110 of 114 rows stuck at `purchased` including orders that definitely shipped (the deployed `shopify-fulfill.js` still does the broken PostgREST PATCH — silent no-op under RLS, documented 2026-07-25).
  - **Genuinely stranded — FULFILLED in Shopify but the SUCCESS fulfillment carries no tracking** (customer got a shipped email with no tracking, or none at all): **#6976** (Aug 18, 2 labels, 92037), **#6755** (Jul 29, 3 labels, 92024 — also has a separate CANCELLED fulfillment), **#6659** (Jul 15, 3 labels, 90022), **#6577** (Jul 7 — *two* box-1-of-1 labels bought 30 min apart, a lost-screen re-buy; SUCCESS + CANCELLED both empty), **#6505** (Jul 1, 3 labels, 94103), **#6500** (Jun 30, 1 label, 92037 — order no longer returned by the Admin API). Plus **#7034**, now hand-fixed.
  - Tracking numbers for all of the above are in `shipping_labels` and were captured in this session for manual attach.

### Resolution

- **Pushed `6c16422` + this entry** (`03d55a8`) on 2026-08-27 — the ADR 0011 recovery code is now deployed.
- **Applied `db/2026-07-25-ship-label-recovery.sql`** to `torque-roast-scheduler` on 2026-08-27. Verified: both columns present, all three RPCs created, #6738 backfill flipped 4 rows. The recovery net (bought-label flag, rehydrate, working status flip) is now live end to end.

### Reconciliation (2026-08-27, done)

- **6 stranded orders** (#6976, #6755, #6659, #6577, #6505, #6500) — Andy added the Shippo tracking numbers to each Shopify fulfillment by hand. Tracking numbers, per order, were pulled from `shipping_labels` this session (see commit message / chat).
  - #6577 had a **duplicate paid label** (two box-1-of-1, bought 30 min apart) — refund the unused one in Shippo.
  - #6500 is no longer returned by the Admin API — verified in the admin UI directly.
- **Backfilled `shipping_labels.status`:** ran `mark_ship_labels_fulfilled()` for all 48 remaining `purchased` orders (every one confirmed FULFILLED-with-tracking in Shopify during the audit). All 114 rows are now `fulfilled`; `ship_labels_pending()` returns 0. The "Finish →" flag is now trustworthy — it will only fire for genuinely stranded shipments from here.

### Prevention — make the silent skip loud (2026-08-27, `index.html`)

The recovery net catches a stranded shipment *after* the fact and only if the operator returns to the list. Added three prevention layers on top, all in `index.html` (no backend change):

1. **Prompt on return from the print tab.** A `visibilitychange` listener: when the Ship tab regains focus and the open order is *labels bought + printed + not fulfilled* (`shipAwaitingFulfill()`), it asks "Fulfill now and email the customer tracking?" — armed once per print (`_fulfillNagArmed`, set in `printAll()` / `printLabel()`), deferred through `setTimeout` so Safari doesn't suppress the dialog. By the time it fires the operator has just been looking at the printout, so ADR 0011's "look first" still holds.
2. **Standing red Step-3 state.** Once printed, the action bar shows a persistent red "⚠ {order} is NOT fulfilled yet — {company} has no tracking" banner, the Fulfill button goes `btn-lg` and pulses, "Open + print all" demotes to "Reprint all". The screen no longer looks calm/done after printing.
3. **List-level banner + one modal alert.** `renderShipList()` renders a red banner above the whole list whenever `ship_labels_pending()` returns anything (not just the per-row chip), and fires one `alert()` per session (`shipPendingAlerted`) naming the orders. Catches the full-tab-discard case where the operator never opens the order again.

Verified: both inline `<script>` blocks parse (`new Function(src)`).

### Still pending — Andy

- **Commit + deploy** — the JOURNAL entries and the `index.html` prevention work are on disk; earlier `git commit` calls this session were blocked by the permission classifier. `03d55a8` (pushed) only has the incident write-up.
- **#6577** — refund the duplicate unused label in Shippo.
- ADR 0011's "when to revisit" (operators ignoring the mismatch warning → make it block) is unchanged.

## 2026-07-25 — Incident + fix: B2B orders printed but never fulfilled (in-memory ship state lost during printing)

### Work done

- **Symptom (Andy, live):** #6738 (Lucky Dog, 4 boxes) printed perfectly, no errors on screen — but Shopify still showed it UNFULFILLED, with no tracking and no customer email. "It used to do it."
- **Ground truth pulled before touching anything:**
  - `shipping_labels` had all four labels safely `purchased` with tracking ($33.49). No money or labels lost.
  - Shopify: order UNFULFILLED, fulfillment order `OPEN`, **no holds**, zero fulfillments, and — decisively — **zero app events**. Nothing had ever attempted a fulfillment.
  - Probed the live endpoint with a nonexistent order id: clean `404 Order not found`, which means OAuth, the `fulfillmentOrders` read and the app scopes are all fine (a missing scope returns the 502 scope message added on 2026-07-02).
  - Deployed `index.html` is byte-identical to local; no commit since 7/14. No code drift, no regression.
  - It *had* worked: #6680 (7/17) logs "Roast Scheduler marked 8 items as fulfilled" + "sent a shipping confirmation email", 62 seconds after its labels were bought.
- **Root cause:** the fulfill request never left the iPad. `shipState` is memory-only, and printing opens the combined 4x6 PDF in a second Safari tab; when iPadOS reclaims the app page you return to a clean order list — no error, no red banner, just no Fulfill button and no sign that four paid labels exist. Re-opening the order offers to *buy labels again*. #6680 survived because it was 2 boxes and was fulfilled before the print excursion; today's 4-box order gave iOS the time it needed. This is the "accepted limitation" from Step 5 (2026-06-30) finally biting — and it fails silently, which is the worst possible shape, because printing is the last visible act and reads as "shipped."
- **Fix (ADR [`0011`](./decisions/0011-recoverable-in-flight-shipments.md)) — bought labels are read back from the DB:**
  - Migration [`db/2026-07-25-ship-label-recovery.sql`](../db/2026-07-25-ship-label-recovery.sql): adds `tracking_url` + `label_url` columns and three `SECURITY DEFINER` functions — `ship_labels_for_order()`, `ship_labels_pending()`, `mark_ship_labels_fulfilled()` — granted to `anon`. None of them return cost/zone/weight, so ADR [`0004`](./decisions/0004-cost-table-security-model.md) still holds; no anon SELECT policy and no new secret.
  - `index.html`: `openShipOrder()` is async and rehydrates bought labels by `box_index` (`rehydrateBoughtLabels()`); the order list flags any order with bought-but-unfulfilled labels in red and its button reads **Finish →**; `renderShipActions()` now checks `allBought` *first* so a recovered order lands on Step 3 (print + fulfill) instead of "Get rates"; rate-completeness ignores boxes that already have labels. A blue banner states that labels were restored and nothing was re-charged; a **red** banner if the re-derived pack disagrees with what was bought.
  - `api/shippo-label.js` stores `tracking_url` + `label_url` on the cost row so a recovered shipment can be reprinted, not just fulfilled.
  - Help-card copy: "printing is not fulfilling", plus what the recovery flag means.
- **Remedy (with Andy's go-ahead — sends a customer email):** fulfilled #6738 through the app's own endpoint (not a direct API call), so it went through the real path and was attributed to Roast Scheduler: `SUCCESS`, one email to Shannon, all four tracking numbers on one fulfillment.

### Detours & fixes

- **`cost_updated: true` was lying, and had been since day one.** The #6738 fulfillment returned `cost_updated: true` while all four rows stayed `purchased` — and the successful 7/17 fulfillment never flipped its rows either. Every row in the table is `purchased` except the four flipped by hand on 7/02. Root cause: a PostgREST `PATCH` needs to **read** the rows its `WHERE` matches, and `shipping_labels` has RLS on with no SELECT policy (deliberate), so the WHERE matches nothing — PostgREST returns `204` with `Content-Range: */0` and `res.ok` is `true`. Verified in the live page: encoded and raw filters both return `*/0` while the rows demonstrably exist. Same family as the "upsert needs SELECT" bug from 2026-06-30. Fixed by replacing the PATCH with the `mark_ship_labels_fulfilled()` RPC, which returns a row count so `cost_updated` means what it says.
- **Ruled out early, cheaply:** B2B fulfillment holds (the `fulfillmentHolds` array is empty and status is `OPEN`, so the `OPEN`/`IN_PROGRESS` filter was never the problem), a missing app scope (the 404 probe), and a stale deploy (hash match).
- **Vercel runtime logs were useless here** — the plan retains roughly an hour, so the 12:18 PDT purchase window was already gone by the time we looked. The Shopify order event log and the Supabase rows carried the whole story instead.

### Verification

- `node --check` on `api/shippo-label.js`, `api/shopify-fulfill.js`, and both inline `<script>` blocks — all pass.
- Drove the **real** functions in a browser against stubbed RPC data (the migration isn't applied yet; `/api` doesn't run under a static preview): full recovery → 2 labels re-attached, phase `bought`, Step 3 with Fulfill showing, no re-buy offered, tracking rendered; partial recovery (1 of 2) → keeps the bought box, rates/buys only the other one; already-`fulfilled` rows → ignored, no resurrection; mismatch (3 bought vs 2 packed) → red warning with the exact counts; **RPC unavailable → identical to the old behavior** (phase `packed`, "Get rates"), so an unapplied migration can't break shipping; reprint guard for labels with no stored `label_url`.
- Screenshotted the list flag ("⚠ 4 labels bought · NOT fulfilled" + **Finish →**) and the restored order detail.

### Still pending — Andy

- **Apply [`db/2026-07-25-ship-label-recovery.sql`](../db/2026-07-25-ship-label-recovery.sql)** (Supabase SQL editor, or approve the MCP migration). Until then the recovery flag and rehydrate quietly no-op and the status flip stays broken. The file ends with a one-line backfill for #6738.
- **Deploy** — the fix is not live until `index.html` + the two `api/` files ship.
- #6739 (Cala La Jolla) still needs shipping — no labels bought for it yet.

### Decisions captured

- [`0011-recoverable-in-flight-shipments.md`](./decisions/0011-recoverable-in-flight-shipments.md)

## 2026-07-14 — Rename: CoffeePlanner → torque-production-portal (disambiguate from torque-green-planner)

### Work done

- **Why:** two separate Torque PWAs had confusingly similar GitHub names — this app (`TorqueCoffee/CoffeePlanner`, the Roast Scheduler at `production.torque.coffee`) and the unrelated green coffee buying/forecasting tool (`TorqueCoffee/torque-green-planner`, at `torque-green-planner.vercel.app`). "CoffeePlanner" gave no signal which app it was, raising the risk of working in the wrong repo.
- **Renamed:**
  - GitHub repo: `TorqueCoffee/CoffeePlanner` → `TorqueCoffee/torque-production-portal`
  - Vercel project: `coffee-planner` → `torque-production-portal`
  - Local repo path: `~/Developer/Torque-Projects/production app/CoffeePlanner` → `~/Developer/Torque-Projects/torque-production-portal` (also drops the space in the old path and moves up one directory level)
- **OIDC check before renaming (Vercel warns project renames affect OIDC token claims):** confirmed via full journal history (ADRs 0001–0010, all fixes) that this app has no AWS/GCP credential federation anywhere — it only talks to Shopify (`api/shopify-token.js`, `api/shopify-fulfill.js`), Supabase (anon key), and Shippo (`api/shippo-label.js`, own API token). `VERCEL_OIDC_TOKEN` was present as a default Vercel env var but unused by any application code. Rename proceeded with no dual-trust-policy cutover needed.
- **Confirmed unchanged:** live domain `production.torque.coffee` still points at the renamed project; git remote and Vercel Git integration re-resolved correctly post-rename.

### Follow-up still open

- ~~`~/.claude/launch.json`: the `coffee-planner` preview config entry (key + `cwd`) needs updating to the new key name and new path.~~ Done — verified 2026-07-25: the entry is `torque-production-portal` pointing at the new path.
- Confirm no stale `.vercel/project.json` left over from the old local path.
- `torque-green-planner` is unaffected — separate repo, separate Vercel project, no rename needed there.

## 2026-07-14 — Fix: TCCDS-40 (Cocoa Drops xBloom Bulk 40lb Box) tripped the B2B packer's over-cap halt

### Work done

- **Root cause:** Torque sells Cocoa Drops xBloom Bulk 40lb Box (SKU `TCCDS-40`) as a single 40lb line item — priced that way so bulk-tier math works — but it physically ships as 2x 20lb boxes. `packBoxes()`'s over-cap halt (`weight_lb > PACK_BOX.maxWeightLb`, cap 20lb) had no way to know this one SKU is actually two physical boxes, so a qty-1 order of it tripped "unit_exceeds_box_cap" instead of packing.
- **Fix (ADR [`0010`](./decisions/0010-per-sku-ship-unit-override.md)):**
  - `index.html`: added `SHIP_UNIT_OVERRIDES = { 'TCCDS-40': { units: 2, weight_lb: 20 } }` and `expandShipItems(items)`, which rewrites any matching line item's `qty`/`weight_lb` to the real physical units before it ever reaches `packBoxes()`. `packBoxes()` itself is untouched — it still only ever sees correct per-unit weights, same as every other SKU.
  - Wired `expandShipItems()` into `loadShipOrders()` right after the `/api/shopify-token?type=b2b-ship` fetch, so the correction happens once and every downstream consumer (order list box-count, ship-detail view, packing-slip contents) sees already-correct items.
  - `api/shopify-token.js`: added `sku` to the `b2b-ship` item shape (it was missing — items previously only carried `product_name`/`variant_title`/`qty`/`grams`/`weight_lb`) so the override can match on SKU rather than fragile title/variant text.

### Verification

- `node --check` on `api/shopify-token.js` and both inline `<script>` blocks extracted from `index.html` — all pass.
- Node-evaluated the packer module in isolation and confirmed: a `{sku:'TCCDS-40', qty:1, weight_lb:40}` line item expands to 2 units of 20lb each and packs as 2 boxes (not a halt, not one 40lb box); a mixed order (`TCCDS-40` qty 1 + a normal 5lb-bag line qty 4) packs correctly across 3 boxes with no cross-contamination between the override and the normal SKU; a line item with any other SKU passes through `expandShipItems()` unchanged.
- Confirmed `SHIP_UNIT_OVERRIDES` has exactly one key (`TCCDS-40`) — no accidental match against another SKU.
- Confirmed expanded 20lb units never reach the `unit_exceeds_box_cap` halt path in `packBoxes()`.

### Decisions captured

- [`0010-per-sku-ship-unit-override.md`](./decisions/0010-per-sku-ship-unit-override.md)

## 2026-07-07 — Fix: 4x6 label/slip printing on iPad Safari — native combined PDF (replace HTML/iframe/@page)

### Work done

- **Root cause (3-part, all confirmed by direct research, not guessed):**
  1. The print documents declared `@page { size: 4in 6in }` inside an HTML `srcdoc`. Safari has never supported the `@page` size descriptor, so the 4x6 page geometry was silently ignored — content printed at the wrong scale (labels came out ~40% size).
  2. The label was a PNG image. AirPrint's thermal-label path expects a native PDF whose MediaBox *is* the physical page; an image goes through AirPrint's scale/fit logic instead and mis-sizes.
  3. Printing went through a hidden off-screen `<iframe>` + `iframe.contentWindow.print()`. iOS Safari iframe printing is long-broken — it prints the parent document or nothing, which is why packing slips weren't coming out at all.
  - This supersedes the whole PNG/combined-HTML/data-URL line of fixes from the last two entries (2026-07-02, 2026-07-07 same-origin-proxy) — those were patching symptoms of an architecture (`@page` + iframe + image) that cannot work on iOS Safari, not fixable by better image handling.
- **Fix — one native 4x6 PDF, opened in a new tab (ADR [`0009`](./decisions/0009-native-pdf-print-path.md)):**
  - `api/shippo-label.js`: reverted `label_file_type` from `PNG` back to `PDF_4x6` (both the Shippo transaction call and the response field) — Shippo returns a native 4x6 PDF label again.
  - New `api/ship-doc.js`: builds ONE combined 4x6 PDF server-side with `pdf-lib`. For each box, in packing order: fetches the Shippo label PDF (host-allowlisted to `*.goshippo.com` / shippo's S3 bucket — SSRF guard) and copies its page in unmodified (already 4x6); then draws a packing-slip page from scratch (Torque logo, box N of M, weight, contents) — no HTML, no `@page`, no iframe. Every page's MediaBox is exactly `[288, 432]` pt (4in × 6in).
  - `index.html`: replaced the entire old print stack (`composeContentsSlipHTML`, `composeCombinedPrintHTML`, `composeSingleLabelHTML`, `labelDataUrl`/`_labelDataUrlCache`, `printCombinedDoc`, the slip-iframe body of `printSlip`, `slipBodyMarkup`, `SLIP_ELEMENT_STYLES`, `hEsc`) with a single `openShipPdf(boxes, { labels, slips })` helper: opens a blank tab **synchronously inside the tap** (so Safari's popup blocker doesn't fire), POSTs to `/api/ship-doc`, and points the tab at the returned PDF blob. `printLabel`, `printSlip`, and `printAll` are now thin wrappers around it.
  - Deleted `api/label-proxy.js` (no longer needed — the browser never fetches the label directly; the server does).
  - Updated the Ship-tab help-card copy to describe the new "opens a 4x6 PDF in a new tab, Share > Print > Rollo" flow instead of the old in-page print dialog.
  - `package.json`: added `pdf-lib": "^1.17.1"`.

### Verification

- `node --check` passes on `api/shippo-label.js` and `api/ship-doc.js`, and on both inline `<script>` blocks extracted from `index.html`.
- Grepped `index.html` for `labelDataUrl`, `composeCombinedPrintHTML`, `composeSingleLabelHTML`, `printCombinedDoc`, `label-proxy`, `contentWindow.print`, `@page` — all gone from the ship path (two remaining hits are prose in a code comment explaining *why* the old approach failed).
- Confirmed `api/label-proxy.js` is deleted.
- Local smoke test of `api/ship-doc.js` with a stubbed `fetch` (a tiny known 4x6 PDF for `label_url`, logo fetch simulated as failing to exercise the skip-on-failure path) and a 2-box payload: output starts with `%PDF`, has exactly 4 pages (label, slip, label, slip), and every page's MediaBox is 288×432pt. Also confirmed the SSRF host guard 400s a non-Shippo `label_url`.
- **Not yet certified against a real device, by design:** this fix targets iOS Safari print behavior (popup-block timing, AirPrint's page handling) that can't be observed from a local/headless run. **Andy to run "Open + print all" on a real 2–3 box order on the iPad and confirm label/slip/label/slip all print at true 4x6 on the Rollo** (Rollo media set to 4x6, iOS print sheet Scale 100%).

### Decisions captured

- [`0009-native-pdf-print-path.md`](./decisions/0009-native-pdf-print-path.md)

## 2026-07-07 — Fix blank/mis-scaled labels on iPad Safari: same-origin label proxy + inline data: URLs

### Work done

- **Root cause:** ADR 0007 (2026-07-02) moved labels to PNG and combined label+slip into one print document, but the label was still embedded as a cross-origin `<img src="{shippo label_url}">`. iOS Safari won't paint a cross-origin image into a print snapshot, so "Open + print all" printed the slips fine but the label pages came out blank. Separately, the old per-box "Open label" button opened the raw PNG directly in a tab — a bare image has no page size, so Safari tiled it across ~6 sheets at native resolution instead of one 4x6 page.
- **Fix — same-origin proxy + inline `data:` URLs (ADR [`0008`](./decisions/0008-same-origin-label-proxy.md)):**
  - New `api/label-proxy.js` — fetches the label PNG server-side (host-allowlisted to Shippo) and re-serves the bytes from our own origin, sidestepping Shippo's CORS-less CDN.
  - `index.html`: `labelDataUrl(labelUrl)` pulls the label through that proxy and converts it to a same-origin `data:` URL (cached per URL); `composeCombinedPrintHTML()` renders `bw.labelDataUrl` instead of the raw label URL; `printAll()` resolves every box's data URL before composing and aborts (alerts, prints nothing) if any fails.
  - Renamed `openLabel(idx)` → `printLabel(idx)`: resolves that box's data URL and prints it through new `composeSingleLabelHTML()`, a single 4x6-page document (same `@page` geometry as the combined doc), fixing the multi-sheet tiling bug. Button text: "Open label" → "Print/Reprint label".
  - `printCombinedDoc()` now awaits `img.decode()` per image (not just `load`) before printing, closing a narrow race where the bitmap wasn't yet paintable at print time.

### Verification

- `node --check` passes on `api/label-proxy.js` and both inline `<script>` blocks.
- Confirmed no `openLabel` references remain anywhere in `index.html`.
- **Not yet certified against a real device, by design:** this fix targets an iPad Safari print-snapshot rendering behavior that can't be observed from a local/headless preview — it requires a live Shippo-purchased label and an actual iPad print. **Andy to run one real "Print label" reprint and one "Open + print all" on a purchased order and confirm both come out as full-bleed 4x6 pages** (not blank, not tiled).

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
