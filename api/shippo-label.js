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
//   carrier: optional; anything other than 'ups' is refused (400). Every shipment is UPS
//   Ground (ups_ground) on Torque's US UPS account. Never Ground Saver, never USPS, no fallback.
//
// Origin is fixed here (Torque) — single source of truth for the ship-from.
// Token is read from process.env.SHIPPO_TOKEN (the live token).

const fetch = globalThis.fetch || require('node-fetch')

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
const UPS_LINE_MAX = 35      // UPS address line limit
const RAW_FIELD_MAX = 200    // anything longer is not an address; refuse before normalizing it
// Cutting these would misdeliver the box, so a line that's too long is refused, not cut.
const STRICT_FIELDS = { street1: 'Address line 1', street2: 'Address line 2', city: 'City' }
// NFC text for the label. Invisible format characters (zero-width, soft hyphen, bidi marks)
// are dropped; control characters become spaces.
function cleanText(v) {
  return v.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
}
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
// UPS does not deliver to P.O. boxes: "P.O. Box 12", "PO-Box 7", "P/O Box 5", "PO BOX 9",
// "POB 12", "P.O.B. 12", "Po Bx 4", "P0 Box 1", "Post Office Box 5", "Postal Box 9". A box
// word must be followed by a number, so a street named "Pobox Way" still ships. Tested on
// the NFKC form of the cleaned line.
const PO_BOX = /\b(?:p[\s.\-\/]*[o0][\s.\-\/]*b(?:o?x)?\.?|post(?:al)?\s+(?:office\s+)?box)\s*(?:#|no\.?)?\s*\d/i
const isPoBox = line => PO_BOX.test(line.normalize('NFKC'))
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

// Existing label for this order + box, via the SECURITY DEFINER RPC from ADR 0011 (no anon
// SELECT on shipping_labels). null when there is none, or when the lookup can't be made.
async function existingLabel(orderId, boxIndex) {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY
  if (!SB_URL || !SB_KEY) return null
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/ship_labels_for_order`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_order_id: String(orderId) })
    })
    if (!r.ok) return null
    const rows = await r.json()
    return (Array.isArray(rows) ? rows : []).find(x => Number(x.box_index) === boxIndex && x.status !== 'voided') || null
  } catch { return null }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = process.env.SHIPPO_TOKEN
  if (!token) return res.status(500).json({ error: 'SHIPPO_TOKEN not configured' })

  // Exactly 'rate' or 'label'. Anything else (a typo, a repeated param) must never fall
  // through to the purchase.
  const action = req.query.action == null ? 'rate' : req.query.action
  if (action !== 'rate' && action !== 'label') return res.status(400).json({ error: "action must be 'rate' or 'label'" })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}') } catch { body = {} } }
  body = body || {}
  if (body.carrier != null && String(body.carrier).toLowerCase() !== 'ups') {
    return res.status(400).json({ error: 'Only UPS Ground is allowed. Reload the page and rate again.' })
  }
  // A page loaded before ADR 0020 sends the net coffee weight; it must not buy at that weight.
  if (body.weight_basis !== 'packed') {
    return res.status(400).json({ error: 'This page is out of date (it sends coffee weight, not packed weight). Reload the page and rate again.' })
  }
  const addr = recipientAddress(body.address_to)
  if (addr.error) return res.status(400).json({ error: addr.error })
  const address_to = addr.address
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
  if (action === 'label' && !(body.order_id && Number.isInteger(boxIndex) && boxIndex >= 1)) {
    return res.status(400).json({ error: 'order_id and box_index are required to buy a label' })
  }

  const auth = { 'Authorization': `ShippoToken ${token}`, 'Content-Type': 'application/json' }

  try {
    // 0) One label per box. If this box already has a label (a lost response, a second tab, a
    // reopened order), hand that label back instead of buying another. R9: a reload never
    // re-buys. If the lookup itself fails, buying goes ahead (R8: logging never blocks).
    if (action === 'label') {
      const prior = await existingLabel(body.order_id, boxIndex)
      if (prior) {
        return res.status(409).json({ error: 'Already bought', tracking_number: prior.tracking_number, tracking_url: prior.tracking_url, label_url: prior.label_url, shippo_object_id: prior.shippo_object_id })
      }
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

    if (action === 'rate') return res.status(200).json({ ok: true, action: 'rate', ...rateOut })

    // The label step re-rates. UPS prices move (address reclassified to commercial, delivery
    // area surcharge), so a price above the confirmed one buys nothing. Same or lower buys.
    // 0.005 absorbs float noise.
    if (fresh > expected + 0.005) {
      return res.status(409).json({ error: 'Price changed', quoted: expected.toFixed(2), amount: String(upsRate.amount), currency: upsRate.currency })
    }

    // 2) Buy the label as a native 4x6 PDF (PDF_4x6) — the physical MediaBox is the 4x6
    // page itself, which is what AirPrint/Rollo needs. Server-side /api/ship-doc merges
    // this PDF page with the drawn packing-slip page into one combined 4x6 PDF opened in
    // a Safari tab. See ADR 0009.
    const txnRes = await fetch(`${SHIPPO_BASE}/transactions/`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ rate: upsRate.object_id, label_file_type: 'PDF_4x6', async: false })
    })
    const txn = await txnRes.json()
    if (txn.status !== 'SUCCESS' || !txn.tracking_number) {
      // Label purchase failed — caller must NOT mark the order fulfilled or notify.
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
          order_id: body.order_id || null,
          order_name: body.order_name || null,
          box_index: body.box_index != null ? body.box_index : null,
          box_count: body.box_count != null ? body.box_count : null,
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
        const sbRes = await fetch(`${SB_URL}/rest/v1/shipping_labels`, {
          method: 'POST',
          // Plain insert (not upsert): upsert's conflict-read needs a SELECT policy we
          // intentionally don't grant. The unique(shippo_object_id) constraint dedupes;
          // a rare retry 409s and is swallowed by this non-blocking guard.
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(row)
        })
        if (sbRes.ok) cost_logged = true
        else cost_log_error = `supabase ${sbRes.status}: ${(await sbRes.text()).slice(0, 200)}`
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
      test: txn.test === true,
      cost_logged, cost_log_error
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
