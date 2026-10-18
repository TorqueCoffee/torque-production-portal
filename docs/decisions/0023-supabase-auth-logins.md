# 0023 — Supabase Auth logins; the database and /api open only to signed-in users

- **Status**: Accepted
- **Date**: 2026-10-18

## Context

Until now the portal's only gate was a client-side password ("TT") that set a cookie. Everything behind it ran on the publishable key, which is inline in `index.html`, so anyone who read the page source could:
- read and write every public table (all 36 RLS policies were `to public` or `to anon`);
- run the three SECURITY DEFINER recovery functions (ADR 0011), which return tracking numbers and label URLs;
- call the four `/api` functions, which had no auth and CORS `*`. They buy live UPS labels, fulfill Shopify orders (the customer gets an email), and return B2B names and addresses.

Five accounts are needed: four people and one shared "floor iPad" account, on six devices (1 iPad, 2 iPhones, 3 Macs), several live at once. Every account can buy labels. Supabase and Vercel are moving to Pro.

Checked while planning: the `supabase_realtime` publication held no tables, so the page's four realtime channels had never delivered anything, and nothing polled.

## Options considered

- **Keep the casual gate, add a shared secret header for `/api`.** The secret would sit in the page next to the key. No change in who can reach the data.
- **Emailed one-time codes (magic link / OTP).** No passwords to manage, but Supabase's built-in mailer is rate-limited and not for production. It needs a custom SMTP provider, and a code has to be typed on a shared iPad.
- **Supabase Auth email + password (chosen).** iCloud Keychain fills the password; no mail is needed, because accounts are created and passwords reset in the dashboard.
- **Verify tokens in `/api` by JWT signature** (JWKS or the project secret). Fast, but needs key handling and doesn't notice a deleted user until the token expires.
- **Verify tokens by asking Supabase Auth (`GET /auth/v1/user`) (chosen).** One extra round trip (~50–150 ms) per `/api` call, and no secret.
- **Turn everything on at once.** Rejected: one missed device or one bug locks the shop out of its own plan.

## Decision

- **Sign-in:** `index.html` shows an email + password form until supabase-js has a session (`<html>` starts locked, so nothing shows behind it). There is no sign-up and no reset link. Sign out is per device (`scope: 'local'`), so it never signs the shared account out elsewhere. Data loads and realtime subscribe only after sign-in.
- **`/api`:** every page call goes through `apiFetch()`, which adds `Authorization: Bearer <access token>`. Each function calls `requireUser()` from `api/_auth.js` first. The `_` prefix keeps Vercel from serving it as an endpoint; it sits inside `api/`, so the ADR 0022 allowlist covers it.
- **Staff only.** A Supabase Auth user is not enough. The account must carry `app_metadata.portal_staff = true`, set by Andy in SQL when he creates it (RUNBOOK step 0). This guards against a sign-up toggle left on, an anonymous sign-in, or any other way a stranger gets a user in this project. `requireUser` answers 403 without the marker. The access migration adds a restrictive "portal staff only" policy on each table, ANDed with the permissive ones, and the recovery functions return nothing for anyone else.
- **Observe, then enforce, except where money or customers are involved.** Without `PORTAL_AUTH_ENFORCE=1`, a missing, bad or unverifiable token is logged (`auth:<reason> … ua="…"`) and the request goes through. Label buying, fulfillment, `ship-doc` and the B2B lists are enforced from the first deploy whatever the variable says: the new page always has a session, and an internet scanner shouldn't be able to buy labels or read addresses during the observation day. With the variable set, a missing or bad token or an anonymous user gets 401 everywhere. Supabase Auth unreachable, or the server's key missing or refused, gets 503 (fails closed). A server key problem is never a 401, so it can't send every device into a sign-in loop.
- **Server-side Supabase calls run as the caller.** The cost-row insert, the one-label-per-box lookup and `mark_ship_labels_fulfilled` forward the caller's bearer token, verified or not. PostgREST checks it again, so an unverified caller is never upgraded to the anon key. The anon key is used only for a caller with no token at all, and only while not enforcing.
- **A failed one-label lookup buys nothing** (503, "try again in a minute"), whether the lookup errors, times out (5 s) or is refused. This reverses ADR 0020's R8 reading for this one check. Whatever breaks the lookup (Supabase down, a token PostgREST refuses, the anon key after the migration) usually breaks the cost-row insert too, so a label bought then would exist nowhere in the database and the next tap would buy it again. A delayed box is better than a second charge with no record of the first.
- **"Already bought" is confirmed with Shippo.** A `shipping_labels` row is only a claim: anyone who can insert one could stop the real purchase, then have the page print their label and email their tracking number. The endpoint hands back only what Shippo returns for that transaction id, and only if the tracking number matches. Otherwise it refuses (409), buying nothing.
- **One buyer per box** (`label_claims`, step 0). The lookup can't stop two devices that both passed it a moment ago. Before buying, the endpoint claims (order, box), so only one claim succeeds. A failed purchase releases the claim; a claim older than 10 minutes can be taken over. A purchase call that errors keeps its claim, since Shippo may have bought it.
- **A label purchase needs at least two minutes left on the user's token**, because the cost row is written with that token after the Shippo call. Otherwise the endpoint answers 401 and the page refreshes the session and retries. The Shippo purchase call itself gets no timeout: aborting it could leave a label bought and unrecorded.
- **Clear on the red banner only clears.** It sends `only_if_fulfilled`, and the server answers 409 instead of fulfilling a partly fulfilled order (with no customer email) that dropped out of the ship list.
- **The page never talks to the database on the publishable key alone.** supabase-js falls back to it when a session can't be refreshed; once tables are `to authenticated`, writes then "succeed" with 0 rows. `sbFetch` (supabase-js's `global.fetch`) refuses those calls and shows the sign-in screen. `apiFetch` refreshes the session once on a 401 before asking for a sign-in.
- **No CORS headers** on the functions: the page is the only caller.
- **Database: four migrations, each with its own rollback, all applied by hand:**
  - `login-prep` (step 0): `activity_log` and `plan_state` policies, `to anon` only, become `to anon, authenticated`, so signed-in devices can finalize and log during the observation day. Additive.
  - `label-claims` (step 0): the claims table and its two functions.
  - `realtime-publication` (step 2b, once the observation day shows no old tab left): publishes the four tables the page subscribes to, after checking each has a primary key (a published table without a replica identity refuses UPDATE and DELETE). An old page would reload on every row event, so it waits for the old tabs to go. It is separate from the access migration so either can be undone alone.
  - `login-rls` (step 3b), described below. Its rollback returns to the login-prep state, which the new page works in.
