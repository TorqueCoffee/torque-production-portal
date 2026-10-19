# Runbook

Torque Roast Scheduler is a single static `index.html` PWA that talks directly to Supabase. The publishable (anon) key in the page only identifies the project: data and the `/api` functions open to users signed in with Supabase Auth (ADR [`0023`](./decisions/0023-supabase-auth-logins.md)). There is no build step.

## Run locally

```sh
cd "/Users/andynewbom/Developer/Torque-Projects/torque-production-portal"
python3 -m http.server 3007
# open http://localhost:3007/index.html
```

Any static file server works. The page shows the sign-in screen; after signing in it reads live data from Supabase, so no local backend is needed. The `/api` functions don't run under a static server.

## Tests

```sh
cd "/Users/andynewbom/Developer/Torque-Projects/torque-production-portal"
node --test "tests/*.test.js"
```

Node 22 or newer (older versions don't expand the quoted glob), no install. The tests stub `fetch`, so they touch no live service. `tests/helpers/index-html.js` loads named functions out of `index.html` so its pure code can be tested without a browser.

Database migrations are tested separately against PGlite (Postgres in WebAssembly, a dev dependency), loaded with a copy of the live access state from `tests/db/`:

```sh
npm install
npm run test:db
```

Run it before handing Andy any migration in `db/`. `.npmrc` (`package-lock=false`) keeps a lockfile out of the repo: one would be deployed (ADR 0022) and pin `pdf-lib`. See ADR [`0024`](./decisions/0024-pglite-for-migration-tests.md).

## Data sources (Supabase)

Project **`torque-roast-scheduler`**, ref `gblkovtjylrfdotoktkb` (us-west-1) — named for the app's original identity, not renamed alongside the repo. The URL and anon key are inline in `index.html`; the service-role key lives only in the Vercel env vars.


**Access (after the login slice's step 3b, [`db/2026-10-18-login-rls.sql`](../db/2026-10-18-login-rls.sql), ADR [`0023`](./decisions/0023-supabase-auth-logins.md)):** every policy on the 10 public tables is `to authenticated`; anon reads `[]` and every write is refused. `green_planner_app` (the separate green planner) reads `blend_matrix` and `green_coffee_settings` through its own SELECT policies. A new table needs its policies written `to authenticated`; a new function needs `revoke execute … from public, anon` (Postgres gives PUBLIC EXECUTE by default). Realtime: `daily_plan`, `roasting_progress`, `plan_state` and `activity_log` are in the `supabase_realtime` publication; Realtime applies the same policies with each subscriber's token.

- `green_coffee_settings` — master coffee list. Name column is **`component_name`** (not `name`/`coffee_name`/`product_name`). Source of the Subscription dropdown options.
  - Per-roaster batch settings. **`batch_size_lbs` / `shrinkage_pct` are the Primo values** — they predate the second roaster and were never renamed. `probat_batch_lbs` (nullable — null means "not measured yet", and the UI prompts instead of calculating), `probat_shrink_pct` (default 15) and `roast_machine` (`primo`|`probat`, default `primo`) were added for the Probat. Apply [`db/2026-08-27-probat-machine.sql`](../db/2026-08-27-probat-machine.sql) to recreate them (ADR [`0012`](./decisions/0012-two-roasters-primo-probat.md)).
  - Roasting math is `green = roasted / (1 - shrink/100)` using the selected machine's shrink and batch size. There is no global shrink constant any more.
- `plan_state` — one row per `(team_id, plan_date)`. `finalized_at` null = the day is open and pulls still move the numbers; set = the plan is frozen and lines created after that timestamp are treated as late.
- `activity_log` — append-only history for the Activity drawer. `undo` jsonb holds `{table,id,column,prev}` for reversible events (counter changes only). Signed-in users have read/insert/update but **no delete policy**, so history cannot be erased.
- `roasting_progress` — per coffee per `plan_date`. `locked_roasted_lbs` null = tracking live demand; set = the roasted-lbs figure this coffee was frozen at.
- `daily_plan.created_at` — when a line first appeared, compared against `plan_state.finalized_at` to flag late orders. `updated_at` cannot be used for this: it moves on every bagged increment.
  - Both come from [`db/2026-08-27-phase2-plan-state.sql`](../db/2026-08-27-phase2-plan-state.sql) (ADR [`0013`](./decisions/0013-plan-finalization-and-activity-log.md)).
- `subscription_schedule` — one row per `week_start` (date, unique), with text columns `modernist`, `classicist`, `espressoist`, and `updated_at`. Stores the per-tier coffee selection; values are plain coffee names matching `green_coffee_settings.component_name`.
- `shipping_labels` — B2B Cubic Shipping cost capture (one row per label). RLS: `authenticated` **INSERT/UPDATE only**, no read. Written server-side by the serverless functions at purchase, as the signed-in user; status flips `purchased`→`fulfilled`. Phase 3 P&L view reads from here.
  - Three `SECURITY DEFINER` functions sit on top of it — `ship_labels_for_order(text)`, `ship_labels_pending()`, `mark_ship_labels_fulfilled(text)` (execute granted to `authenticated` only). They are how the app resumes an in-flight shipment and how the fulfill endpoint flips status, **without** a public SELECT policy that would expose cost (ADR [`0004`](./decisions/0004-cost-table-security-model.md), [`0011`](./decisions/0011-recoverable-in-flight-shipments.md)). Apply [`db/2026-07-25-ship-label-recovery.sql`](../db/2026-07-25-ship-label-recovery.sql) to recreate them (also adds the `tracking_url` / `label_url` columns).
  - Voiding (B6, ADR [`0026`](./decisions/0026-retail-label-kind-and-void.md)): `mark_ship_label_voided(order, box, shippo id)` flips one `purchased` row to `voided` (with `voided_at`) and frees the box's claim; `mark_ship_labels_fulfilled` skips voided rows. Apply [`db/2026-10-19-label-void.sql`](../db/2026-10-19-label-void.sql) to recreate them (needs `label_claims`). *Undo:* `…-label-void-rollback.sql`.
  - A plain PostgREST `PATCH` **cannot** update this table: `UPDATE … WHERE` has to read the rows it matches, and with no SELECT policy the WHERE matches nothing while PostgREST still returns `204` (`Content-Range: */0`). Use the RPC, not a PATCH.

## Serverless API (Vercel)

The `api/` functions run on Vercel and hold all secrets server-side (never in `index.html`). Required environment variables:

- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_HANDLE` — `api/shopify-token.js` (order/product pull; `?type=retail-ship` also needs the app's `read_orders` access to fulfillment orders and products, which the B2B list already uses) and `api/shopify-fulfill.js` (fulfillment write). The custom app must include `write_merchant_managed_fulfillment_orders` + `read_merchant_managed_fulfillment_orders` scopes for the fulfillment write to succeed.
- `SHIPPO_TOKEN` — `api/shippo-label.js` (label purchase). The **live** Shippo token. Every order buys UPS Ground (`ups_ground`) on the Shippo UPS account `21db4cf80df74a2cb27fc20948862003`, which is pinned in the code (`UPS_ACCOUNT` in `api/shippo-label.js`). On a different Shippo login every rate returns 422 "No UPS Ground rate" until that constant is changed to the new login's US UPS account (Shippo API `GET /carrier_accounts?carrier=ups`, the one with `metadata: "US"`). See ADR [`0020`](./decisions/0020-all-orders-ups-ground.md).
- `PORTAL_AUTH_ENFORCE` — `1` makes every function refuse a request without a valid staff token: 401 with no token or a bad one, 403 for an account without the `portal_staff` marker, 503 when Supabase Auth can't be reached. Unset, the request goes through and `auth:<reason> … ua="…"` is logged (Vercel → Logs). Label buying, fulfillment, `ship-doc` and the B2B lists (`?type=b2b`, `b2b-ship`) are enforced whatever it says; only rating, products and the order list wait for it. Only the exact value `1` enforces. Changing it needs a redeploy.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — the token check in `api/_auth.js` (every function; while enforcing, a missing value means 503), `api/shippo-label.js` (cost-row capture, one-label-per-box lookup) and `api/shopify-fulfill.js` (status flip). Those Supabase calls run with the caller's token. Same public values as in `index.html`. **`SUPABASE_URL` must be the bare project URL with no `/rest/v1` suffix** (e.g. `https://gblkovtjylrfdotoktkb.supabase.co`). The code appends `/auth/v1/user` and `/rest/v1/…` itself, so a doubled path 404s.
  - Unset or wrong: the sign-in check fails, so every function answers 503 (label buying, fulfillment, printing and the B2B lists at once; the rest once `PORTAL_AUTH_ENFORCE=1`).
  - Label buying also needs the one-label lookup and the box claim, so it buys nothing (503) until this is fixed.
  - A failed cost-row insert still never blocks a label that was bought: the response carries `cost_logged: false` and the box shows "cost not logged".
- `api/ship-doc.js` needs only the `SUPABASE_*` pair for the sign-in check (builds the combined 4x6 label+slip PDF that iOS Safari opens to print; see ADR [`0009`](./decisions/0009-native-pdf-print-path.md)). Depends on the `pdf-lib` npm package (declared in `package.json`; Vercel installs it at build time — no manual step). `label_url` must be on `goshippo.com` (every stored label is on `deliver.goshippo.com`); any other host gets 400.

## Sign-in and accounts (Supabase Auth)

Email + password; five accounts (four people, one shared floor-iPad account), all with the same rights (ADR [`0023`](./decisions/0023-supabase-auth-logins.md)). Dashboard settings, project `gblkovtjylrfdotoktkb`:

- Authentication → Sign In / Providers → Email: enabled. **Allow new users to sign up: off.** Minimum password length: 12. Leaked password protection: on (Pro plan).
- **Anonymous sign-ins: off.** Every other provider (Google, Apple, phone…): off. Anyone who can get an account in this project gets into the portal.
- Accounts: Authentication → Users → Add user → Create new user, with **Auto Confirm User** ticked. No email is sent.
- Check: `select email, last_sign_in_at, is_anonymous from auth.users order by email;` in the SQL editor.

Password reset: the dashboard's password-recovery option sends an email, which needs a production mailer (custom SMTP) this project doesn't have. Instead, delete the user and create it again with a new password, or set one with the Admin API (`auth.admin.updateUserById(id, { password })`, service-role key, never in the page). There is no self-service reset. Deleting a user stops `/api` at once, but the database accepts their last access token until it expires (1 hour by default).

Sign out (header button) ends the session on that device only.

### First rollout (in this order)

Each step can be undone on its own; the undo is under each one.

0. **Before the code deploys:**
   - Run [`db/2026-10-18-login-prep.sql`](../db/2026-10-18-login-prep.sql) in the SQL editor. It lets signed-in devices use `activity_log` and `plan_state`, which are `to anon` only; without it, Finalize and the activity log fail silently once devices sign in. *Undo:* `…-login-prep-rollback.sql`, only together with reverting the code.
   - Run [`db/2026-10-18-label-claims.sql`](../db/2026-10-18-label-claims.sql): one buyer per box. The new code refuses to buy a label without it. *Undo:* `…-label-claims-rollback.sql`, after reverting the code.
   - Set the dashboard settings above and create the 5 accounts.
   - **Mark them as portal staff** before anyone signs in. The marker is copied into each sign-in token, and label buying, fulfillment, printing and the B2B lists need it from the first deploy:
     ```sql
     update auth.users
        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"portal_staff": true}'
      where email in ('<person 1>', '<person 2>', '<person 3>', '<person 4>', '<floor iPad account>');
     ```
     Check with `select email, raw_app_meta_data ->> 'portal_staff' from auth.users;`. An account marked after it signed in picks up the marker at its next token refresh (within an hour), or at once after signing out and in.
   - The new page shows only a sign-in screen, so all of this must be in place before it reaches any device.
1. **Deploy the login code** (push `main`, Andy's go). `PORTAL_AUTH_ENFORCE` stays unset. Sign in on every device as it reloads; close any portal tab that was left open.
   - *Undo:* `git revert` the login commit and push. The prep and claims SQL can stay; the old page ignores them. The old TT gate comes back on every device, because the new page deleted its cookie.
2. **Observe for a working day:**
   - Vercel → Logs: no `auth:` lines. `ua="…"` shows which device sent one.
   - Supabase → Logs → API: no `/rest/v1/` requests made with the anon role. These come from an old open tab, which will stop saving after step 3b.
   - Every account appears in the `auth.users` check with a `last_sign_in_at`.
   - 2b. Once no old tab is left, run [`db/2026-10-18-realtime-publication.sql`](../db/2026-10-18-realtime-publication.sql), so changes on one device show on the others. Not earlier: an old page reloads on every row event, and its counters can overwrite each other. Then the L6 checks in [`TESTS.md`](./TESTS.md). *Undo:* `…-realtime-publication-rollback.sql`.
3. **Shut the doors:**
   - 3a. Set `PORTAL_AUTH_ENFORCE` and redeploy (Vercel docs, checked 2026-10-19):
     - Vercel dashboard → project `torque-production-portal` → **Environment Variables** in the sidebar. Add New: Name `PORTAL_AUTH_ENFORCE`, Value `1` (exactly `1`), environment **Production** only. Save.
     - The variable reaches only new deployments. **Deployments** in the sidebar → the current production deployment → ⋯ → **Redeploy** → Redeploy.
     - Check: `/api/shopify-token?type=products` without a token returns 401.
     - *Undo:* in Environment Variables, ⋯ next to `PORTAL_AUTH_ENFORCE` → Delete, then redeploy the same way.
   - **Backup before 3b.** The free plan has no daily backups. This follows Supabase's CLI recipe (docs checked 2026-10-19, Backup and Restore using the CLI), without Docker: `supabase db dump` normally runs `pg_dump` in a Docker container, and `--dry-run` prints the same script (Supabase's flags and filters), which runs on a local `pg_dump` instead.
     - Install once: the Supabase CLI (`brew install supabase/tap/supabase`) and `brew install postgresql@17` (the database is Postgres 17; `pg_dump` must be 17 or newer).
     - Connection string: Supabase dashboard → **Connect** → Session pooler. Put the database password in place of `[YOUR-PASSWORD]`. If it's lost, reset it under Database → Settings; the portal and its functions don't use it.
     - The printed script holds the password, so it is piped straight into `bash` and never saved. The files go outside the repo (they hold `auth.users` and every table):
       ```bash
       export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
       mkdir -p ~/Backups/torque-portal/$(date +%F) && cd ~/Backups/torque-portal/$(date +%F)
       read -s DB_URL   # paste the connection string, then Return
       supabase db dump --db-url "$DB_URL" --dry-run --role-only 2>/dev/null | bash > roles.sql
       supabase db dump --db-url "$DB_URL" --dry-run 2>/dev/null | bash > schema.sql
       supabase db dump --db-url "$DB_URL" --dry-run --data-only --use-copy -x "storage.buckets_vectors" -x "storage.vector_indexes" 2>/dev/null | bash > data.sql
       ```
     - Check: three non-empty files; `grep -cE '^COPY "?public' data.sql` counts one COPY per public table (11 since step 0 added `label_claims`).
     - Restoring goes into a new project with `psql` (same docs page). Undoing 3b itself is the rollback SQL below, not this backup.
   - 3b. SQL editor: run [`db/2026-10-18-login-rls.sql`](../db/2026-10-18-login-rls.sql). It refuses to run if any account has never signed in or lacks the staff marker, an anonymous user exists, login-prep is missing, or the policies aren't the 36 it was written against. *Undo:* [`…-login-rls-rollback.sql`](../db/2026-10-18-login-rls-rollback.sql), which returns to the step 0 state, so the login code keeps working.
   - Then the L5 checks in [`TESTS.md`](./TESTS.md).

After 3b, every new table in `public` needs its policies written `to authenticated`, and every new function `revoke execute on function … from public, anon` plus `grant execute … to authenticated`. Postgres gives PUBLIC EXECUTE on new functions by default, and anon is part of PUBLIC.

## Deploy

Push to `main` on [`TorqueCoffee/torque-production-portal`](https://github.com/TorqueCoffee/torque-production-portal). Vercel builds from that branch automatically — static `index.html` plus the `api/` serverless functions. Set the env vars above in the Vercel project before the endpoints work.

`.vercelignore` is an allowlist: only `index.html`, `api/`, `lib/`, `package.json` (and a `package-lock.json` or `vercel.json` if one is added) are deployed, so `docs/`, `db/` and `tests/` are never served (ADR [`0022`](./decisions/0022-deploy-allowlist.md)). A new static file the page needs must be added to it; `tests/syntax.test.js` fails if a same-origin `<script src>` is missing from it. Everything in `lib/` is public.

The shipping rules (weight per item, which lines ship, the packer, the declared weight) live once, in `lib/ship-rules.js`: the page loads it with `<script src>` and the API `require`s it. The label endpoint repacks every order from Shopify with it and refuses a parcel that doesn't match (ADR [`0025`](./decisions/0025-shared-ship-rules-server-repack.md)). Change a rule there, never in `index.html`.

To look at the page locally: `python3 -m http.server 8765 --bind 127.0.0.1` in the repo root, then open `http://127.0.0.1:8765`. It shows the sign-in screen; the `/api` calls need Vercel.

Run `npm test` before every push.

**Rolling back the login code:**
1. If step 3b is in, run `db/2026-10-18-login-rls-rollback.sql` first. After the access migration the old page (anon key) can read nothing.
2. If step 2b is in, run `db/2026-10-18-realtime-publication-rollback.sql`. The old page reloads on every row event.
3. Revert the code and push.
4. Optionally run `…-label-claims-rollback.sql` and `…-login-prep-rollback.sql`. A Vercel Instant Rollback to a deployment from before the login slice has the same problem.

**Upgrading supabase-js:** pick a 2.x version at least two weeks old, then update the URL and the `integrity` hash in `index.html`: `curl -sL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<v>/dist/umd/supabase.js | openssl dgst -sha384 -binary | openssl base64 -A`. A wrong hash blocks the script and the page stays on the sign-in screen.

**Rolling back B0:** `git revert` the B0 code commits and push. Never revert the `.vercelignore` commit, and don't use Vercel Instant Rollback to a deployment from before it: both publish `docs/` and `db/` again (ADR 0022). Open portal tabs need no reload.

- **Vercel project:** [`torquecoffees-projects/torque-production-portal`](https://vercel.com/torquecoffees-projects/torque-production-portal/deployments)
- **Supabase project:** `torque-roast-scheduler` (`gblkovtjylrfdotoktkb`)

The three names do not match, which has cost time more than once: the repo is `torque-production-portal`, the Vercel project matches it, and the Supabase project still carries the app's original `torque-roast-scheduler` name. There is also a separate `torque-green-planner` Vercel project — a different app. Check the URL before concluding a deploy did not happen.

**Retail labels and void (B3 server, B6), in this order:**
1. `npm test` and `npm run test:db` pass.
2. Supabase SQL editor: run [`db/2026-10-19-label-void.sql`](../db/2026-10-19-label-void.sql). Check: `select to_regprocedure('public.mark_ship_label_voided(text, integer, text)');` is not null.
3. Push. Nothing changes for B2B pages (no `kind` = B2B). A retail label needs a page that sends `kind: 'retail'` (the B3 screen).
4. Void from a terminal until the B3 screen has a button (signed-in token from the page: devtools → `(await sb.auth.getSession()).data.session.access_token`):
   ```bash
   curl -s -X POST "https://torque-production-portal.vercel.app/api/shippo-label?action=void" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"order_id":"gid://shopify/Order/<id>","box_index":1}'
   ```
   `voided: true, row_marked: true` = done. `row_marked: false` = refunded in Shippo but the row still says purchased: run `update public.shipping_labels set status = 'voided', voided_at = now() where shippo_object_id = '<id>';` in the SQL editor before the box is rebought. A fulfilled order is refused: void it in the Shippo dashboard only if the box really never shipped.

**Schema changes ship separately.** Migrations in `db/` are applied by hand in the Supabase SQL editor; nothing runs them on deploy. Apply the migration *before* pushing code that writes to the new columns.
