# Runbook

Torque Roast Scheduler is a single static `index.html` PWA that talks directly to Supabase using the anon key embedded in the page. There is no build step.

## Run locally

```sh
cd "/Users/andynewbom/Developer/Torque-Projects/production app/CoffeePlanner"
python3 -m http.server 3007
# open http://localhost:3007/index.html
```

Any static file server works; the page fetches live data from Supabase on load, so no local backend is needed.

## Data sources (Supabase)

- `green_coffee_settings` — master coffee list. Name column is **`component_name`** (not `name`/`coffee_name`/`product_name`). Source of the Subscription dropdown options.
- `subscription_schedule` — one row per `week_start` (date, unique), with text columns `modernist`, `classicist`, `espressoist`, and `updated_at`. Stores the per-tier coffee selection; values are plain coffee names matching `green_coffee_settings.component_name`.
- `shipping_labels` — B2B Cubic Shipping cost capture (one row per label). RLS: anon **INSERT/UPDATE only**, no public read. Written server-side by the serverless functions at purchase; status flips `purchased`→`fulfilled`. Phase 3 P&L view reads from here.

## Serverless API (Vercel)

The `api/` functions run on Vercel and hold all secrets server-side (never in `index.html`). Required environment variables:

- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_STORE_HANDLE` — `api/shopify-token.js` (order/product pull) and `api/shopify-fulfill.js` (fulfillment write). The custom app must include `write_merchant_managed_fulfillment_orders` + `read_merchant_managed_fulfillment_orders` scopes for the fulfillment write to succeed.
- `SHIPPO_TOKEN` — `api/shippo-label.js` (B2B Cubic Shipping label purchase). Use the Shippo **test** token until the live cutover; swap to the live token only after Steps 1–5 pass and funding is confirmed.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — `api/shippo-label.js` (cost-row capture) and `api/shopify-fulfill.js` (status flip). Same public values as in `index.html`. **`SUPABASE_URL` must be the bare project URL with no `/rest/v1` suffix** (e.g. `https://gblkovtjylrfdotoktkb.supabase.co`) — both functions append `/rest/v1/shipping_labels` themselves, so a value that already includes `/rest/v1` doubles the path and 404s. If unset, cost-capture no-ops with a warning and the label still ships; if set wrong (doubled path), it fails the same way but less obviously — check Supabase API logs for a `/rest/v1/rest/v1/...` 404 if cost rows aren't landing.
- No env vars — `api/label-proxy.js` (same-origin proxy so iOS Safari can print label PNGs; see ADR [`0008`](./decisions/0008-same-origin-label-proxy.md)). Host-allowlisted to `*.goshippo.com` / shippo's `*.amazonaws.com` buckets; rejects any other `url` param with 400.

## Deploy

Committed to git and deployed on Vercel (static `index.html` + `api/` serverless functions). Set the env vars above in the Vercel project before the endpoints work.