- **The access migration `db/2026-10-18-login-rls.sql`:**
  - the 36 policies move to `authenticated` with `ALTER POLICY … TO`, so command and expressions are unchanged, and are renamed `authenticated …`;
  - `green_planner_app` gets its own SELECT policies on `blend_matrix` and `green_coffee_settings`;
  - a restrictive "portal staff only" policy on each of the 10 tables;
  - EXECUTE on the three recovery functions is revoked from PUBLIC and anon, and their bodies gain the staff condition;
  - objects `postgres` creates later in `public` no longer get Supabase's explicit anon grants.
  - Table GRANTs to anon stay, so anon reads `[]` rather than an error.
  - It refuses to run if there are no accounts, if any account has never signed in or lacks the staff marker, if an anonymous user exists, or if the policies are not the 36 it was written against (including login-prep's two roles on the log tables). Its rollback checks the policies by name, so tables added later don't block it.
- **Order:**
  - Step 0: login-prep and label-claims; the 5 accounts created and marked as staff.
  - Step 1: code deploys, and each device signs in at its next load (a new page with no accounts would lock everyone out).
  - Step 2: observe for a working day. The Vercel logs should show no `auth:` lines, the Supabase API logs no anon REST calls (old open tabs), and every account should have signed in. Step 2b: the realtime publication.
  - Step 3a: `PORTAL_AUTH_ENFORCE=1`, the door that spends money.
  - Step 3b: the access migration.
- **Realtime reloads** are debounced (800 ms) and run one at a time. They are held while this device has a write in flight, wrote in the last 800 ms, has a finger down or a field focused (at most 60 s). A failed read keeps what is on screen. A reload that read rows while a local write went out is dropped and re-run, so the echo of one tap can't undo the next. A live channel that drops shows on the sync pill.
- **supabase-js** is pinned to an exact version (2.117.2) with an SRI hash. A stored-XSS bug would now leak a refresh token from localStorage, so customer and Shopify text rendered through `innerHTML` is escaped. Names passed to inline handlers go through `jsArg()`, and links through `safeUrl()`.

## Consequences

**Positive:**
- The publishable key alone reads nothing, writes nothing, runs no recovery function and reaches no `/api` function.
- Every step has its own undo: unset the env var; run a migration's rollback SQL; revert the code (after the access and realtime rollbacks; RUNBOOK).
- Two devices can no longer buy the same box, and a planted label row can't stand in for a real purchase.
- Realtime cross-device sync works for the first time.
- The read-only `green_planner_app` role loses the EXECUTE it had through PUBLIC, including on `mark_ship_labels_fulfilled`, which writes.

**Negative:**
- Each `/api` call costs one extra round trip to Supabase Auth, and a Supabase Auth outage stops `/api` (503) while enforcing.
- Passwords are reset by Andy in the dashboard; there is no self-service.
- **Reverting the code after the migration breaks the app**, because the old page runs on the anon key. Run the rollback SQL first. The same goes for a Vercel Instant Rollback to a deployment from before this slice.
- Turning enforcement off after the migration (unsetting the variable, a typo like `true`, or an Instant Rollback to the step-1 deployment) reopens rating, products and the order list to callers with no token. Label buying, fulfillment, printing and the B2B lists stay enforced.
- An account created later must be marked `portal_staff` before it can use the portal. The access migration refuses to run while an unmarked account exists.
- A new function in `public` still gets EXECUTE for PUBLIC, anon included, from Postgres's built-in default. A schema-level default can't remove that; a database-wide one would also change the green planner's schema. Every new function needs `revoke execute … from public, anon`, and every new table needs its policies written `to authenticated`. Objects created by `supabase_admin` keep Supabase's defaults.
- Realtime goes live for the first time. Rows still re-render when another device changes them (held only while a finger is down), and counters are written as absolute values, so two devices tapping the same line at the same moment can still overwrite each other.
- A Supabase outage now also stops label buying (503 at the lookup) even when Supabase Auth answers.
- All five accounts have the same rights. There is no per-user role and no audit of who did what (the activity log does not record the user).

**When to revisit:**
- Counters need to be safe across devices tapping at once (relative increments via an RPC).
- An account needs fewer rights than the others (e.g. view-only).
- The activity log should name who made each change.
- Supabase Auth latency or outages show up in the `/api` logs.
- Self-service password reset is wanted (needs custom SMTP).
