// api/_shopify.js — Shopify Admin access shared by the /api functions. Not an endpoint:
// Vercel does not turn files in api/ whose name starts with "_" into functions.
// Client-credentials OAuth. Used by shopify-token.js, shopify-fulfill.js and shippo-label.js.

const fetch = globalThis.fetch || require('node-fetch')

const API_VERSION = '2025-01'
const ORDER_TIMEOUT_MS = 5000   // token exchange + order read, together

// -> { token } or { error }. `signal` (optional) aborts the exchange.
async function getToken(signal) {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_HANDLE } = process.env
  const r = await fetch(`https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
    signal
  })
  const d = await r.json()
  return d.access_token ? { token: d.access_token } : { error: d }
}

// The numeric id in "gid://shopify/Order/123" (or a bare "123"); null for anything else.
function orderNumericId(orderId) {
  const m = /^(?:gid:\/\/shopify\/Order\/)?(\d{1,20})$/.exec(String(orderId == null ? '' : orderId))
  return m ? m[1] : null
}

// One order as REST returns it (line_items with vendor, grams, sku, fulfillment_status).
//   { ok: true, order }   { ok: false, status, why }   status 404 = no such order
async function fetchOrder(orderId) {
  const id = orderNumericId(orderId)
  if (!id) return { ok: false, status: 400, why: 'bad order id' }
  // One timeout covers the token exchange and the order read; any failure (a non-JSON error
  // page included) comes back as a result, never a throw.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ORDER_TIMEOUT_MS)
  try {
    const tk = await getToken(ctrl.signal)
    if (tk.error) return { ok: false, status: 502, why: 'token exchange failed' }
    const r = await fetch(
      `https://${process.env.SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/${API_VERSION}/orders/${id}.json?fields=id,name,cancelled_at,line_items`,
      { headers: { 'X-Shopify-Access-Token': tk.token, 'Content-Type': 'application/json' }, signal: ctrl.signal }
    )
    if (r.status === 404) return { ok: false, status: 404, why: 'not found' }
    if (r.status !== 200) return { ok: false, status: 502, why: `status ${r.status}` }
    const d = await r.json()
    if (!d || !d.order || !Array.isArray(d.order.line_items)) return { ok: false, status: 502, why: 'unexpected response' }
    return { ok: true, order: d.order }
  } catch (e) {
    return { ok: false, status: 502, why: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { API_VERSION, getToken, orderNumericId, fetchOrder }
