// api/shippo-label.js — UPS Ground rate + label via Shippo (ADR 0020). Server-side so the
// Shippo token never reaches the browser.
//
//   POST /api/shippo-label?action=rate    { address_to, parcel, weight_basis } -> UPS Ground rate (no purchase)
//   POST /api/shippo-label?action=label   { address_to, parcel, weight_basis, expected_amount,
//                                           order_id, order_name, box_index, box_count }
//                                         -> buys label; returns tracking + 4x6 PDF label_url + cost
//
//   parcel: { length, width, height, weight }  numbers; inches; weight = declared whole pounds,
//           tare included (declaredWeightLb in index.html). weight_basis must be 'packed':
//           a page loaded before ADR 0020 sends net coffee weight and no basis, and is refused.
//   expected_amount: the rate the operator confirmed. The label step re-rates; if the fresh
//           price is higher, nothing is bought (409) and the new price comes back.
//   pack_sig: the whole pack as the page sees it (packSignature in lib/ship-rules.js), required
//           for a label. Before buying, the order is fetched from Shopify and repacked with the
//           same file (B2a, ADR 0025). The whole pack must match pack_sig and this box's parcel
//           must be its own; otherwise 409 { code: 'pack_changed' }, nothing bought, and the
//           page stops buying the rest of the order.
//   kind: 'b2b' (absent = b2b, for pages from before B3) or 'retail' (B3, ADR 0026): which
//           packer the server repacks with. Retail: the order is read through GraphQL, must
//           classify LIST (else 409 { code: 'not_listed', class }), and packs to one carton
//           (packRetail), so box_index = box_count = 1. Anything else is refused (400).
//           Retail rates (when order_id is sent) and buys at the address Shopify has now, not the
//           page's address_to (B3a, ADR 0028): a fix made in Shopify after the list loaded is the
//           one that gets the label. A P.O. box or a line over 35 there is refused (409 code 'address').
//   carrier: optional; anything other than 'ups' is refused (400). Every shipment is UPS
//   Ground (ups_ground) on Torque's US UPS account. Never Ground Saver, never USPS, no fallback.
//
//
//   POST /api/shippo-label?action=void    { order_id, box_index } -> voids that box's unused label
//           through Shippo's refunds API and marks its row voided (B6). Signed-in staff only.
//           Refused (409) when the row is fulfilled, or Shopify shows the order fulfilled in
//           any part; refused (503) when either can't be checked. Nothing else is changed.
//
// Origin is fixed here (Torque) — single source of truth for the ship-from.
// Token is read from process.env.SHIPPO_TOKEN (the live token).

const fetch = globalThis.fetch || require('node-fetch')
const { requireUser, supabaseHeaders } = require('./_auth')
const { fetchOrder, orderNumericId } = require('./_shopify')
const { fetchRetailOrder, checkRetailOrder } = require('./_retail')
const { rpc } = require('./_supabase')
const { b2bShipItems, packB2BItems, boxParcel, packSignature, UPS_LINE_MAX, cleanText, isPoBox } = require('../lib/ship-rules.js')

const SHIPPO_BASE = 'https://api.goshippo.com'
const SERVICE_TOKEN = 'ups_ground'   // NOT ups_ground_saver
// The US UPS account on the Shippo login. A second UPS account (Canada, 588f0f77…) exists
// on the same login; pinning keeps every rate on this one.
const UPS_ACCOUNT = '21db4cf80df74a2cb27fc20948862003'

const ORIGIN = {
  name: 'Torque Coffee',
  street1: '3459 El Cajon Blvd',
  city: 'San Diego',
  state: 'CA',
  zip: '92104',
  country: 'US',
  phone: '6192305400',
  email: 'production@torque.coffee'
}

