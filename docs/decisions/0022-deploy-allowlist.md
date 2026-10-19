# 0022 — Deploy only the app: index.html, api/, package.json

- **Status**: Accepted (amended 2026-10-19: `lib/` added for B2a)
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
- Only new deployments are affected. Earlier deployments still contain `docs/` and `db/` at their own `*.vercel.app` URLs. Checked 2026-10-18: those URLs redirect to Vercel's SSO login (Standard Deployment Protection), so they are not public. That holds only while Deployment Protection stays on.
- `package.json` itself is public (dependency versions only).
- The allowlist must reach production before the Phase A docs do, and must never be rolled back: reverting it, or a Vercel Instant Rollback to an earlier deployment, publishes `docs/` and `db/` again. The push order is in TESTS.md G7.
**When to revisit:** the app gains static assets or a build step.

## Amendment, 2026-10-19: `lib/`

B2a moved the shipping rules into `lib/ship-rules.js`, which the page loads as `<script src="/lib/ship-rules.js">` and the API `require`s. `!lib` is added to `.vercelignore`. If it were missing, the file would 404 and the page's script would stop at its first line, sign-in included. `tests/syntax.test.js` now checks that every same-origin `<script src>` in `index.html` exists in the repo and is allowed by `.vercelignore`. `lib/` holds only code that is safe to publish: everything in it is served to every visitor.

