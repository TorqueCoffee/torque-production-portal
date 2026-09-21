# Runbook

Torque Roast Scheduler is a single static `index.html` PWA that talks directly to Supabase using the anon key embedded in the page. There is no build step.

## Run locally

```sh
cd "/Users/andynewbom/Developer/Torque-Projects/torque-production-portal"
python3 -m http.server 3007
# open http://localhost:3007/index.html
```

Any static file server works; the page fetches live data from Supabase on load, so no local backend is needed.

## Data sources (Supabase)

Project **`torque-roast-scheduler`**, ref `gblkovtjylrfdotoktkb` (us-west-1) — named for the app's original identity, not renamed alongside the repo. The URL and anon key are inline in `index.html`; the service-role key lives only in the Vercel env vars.


- `green_coffee_settings` — master coffee list. Name column is **`component_name`** (not `name`/`coffee_name`/`product_name`). Source of the Subscription dropdown options.
  - Per-roaster batch settings. **`batch_size_lbs` / `shrinkage_pct` are the Primo values** — they predate the second roaster and were never renamed. `probat_batch_lbs` (nullable — null means "not measured yet", and the UI prompts instead of calculating), `probat_shrink_pct` (default 15) and `roast_machine` (`primo`|`probat`, default `primo`) were added for the Probat. Apply [`db/2026-08-27-probat-machine.sql`](../db/2026-08-27-probat-machine.sql) to recreate them (ADR [`0012`](./decisions/0012-two-roasters-primo-probat.md)).
  - Roasting math is `green = roasted / (1 - shrink/100)` using the selected machine's shrink and batch size. There is no global shrink constant any more.
- `plan_state` — one row per `(team_id, plan_date)`. `finalized_at` null = the day is open and pulls still move the numbers; set = the plan is frozen and lines created after that timestamp are treated as late.
- `activity_log` — append-only history for the Activity drawer. `undo` jsonb holds `{table,id,column,prev}` for reversible events (counter changes only). Anon has read/insert/update but **no delete policy**, so history cannot be erased.
- `roasting_progress` — per coffee per `plan_date`. `locked_roasted_lbs` null = tracking live demand; set = the roasted-lbs figure this coffee was frozen at.
- `daily_plan.created_at` — when a line first appeared, compared against `plan_state.finalized_at` to flag late orders. `updated_at` cannot be used for this: it moves on every bagged increment.
  - Both come from [`db/2026-08-27-phase2-plan-state.sql`](../db/2026-08-27-phase2-plan-state.sql) (ADR [`0013`](./decisions/0013-plan-finalization-and-activity-log.md)).
- `subscription_schedule` — one row per `week_start` (date, unique), with text columns `modernist`, `classicist`, `espressoist`, and `updated_at`. Stores the per-tier coffee selection; values are plain coffee names matching `green_coffee_settings.component_name`.
- `shipping_labels` — B2B Cubic Shipping cost capture (one row per label). RLS: anon **INSERT/UPDATE only**, no public read. Written server-side by the serverless functions at purchase; status flips `purchased`→`fulfilled`. Phase 3 P&L view reads from here.
  - Three `SECURITY DEFINER` functions sit on top of it — `ship_labels_for_order(text)`, `ship_labels_pending()`, `mark_ship_labels_fulfilled(text)` (execute granted to `anon`). They are how the app resumes an in-flight shipment and how the fulfill endpoint flips status, **without** a public SELECT policy that would expose cost (ADR [`0004`](./decisions/0004-cost-table-security-model.md), [`0011`](./decisions/0011-recoverable-in-flight-shipments.md)). Apply [`db/2026-07-25-ship-label-recovery.sql`](../db/2026-07-25-ship-label-recovery.sql) to recreate them (also adds the `tracking_url` / `label_url` columns).
  - A plain PostgREST `PATCH` **cannot** update this table: `UPDATE … WHERE` has to read the rows it matches, and with no SELECT policy the WHERE matches nothing while PostgREST still returns `204` (`Content-Range: */0`). Use the RPC, not a PATCH.

## Serverless API (Vercel)

The `api/` functions run on Vercel and hold all secrets server-side (never in `index.html`). Required environment variables:

- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_HANDLE` — `api/shopify-token.js` (order/product pull) and `api/shopify-fulfill.js` (fulfillment write). The custom app must include `write_merchant_managed_fulfillment_orders` + `read_merchant_managed_fulfillment_orders` scopes for the fulfillment write to succeed.
- `SHIPPO_TOKEN` — `api/shippo-label.js` (B2B Cubic Shipping label purchase). Use the Shippo **test** token until the live cutover; swap to the live token only after Steps 1–5 pass and funding is confirmed. The Shippo account must have **both** USPS and a **UPS** carrier account enabled: accounts listed in `UPS_COMPANIES` (`index.html`, currently Best Coffee) buy `ups_ground` — see ADR [`0018`](./decisions/0018-per-customer-carrier-routing.md).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — `api/shippo-label.js` (cost-row capture) and `api/shopify-fulfill.js` (status flip). Same public values as in `index.html`. **`SUPABASE_URL` must be the bare project URL with no `/rest/v1` suffix** (e.g. `https://gblkovtjylrfdotoktkb.supabase.co`) — both functions append `/rest/v1/shipping_labels` themselves, so a value that already includes `/rest/v1` doubles the path and 404s. If unset, cost-capture no-ops with a warning and the label still ships; if set wrong (doubled path), it fails the same way but less obviously — check Supabase API logs for a `/rest/v1/rest/v1/...` 404 if cost rows aren't landing.
- No env vars — `api/ship-doc.js` (builds the combined 4x6 label+slip PDF that iOS Safari opens to print; see ADR [`0009`](./decisions/0009-native-pdf-print-path.md)). Depends on the `pdf-lib` npm package (declared in `package.json`; Vercel installs it at build time — no manual step). `label_url` inputs are host-allowlisted to `*.goshippo.com` / Shippo's `*.amazonaws.com` buckets; rejects any other host with 400.

## Deploy

Push to `main` on [`TorqueCoffee/torque-production-portal`](https://github.com/TorqueCoffee/torque-production-portal). Vercel builds from that branch automatically — static `index.html` plus the `api/` serverless functions. Set the env vars above in the Vercel project before the endpoints work.

- **Vercel project:** [`torquecoffees-projects/torque-production-portal`](https://vercel.com/torquecoffees-projects/torque-production-portal/deployments)
- **Supabase project:** `torque-roast-scheduler` (`gblkovtjylrfdotoktkb`)

The three names do not match, which has cost time more than once: the repo is `torque-production-portal`, the Vercel project matches it, and the Supabase project still carries the app's original `torque-roast-scheduler` name. There is also a separate `torque-green-planner` Vercel project — a different app. Check the URL before concluding a deploy did not happen.

**Schema changes ship separately.** Migrations in `db/` are applied by hand in the Supabase SQL editor; nothing runs them on deploy. Apply the migration *before* pushing code that writes to the new columns.