// Recipient address as sent to Shippo: known string fields only. No email ever (the one
// customer email comes from Shopify on fulfillment; a recipient email makes Shippo send its
// own notice). No phone on the order -> Torque's phone (R5).
const ADDRESS_FIELDS = ['name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone']
const RAW_FIELD_MAX = 200    // anything longer is not an address; refuse before normalizing it
// Cutting these would misdeliver the box, so a line that's too long is refused, not cut.
const STRICT_FIELDS = { street1: 'Address line 1', street2: 'Address line 2', city: 'City' }
// UPS_LINE_MAX, cleanText and isPoBox live in lib/ship-rules.js: the retail queue (B1) runs the
// same checks at list time (addressProblem), so an address it lets through is one this accepts.
// -> { address } or { error }
function recipientAddress(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'address_to required' }
  const out = {}
  for (const k of ADDRESS_FIELDS) {
    const v = a[k]
    if (typeof v !== 'string') { out[k] = ''; continue }
    if (v.length > RAW_FIELD_MAX) return { error: `Address field ${k} is too long.` }
    const t = cleanText(v)
    const chars = Array.from(t)   // by code point: never split an emoji
    if (STRICT_FIELDS[k] && chars.length > UPS_LINE_MAX) {
      return { error: `${STRICT_FIELDS[k]} is longer than UPS allows (${UPS_LINE_MAX} characters). Shorten it in Shopify (for example, move the suite to line 2), then re-rate.` }
    }
    out[k] = chars.slice(0, UPS_LINE_MAX).join('')
  }
  if (!out.phone) out.phone = ORIGIN.phone
  if (!out.country) out.country = 'US'
  return { address: out }
}
// The confirmed price, as the page sends it (Number(...).toFixed(2)).
const AMOUNT_RX = /^\d{1,4}(\.\d{1,2})?$/

// Parcel as sent to Shippo: numbers only, weight a whole pound count >= 1.
function cleanParcel(p) {
  if (!p || typeof p !== 'object') return null
  const dims = [p.length, p.width, p.height]
  if (!dims.every(d => typeof d === 'number' && Number.isFinite(d) && d > 0)) return null
  if (!(typeof p.weight === 'number' && Number.isInteger(p.weight) && p.weight >= 1)) return null
  return { length: p.length, width: p.width, height: p.height, weight: p.weight }
}

// Existing label for this order + box, via the SECURITY DEFINER RPC from ADR 0011 (no SELECT
// on shipping_labels). Runs as the caller (ADR 0023): anon has no EXECUTE once the RLS
// migration is in.
//   { ok: true, label }  label = the box's non-voided label, or null when it has none
//   { ok: false, why }   the lookup could not be made or was refused
// A failed lookup stops the buy (ADR 0023, reversing ADR 0020's R8 reading for this check):
// whatever breaks the lookup (Supabase down, a refused token) usually breaks the cost-row
// insert too, so a label bought then exists nowhere in the DB and the next tap buys it again.
const LOOKUP_TIMEOUT_MS = 5000
async function existingLabel(orderId, boxIndex, userToken) {
  const r = await rpc('ship_labels_for_order', { p_order_id: String(orderId) }, userToken, LOOKUP_TIMEOUT_MS)
  if (!r.ok) return { ok: false, why: r.why === 'not configured' ? 'SUPABASE_URL/SUPABASE_ANON_KEY not configured' : r.why }
  if (!Array.isArray(r.data)) return { ok: false, why: 'unexpected response' }
  return { ok: true, label: r.data.find(x => Number(x.box_index) === boxIndex && x.status !== 'voided') || null }
}

// claim_label_box / release_label_box (db/2026-10-18-label-claims.sql), as the caller.
// Returns the function's boolean, or a string saying why it couldn't be called.
async function labelClaim(fn, orderId, boxIndex, userToken) {
  const r = await rpc(fn, { p_order_id: String(orderId), p_box_index: boxIndex }, userToken, LOOKUP_TIMEOUT_MS)
  if (!r.ok) return r.why
  return typeof r.data === 'boolean' ? r.data : 'unexpected response'
}

// Seconds until the (already verified) access token expires; 0 if it can't be read.
const MIN_TOKEN_LIFE_S = 120
function tokenSecondsLeft(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return Number(payload.exp) - Date.now() / 1000
  } catch (e) { return 0 }
}

