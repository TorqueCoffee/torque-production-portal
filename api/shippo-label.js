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

// Recipient address as sent to Shippo: known fields only, as strings. No email ever (the one
// customer email comes from Shopify on fulfillment; a recipient email makes Shippo send its
// own notice). No phone on the order -> Torque's phone (R5).
const ADDRESS_FIELDS = ['name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'country', 'phone']
function recipientAddress(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  const out = {}
  for (const k of ADDRESS_FIELDS) out[k] = a[k] == null ? '' : String(a[k]).trim().slice(0, 100)
  if (!out.phone) out.phone = ORIGIN.phone
  if (!out.country) out.country = 'US'
  return out
}
// UPS does not deliver to P.O. boxes.
const PO_BOX = /\bP\.?\s*O\.?\s*Box\b|\bPost\s+Office\s+Box\b/i

// Parcel as sent to Shippo: numbers only, weight a whole pound count >= 1.
function cleanParcel(p) {
  if (!p || typeof p !== 'object') return null
  const dims = [p.length, p.width, p.height]
  if (!dims.every(d => typeof d === 'number' && Number.isFinite(d) && d > 0)) return null
  if (!(typeof p.weight === 'number' && Number.isInteger(p.weight) && p.weight >= 1)) return null
  return { length: p.length, width: p.width, height: p.height, weight: p.weight }
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
  const address_to = recipientAddress(body.address_to)
  if (!address_to) return res.status(400).json({ error: 'address_to required' })
  if (PO_BOX.test(address_to.street1) || PO_BOX.test(address_to.street2)) {
    return res.status(400).json({ error: 'UPS does not deliver to P.O. boxes. Get a street address for this order.' })
  }
  const parcel = cleanParcel(body.parcel)
  if (!parcel) return res.status(400).json({ error: 'parcel needs numeric length, width and height, and a whole-pound weight of at least 1' })
  const expected = Number(body.expected_amount)
  if (action === 'label' && !(Number.isFinite(expected) && expected > 0)) {
    return res.status(400).json({ error: 'expected_amount (the confirmed rate) is required to buy a label' })
  }

  const auth = { 'Authorization': `ShippoToken ${token}`, 'Content-Type': 'application/json' }

  try {
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
    if (!upsRate) {
      // Edge case: box disqualified / no rate for the required service — surface the rates,
      // never silently buy a different service or carrier.
      return res.status(422).json({
        error: 'No UPS Ground rate returned',
        rates: rates.map(r => ({ service: r.servicelevel && r.servicelevel.token, amount: r.amount, carrier_account: r.carrier_account })),
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
    // area surcharge), so a higher price than the one confirmed buys nothing.
    if (Number(upsRate.amount) > expected + 0.005) {
      return res.status(409).json({ error: 'Price changed', quoted: expected.toFixed(2), amount: upsRate.amount, currency: upsRate.currency })
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
