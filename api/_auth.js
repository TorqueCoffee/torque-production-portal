// api/_auth.js — signed-in check shared by the /api functions (ADR 0023). Not an endpoint:
// Vercel does not turn files in api/ whose name starts with "_" into functions.
//
// The page sends the Supabase Auth access token as `Authorization: Bearer <token>`. The token
// is checked by asking Supabase Auth who it belongs to (GET /auth/v1/user), so a signed-out or
// deleted user is refused without this code holding any JWT secret.
//
// Only the portal's own accounts count: the user must carry app_metadata.portal_staff = true
// (set by Andy in SQL, RUNBOOK). Anyone else who manages to get a Supabase Auth user in this
// project (a sign-up toggle left on, an anonymous sign-in) is refused.
//
// PORTAL_AUTH_ENFORCE=1 (Vercel env var): no token, a bad token or an anonymous user -> 401;
// a valid user without the staff marker -> 403; Supabase Auth unreachable,
// SUPABASE_URL/SUPABASE_ANON_KEY unset, or the key refused -> 503. Fails closed.
// Unset: the request goes through and the problem is logged as `auth:<reason>`, so the
// Vercel logs show whether every device sends a token before the door is shut. Calls that
// spend money or return customer data pass { always: true } and are enforced either way.

const fetch = globalThis.fetch || require('node-fetch')

// Exposed so tests can shorten the wait; nothing else changes it.
const settings = { checkTimeoutMs: 3000 }
const TOKEN_MAX = 8192        // a Supabase access token is ~1 KB; anything this long is not one

function enforcing() { return process.env.PORTAL_AUTH_ENFORCE === '1' }

function bearerToken(req) {
  const h = req && req.headers && req.headers.authorization
  if (typeof h !== 'string' || h.length > TOKEN_MAX + 7) return null
  const m = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(h.trim())
  return m ? m[1] : null
}

// { ok: true, user } or { ok: false, reason: 'invalid' | 'anonymous' | 'not_staff' | 'unreachable' | 'unconfigured' }
async function checkToken(token) {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
  if (!SB_URL || !SB_KEY) return { ok: false, reason: 'unconfigured' }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl && setTimeout(() => ctrl.abort(), settings.checkTimeoutMs)
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
      signal: ctrl ? ctrl.signal : undefined
    })
    if (r.status === 401 || r.status === 403) {
      // A wrong or rotated SUPABASE_ANON_KEY is a server problem (503), not every user's
      // session ending: telling staff to sign in again would loop.
      const body = await r.text().catch(() => '')
      return { ok: false, reason: /invalid api key|no api key|apikey/i.test(body) ? 'unconfigured' : 'invalid' }
    }
    if (!r.ok) return { ok: false, reason: 'unreachable' }
    const user = await r.json().catch(() => null)
    if (!user || typeof user.id !== 'string' || !user.id) return { ok: false, reason: 'invalid' }
    // Anonymous sign-ins (if ever switched on in the dashboard) also get role `authenticated`.
    if (user.is_anonymous === true) return { ok: false, reason: 'anonymous' }
    if (!(user.app_metadata && user.app_metadata.portal_staff === true)) return { ok: false, reason: 'not_staff' }
    return { ok: true, user }
  } catch {
    return { ok: false, reason: 'unreachable' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Call first in every handler:  const session = await requireUser(req, res); if (!session) return
// { always: true } enforces whatever PORTAL_AUTH_ENFORCE says (label purchase, fulfillment,
// customer names and addresses, label PDFs): the login page always has a session, so only
// old pages and strangers lose these calls.
// Returns { user, token }. token is the caller's bearer token whenever there is one, verified
// or not: server-side PostgREST calls forward it and PostgREST checks it again, so an
// unverified caller is never upgraded to the anon key's rights (which, once the RLS migration
// is in, would make the one-label lookup and the cost row fail). null only when the caller
// sent no token (not enforcing). Returns null after sending the 401/503.
async function requireUser(req, res, { always = false } = {}) {
  const token = bearerToken(req)
  const result = token ? await checkToken(token) : { ok: false, reason: 'missing' }
  if (result.ok) return { user: result.user, token }
  const enforce = always || enforcing()
  const where = String((req && req.url) || '').split('?')[0]
  const ua = String((req && req.headers && req.headers['user-agent']) || '-').replace(/[^\x20-\x7e]|"/g, '').slice(0, 80)
  console.warn(`auth:${result.reason} ${req && req.method} ${where} enforce=${enforce ? 1 : 0} ua="${ua}"`)
  if (!enforce) return { user: null, token }
  if (result.reason === 'missing' || result.reason === 'invalid' || result.reason === 'anonymous') {
    res.status(401).json({ error: 'Sign in again: your session has ended.' })
  } else if (result.reason === 'not_staff') {
    res.status(403).json({ error: "This account isn't set up for the portal. Ask Andy." })
  } else {
    res.status(503).json({ error: "Can't check your sign-in right now. Try again in a minute." })
  }
  return null
}

// Headers for a server-side PostgREST call made on the caller's behalf: their token when there
// is one (RLS sees `authenticated`, or PostgREST refuses a bad one), else the anon key (only
// while not enforcing, for a caller with no token).
function supabaseHeaders(userToken, extra = {}) {
  const key = process.env.SUPABASE_ANON_KEY
  return { apikey: key, Authorization: `Bearer ${userToken || key}`, 'Content-Type': 'application/json', ...extra }
}

module.exports = { requireUser, supabaseHeaders, bearerToken, checkToken, settings }