// A shipping_labels row checked against Shippo: the transaction must exist, have succeeded and
// carry the same tracking number. Returns Shippo's own values, or null.
async function confirmWithShippo(prior, auth) {
  const id = String(prior.shippo_object_id || '')
  if (!/^[0-9a-f]{32}$/i.test(id)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS)
  try {
    const r = await fetch(`${SHIPPO_BASE}/transactions/${id}`, { headers: auth, signal: ctrl.signal })
    if (r.status !== 200) return null
    const t = await r.json()
    if (!t || t.status !== 'SUCCESS' || !t.tracking_number || t.tracking_number !== prior.tracking_number) return null
    return { tracking_number: t.tracking_number, tracking_url: t.tracking_url_provider || null, label_url: t.label_url || null, shippo_object_id: t.object_id || id }
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// The pack the server itself makes for this order (B2a), with the packer `kind` names (B3).
//   { ok: true, pack }   { ok: false, status, error, code?, class? }
async function serverPack(kind, orderId) {
  if (kind === 'retail') return checkRetailOrder(orderId, 'bought')   // the list's rules and the retail packer, shared with fulfill
  const got = await fetchOrder(orderId)
  if (!got.ok) {
    if (got.status === 400) return { ok: false, status: 400, error: 'order_id is not a Shopify order id' }
    if (got.status === 404) return { ok: false, status: 409, code: 'pack_changed', error: "Shopify has no such order. Nothing was bought. Reload the orders." }
    console.warn(`serverPack: Shopify ${kind} order fetch failed (${got.why}); nothing bought`)
    return { ok: false, status: 503, error: "Couldn't read the order from Shopify to check the boxes, so nothing was bought. Try again in a minute; if it repeats, tell Andy." }
  }
  if (got.order.cancelled_at) return { ok: false, status: 409, code: 'pack_changed', error: 'This order is cancelled in Shopify. Nothing was bought.' }
  return { ok: true, pack: packB2BItems(b2bShipItems(got.order.line_items)) }
}

// The page's parcel and pack checked against the server's own pack. The page packs from the
// order list it loaded; the order may have been edited since, or the page may be out of date or
// tampered with. The whole pack is compared, not only this box: an order that changed buys
// nothing, rather than some boxes of a packing that no longer exists.
//   { ok: true }   { ok: false, status, error, code?, class? }
//   (retail: also `order`, the order as Shopify has it now, for its address)
async function checkPackedBox(kind, orderId, boxIndex, boxCount, parcel, pageSig) {
  const got = await serverPack(kind, orderId)
  if (!got.ok) return got
  const pack = got.pack
  if (pack.unpackable.length) return { ok: false, status: 409, code: 'pack_changed', error: "This order has an item the packer can't weigh. Nothing was bought. Ship it by hand or fix the item in Shopify." }
  const sig = packSignature(pack.boxes)
  const box = pack.boxes[boxIndex - 1]
  const want = box ? boxParcel(box) : null
  if (pack.boxes.length && !sig) return { ok: false, status: 409, code: 'pack_changed', error: "This order's boxes can't be weighed. Nothing was bought. Tell Andy." }
  const same = want && sig === pageSig && pack.box_count === boxCount &&
    want.length === parcel.length && want.width === parcel.width && want.height === parcel.height && want.weight === parcel.weight
  if (!same) {
    console.warn(`checkPackedBox: ${kind} ${orderId} box ${boxIndex}: page ${pageSig} ${JSON.stringify(parcel)}, server ${sig} ${JSON.stringify(want)}`)
    return { ok: false, status: 409, code: 'pack_changed', error: `This order changed since the list was loaded (Shopify now packs it as ${sig || 'nothing to ship'}). Nothing was bought. Go back to the orders, refresh, and open it again.` }
  }
  return { ok: true, order: got.order || null }
}

// A retail order's ship-to as Shopify has it now (B3a, ADR 0028), checked like a page address.
// Retail rates and buys at this address, never the page's: an address fixed in Shopify after the
// list loaded is the one that gets the label, and Re-rate quotes it.
//   { address } or { status, error }
function retailRecipient(order) {
  const a = (order && order.address) || {}
  const got = recipientAddress({ name: a.name, company: '', street1: a.address1, street2: a.address2, city: a.city,
    state: a.province, zip: a.zip, country: a.country || '', phone: a.phone })
  if (got.error) return { status: 409, error: got.error }
  if (isPoBox(got.address.street1) || isPoBox(got.address.street2)) return { status: 409, error: 'UPS does not deliver to P.O. boxes. Get a street address for this order.' }
  if (!got.address.street1 || !got.address.city || !got.address.zip) return { status: 409, error: 'The ship-to address in Shopify has no street, city or ZIP. Fix it in Shopify.' }
  // What the page shows and prints on the slip (the street is on the label only).
  const shown = { name: got.address.name, city: got.address.city, province: got.address.state, zip: got.address.zip }
  return { address: got.address, shown }
}

// mark_ship_label_voided (db/2026-10-19-label-void.sql), as the caller. -> the row count it
// returns (1 = marked), or a string saying why it couldn't be called.
async function markLabelVoided(orderId, boxIndex, shippoId, userToken) {
  const r = await rpc('mark_ship_label_voided', { p_order_id: String(orderId), p_box_index: boxIndex, p_shippo_object_id: shippoId }, userToken, LOOKUP_TIMEOUT_MS)
  if (!r.ok) return r.why
  return typeof r.data === 'number' ? r.data : 'unexpected response'
}

// Every label row is stored under "gid://shopify/Order/<n>" (all 231 live rows, 2026-10-19).
// The lookup and the claim compare the id as a string, so "8333" or "08333" would miss the row
// for the same order and buy its box again: every label and void call uses this one spelling.
function canonicalOrderId(orderId) {
  const n = orderNumericId(orderId)
  return n ? `gid://shopify/Order/${String(BigInt(n))}` : null
}

// B6: void one box's unused label. Order: the row (must be 'purchased') -> Shopify (no
// fulfillment of any part) -> Shippo confirms the transaction -> refund -> mark the row. Any
// check that can't be made stops before Shippo is asked for anything.
const REFUND_OK = ['QUEUED', 'PENDING', 'SUCCESS']
async function voidLabel(req, res, session, auth) {
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}') } catch { body = {} } }
  body = body || {}
  const boxIndex = Number(body.box_index)
  if (!orderNumericId(body.order_id) || !(Number.isInteger(boxIndex) && boxIndex >= 1)) {
    return res.status(400).json({ error: 'order_id (a Shopify order id) and box_index are required to void a label' })
  }
  const orderId = canonicalOrderId(body.order_id)   // the one spelling the rows are stored under
  let voidLock = null
  try {
    const lookup = await existingLabel(orderId, boxIndex, session.token)
    if (!lookup.ok) {
      console.warn(`voidLabel: lookup failed (${lookup.why}); nothing voided`)
      return res.status(503).json({ error: "Couldn't read this box's label record, so nothing was voided. Try again in a minute." })
    }
    let row = lookup.label
    if (!row) return res.status(404).json({ error: 'This box has no label to void.' })
    // A retail label shares one lock with Fulfill (db/2026-10-20-label-held-back.sql): a void can't
    // refund a label while Fulfill is about to email its tracking number, and two devices can't
    // void one label together. The row is read again once the lock is held.
    if (row.channel === 'retail') {
      const got = await rpc('claim_order_fulfill', { p_order_id: orderId }, session.token, LOOKUP_TIMEOUT_MS)
      if (!got.ok) {
        console.warn(`voidLabel: fulfill lock failed (${got.why}); nothing voided`)
        return res.status(503).json({ error: "Couldn't take the order's lock (is db/2026-10-20-label-held-back.sql applied?), so nothing was voided. Try again in a minute." })
      }
      if (got.data !== true) return res.status(409).json({ code: 'busy', error: 'Another device is fulfilling or voiding this order right now. Nothing was voided. Try again in a moment.' })
      voidLock = orderId
      const again = await existingLabel(orderId, boxIndex, session.token)
      if (!again.ok) return res.status(503).json({ error: "Couldn't read this box's label record, so nothing was voided. Try again in a minute." })
      row = again.label
      if (!row) return res.status(404).json({ error: 'This box has no label to void.' })
    }
    if (row.status !== 'purchased') {
      return res.status(409).json({ error: `This label is ${row.status}, so it can't be voided here. Nothing was changed.` })
    }
    // The row flips to fulfilled only after the fulfill call; an order fulfilled by hand in
    // Shopify, or a fulfill whose row flip failed, still says purchased. Ask Shopify too.
    const got = await fetchOrder(orderId)
    if (!got.ok) {
      if (got.status === 404) return res.status(409).json({ error: "Shopify has no such order, so nothing was voided. Void it in Shippo by hand if it's really unused." })
      console.warn(`voidLabel: Shopify order fetch failed (${got.why}); nothing voided`)
      return res.status(503).json({ error: "Couldn't check the order in Shopify, so nothing was voided. Try again in a minute." })
    }
    const lines = got.order.line_items || []
    if (got.order.fulfillment_status != null || lines.some(l => l.fulfillment_status)) {
      return res.status(409).json({ error: 'This order is already fulfilled in Shopify (the customer has the tracking number). Nothing was voided.' })
    }
    const confirmed = await confirmWithShippo(row, auth)
    if (!confirmed) {
      console.warn(`voidLabel: row for ${orderId} box ${boxIndex} not confirmed by Shippo; nothing voided`)
      return res.status(409).json({ error: "Shippo doesn't confirm this label, so nothing was voided. Tell Andy." })
    }
    const refundRes = await fetch(`${SHIPPO_BASE}/refunds/`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ transaction: confirmed.shippo_object_id, async: false })
    })
    const refund = await refundRes.json().catch(() => null)
    if (!refundRes.ok || !refund || !REFUND_OK.includes(refund.status)) {
      console.warn(`voidLabel: refund refused for ${confirmed.shippo_object_id}: ${refundRes.status} ${JSON.stringify(refund).slice(0, 300)}`)
      return res.status(502).json({ error: 'Shippo refused the void. The label is still live; nothing was changed.', status: refund && refund.status, detail: refund })
    }
    const marked = await markLabelVoided(orderId, boxIndex, confirmed.shippo_object_id, session.token)
    if (marked !== 1) {
      // The refund is in; only the record is behind. Say so: the box would still read as bought.
      console.warn(`voidLabel: refund ${refund.object_id} in, row not marked (${marked})`)
      return res.status(200).json({ ok: true, voided: true, row_marked: false, refund_status: refund.status, refund_id: refund.object_id || null,
        error: "The label is voided in Shippo, but the portal's record wasn't updated. Tell Andy before rebuying this box." })
    }
    return res.status(200).json({ ok: true, voided: true, row_marked: true, refund_status: refund.status, refund_id: refund.object_id || null, tracking_number: confirmed.tracking_number })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  } finally {
    if (voidLock) await rpc('release_order_fulfill', { p_order_id: voidLock }, session.token, LOOKUP_TIMEOUT_MS)
  }
}

