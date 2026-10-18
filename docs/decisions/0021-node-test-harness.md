# 0021 — Tests run with `node --test`, loading code out of index.html

- **Status**: Accepted
- **Date**: 2026-10-17

## Context

Until now the gates in `TESTS.md` were checked by eye or by one-off node snippets that were not kept. Phase B needs repeatable tests: B2's `packRetail()` must pass all 30 acceptance fixtures, and every slice touches label buying, where a regression costs money. The app is one `index.html` with inline scripts and no module system or build step.

## Options considered

- **Keep ad hoc snippets.** Nothing to rerun later, so regressions go unseen.
- **Jest or Vitest.** A dependency and config for a repo whose only packages are `pdf-lib` and `node-fetch`.
- **`node --test`, with a helper that pulls named declarations out of index.html into a `vm` sandbox (chosen).** No dependency, and it tests the code that actually ships.
- **Move testable code into separate `.js` files loaded by index.html.** The cleaner end state. It is right for new shared rules, but too much churn for existing code.

## Decision

- Tests live in `tests/*.test.js` and run with `node --test "tests/*.test.js"` (Node 22 or newer; older versions don't expand the glob).
- `tests/helpers/index-html.js` finds top-level `function` and `const` declarations by name. It loads them into a sandbox with stand-ins for page state and browser APIs.
- The API functions are `require`d directly with `fetch` stubbed, so no live service is touched.
- `tests/syntax.test.js` is the global gate: every inline script parses, and every `api/*.js` passes `node --check`.

## Consequences

**Positive:** no install, and the tests exercise the code that ships. A declaration that can't be extracted fails loudly.
**Negative:**
- The extractor counts brackets without understanding strings or comments, and each test must list a function's dependencies by hand.
- Sandbox values come from another realm, so comparisons go through `structuredClone`.
- Module-level `let` state (`shipState`) must be passed in as a stand-in.

**When to revisit:** B2 adds shared shipping rules. Those go in a plain `.js` file that index.html loads with `<script src>` and the tests `require`. The extractor stays for existing index.html code only.
