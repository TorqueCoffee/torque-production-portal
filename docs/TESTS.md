# TESTS — pre-commit gates

What must pass before committing each step. No CI here (single-file PWA, static deploy) — gates are checked by eye or a node snippet; the automatable ones are actually run.

## Global (any commit touching index.html, api/ or tests/)
- [ ] Full-script syntax: extract `<script>` blocks and `node --check` → no errors. A paste error breaks the entire app's JS, so this is non-negotiable. Automated in `tests/syntax.test.js`.
- [ ] `npm test` (`node --test "tests/*.test.js"`) → all pass.

## Login slice (Supabase Auth, ADR [`0023`](./decisions/0023-supabase-auth-logins.md))

Rollout order (RUNBOOK "First rollout"):
- 0: login-prep and label-claims SQL; accounts created and marked `portal_staff`.
- 1: deploy, and every device signs in.
- 2: a day of observation. 2b: the realtime SQL once no old tab is left.
- 3a: `PORTAL_AUTH_ENFORCE=1`. 3b: the access SQL.

- [x] **L1:** `npm test` passes, syntax included.
- [x] **L2 token check** (`tests/auth.test.js`, fetch stubbed; `tests/b0-ups.test.js` runs every API test with enforcement on and a token):
  - Enforcing, each of the 4 functions answers 401, before any Shippo, Shopify or PostgREST call, to:
    - a missing token, a bad one, `Basic …`, an empty bearer, two tokens, or one over 8 KB;
    - an anonymous Supabase user.
    - The token is never echoed back.
  - Enforcing, 503 when:
    - Supabase Auth returns 5xx, refuses the connection, or doesn't answer within the timeout;
    - `SUPABASE_URL` or `SUPABASE_ANON_KEY` is unset;
    - Supabase refuses the server's key ("Invalid API key"), so a rotated key can't send every device into a sign-in loop.
  - A valid token passes. The check sends the token and the anon key to `/auth/v1/user`. "bearer" works in any case.
  - The cost row, the one-label lookup and the fulfill status flip (`mark_ship_labels_fulfilled`) carry the user's token.
  - **Double-charge guard:** nothing is bought (503), and no cost row is written, when the one-label lookup is refused, errors or times out. That holds enforcing, and not enforcing with no token or a bad one (the after-migration case). ADR 0020's "lookup fails → buy anyway" is reversed.
  - Not enforcing:
    - a missing, bad or unverifiable token is logged with the device's user agent, and the request passes;
    - a bad token is forwarded as is, never swapped for the anon key;
    - no token falls back to the anon key;
    - tokens are never logged.
  - Only the exact value `1` enforces.
  - No CORS headers. Wrong method and OPTIONS → 405.
  - `ship-doc` fetches labels only from `goshippo.com`. S3 buckets with "shippo" in the name are refused.
