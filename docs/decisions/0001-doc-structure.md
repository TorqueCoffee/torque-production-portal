# 0001 — Adopt JOURNAL + RUNBOOK + ADR documentation structure

- **Status**: Accepted
- **Date**: 2026-06-11

## Context

The project had no `docs/` directory. The codebase is a single ~78KB `index.html` PWA with non-obvious coupling (globals populated as tab side effects, exact Supabase column names like `component_name`). That kind of context rotates out of head fast and is expensive to re-derive from the code.

## Options considered

- **No docs, rely on git history** — zero overhead, but loses the *why* and the things that aren't visible in a diff.
- **A single freeform README** — low ceremony, but mixes narrative, setup, and rationale into something that decays.
- **Three-part structure (JOURNAL + RUNBOOK + ADRs)** — clear separation of concerns; small per-change cost.

## Decision

Adopt the three-document structure: chronological `JOURNAL.md`, an idempotent `RUNBOOK.md`, and numbered ADRs under `decisions/`, indexed by `README.md`.

## Consequences

**Positive:** future readers know where to look; decisions and gotchas survive.
**Negative:** small upkeep cost per meaningful change.
**When to revisit:** if the project is retired or folds into a larger documented codebase.
