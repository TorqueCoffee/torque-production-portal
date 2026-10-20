// api/_supabase.js — one way to call a Supabase RPC (PostgREST) as the signed-in caller, with a
// timeout. Not an endpoint: Vercel does not turn files in api/ whose name starts with "_" into
// functions. The label, void and fulfill endpoints all call SECURITY DEFINER functions this way
// (shipping_labels has no SELECT policy, ADR 0004), as the caller (ADR 0023): anon has no EXECUTE.

const fetch = globalThis.fetch || require('node-fetch')
const { supabaseHeaders } = require('./_auth')

const RPC_TIMEOUT_MS = 5000

// -> { ok: true, data }  (HTTP 200, body parsed; null for an empty body)
//    { ok: false, status?, why }  not configured, a non-200, a timeout, or a network error
async function rpc(name, args, userToken, timeoutMs = RPC_TIMEOUT_MS) {
  const SB_URL = process.env.SUPABASE_URL
  if (!SB_URL || !process.env.SUPABASE_ANON_KEY) return { ok: false, why: 'not configured' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: supabaseHeaders(userToken), body: JSON.stringify(args || {}), signal: ctrl.signal
    })
    if (r.status !== 200) return { ok: false, status: r.status, why: `status ${r.status}` }
    return { ok: true, data: await r.json() }
  } catch (e) {
    return { ok: false, why: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { rpc, RPC_TIMEOUT_MS }
