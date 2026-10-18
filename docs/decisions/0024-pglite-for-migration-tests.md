# 0024 — Migrations are tested on PGlite, outside `npm test`

- **Status**: Accepted
- **Date**: 2026-10-18

## Context

The login slice changes all 36 RLS policies, function grants, default privileges and the realtime publication in one hand-applied migration. A mistake either locks the shop out or leaves the data open. Migrations in `db/` had never been run anywhere before Andy pasted them into the production SQL editor. There is no local Postgres or Docker on the Mac, and ADR 0021 kept `npm test` free of dependencies.

## Options considered

- **Review by eye and run in production.** What happened until now; the first run is the real one.
- **A Supabase branch or a second project.** Faithful, but it costs money and needs setup each time.
- **Homebrew `postgresql@17`.** Real Postgres, but a system install, a server to start, and a recipe outside the repo.
- **PGlite (Postgres compiled to WebAssembly) as a dev dependency (chosen).** `npm install` and it runs inside `node --test`. It supports roles, `SET ROLE`, RLS, `ALTER DEFAULT PRIVILEGES` and publications. It is Postgres 18; live is Supabase's Postgres.

## Decision

- `@electric-sql/pglite` is pinned exactly (0.5.8) as a devDependency. `.npmrc` sets `package-lock=false`, because a lockfile would be deployed (ADR 0022) and would pin `pdf-lib` as a side effect.
- Migration tests live in `tests/db/` and run with `npm run test:db`. `npm test` stays as it was, no install (ADR 0021).
- Each test loads `tests/db/live-schema-<date>.sql`, a hand-built copy of the live access state: tables, keys, grants, policies, functions, default privileges and publication, read from the live catalog. The tests then compare who can do what before and after, cell by cell.

## Consequences

**Positive:** a migration and its rollback run end to end before they reach production; preconditions are tested by breaking them. It has already caught two errors: publishing a table without a primary key, and a default-privilege revoke that couldn't work.
**Negative:**
- The fixture is a copy, not the database. Drift in live policies, PostgREST, Realtime and Supabase's own roles aren't modelled, so the live checks after each migration remain the real proof.
- Vercel installs the dev dependency on every deploy (no lockfile), adding a few seconds.
- Node 22+ and an `npm install` are needed for this suite.

**When to revisit:** the fixture drifts from live often enough to mislead, or migrations become frequent enough to justify a Supabase branch per migration.
