// api/shopify-fulfill.js — B2B Cubic Shipping · Step 4: write ONE fulfillment with all
// box tracking numbers back to the Shopify order, with a single customer notification.
// Uses the modern FulfillmentOrder GraphQL flow (fulfillmentCreate). Server-side so the
// Shopify token never reaches the browser; reuses the client-credentials OAuth pattern
// from shopify-token.js.
//
//   POST /api/shopify-fulfill
//   body: { order_id, tracking: [{ number, url }], company?: 'USPS', notifyCustomer?: true }
//
// Idempotent: if the order has no open fulfillment order (already fulfilled), it does NOT
// create a fulfillment or notify again — guards against double-notify on retry.

const fetch = globalThis.fetch || require('node-fetch')
const API_VERSION = '2025-01'

async function getToken() {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_HANDLE } = process.env
  const r = await fetch(`https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET })
  })
  const d = await r.json()
  return d.access_token ? { token: d.access_token } : { error: d }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}') } catch { body = {} } }
  body = body || {}
  const tracking = Array.isArray(body.tracking) ? body.tracking.filter(t => t && t.number) : []
  const company = body.company || 'USPS'
  const notifyCustomer = body.notifyCustomer !== false
  let orderId = body.order_id
  if (!orderId || !tracking.length) return res.status(400).json({ error: 'order_id and tracking[] required' })
  if (!String(orderId).startsWith('gid://')) orderId = `gid://shopify/Order/${String(orderId).replace(/[^0-9]/g, '')}`

  const { SHOPIFY_STORE_HANDLE } = process.env
  try {
    const tk = await getToken()
    if (tk.error) return res.status(500).json({ error: 'Shopify token exchange failed', detail: tk.error })
    const gql = async (query, variables) => {
      const r = await fetch(`https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': tk.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
      })
      return r.json()
    }

    // 1) Look up the order's fulfillment orders (idempotency guard).
    const foRes = await gql(
      `query($id: ID!) { order(id: $id) { id name fulfillmentOrders(first: 10) { edges { node { id status } } } } }`,
      { id: orderId }
    )
    const order = foRes.data && foRes.data.order
    if (!order) {
      // A null order with GraphQL errors is almost always a missing app scope (this query
      // reads `fulfillmentOrders`, which needs read_merchant_managed_fulfillment_orders) —
      // NOT a genuinely absent order. Say so, so it isn't mistaken for a bad order id.
      const errs = foRes.errors || []
      const accessDenied = errs.some(e => /access denied|scope|not approved|permission/i.test(e.message || ''))
      const msg = accessDenied || errs.length
        ? 'Could not read the order — the planner app is likely missing the read/write_merchant_managed_fulfillment_orders scopes. Grant them to the custom app and reinstall.'
        : 'Order not found'
      return res.status(accessDenied || errs.length ? 502 : 404).json({ error: msg, detail: errs.length ? errs : null })
    }
    const openFOs = (order.fulfillmentOrders.edges || []).map(e => e.node)
      .filter(n => n.status === 'OPEN' || n.status === 'IN_PROGRESS')
    if (!openFOs.length) {
      // Already fulfilled — do not create or notify again.
      return res.status(200).json({ ok: true, order: order.name, alreadyFulfilled: true, notified: false })
    }

    // 2) Create ONE fulfillment with all tracking numbers; notify once.
    const numbers = tracking.map(t => t.number)
    const urlsAll = tracking.map(t => t.url)
    const trackingInfo = { company, numbers }
    if (urlsAll.every(Boolean)) trackingInfo.urls = urlsAll  // positional match only if complete

    const mRes = await gql(
      `mutation($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) {
          fulfillment { id status trackingInfo(first: 20) { company number url } }
          userErrors { field message }
        }
      }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: openFOs.map(fo => ({ fulfillmentOrderId: fo.id })),
          trackingInfo,
          notifyCustomer
        }
      }
    )
    const payload = mRes.data && mRes.data.fulfillmentCreate
    const userErrors = (payload && payload.userErrors) || []
    if (!payload || !payload.fulfillment || userErrors.length) {
      // Do NOT claim success — caller must not log a cost row or mark shipped.
      return res.status(502).json({ error: 'fulfillmentCreate failed', userErrors, detail: mRes.errors || null })
    }
    // Cost capture (Step 4b): flip this order's label rows to 'fulfilled'. NON-BLOCKING.
    let cost_updated = false
    try {
      const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
      if (SB_URL && SB_KEY) {
        const u = await fetch(`${SB_URL}/rest/v1/shipping_labels?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'fulfilled' })
        })
        cost_updated = u.ok
      }
    } catch (e) { /* non-blocking: analytics is the passenger, not the shipment */ }

    return res.status(200).json({
      ok: true, order: order.name, notified: notifyCustomer,
      fulfillment_id: payload.fulfillment.id, status: payload.fulfillment.status,
      tracking: payload.fulfillment.trackingInfo,
      cost_updated
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
