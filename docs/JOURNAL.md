# Journal

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