- [x] **L3 page:**
  - Sign-in screen:
    - No TT password or cookie gate is left, and `<html>` starts locked.
    - The form has `autocomplete="username"` / `"current-password"` and `onsubmit="return false"`, so it can't post credentials if the script fails. A failed supabase-js load shows a message.
    - There's a Sign out button (refused mid-buy and mid-fulfill), and no sign-up or reset call.
  - supabase-js is pinned (`@2.117.2`) with a sha384 `integrity` attribute. The CDN file was compared byte for byte with the npm tarball.
  - `apiFetch`:
    - all 11 `/api` call sites use it (the 11th is the Retail queue), and no bare `fetch('/api…')` is left;
    - it sends `Authorization: Bearer <token>`, and none without a session;
    - on a 401 it refreshes the session once and retries, then shows the sign-in screen.
  - `sbFetch` (supabase-js's fetch):
    - refuses any `/rest/v1/` call on the publishable key alone and shows the sign-in screen;
    - counts in-flight writes;
    - lets reads and `/auth/v1/` calls through.
  - Session lifecycle:
    - no session → the sign-in screen; `init()` and realtime don't run;
    - a session (including repeated `TOKEN_REFRESHED`) starts them exactly once;
    - signing out reloads the page, or only shows sign-in while a buy is running.
  - Realtime:
    - 60 events become one reload;
    - a reload waits while this device writes or a finger is down;
    - a reload whose reads raced a local write is dropped and re-run;
    - `loadPlan` keeps the list on a failed read;
    - a live channel that drops sets the sync pill to error, and one that never connected only logs.
  - Escaping:
    - `jsArg` round-trips quotes, backslashes and `</script>` and leaves no raw quote or bracket;
    - `safeUrl` refuses `javascript:`, `data:`, `vbscript:` and relative URLs;
    - ship box and B2B list output with `<img onerror>` in every Shopify field contains no live markup;
    - no inline handler takes a data-derived name as a quoted JS string.
  - Browser preview (Chromium, local static server, no session):
    - only the sign-in screen is visible, with the email field focused;
    - supabase-js loads through the integrity check, and no Supabase request is made;
    - an empty submit shows the "enter your email and password" message;
    - it fits a 375 px width.
- [x] **L4 migrations** (`npm run test:db`, PGlite 0.5.8 with `tests/db/live-schema-2026-10-18.sql`, a copy of the live tables, keys, grants, 36 policies, 3 functions, default privileges and the empty publication; ADR [`0024`](./decisions/0024-pglite-for-migration-tests.md)):
  - The fixture reproduces today: anon has full CRUD; a signed-in user sees and saves nothing on `activity_log` and `plan_state`.
  - **login-prep:**
    - signed-in users get exactly anon's access, and anon loses nothing;
    - a second run is refused;
    - the rollback restores today.
  - **realtime:**
    - publishes the 4 tables and can be run twice;
    - access is unchanged and UPDATE/DELETE still work;
    - the rollback unpublishes;
    - it's refused if a table has no primary key.
  - **access:**
    - anon gets 0 rows on all 10 tables, inserts are refused, updates and deletes hit 0 rows, and all 3 functions are denied;
    - `authenticated` access equals anon's before, cell for cell, and all 3 functions work;
    - `green_planner_app` reads only its 2 tables, writes nothing, and loses the PUBLIC EXECUTE it had (including on `mark_ship_labels_fulfilled`);
    - policies keep command and expressions; only role and name change;
    - new tables and functions created by postgres get no anon grant.
    - It is refused, with nothing changed, when: login-prep is missing; there are no accounts; an account has never signed in; an anonymous user exists; the policies drifted; it's run a second time. A deleted, never-signed-in account doesn't block.
    - The rollback returns to the login-prep state (signed-in access intact), the prep rollback then to today, and a second rollback is refused.
- [x] **Round 2 additions** (`npm test` 92, `npm run test:db` 16):
  - **Staff marker:** an account without `app_metadata.portal_staff` gets 403 from `/api` and, after 3b, no rows, no writes and empty recovery functions; 3b refuses to run while one exists.
  - **Always enforced:** label buying, fulfill, `ship-doc` and `?type=b2b` / `b2b-ship` answer 401 without a token even when not enforcing; products and the order list wait for the variable.
  - **"Already bought":** the row is confirmed with Shippo (transaction id, SUCCESS, same tracking number), and the response carries Shippo's label and link. An unconfirmed row → 409, nothing bought.
  - **One buyer per box:** a claimed box → 409, and a claim failure (including the migration missing) → 503, with no purchase in either case. A failed purchase releases its claim. L4: the second claim fails, a release or a 10-minute-old claim frees the box, anon and green_planner_app are denied, a stranger gets `false`, and the table is reachable only through the functions.
  - **Token life:** a label buy with under 2 minutes left on the token → 401 before anything is bought; rating is unaffected.
  - **Clear:** `only_if_fulfilled` on an order with open items → 409, nothing created or flipped.
  - **Page:**
    - a label 409 other than "Price changed" shows as a failed box;
    - a failed `plan_state` or roasting read keeps what is shown;
    - signing in again after a lock reloads the data;
    - reloads wait while a field is focused (at most 60 s);
    - sign-out is refused mid-buy and mid-fulfill.
  - **Rollback** checks policies by name, so later tables don't block it.
- [x] **L5 live**, publishable key only, after step 3:
  - `GET /rest/v1/daily_plan` → `[]`
  - `POST /rest/v1/rpc/ship_labels_pending` → refused
  - `POST /api/shippo-label?action=rate` and `GET /api/shopify-token?type=b2b-ship` → 401
  - `GET /api/_auth` → 404. A 500 would mean Vercel built it as a function; that is not an exposure, but say so.
- [x] **L6 devices (Andy)**, after step 2b:
  - The plan loads.
  - A change on one device shows on another within a couple of seconds without a reload.
  - Six fast "+" taps on one line store 6.
  - Pull Orders works.
  - Ship gets a rate with no purchase.
  - The green planner still loads.
- [ ] **L7:** adversarial review, then Andy approves each step.

**Run log:**
- 2026-10-18: L1–L3 PASS, 69/69 (`npm test`, Node 25.8.1). L4 PASS, 10/10. L4 caught a real hazard: publishing a table with no replica identity makes Postgres refuse its UPDATEs and DELETEs. All 4 live tables have primary keys; the realtime migration now checks.
- 2026-10-18: L7 round 1 (Saboteur, Security Auditor, Architect; the first attempt hit the usage limit).
  - 37 findings: 4 Blocks ship (3 of them the same hole), 15 Should fix, 18 Worth noting. Accepted fixes landed (JOURNAL).
  - L1–L3 PASS, 82/82. L4 PASS, 13/13. L4 caught a second error: a schema-level default-privilege revoke can't remove PUBLIC's EXECUTE on new functions.
- 2026-10-18: L7 round 2 (fresh reviewers).
  - 0 Blocks ship, 18 Should fix (all fixed), 30 Worth noting.
  - Andy ended the review loop after round 2.
  - L1–L3 PASS, 92/92. L4 PASS, 16/16.
- 2026-10-18: step 1 deployed (bcc505e).
  - L5 partial PASS, publishable key only: without a token, `/api/shippo-label?action=label`, `/api/shopify-fulfill`, `/api/ship-doc` and `/api/shopify-token?type=b2b` / `b2b-ship` → 401; `/api/_auth` → 404; `?type=products` → 200 (as planned until 3a).
  - The REST and RPC checks wait for step 3b.
- 2026-10-19: step 3a (`PORTAL_AUTH_ENFORCE=1`, redeployed). L5 API part PASS: with no token, `?type=products`, the order list, `?type=b2b` and `shippo-label` rate → 401; with a made-up token → 401.
  - Andy's Mac (andy@, and nanelle@ in a private window) ran Pull Orders under enforcement: 200s, no `auth:` lines, writes as `authenticated`. The floor device didn't show in the logs.
- 2026-10-19: step 3b run. L5 PASS (publishable key only): table reads → `[]`, `activity_log` insert refused by RLS, `ship_labels_pending` / `mark_ship_labels_fulfilled` → permission denied, `shippo-label` rate and `b2b-ship` → 401, `/api/_auth` → 404.
  - After 3b, Andy's Mac: plan loads, Pull Orders writes (`authenticated`, 204/201); the green planner reads `green_coffee_settings` (15 rows) and `blend_matrix` (19) as `green_planner_app`.
- 2026-10-18 (PDT): step 2b run (realtime publication, 4 tables). L6 PASS (Andy, on two devices): the plan loads, a change shows on the other device without a reload, six fast "+" taps store 6, Pull Orders works, Ship rates without buying, and the green planner loads.

## UPS Ground (Phase B, plan: [`Retail-USPS-UPS.md`](./Retail-USPS-UPS.md))

### B0 — B2B cutover and safety
Every order ships UPS Ground at the packed weight (ADR [`0020`](./decisions/0020-all-orders-ups-ground.md)). `tests/syntax.test.js` + `tests/b0-ups.test.js` (ADR [`0021`](./decisions/0021-node-test-harness.md)), fetch stubbed, no network:
- [x] **G1 syntax:** both inline `<script>` blocks parse; every `api/*.js` (and, since B2a, `lib/*.js`) passes `node --check`.
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
  - **A 409 stops the buy after that box** and sends every unbought box back to the rate step. The box shows "Price changed" (not "No rate"), and the action bar offers Re-rate, not Buy. After the re-rate, the warning clears and Buy shows the new total.
  - **While buying, the action bar has no buttons and "← Orders" is hidden.** Buy, Re-rate, Get rates (even nested mid-buy), ← Orders, reopening the order and Refresh Orders all refuse while a buy is running. The lock is module-level, so a reopened order can't start a second loop.
  - "Already bought" from the server becomes a recovered label, not a failure.
  - Clear on the red banner closes out a hand-fulfilled order only when the server says it is fulfilled, and sends no email.
  - Re-rating skips boxes with a label. The buy button counts only boxes still to buy.
  - Shippo's reason and fulfill errors are HTML-escaped. There is exactly one `escHtml`, and it escapes `& < > " '`.
  - Fulfill sends `company:'UPS'` (rollback safety).
  - No `carrierForOrder`, `UPS_COMPANIES` or `'usps'` is left in the page.
- [x] **G3 label endpoint, accepted path:**
  - The request pins `carrier_accounts [21db4cf8…]`, origin phone 6192305400 and ZIP 92104.
  - The recipient address is 9 known string fields: email, extras and non-strings dropped; control and invisible format characters removed; NFC (not NFKC, so "123½" stays); name and company cut to 35 characters by code point; the phone falls back to Torque's.
  - From Saver, USPS, CA-account UPS and US-account UPS rates it picks the US-account `ups_ground`.
  - "1 Pobox Way" still ships.
- [x] **G3 label endpoint, refused with 400 before any Shippo call:**
  - carrier usps/USPS/fedex, at rate and at label
  - no `weight_basis`, at rate and at label
  - a weight that is not a whole-pound number (20.5, `'22'`, `true`, 0), or string dims
  - an address that is not an object
  - a P.O. box (P.O. Box, PO BOX, POB, P.O.B., P0 Box, PO-Box, P/O Box, Po Bx, Postal Box, with zero-width, soft-hyphen or bidi characters inside)
  - street 1, street 2 or city over 35 characters (refused, never cut), or any field over 200 characters
  - a label request without `order_id` and `box_index`
  - a label request with no confirmed price, or one not in `"16.43"` form (`1e308`, `[16.43]`, `true`, `16.431`, `0`, `-1`)
  - `action` Rates, `[rate,rate]`, void
  - No error echoes caller input.
- [x] **G3 label endpoint, purchase path:**
  - No US-account `ups_ground` rate → 422, nothing bought. The response labels rates `torque-us`/`other` and carries no account ids.
  - A fresh price higher than confirmed, even by a cent (16.44 vs 16.43) → 409 with both prices, nothing bought.
  - An unreadable price (`''`, `N/A`, null, 0) or a non-USD one → 422 at rate and at label, nothing bought.
  - A box that already has a label (same `order_id` + `box_index`, not voided) → 409 "Already bought" with that label, and no Shippo call. A label on another box, or a voided one, doesn't block. ~~If the lookup fails, the buy goes ahead.~~ Since the login slice: a failed or refused lookup → 503, nothing bought (ADR 0023).
  - The same or a lower price buys; the confirmed price may be a number.
  - A purchase logs `ups_ground`, `is_cubic false`, `weight_lb 22`.
  - A failed purchase → 502, no cost row.
- [x] **G3 fulfill:**
  - The tracking company is UPS whatever the page sends.
  - A box with no tracking number (empty, missing, null, an array) → 400 with zero Shopify calls.
  - An open order with a USPS or malformed number → 400 "fulfill by hand", and nothing is created.
  - An already-fulfilled order (Shopify FULFILLED, every fulfillment order CLOSED, e.g. fulfilled by hand) → 200 `alreadyFulfilled`, no notification, label rows flipped to fulfilled.
  - ON_HOLD, SCHEDULED, INCOMPLETE, no visible fulfillment order, or a cancelled order → 409 with what to do. Rows are not flipped.
  - No tracking URL is sent to Shopify.
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
  1. ✓ 2026-10-18: Andy approved the merge and signed off on both open questions. The 14x10x10 tare stays 0.83 (not A3's 0.99), and xPods count as 12 oz (0.75 lb) in B2B.
  - ✓ 2026-10-18 step 3: no `purchased` rows right before the push. Step 4: `main` pushed once (64fc9aa), live at 17:42 UTC. The /docs, /db, /tests, /.vercelignore and /docs/shipping_margin.md paths return 404; the app and the products API return 200; the label endpoint refuses `usps` and old-page payloads with 400. G4–G6 are open.
  - ✓ 2026-10-18 step 5: old deployment URLs (e.g. the e740616 and 26200df deployments, from GitHub's deployment records) answer every path, `/docs/RUNBOOK.md` included, with a 302 to Vercel's SSO login (Standard Deployment Protection). They are not public.
  - ✓ 2026-10-18 step 2: allowlist pushed alone (07d002d); `/docs/RUNBOOK.md`, `/docs/JOURNAL.md`, `/db/…sql` and `/.vercelignore` return 404, and the app and `/api/shopify-token?type=products` return 200.
  2. **The allowlist ships alone, first.** Local `main` (fc0f43c, the Phase A docs) must not reach origin before it.
     - On a fresh branch from `origin/main`, commit only `.vercelignore` (its final form from `b0-b2b-ups`) and push it to `main`.
     - Verify: `/docs/RUNBOOK.md` and `/db/2026-07-25-ship-label-recovery.sql` return 404, `/api/shopify-token?type=products` returns 200, and the app loads.
     - Only then rebase or merge local `main` + `b0-b2b-ups` onto it and continue.
  3. **Immediately before the B0 push**, in the Supabase SQL editor (anon has no SELECT, ADR 0004), run `select order_id, order_name, service, count(*) from public.shipping_labels where status = 'purchased' group by 1, 2, 3;` and expect no rows. For each row it does return: fulfill the order (by hand in Shopify if its labels are USPS), run `select public.mark_ship_labels_fulfilled('gid://shopify/Order/<id>');`, then re-run the query.
  4. Push `main` once. After deploy:
     - Repeat the 404 checks, plus `/tests/b0-ups.test.js` and `/.vercelignore`.
     - `/api/shopify-token?type=products` returns 200, and the app loads.
     - Record the deployment time in the JOURNAL B0 entry: `shipping_labels.weight_lb` is the declared weight from then on.
  5. Andy checks in the Vercel dashboard whether Deployment Protection covers old `*.vercel.app` deployment URLs, which still serve `/docs` from before the allowlist.

**Run log:**
- 2026-10-17: G1–G3 PASS, 18/18 (`node --test "tests/*.test.js"`, Node 25.8.1).
- 2026-10-17: adversarial review round 1. Accepted fixes landed (see JOURNAL). G1–G3 PASS, 25/25.
- 2026-10-17: adversarial review round 2. Accepted fixes landed (see JOURNAL). G1–G3 PASS, 38/38 (`npm test`).
- 2026-10-18: adversarial review round 3 (the cap). Accepted fixes landed (see JOURNAL). G1–G3 PASS, 47/47 (`npm test`).

### B3b and B6 UI — Pack, Hold back, Fulfill, Done, the red banner, Void (ADR [`0029`](./decisions/0029-retail-pack-and-fulfill.md))
`tests/b3b-retail-fulfill.test.js` (the real `api/shopify-fulfill.js`, Shopify, Supabase and Shippo stubbed), `tests/b3b-retail-pack.test.js`, `tests/b3b-retail-done.test.js`, `tests/b3b-retail-banner.test.js`, `tests/b3b-retail-void.test.js` (the page's own functions in a sandbox with a fake server, `tests/helpers/retail-page.js`), `tests/b3b-retail-contract.test.js` (the page calling the real handler), the void-lock block in `tests/b3-retail-label.test.js`, and `tests/db/label-held-back.test.js` (PGlite). Nothing is bought, fulfilled, voided or written.
- [x] **F1 retail fulfill (server):** tracking from the DB row (a `tracking` in the body is ignored); one create; `emailed` true only when created, notified and the order has an email; the customer email is always on for retail (a body can't turn it off); no live retail label, two, a voided-only, a fulfilled-only, a B2B-channel or a box-2-of-2 row: 409 `labels`; held back: 409 `held_back`; a non-UPS number: 400, before the repack; billed lb changed or no weight on record, the order's ZIP differing from the label's: 409 `pack_changed`; no longer LIST: 409 `not_listed`; Shopify 404: 409; Shopify down or the label record unreadable: 503; none of these creates anything.
- [x] **F2 lock:** taken before anything is read, released on every path (created, refused, already fulfilled, cancelled, Shopify error or throw); a busy lock is 409 `busy` with no Shopify read; a lock that can't be taken (SQL not applied, Supabase down) is 503; two simultaneous requests: one create, one `busy`, and the loser's retry is `alreadyFulfilled`.
- [x] **F3 Shippo:** a label Shippo reads REFUNDED, REFUNDPENDING, with another tracking number, 404, a non-200, a timeout, no token, or with no 32-hex transaction (a planted row) is refused (409 `label_not_live` or 503) and nothing is created.
- [x] **F5 no kind:** an order with a live retail label is retail whatever the body says (the DB number, the held-back, pack and lock checks); no kind and no retail label is the B2B path (the B0 G-tests are unchanged and pass); a failed label lookup leaves B2B as it was.
- [x] **F6–F9:** a Shopify call that never answers is a 504 ("fulfill again is safe") and the lock is released; a hung label flip after the create doesn't fail the fulfill; a record without the new columns is a 503 that names the SQL, not a blame on the order; the order id is read one way and junk is a 400.
- [x] **V void lock (server):** a retail void takes the order's lock before Shopify or Shippo, reads the row again, and releases on every path; a busy lock is 409; B2B voids take no lock.
- [x] **P1 Pack:** cards come from the DB's pending labels, not from any in-page batch; gone and unrecorded orders get no card; held state is `held_back_at` and survives a reload; sorted by carton then oldest; every data field escaped; `data-id` handlers and 44px buttons; Hold back asks the DB and re-reads, and an RPC error or a 0 result changes nothing and says so; a second tap or any tap while loading, confirming, fulfilling or voiding does nothing; Refresh is off while a hold is in flight; two overlapping Hold backs can't paint the older state; the Resume banner counts and hides; Buy is blocked while a batch is open (no request, button off, message and Resume link; only gone orders: it says to clear or void); an all-bought run goes to Pack, a mixed run stays on Buying with "Pack and fulfill", an unrecorded or PDF-less run stays; focus stays on the button just used; 3, 2 and 1 columns.
- [x] **D1 Fulfill and Done (acceptance checks 7 and 8):** the confirm counts only included cards and is in the page; the run sends `kind: 'retail'` for the included ids only; a double tap or a second Fulfill makes no extra calls; the Done counts equal the fulfillments created; a failure doesn't stop the rest and shows as Still open; a lost answer then Fulfill again creates once and counts no extra email; a lost answer to a fulfill that went through (rows flipped) counts as shipped with a note; a 429 or 503 drops to one at a time and retries three times; a refusal retrying can't fix says to hold it back and void or fulfill by hand; Done follows a Retry; Reprint this batch makes no `shippo-label` call, opens in the tap, and builds 25 at most.
- [x] **R1 red banner:** Clear sends `only_if_fulfilled` with notify off and never creates (an open order is refused and says so); Retry with `alreadyFulfilled` clears the entry and counts no email; entries are this session's only (a reload shows the order in the open batch again); the banner shows on the queue, Pack and Done, escaped; the B2B Ship tab still skips retail rows (B3a R10).
- [x] **V1 Void (acceptance check 9):** no confirm, no request; the right request; each answer (marked, not marked, 502, 409/404/503, no answer, other) has its own message; after a marked void the order is a ready row again; Void is on Bought rows, held-back cards and gone orders and never on included cards or unrecorded rows; off while buying, fulfilling, loading or another Void runs; a refunded-but-unmarked void stays flagged on this device and drops once the DB row is fixed.
- [x] **X1 contract:** the page's Fulfill against the real handler: every included order ships once and the Done counts equal Shopify's; a second Fulfill is `alreadyFulfilled` with no extra email; held back on another device is listed as held, not failed; a lost answer is recovered; a busy lock fails the order with the reason and a retry ships it; a refunded label and a changed pack are refused and the page says what to do.
- [x] **H1 migration:** staff hold back and include a retail purchased row; a B2B, fulfilled, voided or unknown order returns 0; a stranger gets 0, anon and the green planner are denied; the lookups return `held_back_at` (and `weight_lb`, `dest_zip`); one claim per order until released or 2 minutes old; the claim functions are staff only and the table has no direct access; Hold back changes nothing while the order is claimed; signed-in users can no longer UPDATE a label row but the functions and INSERT still work; refused a second time and before the channel or void migrations; the rollback restores the channel-era signatures, drops the column, functions and table, and reopens UPDATE.
- [x] **Mutation checks:** every new test was run against its code with the fix removed and failed. After round 1, only the changed code was mutated (about 100 mutations). Equivalent mutants, not worth a test: the SQL `pg_temp` in `search_path`; Clear forcing notify on (it never creates); an order with no ZIP (it can't classify LIST); the busy code (the page doesn't branch on it).
- [x] **P1 preview:** local page with sample data (stubbed `apiFetch` and `sb.rpc` in the console only): Pack at 1180 (3 columns), 768 (2) and 375 (1, no sideways scroll), the confirm, Done with a failed order, the red banner, Hold back kept across a re-open, Retry, Clear, Void; no console errors.
- [ ] **L live (Andy):** apply `db/2026-10-20-label-held-back.sql` (RUNBOOK "Retail Pack and Fulfill"); the 3-label test from B3a, then on the same three: Pack shows them, hold one back and reload (still held), Fulfill two (two emails, Done 2/2/2/1), Fulfill again (no second email), Include the third and void its label then try to Fulfill it (refused: Shippo says it isn't live), cancel one in Shopify (the red box, Void), check Shippo's status for a refunded label really is REFUNDED, and watch the Vercel log for a function timeout.

**Run log:**
- 2026-10-20: S1–S5 PASS (275 then 305 with round 1 fixes), `npm run test:db` 37/37.

### B3a — Retail Buy and print, and B4 — the retail slip (ADR [`0028`](./decisions/0028-retail-buy-and-print.md))
`tests/b3a-retail-buy.test.js` (page functions out of `index.html` with a fake server), `tests/b4-retail-slip.test.js` (`api/ship-doc.js` and `api/_retail-slip.js`, label files stubbed), the B3a blocks in `tests/b3-retail-label.test.js`, `tests/b1-retail.test.js` and `tests/b0-ups.test.js`, and `tests/db/label-channel.test.js` (PGlite). Nothing is bought, rated or voided.
- [x] **R0 quantity:** `min(unfulfilledQuantity, currentQuantity)`; #3341's shape (1 and 0) drops the line; one field alone is used as is; the 30 fixtures are unchanged.
- [x] **R1 two taps:** Select all, then Buy and print buys every order and makes one PDF; no confirm dialog; the PDF tab is opened before any request, and before the first `await` in every handler that opens one.
- [x] **R2 requests:** every rate and label request carries `kind: 'retail'`, `order_id`, `ups`, `packed`, no email; label requests carry the quote as `"x.xx"`, box 1 of 1 and the list's `pack_sig`. Off, past 25, or a fix row: nothing is sent.
- [x] **R3 no rate:** the order is not bought, the others are; the screen says so, with Open in Shopify and Re-rate; Re-rate then Buy buys it alone at the new quote. A Shopify address the server refuses (`code: 'address'`) shows the same way.
- [x] **R4 one failure:** a 502 on one order leaves the others bought; Try again buys it. No answer: "Try again; it never buys a box twice". A 200 with no tracking number is not bought.
- [x] **R5 price guard:** a price that rose is not bought and has no Buy until it is re-rated; then it buys at the new quote, that row only.
- [x] **R6 already bought, reload:** "Already bought" is bought at $0.00 and its label is in the PDF. After a reload, orders with a retail label (from `ship_labels_pending`, `channel = 'retail'`) are in "Bought, not fulfilled", can't be ticked, aren't in Select all, never reach Buy; B2B rows are ignored; a failed lookup says so. A label bought but not recorded (`cost_logged: false`) is flagged on the row and above the table, and stays in Bought ("not recorded") after Back, a reload and a new page load on this device until the DB has its row.
- [x] **R7 lock:** while buying, and while the PDF is made, ticking, Refresh, Back, a second Buy, Open PDF, Reprint and row actions do nothing, and the screen shows no Back or row buttons. Actions on a bought row, or on an order that changed in Shopify (`pack_changed`, `not_listed`), do nothing.
- [x] **R8 PDF:** one `ship-doc` call, label then slip per order, by carton then oldest; Open PDF reuses it, Reprint makes a new one; neither buys. A blocked or closed tab, a failed build, a reply that isn't a PDF, or a label with no file each say what to do. Queue Reprint prints the order's one live label (a newer voided one is ignored; two live ones are refused). The slip fields per `retail_slip_spec.md` (Pacific date; NO COFFEE SET on a subscription line without one).
- [x] **R9 escaping:** names, coffees, notes and server reasons are escaped on the Buying screen.
- [x] **R10 B2B banner:** the B2B Ship tab's "never fulfilled" banner leaves `channel = 'retail'` rows out; rows without a channel are B2B.
- [x] **R11 speed:** never more than 3 requests at once; a 429 (at the quote or the buy) drops to one at a time and retries that order after a wait (1.5 s, then 3, then 4.5), three times at most; a row put back after every worker finished is still bought (none left Waiting); a Re-rate that hits a 429 ends "busy", not Waiting.
- [x] **R13 maybe bought:** a `label_pending` buy, or one with no answer, is remembered on this device and shows in Bought after a reload even when the lookup fails; a retry that buys and records it clears the note; "Shippo shows none" (after a confirm) puts it back in the queue. Server: the claim is freed only on ERROR or a 4xx; SUCCESS without tracking and a 5xx keep it.
- [x] **R12 ship-to and guards:** the screen and the slip show the `ship_to` the server used; Shippo still working on a label (`label_pending`) gets no Try again; Open PDF makes a new PDF once the old one is freed; Buy waits for a list load; Reprint ignores a second tap.
- [x] **K7 server (retail):**
  - quotes (with `order_id`) and buys at the address Shopify has now, not the page's, and returns that `ship_to` (no street);
  - a P.O. box, a line over 35, or no street, city or ZIP there is a 409 `code: 'address'`; a missing order at quote time is 409 `not_listed`; nothing is rated;
  - a retail quote needs a signed-in user even with enforcement off;
  - `order_id` in any spelling ("8333", "08333") is stored and looked up as `gid://shopify/Order/8333`, so the label already bought is found;
  - a Shippo 429 (rate or buy) is a 429 and a rate 5xx a 502, never "No UPS Ground rate";
  - QUEUED keeps the claim (`label_pending`), ERROR frees it;
  - the cost row:
    - gets the validated box numbers and Shopify's order name;
    - is retried once after a network error or a 5xx (a 23505 on that retry counts as written);
    - carries `channel: 'retail'` (B2B rows send none);
    - without the column, is written without it only on PostgREST's PGRST204 for `'channel'`.
- [x] **S1–S7 slip and batch PDF:** label then slip per order in the order sent; labels only or slips only; refused before any fetch: a host other than `https://deliver.goshippo.com` (http, a port, credentials, another goshippo host), more than 30 orders, a bad slip (named), nothing to print, no sign-in; a label fetch follows no redirect, must be a PDF and at most 2 MB, is cut off by its own timer, and a failure names the order; emoji, accents, CJK and control characters never fail a slip; the name column steps 10/9/8.5/8 pt, drops the country (never at a comma inside the coffee name), then cuts with "..."; 12 rows a page, 11 with a note, then a second page; `cleanSlip` keeps known fields only, bounded.
- [x] **C1 migration:** checks itself before committing; existing rows read `b2b`; a staff insert can say `retail`; another value or null is refused; pending groups by order and channel; `ship_labels_for_order` returns it; anon and the green planner denied, a stranger sees nothing, still no SELECT; works after the void migration; refused twice and before login-rls; the rollback restores the old functions, keeps the rows, and the login-rls rollback can still run after it.
- [x] **P1 preview:** local page with sample data: the Buying screen mid-run and after, at 1180 and 768 wide (the table fits 724 of 724 px), and the queue's Bought group; no console errors.
- [x] **B4 sample (Andy):** a printed slip sample on the Rollo or AirPrint printer (`docs/retail_slip_sample_b3a.pdf`). Approved 2026-10-19, with the four spec readings in ADR 0028.
- [ ] **L live (Andy, with B3b):** apply `db/2026-10-19-label-channel.sql` and the void SQL; the 3-label test (one per carton): two taps buy and print; the PDF tab fills in while the portal tab is in the background on the iPad (Safari may slow a background tab); a reload shows them in Bought; void one.

**Run log:**
- 2026-10-19: R0–R11, K7, S1–S7 PASS, 188/188 (`npm test`); C1 PASS, 26/26 (`npm run test:db`). Adversarial review round 1 (Saboteur, Security Auditor, Architect) fixes in; every new test was run against the code with its fix removed and failed.
- 2026-10-19: review round 2 fixes in; R0–R12, K7, S1–S7 PASS, 201/201; C1 PASS, 26/26.
- 2026-10-19: review round 3 fixes in (text/plain body auth, junk storage entry, two escaping tests; maybe-bought orders remembered; claim freed only on ERROR or a 4xx); 204/204; 26/26.

### B3 (server) — retail label buying, and B6 — void (ADR [`0026`](./decisions/0026-retail-label-kind-and-void.md))
`tests/b3-retail-label.test.js`, fetch stubbed (nothing is bought or voided); `tests/db/label-void.test.js` on PGlite (`npm run test:db`). The B3 screen itself is Andy's design and has its own gates.
- [x] **K1 retail buys:** `kind: 'retail'` for #8333 with the server's own pack (`12x8x6@2`) passes the check and buys one UPS Ground label; the order is read through GraphQL (2025-10), never REST. Order kept: lookup → pack check → rate → claim → buy → cost row. #8331, #8289, #7388 and #8291 buy at Phase A's carton and pounds.
- [x] **K2 wrong pack:** lighter, another carton, another sig, two boxes, the B2B pack, or an order edited since it was listed → 409 `pack_changed`; nothing rated, claimed or bought.
- [x] **K3 not listed:** HOLD (HI, non-Torque vendor), EXCLUDE (company, pickup) and orders that changed since they were listed (cancelled, fulfilled by hand, refunded, partly shipped) → 409 `not_listed` with the class; nothing rated.
- [x] **K4 fail closed:** no such order 409; GraphQL errors, Shopify 500 or a failed token exchange 503; a non-order id 400 without calling Shopify; `kind` other than `b2b`/`retail` 400. An already-bought retail box is handed back, not rebought.
- [x] **K5 batch:** three labels make one token exchange and three order reads; a 401 drops the token and retries once; a token without `expires_in`, or one expiring within 5 minutes, is not kept.
- [x] **K6 B2B unchanged:** a request without `kind` is B2B (REST order, B2B packer); all B0/B2a tests pass unchanged.
- [x] **V1 void:** an unused label is refunded (`POST /refunds/ { transaction, async: false }`) and its row marked through `mark_ship_label_voided` with the caller's token. Order: row → Shopify → Shippo confirms → refund → mark.
- [x] **V2 staff only:** no token or a bad one → 401 even with `PORTAL_AUTH_ENFORCE` unset.
- [x] **V3 never a shipped order:** a fulfilled row, an order fulfilled or partly fulfilled in Shopify, or any fulfilled line → 409, no refund. A cancelled unfulfilled order voids.
- [x] **V4 fail closed:** no row or an already-voided row 404; the lookup or Shopify down 503; no such order 409; a row Shippo doesn't confirm 409; a bad body 400 with no call made. A refused refund (502) leaves the row; a refund whose row can't be marked returns `row_marked: false` and says so.
- [x] **V5 migration:** staff void one `purchased` row by order, box and Shippo id; the box's claim is freed; a wrong id, another box or a fulfilled row is never voided; anon and `green_planner_app` denied, a stranger changes nothing; still no SELECT on `shipping_labels`; fulfilling an order leaves its voided label voided; refused without `label_claims`; the rollback drops the function and column and keeps the rows.
- [ ] **V6 live (Andy, Phase B step 3):** a real test label is voided from the portal; Shippo shows the refund; the row reads `voided`.

**Run log:**
- 2026-10-19: K1–K6, V1–V4 PASS, 128/128 (`npm test`); V5 PASS, 21/21 (`npm run test:db`). Migration not applied; not deployed.

### B2 — retail packer (`packRetail`)
`tests/b2-retail-pack.test.js`, pure:
- [x] **P1 acceptance:** all 16 LIST orders in `acceptance_fixtures.json` get Phase A's carton and billed pounds.
- [x] **P2 fit table and oversize:** R2's 12x8x6 list, the 8x6x3 single, and every combination in A4's oversize table (5 x 12 oz → 5 lb … 3 x 2 lb + 5 lb → 13 lb, all 14x10x10); a 5 lb bag with a 12 oz is oversize; a size outside the table is oversize.
- [x] **P3 one carton:** 30 bags is one 14x10x10 at 24 lb; empty or unweighable orders pack to nothing.
- [x] **P4 list:** `?type=retail-ship` returns the parcel for LIST orders and null for HOLD.

**Run log:**
- 2026-10-19: P1–P4 PASS, 115/115 (`npm test`).
- 2026-10-19: deployed (f2b0f2f). Lib matches the commit; `retail-ship` 401 without a token.

### B1 UI — the Retail tab queue (ADR [`0027`](./decisions/0027-retail-queue-scope.md))
`tests/b1-retail-ui.test.js` (page functions loaded out of `index.html`, no browser) and the B1 UI block in `tests/b1-retail.test.js` (endpoint, fetch stubbed):
- [x] **U1 address pre-check:** `addressProblem` (shared with the label endpoint) flags P.O. boxes in every spelling B0 refuses (line 1 or 2, full-width letters) and street or city lines over 35 characters (by character; invisible characters dropped first); 35 passes; "Pobox Way" passes. The endpoint puts a LIST order with a bad address in `fix` and leaves its decision LIST; a HOLD order never gets a `fix`.
- [x] **U2 endpoint extras:** `note` (trimmed), `discount_codes` and `admin_url` (handle from `SHOPIFY_STORE_HANDLE`) come back for the NOTE chip, the REPLACEMENT reason and the hold list.
- [x] **U3 groups:** Needs a fix first, then one group per carton (8x6x3, 12x8x6, 14x10x10), Hold apart. An order with a fix, or one whose carton the table doesn't name, is never ready.
- [x] **U4 selection:** a fresh load ticks nothing and Buy is off; Select all takes the oldest ready orders up to 25 and says so; a 26th tick is refused with a message; a second Select all clears; fix, hold and unknown ids cannot be ticked. Billed lb is the sum of the server's declared pounds.
- [x] **U5 chips:** only REPLACEMENT (with the discount-code reason, or "reason not recorded"), NOTE, age (from 2 whole days, Andy 2026-10-19) and "No coffee set this week. Set it in Subscriptions". No SUBSCRIPTION, COLLECTIVE or free-shipping chips. The note text is shown, escaped.
- [x] **U6 lines, hold list, escaping:** every line shows qty, size and coffee (a 250 g box shows "250g" and xPods "8 xPods", not "12oz"); the hold list shows plain-language reasons (Shopify's own status for a partly fulfilled or on-hold order; "Over 30 × 12oz by weight") and an Open in Shopify button only when it is an https URL; order names and notes are escaped; the "not listed" counts show.
- [x] **U7 states:** loading, error (replaces the list), empty.
- [x] **U8 subscriptions:** one call to `applySubscriptionSubstitution` over every line; the helper keys are stripped after; the Subscriptions tab's "no coffee selected" alert is left as Bagging set it.
- [x] **U9 what the block calls** (was "read-only" until B3a): the tab is wired in and loading it only reads. Since B3a the Retail block names exactly `/api/shopify-token`, `/api/shippo-label` (rate and label only, never void) and `/api/ship-doc`; no `shopify-fulfill`; no table insert/update/upsert/delete; the only Supabase calls are the Schedule read and the two label lookups (`ship_labels_pending`, `ship_labels_for_order`). `RETAIL_BUY_ENABLED` is false.
- [x] **U10 preview:** local page with sample data built from the 30 fixtures, no console errors. Nothing ticked on load; Select all ticks the 14 ready orders; two address problems under Needs a fix, unticked and disabled; the 6 hold orders match #7482, #6889, #8293, #7297, #7248, #7349; indeterminate header with a partial selection; on a phone-width screen the table scrolls inside its box and the page doesn't.
- [x] **U12 touch and keyboard:** every Retail button and link is at least 44 px tall (`.rt-tap`), as is each tick box's cell; the grid's minimum width fits an iPad in portrait (768) with the Check column showing; the selection bar is sticky under the header from 700 px wide; a tick keeps keyboard focus on its box.
- [x] **U13 unpaid orders list:** pending, authorized and partly paid orders classify LIST like paid ones; refunded still doesn't ship (Shopify shows pending for about an hour after checkout).
- [x] **U14 fix-row link:** a Needs a fix row has Open in Shopify (https links only); a ready row has none.
- [ ] **U11 live (Andy):** deployed 2026-10-19 (a398837); live empty state confirmed by Andy (Shopify had only 2 open pickup orders; the tab showed no orders and "Not listed right now: 2 pickup"). Still to check with real orders:  open Retail on the iPad signed in: the real open orders list with coffees and cartons; the subscription lines show this week's coffee; Refresh works.

**Run log:**
- 2026-10-19: U1–U10 PASS, 127/127 (`npm test`).
- 2026-10-19: after the review fixes and Andy's four decisions: U13, U14 added; 133/133.
- 2026-10-19: adversarial review (code, UX, copy) fixes; U1–U10 and U12 PASS, 131/131 (`npm test`). Preview re-checked at 1180, 768 and 375 wide: at 768 the table fits (724 of 724 px) with chips showing, every control 44 px or more, the bar sticks under the header, focus stays on a ticked box.

### B1 — retail order list (`?type=retail-ship`)
`tests/b1-retail.test.js`, fetch stubbed:
- [x] **R1 acceptance:** the 30 orders in `tests/fixtures/retail-orders.json` (Shopify's own data for `docs/acceptance_fixtures.json`) list, hold or are excluded exactly as Phase A decided, with the same class.
- [x] **R2 contents:** listed orders carry Phase A's bags (xPods = 12 oz; title beats a 0 catalog weight); shipping charged matches; SUBSCRIPTION, REPLACEMENT and FREE_SHIPPING flags.
- [x] **R3 other holds:** partly fulfilled → HOLD; fulfilled → excluded; refunded, local delivery, no delivery method, non-US or missing address, more than 30 lines, an unweighable line, over 30 bag-equivalents (30 itself lists), nothing left to ship. A gift card line doesn't block.
- [x] **R4 endpoint:** signed-in staff only even before enforcement; pages are joined; a failed page fails the whole list (502).
- [x] **R5 live (read-only):** Shopify accepts the query; today's open orders classify as expected.
- [ ] **R6 deployed:** `?type=retail-ship` from a signed-in device returns the open retail orders.

**Run log:**
- 2026-10-19: R1–R5 PASS, 112/112 (`npm test`).
- 2026-10-19: deployed (af08ce7). Lib matches the commit; `retail-ship` 401 without a token; fixtures and `_retail` 404. R6 open.

### B2a — shared ship rules (ADR [`0025`](./decisions/0025-shared-ship-rules-server-repack.md))
One copy of the weight and packing rules in `lib/ship-rules.js`, loaded by the page and `require`d by the API. The label endpoint repacks the order from Shopify and buys only the parcel it packs itself. `tests/b0-ups.test.js` (B2a block) + `tests/syntax.test.js`, fetch stubbed:
- [x] **S1 one copy:** every name the page takes from `ShipRules` is exported by the lib and declared nowhere in `index.html`; `shopify-token.js` and `shippo-label.js` declare no rule. In a browser the file defines a frozen `ShipRules` global.
- [x] **S2 deployed:** every same-origin `<script src>` exists in the repo and is in the `.vercelignore` allowlist; `lib/*.js` passes `node --check`.
- [x] **S3 same items:** the order list (`?type=b2b-ship`) and the label check build items through the same `b2bShipItems()` (filler, other-vendor and fulfilled lines dropped; quantity is `fulfillable_quantity`) and pack through the same `packB2BItems()`.
- [x] **S4 refuse a mismatch:** a parcel 1 lb lighter or heavier, another carton, another box count, or an order edited since it was listed (a real Shopify edit: `quantity` 16, `fulfillable_quantity` 15) → 409 `pack_changed` for every box, not only the changed one; nothing claimed or bought. A page that sends no `pack_sig` is told to reload. The TCCDS-40 override applies on the server too. `boxParcel` returns null for an unreadable or tare-less carton.
- [x] **S4b page stops:** a `pack_changed` refusal stops the page's buy loop after that box.
- [x] **S5 fail closed:** a cancelled or missing order, an unweighable line, Shopify down or the token exchange failing → nothing bought (409 or 503). A malformed `order_id` never reaches Shopify.
- [x] **S6 no new waits:** rating and the "Already bought" path make no Shopify call.
- [x] **S7 page (preview):** the page served locally shows sign-in with no console errors; `packB2BItems === ShipRules.packB2BItems`; TCCDS-40 + 3 x 5 lb packs to `14x10x10@21,14x10x10@21,14x10x10@17`. With `/lib/ship-rules.js` missing, sign-in still shows and the only error is the 404.
- [x] **S9 lib is public:** no `process.env`, `require(` or secret names in `lib/` code.
- [ ] **S8 live (Andy):** the next B2B order rates and buys as before; the Vercel logs show no `checkPackedBox` warning.

**Run log:**
- 2026-10-19: S1–S7 PASS, 100/100 (`npm test`).
- 2026-10-19: one Architect review (Andy's call: one reviewer, one round). 11 findings: 0 Blocks ship, 6 Should fix, 5 Worth noting. Accepted fixes landed (JOURNAL). S1–S9 PASS, 104/104.
- 2026-10-19: deployed (f3a78d3, 01:32 UTC). Live: page loads the lib, lib matches the commit, hidden paths 404, label and `b2b-ship` 401 without a token. S8 open.

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
