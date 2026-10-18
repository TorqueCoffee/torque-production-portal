// api/shopify-fulfill.js — B2B Cubic Shipping · Step 4: write ONE fulfillment with all
// box tracking numbers back to the Shopify order, with a single customer notification.
// Uses the modern FulfillmentOrder GraphQL flow (fulfillmentCreate). Server-side so the
// Shopify token never reaches the browser; reuses the client-credentials OAuth pattern
// from shopify-token.js.
//
//   POST /api/shopify-fulfill
//   body: { order_id, tracking: [{ number, url }], notifyCustomer?: true }
//   The tracking company is always UPS (ADR 0020); a `company` in the body is ignored.
//   Every box needs a tracking number, and every number must be a UPS number (1Z + 16): a
//   USPS label bought before the switch is refused, so it is never announced as UPS. That
//   order is fulfilled by hand in Shopify; reopening it here and tapping Fulfill then takes
//   the already-fulfilled path below, which clears its pending flag.
//
// Idempotent: if the order has no open fulfillment order (already fulfilled), it does NOT
// create a fulfillment or notify again — guards against double-notify on retry.

const fetch = globalThis.fetch || require('node-fetch')
const API_VERSION = '2025-01'
const UPS_TRACKING = /^1Z[0-9A-Z]{16}$/i

// Flip an order's shipping_labels rows to 'fulfilled'. NON-BLOCKING: never throws.
//
// Via an RPC, not a PATCH. A PostgREST PATCH silently no-ops here: `UPDATE ... WHERE`
// has to READ the rows it matches, and with RLS on and no SELECT policy (deliberate —
// ADR 0004 keeps cost unreadable) the WHERE matches nothing. PostgREST then returns
// 204 + Content-Range */0, so `res.ok` was true and this reported success while every
// row stayed 'purchased'. mark_ship_labels_fulfilled() is SECURITY DEFINER and returns
// the row count, so cost_updated means what it says.
async function markLabelsFulfilled(orderId) {
  let cost_updated = false, cost_rows_updated = 0
  try {
    const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
    if (SB_URL && SB_KEY) {
      const u = await fetch(`${SB_URL}/rest/v1/rpc/mark_ship_labels_fulfilled`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_order_id: orderId })
      })
      if (u.ok) {
        cost_rows_updated = Number(await u.text()) || 0
        cost_updated = cost_rows_updated > 0
      }
    }
  } catch (e) { /* non-blocking: analytics is the passenger, not the shipment */ }
  return { cost_updated, cost_rows_updated }
}

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
  const tracking = Array.isArray(body.tracking) ? body.tracking : []
  const company = 'UPS'
  const notifyCustomer = body.notifyCustomer !== false
  let orderId = body.order_id
  if (!orderId || !tracking.length) return res.status(400).json({ error: 'order_id and tracking[] required' })
  // A box with no number is refused, never dropped: dropping it would fulfill and email the
  // customer with fewer tracking numbers than boxes.
  if (!tracking.every(t => t && typeof t.number === 'string' && t.number.trim())) {
    return res.status(400).json({ error: 'Every box needs a tracking number.' })
  }
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
      `query($id: ID!) { order(id: $id) { id name cancelledAt displayFulfillmentStatus fulfillmentOrders(first: 50) { edges { node { id status } } } } }`,
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
    const allFOs = (order.fulfillmentOrders.edges || []).map(e => e.node)
    const openFOs = allFOs.filter(n => n.status === 'OPEN' || n.status === 'IN_PROGRESS')
    if (order.cancelledAt) {
      return res.status(409).json({ error: 'This order is cancelled in Shopify. Nothing was fulfilled. Void these labels in Shippo.' })
    }
    if (!openFOs.length) {
      // Only a truly fulfilled order counts as done. ON_HOLD, SCHEDULED, INCOMPLETE or no
      // visible fulfillment order is NOT done: flipping its rows would hide paid labels from
      // the "paid, not fulfilled" alarm (ADR 0011) and invite buying them again.
      const done = allFOs.length > 0 && allFOs.every(n => n.status === 'CLOSED') && order.displayFulfillmentStatus === 'FULFILLED'
      if (!done) {
        const statuses = [...new Set(allFOs.map(n => n.status))].join(', ') || 'none visible'
        const hint = allFOs.some(n => n.status === 'ON_HOLD') ? ' Release the hold in Shopify, then tap Fulfill order again.' : ''
        return res.status(409).json({ error: `Shopify can't fulfill this order right now (fulfillment status: ${statuses}). Nothing was fulfilled.${hint}` })
      }
      // Already fulfilled (by a retry, or by hand in Shopify) — do not create or notify again,
      // but do flip the label rows so the order stops showing as "paid, not fulfilled".
      const flip = await markLabelsFulfilled(orderId)
      return res.status(200).json({ ok: true, order: order.name, alreadyFulfilled: true, notified: false, ...flip })
    }

    // Checked after the already-fulfilled guard, so a hand-fulfilled USPS order can still
    // clear its pending flag here.
    if (tracking.some(t => !UPS_TRACKING.test(t.number.trim()))) {
      return res.status(400).json({ error: 'Not a UPS tracking number: these labels were not bought as UPS Ground. Fulfill this order by hand in Shopify, then tap Fulfill order again here (or Clear on the red banner) to close it out' })
    }

    // 2) Create ONE fulfillment with all tracking numbers; notify once.
    const numbers = tracking.map(t => t.number.trim())
    // No URLs: Shopify builds the UPS tracking link from company + number. A URL taken from
    // the page (or from a shipping_labels row anon can update) would put an arbitrary link
    // in the customer's shipping email.
    const trackingInfo = { company, numbers }

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
    const { cost_updated, cost_rows_updated } = await markLabelsFulfilled(orderId)

    return res.status(200).json({
      ok: true, order: order.name, notified: notifyCustomer,
      fulfillment_id: payload.fulfillment.id, status: payload.fulfillment.status,
      tracking: payload.fulfillment.trackingInfo,
      cost_updated, cost_rows_updated
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
