# Runbook

Torque Roast Scheduler is a single static `index.html` PWA that talks directly to Supabase using the anon key embedded in the page. There is no build step.

## Run locally

```sh
cd /Users/andynewbom/CoffeePlannerRepo
python3 -m http.server 3007
# open http://localhost:3007/index.html
```

Any static file server works; the page fetches live data from Supabase on load, so no local backend is needed.

## Data sources (Supabase)

- `green_coffee_settings` — master coffee list. Name column is **`component_name`** (not `name`/`coffee_name`/`product_name`). Source of the Subscription dropdown options.
- `subscription_schedule` — one row per `week_start` (date, unique), with text columns `modernist`, `classicist`, `espressoist`, and `updated_at`. Stores the per-tier coffee selection; values are plain coffee names matching `green_coffee_settings.component_name`.

## Deploy

Committed to the `CoffeePlannerRepo` git repo and served as a static page (see git history for the hosting target).
