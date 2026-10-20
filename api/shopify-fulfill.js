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
//   number, still match the order as Shopify has it now (the same check as the label step,
//   checkRetailOrder: the billed lb and the ZIP the label was bought for must be unchanged), and
//   be confirmed by Shippo as a live label (a voided or planted one is refused). A `tracking` in a
//   retail body is ignored, and the customer email is always on for it (only Clear sends
//   notifyCustomer false, and Clear never creates anything). Refusals are 409 with a `code`:
//   busy, labels, held_back, not_listed, pack_changed, label_not_live; a lookup that can't be made
//   is 503, a Shopify call that times out 504. Nothing is fulfilled on any of them.
//   The whole retail request runs under the order's lock (claim_order_fulfill, shared with Void
//   and Hold back): two devices can't fulfill one order together, and a label can't be voided
//   while its tracking number is on its way to the customer.
//   A request with no kind is B2B, unless the order has a live retail label: then it is retail
//   (a page, or a stale tab, can't skip the retail checks by leaving `kind` out).
//   The response says `emailed`: true only when a fulfillment was created, the customer was to
//   be notified and the order has an email address (Shopify sends the one shipping email).
//
// Idempotent: if the order has no open fulfillment order (already fulfilled), it does NOT
// create a fulfillment or notify again — guards against double-notify on retry. A retail
// fulfill whose answer was lost takes this path on the retry: no second email.

const fetch = globalThis.fetch || require('node-fetch')
const { requireUser, supabaseHeaders } = require('./_auth')
const { API_VERSION, getToken, orderNumericId } = require('./_shopify')
const { checkRetailOrder } = require('./_retail')
const { rpc } = require('./_supabase')
const { labelIsLive } = require('./_shippo')
const { boxParcel } = require('../lib/ship-rules.js')
const UPS_TRACKING = /^1Z[0-9A-Z]{16}$/i
const NOT_UPS = 'Not a UPS tracking number: these labels were not bought as UPS Ground. Fulfill this order by hand in Shopify, then tap Fulfill order again here (or Clear on the red banner) to close it out'
const LOOKUP_TIMEOUT_MS = 5000
// One Shopify call: a hung one must not eat the whole function window. Exposed so a test can shorten it.
const settings = { shopifyTimeoutMs: 6000 }

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
  // A 5 s timer: a hung Supabase after the fulfillment must not make the page say it failed.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
    if (SB_URL && SB_KEY) {
      const u = await fetch(`${SB_URL}/rest/v1/rpc/mark_ship_labels_fulfilled`, {
        method: 'POST',
        headers: supabaseHeaders(userToken),
        body: JSON.stringify({ p_order_id: orderId }),
        signal: ctrl.signal
      })
      if (u.ok) {
        cost_rows_updated = Number(await u.text()) || 0
        cost_updated = cost_rows_updated > 0
      }
    }
  } catch (e) { /* non-blocking: analytics is the passenger, not the shipment */ }
  finally { clearTimeout(timer) }
  return { cost_updated, cost_rows_updated }
}

// The first five digits of a ZIP, for comparing "92104" with "92104-1234".
const zip5 = z => String(z == null ? '' : z).replace(/\D/g, '').slice(0, 5)

