# 0022 — Deploy only the app: index.html, api/, package.json

- **Status**: Accepted
- **Date**: 2026-10-17

## Context

Vercel deploys the repo root as static files. On 2026-10-17, `production.torque.coffee/docs/RUNBOOK.md`, `/docs/JOURNAL.md` and `/db/...sql` all returned 200: every doc, ADR and migration was public.

The Phase A docs committed for Phase B are more sensitive than what was public before:
- shipping margin by order (`shipping_margin.md`)
- order numbers with ZIPs (`acceptance_fixtures.json`)
- the full catalog with SKUs (`retail_catalog.csv`)
- a written description of the `shipping_labels` write gap (`cost_report_spec.md` §3), sitting next to the anon key that is inline in `index.html`

## Options considered

- **Keep docs out of the repo.** Breaks the project's documentation discipline, and Phase B sessions read them from `docs/`.
- **`.vercelignore` denylist (`docs/`, `db/`, `tests/`).** Every new folder has to be remembered, and an add the list misses is published.
- **`.vercelignore` allowlist (chosen).** Ignore everything at the root except `api`, `index.html` and `package.json`.

## Decision

`.vercelignore` contains `/*`, `!api`, `!index.html`, `!package.json`, `!package-lock.json` and `!vercel.json` (the last two so a lockfile or project config added later is not silently dropped). Nothing else is uploaded to Vercel.

## Consequences

**Positive:** docs, migrations, tests and stray working files are never served. A new top-level file is private by default.
**Negative:**
- A new static asset the page needs (an icon, a manifest, a second page, a shared `lib/` script) must be added to the allowlist, or it 404s in production.
- Docs links that may have been shared publicly stop working.
- Only new deployments are affected. Every earlier deployment keeps serving `docs/` and `db/` at its own `*.vercel.app` URL, unless Vercel Deployment Protection covers those URLs (Andy to check; the Vercel connector can't see this project).
- `package.json` itself is public (dependency versions only).
- The allowlist must reach production before the Phase A docs do, and must never be rolled back: reverting it, or a Vercel Instant Rollback to an earlier deployment, publishes `docs/` and `db/` again. The push order is in TESTS.md G7.
**When to revisit:** the app gains static assets or a build step.
