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
//   kind: 'retail' (B3b, ADR 0029) is the Retail tab's Fulfill: body { order_id, kind: 'retail',
//   notifyCustomer?, only_if_fulfilled? }. Any other value, or none, is B2B and works as above.
//   Retail takes the tracking number from the DB, never the page: the order's one live retail
//   label (ship_labels_for_order, as the caller) must exist, not be held back, carry a UPS
//   number, and still match the order as Shopify has it now (same list rules and same packer
//   as the label step: refused when the billed lb changed). A `tracking` in a retail body is
//   ignored. Refusals are 409 with a `code`: labels, held_back, not_listed, pack_changed; a
//   lookup that can't be made is 503. Nothing is fulfilled on any of them.
//   The response says `emailed`: true only when a fulfillment was created, the customer was to
//   be notified and the order has an email address (Shopify sends the one shipping email).
//
// Idempotent: if the order has no open fulfillment order (already fulfilled), it does NOT
// create a fulfillment or notify again — guards against double-notify on retry. A retail
// fulfill whose answer was lost takes this path on the retry: no second email.

const fetch = globalThis.fetch || require('node-fetch')
const { requireUser, supabaseHeaders } = require('./_auth')
const { API_VERSION, getToken } = require('./_shopify')
const { fetchRetailOrder } = require('./_retail')
const { classifyRetailOrder, retailShipItems, packRetail, boxParcel } = require('../lib/ship-rules.js')
const UPS_TRACKING = /^1Z[0-9A-Z]{16}$/i
const NOT_UPS = 'Not a UPS tracking number: these labels were not bought as UPS Ground. Fulfill this order by hand in Shopify, then tap Fulfill order again here (or Clear on the red banner) to close it out'
const LOOKUP_TIMEOUT_MS = 5000