module.exports = async function handler(req, res) {
  // Same-origin only: no CORS headers (the page is the only caller).
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // A purchase needs a signed-in staff user from the first deploy on (ADR 0023); rating is
  // only enforced once PORTAL_AUTH_ENFORCE=1.
  // A retail quote reads the customer's order from Shopify (B3a), so it is signed-in only too.
  // Decided on the parsed body: a text/plain body arrives as a string and must not slip past.
  let parsed = req.body
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed || '{}') } catch { parsed = {} } }
  const readsOrder = !!(parsed && typeof parsed === 'object' && parsed.kind === 'retail')
  const session = await requireUser(req, res, { always: req.query.action === 'label' || req.query.action === 'void' || readsOrder })
  if (!session) return

  const token = process.env.SHIPPO_TOKEN
  if (!token) return res.status(500).json({ error: 'SHIPPO_TOKEN not configured' })

  // Exactly 'rate', 'label' or 'void'. Anything else (a typo, a repeated param) must never fall
  // through to the purchase.
  const action = req.query.action == null ? 'rate' : req.query.action
  if (action !== 'rate' && action !== 'label' && action !== 'void') return res.status(400).json({ error: "action must be 'rate', 'label' or 'void'" })
  if (action === 'void') return voidLabel(req, res, session, { 'Authorization': `ShippoToken ${token}`, 'Content-Type': 'application/json' })

  const body = parsed || {}
  if (body.carrier != null && String(body.carrier).toLowerCase() !== 'ups') {
    return res.status(400).json({ error: 'Only UPS Ground is allowed. Reload the page and rate again.' })
  }
  // A page loaded before ADR 0020 sends the net coffee weight; it must not buy at that weight.
  const kind = body.kind == null ? 'b2b' : body.kind
  if (kind !== 'b2b' && kind !== 'retail') return res.status(400).json({ error: "kind must be 'b2b' or 'retail'" })
  if (body.weight_basis !== 'packed') {
    return res.status(400).json({ error: 'This page is out of date (it sends coffee weight, not packed weight). Reload the page and rate again.' })
  }
  const addr = recipientAddress(body.address_to)
  if (addr.error) return res.status(400).json({ error: addr.error })
  let address_to = addr.address
  let shipTo = null               // retail: the ship-to the label goes to (no street), for the slip
  let orderName = typeof body.order_name === 'string' ? body.order_name.slice(0, 40) : null
  if (isPoBox(address_to.street1) || isPoBox(address_to.street2)) {
    return res.status(400).json({ error: 'UPS does not deliver to P.O. boxes. Get a street address for this order.' })
  }
  const parcel = cleanParcel(body.parcel)
  if (!parcel) return res.status(400).json({ error: 'parcel needs numeric length, width and height, and a whole-pound weight of at least 1' })
  const rawExpected = body.expected_amount
  const expected = Number(rawExpected)
  const expectedOk = (typeof rawExpected === 'string' || typeof rawExpected === 'number') &&
    AMOUNT_RX.test(String(rawExpected)) && expected > 0
  if (action === 'label' && !expectedOk) {
    return res.status(400).json({ error: 'expected_amount (the confirmed rate, e.g. "16.43") is required to buy a label' })
  }
  const boxIndex = Number(body.box_index)
  const boxCount = Number(body.box_count)
  if (action === 'label' && !(body.order_id && Number.isInteger(boxIndex) && boxIndex >= 1 &&
      Number.isInteger(boxCount) && boxCount >= boxIndex)) {
    return res.status(400).json({ error: 'order_id, box_index and box_count are required to buy a label' })
  }
  const orderId = body.order_id == null ? null : canonicalOrderId(body.order_id)
  if (body.order_id != null && !orderId) return res.status(400).json({ error: 'order_id is not a Shopify order id' })
  if (action === 'label' && !(typeof body.pack_sig === 'string' && body.pack_sig.length <= 2000)) {
    return res.status(400).json({ error: 'This page is out of date (it sends no pack). Reload the page and open the order again.' })
  }

  const auth = { 'Authorization': `ShippoToken ${token}`, 'Content-Type': 'application/json' }

  try {
    // 0) One label per box. If this box already has a label (a lost response, a second tab, a
    // reopened order), hand that label back instead of buying another. R9: a reload never
    // re-buys. If the lookup can't be made, nothing is bought (ADR 0023): a delayed box beats
    // a second charge with no record of the first.
    if (action === 'label') {
      // The cost row is written with this same token after the purchase. If it expired during
      // the Shippo call, the label would be bought and recorded nowhere. Ask for a fresh one
      // first: the page refreshes its session on a 401 and retries, and nothing is bought yet.
      if (tokenSecondsLeft(session.token) < MIN_TOKEN_LIFE_S) {
        return res.status(401).json({ error: 'Your session is about to expire. Try again.' })
      }
      const lookup = await existingLabel(orderId, boxIndex, session.token)
      if (!lookup.ok) {
        console.warn(`existingLabel: lookup failed (${lookup.why}); nothing bought`)
        return res.status(503).json({ error: "Couldn't check whether this box already has a label, so nothing was bought. Try again in a minute; if it repeats, tell Andy." })
      }
      const prior = lookup.label
      if (prior) {
        // The row is only a claim: anyone who can insert into shipping_labels could plant one and
        // stop the real purchase, then have the page print their label and email their tracking
        // number. Hand back only what Shippo itself confirms for that transaction.
        const confirmed = await confirmWithShippo(prior, auth)
        if (!confirmed) {
          console.warn(`existingLabel: row for ${orderId} box ${boxIndex} not confirmed by Shippo; nothing bought`)
          return res.status(409).json({ error: "This box has a label record that Shippo doesn't confirm. Nothing was bought. Tell Andy." })
        }
        return res.status(409).json({ error: 'Already bought', ...confirmed })
      }
      // The parcel must be the one the server packs for this box (B2a).
      const check = await checkPackedBox(kind, orderId, boxIndex, boxCount, parcel, body.pack_sig)
      if (!check.ok) return res.status(check.status).json({ error: check.error, ...(check.code ? { code: check.code } : {}), ...(check.class ? { class: check.class } : {}) })
      if (kind === 'retail') {
        const to = retailRecipient(check.order)
        if (to.error) return res.status(to.status).json({ error: to.error, code: 'address' })
        address_to = to.address
        shipTo = to.shown
        orderName = check.order.order_name || orderName
      }
    } else if (kind === 'retail' && orderId) {
      // A retail quote is for the address Shopify has now (see retailRecipient).
      const got = await fetchRetailOrder(orderId)
      if (!got.ok) {
        if (got.status === 404) return res.status(409).json({ error: 'Shopify has no such order. Refresh the orders.', code: 'not_listed' })
        return res.status(503).json({ error: "Couldn't read the order from Shopify, so there is no quote. Try again in a minute." })
      }
      const to = retailRecipient(got.order)
      if (to.error) return res.status(to.status).json({ error: to.error, code: 'address' })
      address_to = to.address
      shipTo = to.shown
    }

    // 1) Rate the shipment.
    const shipmentRes = await fetch(`${SHIPPO_BASE}/shipments/`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        address_from: ORIGIN,
        address_to,
        parcels: [{
          length: String(parcel.length), width: String(parcel.width), height: String(parcel.height),
          distance_unit: 'in', weight: String(parcel.weight), mass_unit: 'lb'
        }],
        carrier_accounts: [UPS_ACCOUNT],
        async: false
      })
    })
    // A throttle or an outage is not "no rate": saying so would send the operator to fix an
    // address that is fine. Nothing has been bought at this point.
    if (shipmentRes.status === 429) return res.status(429).json({ error: 'Shippo is busy (too many requests). Nothing was bought. Try again in a minute.' })
    if (shipmentRes.status >= 500) return res.status(502).json({ error: `Shippo didn't answer the rate request (status ${shipmentRes.status}). Nothing was bought. Try again.` })
    const shipment = await shipmentRes.json()
    const rates = shipment.rates || []
    const upsRate = rates.find(r => r.servicelevel && r.servicelevel.token === SERVICE_TOKEN && r.carrier_account === UPS_ACCOUNT)
    // A price that can't be read, or isn't in USD, is never shown as buyable (fail closed).
    const fresh = upsRate ? Number(upsRate.amount) : NaN
    if (upsRate && !(Number.isFinite(fresh) && fresh > 0 && upsRate.currency === 'USD')) {
      return res.status(422).json({ error: "UPS returned a price that can't be used. Nothing was bought. Re-rate; if it repeats, tell Andy.", rates: [], messages: shipment.messages || [] })
    }
    if (!upsRate) {
      // Edge case: box disqualified / no rate for the required service — surface the rates,
      // never silently buy a different service or carrier.
      return res.status(422).json({
        error: 'No UPS Ground rate returned',
        // 'other' = a rate from another carrier account on the login (e.g. the Canada UPS
        // account): shown so the operator isn't misled, never bought.
        rates: rates.map(r => ({ service: r.servicelevel && r.servicelevel.token, amount: r.amount, account: r.carrier_account === UPS_ACCOUNT ? 'torque-us' : 'other' })),
        messages: shipment.messages || []
      })
    }

    const rateOut = {
      service: upsRate.servicelevel.token,
      service_name: upsRate.servicelevel.name,
      amount: upsRate.amount,
      currency: upsRate.currency,
      zone: upsRate.zone,
      estimated_days: upsRate.estimated_days,
      rate_id: upsRate.object_id
    }

    if (action === 'rate') return res.status(200).json({ ok: true, action: 'rate', ...rateOut, ...(shipTo ? { ship_to: shipTo } : {}) })

    // The label step re-rates. UPS prices move (address reclassified to commercial, delivery
    // area surcharge), so a price above the confirmed one buys nothing. Same or lower buys.
    // 0.005 absorbs float noise.
    if (fresh > expected + 0.005) {
      return res.status(409).json({ error: 'Price changed', quoted: expected.toFixed(2), amount: String(upsRate.amount), currency: upsRate.currency })
    }

    // 2) Claim the box. The lookup above can't stop two devices that both passed it a moment
    // ago; the claim is one row per (order, box), so only one of them buys (ADR 0023).
    const claim = await labelClaim('claim_label_box', orderId, boxIndex, session.token)
    if (claim !== true) {
      if (claim === false) return res.status(409).json({ error: 'This box is being bought on another device right now. Wait a minute, then reopen the order.' })
      console.warn(`claim_label_box failed (${claim}); nothing bought`)
      return res.status(503).json({ error: "Couldn't reserve this box for buying, so nothing was bought. Try again in a minute; if it repeats, tell Andy." })
    }

    // 3) Buy the label as a native 4x6 PDF (PDF_4x6) — the physical MediaBox is the 4x6
    // page itself, which is what AirPrint/Rollo needs. Server-side /api/ship-doc merges
    // this PDF page with the drawn packing-slip page into one combined 4x6 PDF opened in
    // a Safari tab. See ADR 0009.
    const txnRes = await fetch(`${SHIPPO_BASE}/transactions/`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ rate: upsRate.object_id, label_file_type: 'PDF_4x6', async: false })
    })
    let txn = null
    try { txn = await txnRes.json() } catch (e) { txn = null }
    // The box is freed only when Shippo says plainly that nothing was bought: status ERROR, or a
    // 4xx refusal. Anything else (QUEUED, WAITING, SUCCESS with no tracking number, a 5xx, an
    // unreadable answer) may yet be a bought label: keep the claim so nothing buys the box again.
    const refused = (txn && txn.status === 'ERROR') || (txnRes.status >= 400 && txnRes.status < 500)
    if (!refused && !(txn && txn.status === 'SUCCESS' && txn.tracking_number)) {
      txn = txn || {}
      console.warn(`label: Shippo transaction ${txn.object_id || '?'} for ${orderId} box ${boxIndex} is ${txn.status}; claim kept`)
      return res.status(502).json({ error: `Shippo hasn't finished this label (${String(txn.status || 'no status').slice(0, 20)}). Don't buy it again: check Shippo in a few minutes and tell Andy.`, code: 'label_pending' })
    }
    if (txn.status !== 'SUCCESS' || !txn.tracking_number) {
      // Label purchase failed — caller must NOT mark the order fulfilled or notify. Nothing
      // was bought, so the box can be tried again at once. (A thrown error above keeps the
      // claim: Shippo may have bought it, and the claim blocks a re-buy until it goes stale.)
      await labelClaim('release_label_box', orderId, boxIndex, session.token)
      txn = txn || {}
      if (txnRes.status === 429) return res.status(429).json({ error: 'Shippo is busy (too many requests). Nothing was bought. Try again in a minute.' })
      return res.status(502).json({ error: 'Label purchase failed', status: txn.status, messages: txn.messages || [] })
    }

    // Cost capture (Step 4b): write the cost row at purchase — the cost exists only in
    // this response. NON-BLOCKING: a failed log must never block the shipment.
    let cost_logged = false, cost_log_error = null
    try {
      const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
      if (!SB_URL || !SB_KEY) {
        cost_log_error = 'SUPABASE_URL/SUPABASE_ANON_KEY not configured'
      } else {
        const row = {
          order_id: orderId,
          order_name: orderName,       // retail: Shopify's own name for the order
          box_index: boxIndex,      // the validated numbers: a raw "1e0" would fail the integer column
          box_count: boxCount,      // and leave a bought label recorded nowhere

          cost: upsRate.amount,
          currency: upsRate.currency,
          service: upsRate.servicelevel.token,
          is_cubic: false,   // column predates UPS; cubic was a USPS-only tier
          zone: upsRate.zone || null,
          dest_zip: address_to.zip || null,
          weight_lb: parcel.weight,   // declared (billed) weight since ADR 0020; net before it
          tracking_number: txn.tracking_number,
          // Stored so the ship screen can be rebuilt from the DB alone if the app
          // page is reloaded/discarded mid-flow (tracking to fulfil, label to reprint).
          tracking_url: txn.tracking_url_provider || null,
          label_url: txn.label_url || null,
          shippo_object_id: txn.object_id,
          status: 'purchased'
        }
        // Which tab the label belongs to (db/2026-10-19-label-channel.sql, ADR 0028). B2B rows
        // take the column's default and never send it, so B2B is unaffected by the migration.
        if (kind === 'retail') row.channel = 'retail'
        const insert = r => fetch(`${SB_URL}/rest/v1/shipping_labels`, {
          method: 'POST',
          // Plain insert (not upsert): upsert's conflict-read needs a SELECT policy we
          // intentionally don't grant. The unique(shippo_object_id) constraint dedupes;
          // a rare retry 409s and is swallowed by this non-blocking guard.
          // As the signed-in user (ADR 0023): the insert policy is `to authenticated`.
          headers: supabaseHeaders(session.token, { Prefer: 'return=minimal' }),
          body: JSON.stringify(r)
        })
        // A label is bought: try hard to record it. One more try after a network error or a 5xx.
        let sbRes, retried = false
        try { sbRes = await insert(row) } catch (e) { sbRes = null }
        if (!sbRes || sbRes.status >= 500) { retried = true; sbRes = await insert(row) }
        // The column isn't there (migration not applied, or rolled back): the label is bought, so
        // record it without the channel rather than not at all. A missing row would let the box
        // be bought again once its claim goes stale. Only PostgREST's "no such column" (PGRST204).
        let errText = sbRes.ok ? '' : await sbRes.text()
        if (!sbRes.ok && row.channel && /PGRST204/.test(errText) && /'channel'/.test(errText)) {
          const { channel, ...plain } = row
          sbRes = await insert(plain)
          errText = sbRes.ok ? '' : await sbRes.text()
          console.warn('cost row: shipping_labels has no channel column; written without it (apply db/2026-10-19-label-channel.sql)')
        }
        // The retry found the row already there (unique shippo_object_id, 23505): the first try
        // did write it; only its answer was lost.
        if (!sbRes.ok && retried && sbRes.status === 409 && /23505/.test(errText)) cost_logged = true
        else if (sbRes.ok) cost_logged = true
        else cost_log_error = `supabase ${sbRes.status}: ${errText.slice(0, 200)}`
      }
    } catch (e) { cost_log_error = e.message }

    return res.status(200).json({
      ok: true, action: 'label',
      ...rateOut,
      cost: upsRate.amount,       // actual charged = the bought rate's amount
      tracking_number: txn.tracking_number,
      tracking_url: txn.tracking_url_provider,
      label_url: txn.label_url,
      label_file_type: 'PDF_4x6',
      shippo_object_id: txn.object_id,
      ...(shipTo ? { ship_to: shipTo } : {}),
      test: txn.test === true,
      cost_logged, cost_log_error
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