// The checks a retail fulfill passes before Shopify is written (B3b). -> { row } (the one live
// label) or { status, body } (the refusal). Runs after the cancelled / not-done / already
// fulfilled / only_if_fulfilled guards, so it only sees an order with open items, and under the
// order's lock, so the row it reads is still the row when the fulfillment is written.
async function retailGate(orderId, userToken) {
  // The label record, as the caller. The tracking number comes from here and from nowhere else.
  const lab = await rpc('ship_labels_for_order', { p_order_id: String(orderId) }, userToken, LOOKUP_TIMEOUT_MS)
  if (!lab.ok || !Array.isArray(lab.data)) return { status: 503, body: { error: "Couldn't read this order's label record, so nothing was fulfilled. Try again." } }
  const live = lab.data.filter(x => x && x.status === 'purchased' && x.channel === 'retail')
  if (live.length === 0) return { status: 409, body: { code: 'labels', error: 'No live retail label on record for this order' } }
  if (live.length > 1) return { status: 409, body: { code: 'labels', error: `${live.length} live labels on record. Tell Andy` } }
  const row = live[0]
  // The page deployed before db/2026-10-20-label-held-back.sql: the record has no weight or hold
  // flag to check. Say so, rather than blaming the order.
  if (!('held_back_at' in row) || !('weight_lb' in row) || !('dest_zip' in row)) {
    return { status: 503, body: { error: 'The portal database update for Hold back and Fulfill (db/2026-10-20-label-held-back.sql) has not been applied, so nothing was fulfilled. Tell Andy.' } }
  }
  if (Number(row.box_index) !== 1 || Number(row.box_count) !== 1) {
    return { status: 409, body: { code: 'labels', error: `The label on record is box ${row.box_index} of ${row.box_count}, not a single carton. Tell Andy` } }
  }
  if (row.held_back_at) return { status: 409, body: { code: 'held_back', error: 'This order is held back. Include it on the Pack screen first.' } }
  if (!UPS_TRACKING.test(String(row.tracking_number || '').trim())) return { status: 400, body: { error: NOT_UPS } }

  // The pack and address the label was bought for must still be the order's (Decision 3): the
  // same reading, list rules and packer as the label step (checkRetailOrder).
  const chk = await checkRetailOrder(orderId, 'fulfilled')
  if (!chk.ok) return { status: chk.status, body: { error: chk.error, ...(chk.code ? { code: chk.code } : {}), ...(chk.class ? { class: chk.class } : {}) } }
  const pack = chk.pack
  const want = pack.boxes.length === 1 && !pack.unpackable.length ? boxParcel(pack.boxes[0]) : null
  const labelLb = Number(row.weight_lb)
  if (!want || !(labelLb > 0) || want.weight !== labelLb) {
    const now = want ? `${want.weight} lb` : "a pack that can't be weighed"
    return { status: 409, body: { code: 'pack_changed', error: `This order changed in Shopify since its label was bought (label ${Number.isFinite(labelLb) && labelLb > 0 ? labelLb + ' lb' : 'with no weight on record'}, now ${now}). Nothing was fulfilled. Void the label and buy again, or fulfill by hand in Shopify.` } }
  }
  const boughtZip = zip5(row.dest_zip), nowZip = zip5(chk.order.address && chk.order.address.zip)
  if (!boughtZip || boughtZip !== nowZip) {
    return { status: 409, body: { code: 'pack_changed', error: `This order's ship-to ZIP changed in Shopify since its label was bought (label ${boughtZip || 'with no ZIP on record'}, now ${nowZip || 'none'}). Nothing was fulfilled. Void the label and buy again, or fulfill by hand in Shopify.` } }
  }

  // Shippo has the last word on the label: a row can be planted, or the label voided by hand in
  // the Shippo dashboard while its row still reads 'purchased'.
  const live2 = await labelIsLive(row)
  if (!live2.ok) return { status: live2.status, body: { error: live2.error, ...(live2.code ? { code: live2.code } : {}) } }
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
  let retail = body.kind === 'retail'   // anything else, or nothing, is B2B (unless the order has a live retail label, below)
  let tracking = !retail && Array.isArray(body.tracking) ? body.tracking : []   // retail: read from the DB below
  const company = 'UPS'
  let orderId = body.order_id
  if (retail ? !orderId : (!orderId || !tracking.length)) return res.status(400).json({ error: retail ? 'order_id required' : 'order_id and tracking[] required' })
  // A box with no number is refused, never dropped: dropping it would fulfill and email the
  // customer with fewer tracking numbers than boxes.
  if (!retail && !tracking.every(t => t && typeof t.number === 'string' && t.number.trim())) {
    return res.status(400).json({ error: 'Every box needs a tracking number.' })
  }
  if (retail) {
    // One spelling, as the label rows are stored (shippo-label.js canonicalOrderId).
    const n = orderNumericId(orderId)
    if (!n) return res.status(400).json({ error: 'order_id is not a Shopify order id' })
    orderId = `gid://shopify/Order/${String(BigInt(n))}`
  } else if (!String(orderId).startsWith('gid://')) orderId = `gid://shopify/Order/${String(orderId).replace(/[^0-9]/g, '')}`
  // No kind: an order with a live retail label is retail whatever the body says, so the page's
  // tracking numbers can't stand in for the label's. A lookup that fails leaves B2B as it was.
  if (!retail) {
    const lab = await rpc('ship_labels_for_order', { p_order_id: String(orderId) }, session.token, LOOKUP_TIMEOUT_MS)
    if (lab.ok && Array.isArray(lab.data) && lab.data.some(x => x && x.status === 'purchased' && x.channel === 'retail')) retail = true
  }
  // Retail: the customer email is always on. Only Clear (only_if_fulfilled) says otherwise, and it creates nothing.
  const notifyCustomer = retail && body.only_if_fulfilled !== true ? true : body.notifyCustomer !== false

  const { SHOPIFY_STORE_HANDLE } = process.env
  let locked = false
  try {
    if (retail) {
      // One fulfiller, voider or hold-back per order at a time. Taken before anything is read, so
      // what is read is still true when the fulfillment is written; released below, whatever happens.
      const got = await rpc('claim_order_fulfill', { p_order_id: orderId }, session.token, LOOKUP_TIMEOUT_MS)
      if (!got.ok) {
        console.warn(`shopify-fulfill: order lock failed (${got.why}); nothing fulfilled`)
        return res.status(503).json({ error: "Couldn't take the order's lock (is db/2026-10-20-label-held-back.sql applied?), so nothing was fulfilled. Try again in a minute.", emailed: false })
      }
      if (got.data !== true) return res.status(409).json({ code: 'busy', error: 'Another device is fulfilling or voiding this order right now. Nothing was fulfilled. Try again in a moment.', emailed: false })
      locked = true
    }
    const tk = await getToken()
    if (tk.error) return res.status(500).json({ error: 'Shopify token exchange failed', detail: tk.error })
    const gql = async (query, variables) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), settings.shopifyTimeoutMs)
      try {
        const r = await fetch(`https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': tk.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: ctrl.signal
        })
        return await r.json()
      } finally {
        clearTimeout(timer)
      }
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
    // the page (or from a shipping_labels row that was planted) would put an arbitrary link
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
    // Shopify didn't answer in time: the fulfillment may or may not exist. Fulfilling again is safe.
    if (err && err.name === 'AbortError') return res.status(504).json({ error: "Shopify didn't answer in time. Nothing may have been fulfilled; tap Fulfill again (it never sends a second email).", emailed: false })
    return res.status(500).json({ error: err.message })
  } finally {
    if (locked) await rpc('release_order_fulfill', { p_order_id: orderId }, session.token, LOOKUP_TIMEOUT_MS)
  }
}

module.exports.settings = settings