// Flip an order's shipping_labels rows to 'fulfilled'. NON-BLOCKING: never throws.
//
// Via an RPC, not a PATCH. A PostgREST PATCH silently no-ops here: `UPDATE ... WHERE`
// has to READ the rows it matches, and with RLS on and no SELECT policy (deliberate —
// ADR 0004 keeps cost unreadable) the WHERE matches nothing. PostgREST then returns
// 204 + Content-Range */0, so `res.ok` was true and this reported success while every
// row stayed 'purchased'. mark_ship_labels_fulfilled() is SECURITY DEFINER and returns
// the row count, so cost_updated means what it says.
// Runs as the signed-in user (ADR 0023): anon has no EXECUTE on the RPC once the doors close.
async function markLabelsFulfilled(orderId, userToken) {
  let cost_updated = false, cost_rows_updated = 0
  try {
    const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
    if (SB_URL && SB_KEY) {
      const u = await fetch(`${SB_URL}/rest/v1/rpc/mark_ship_labels_fulfilled`, {
        method: 'POST',
        headers: supabaseHeaders(userToken),
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

// ship_labels_for_order as the caller (db/2026-10-20-label-held-back.sql adds weight_lb and
// held_back_at). -> { ok: true, rows } or { ok: false }. A lookup that can't be made stops the
// fulfill: the tracking number comes from this record and from nowhere else.
async function labelsForOrder(orderId, userToken) {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
  if (!SB_URL || !SB_KEY) return { ok: false }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/ship_labels_for_order`, {
      method: 'POST',
      headers: supabaseHeaders(userToken),
      body: JSON.stringify({ p_order_id: String(orderId) }),
      signal: ctrl.signal
    })
    if (r.status !== 200) return { ok: false }
    const rows = await r.json()
    return Array.isArray(rows) ? { ok: true, rows } : { ok: false }
  } catch (e) {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

// The checks a retail fulfill passes before Shopify is written (B3b). -> { row } (the one live
// label) or { status, body } (the refusal). Runs after the cancelled / not-done / already
// fulfilled / only_if_fulfilled guards, so it only sees an order with open items.
async function retailGate(orderId, userToken) {
  const lab = await labelsForOrder(orderId, userToken)
  if (!lab.ok) return { status: 503, body: { error: "Couldn't read this order's label record, so nothing was fulfilled. Try again." } }
  const live = lab.rows.filter(x => x && x.status === 'purchased' && x.channel === 'retail')
  if (live.length === 0) return { status: 409, body: { code: 'labels', error: 'No live retail label on record for this order' } }
  if (live.length > 1) return { status: 409, body: { code: 'labels', error: `${live.length} live labels on record. Tell Andy` } }
  const row = live[0]
  if (Number(row.box_index) !== 1 || Number(row.box_count) !== 1) {
    return { status: 409, body: { code: 'labels', error: `The label on record is box ${row.box_index} of ${row.box_count}, not a single carton. Tell Andy` } }
  }
  if (row.held_back_at) return { status: 409, body: { code: 'held_back', error: 'This order is held back. Include it on the Pack screen first.' } }
  if (!UPS_TRACKING.test(String(row.tracking_number || '').trim())) return { status: 400, body: { error: NOT_UPS } }

  // The pack the label was bought for must still be the order's pack (Decision 3): the same
  // reading and packer as the label step (serverPack in shippo-label.js).
  const got = await fetchRetailOrder(orderId)
  if (!got.ok) {
    if (got.status === 404) return { status: 409, body: { code: 'pack_changed', error: 'Shopify has no such order. Nothing was fulfilled.' } }
    console.warn(`shopify-fulfill: Shopify retail order read failed (${got.why}); nothing fulfilled`)
    return { status: 503, body: { error: "Couldn't read the order from Shopify to check it against its label, so nothing was fulfilled. Try again in a minute." } }
  }
  const c = classifyRetailOrder(got.order)
  if (c.decision !== 'LIST') {
    return { status: 409, body: { code: 'not_listed', class: c.class, error: `This order is no longer shippable here (${c.decision} ${c.class}${c.detail ? ' ' + c.detail : ''}). Nothing was fulfilled.` } }
  }
  const pack = packRetail(retailShipItems(got.order))
  const want = pack.boxes.length === 1 && !pack.unpackable.length ? boxParcel(pack.boxes[0]) : null
  const labelLb = Number(row.weight_lb)
  if (!want || !(labelLb > 0) || want.weight !== labelLb) {
    const now = want ? `${want.weight} lb` : "a pack that can't be weighed"
    return { status: 409, body: { code: 'pack_changed', error: `This order changed in Shopify since its label was bought (label ${Number.isFinite(labelLb) && labelLb > 0 ? labelLb + ' lb' : 'with no weight on record'}, now ${now}). Nothing was fulfilled. Void the label and buy again, or fulfill by hand in Shopify.` } }
  }
  return { row }
}

module.exports = async function handler(req, res) {
  // Same-origin only: no CORS headers (the page is the only caller).
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const session = await requireUser(req, res, { always: true })   // emails customers (ADR 0023)
  if (!session) return

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}') } catch { body = {} } }
  body = body || {}
  const retail = body.kind === 'retail'   // anything else, or nothing, is B2B
  let tracking = !retail && Array.isArray(body.tracking) ? body.tracking : []   // retail: read from the DB below
  const company = 'UPS'
  const notifyCustomer = body.notifyCustomer !== false
  let orderId = body.order_id
  if (retail ? !orderId : (!orderId || !tracking.length)) return res.status(400).json({ error: retail ? 'order_id required' : 'order_id and tracking[] required' })
  // A box with no number is refused, never dropped: dropping it would fulfill and email the
  // customer with fewer tracking numbers than boxes.
  if (!retail && !tracking.every(t => t && typeof t.number === 'string' && t.number.trim())) {
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
      `query($id: ID!) { order(id: $id) { id name email cancelledAt displayFulfillmentStatus fulfillmentOrders(first: 50) { edges { node { id status } } } } }`,
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
      const flip = await markLabelsFulfilled(orderId, session.token)
      return res.status(200).json({ ok: true, order: order.name, alreadyFulfilled: true, notified: false, emailed: false, ...flip })
    }

    // Clear on the red banner only closes out an order Shopify already shows fulfilled. A
    // partly fulfilled order also drops out of the ship list; it must not be fulfilled here
    // (silently, with no customer email) by a button that means "done by hand".
    if (body.only_if_fulfilled === true) {
      return res.status(409).json({ error: 'Shopify still has unfulfilled items on this order, so nothing was changed. Fulfill the rest in Shopify, or open the order here and tap Finish →.' })
    }

    // Retail (B3b): the tracking number is the DB label's, after the label, held-back, UPS and
    // repack checks. Still after the already-fulfilled guard above, so a retry whose first
    // answer was lost finds the order fulfilled and sends nothing.
    if (retail) {
      const gate = await retailGate(orderId, session.token)
      if (!gate.row) return res.status(gate.status).json({ ...gate.body, emailed: false })
      tracking = [{ number: String(gate.row.tracking_number).trim() }]
    }

    // Checked after the already-fulfilled guard, so a hand-fulfilled USPS order can still
    // clear its pending flag here.
    if (tracking.some(t => !UPS_TRACKING.test(t.number.trim()))) {
      return res.status(400).json({ error: NOT_UPS })
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
    const { cost_updated, cost_rows_updated } = await markLabelsFulfilled(orderId, session.token)

    return res.status(200).json({
      ok: true, order: order.name, notified: notifyCustomer, emailed: notifyCustomer && !!order.email,
      fulfillment_id: payload.fulfillment.id, status: payload.fulfillment.status,
      tracking: payload.fulfillment.trackingInfo,
      cost_updated, cost_rows_updated
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
