// api/shippo-label.js — B2B Cubic Shipping · Step 2: USPS Ground Advantage cubic
// rate + label via Shippo. Server-side so the Shippo token never reaches the browser.
//
//   POST /api/shippo-label?action=rate    { address_to, parcel } -> GA rate only (no purchase)
//   POST /api/shippo-label?action=label   { address_to, parcel } -> buys label; returns
//                                           tracking + 4x6 PDF label_url + cost (for capture)
//
//   parcel: { length, width, height, weight }   (inches, pounds)
//
// Origin is fixed here (Torque) — single source of truth for the ship-from.
// Token is read from process.env.SHIPPO_TOKEN (test token until live cutover).

const fetch = globalThis.fetch || require('node-fetch')

const SHIPPO_BASE = 'https://api.goshippo.com'
const GA_TOKEN = 'usps_ground_advantage'

const ORIGIN = {
  name: 'Torque Coffee',
  street1: '3459 El Cajon Blvd',
  city: 'San Diego',
  state: 'CA',
  zip: '92104',
  country: 'US',
  phone: '6195551234',
  email: 'production@torque.coffee'
}

// USPS GA cubic eligibility — Shippo exposes no flag, so we DERIVE is_cubic from dims.
// (GA cubic: <= 1.0 cu ft, longest side <= 18", <= 20 lb.)
function isCubicEligible(p) {
  const L = Number(p.length), W = Number(p.width), H = Number(p.height), wt = Number(p.weight)
  if (![L, W, H, wt].every(Number.isFinite)) return false
  const cuft = (L * W * H) / 1728
  return cuft <= 1.0 && Math.max(L, W, H) <= 18 && wt <= 20
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = process.env.SHIPPO_TOKEN
  if (!token) return res.status(500).json({ error: 'SHIPPO_TOKEN not configured' })

  const action = String(req.query.action || 'rate').toLowerCase()
  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}') } catch { body = {} } }
  body = body || {}
  const { address_to, parcel } = body
  if (!address_to || !parcel) return res.status(400).json({ error: 'address_to and parcel required' })

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
        async: false
      })
    })
    const shipment = await shipmentRes.json()
    const rates = shipment.rates || []
    const ga = rates.find(r => r.servicelevel && r.servicelevel.token === GA_TOKEN)
    if (!ga) {
      // Edge case: box disqualified / no GA rate — surface the rates, never silently buy weight-based.
      return res.status(422).json({
        error: 'No Ground Advantage rate returned',
        rates: rates.map(r => ({ service: r.servicelevel && r.servicelevel.token, amount: r.amount })),
        messages: shipment.messages || []
      })
    }

    const rateOut = {
      service: ga.servicelevel.token,
      service_name: ga.servicelevel.name,
      amount: ga.amount,
      currency: ga.currency,
      zone: ga.zone,
      estimated_days: ga.estimated_days,
      is_cubic: isCubicEligible(parcel),
      rate_id: ga.object_id
    }

    if (action === 'rate') return res.status(200).json({ ok: true, action: 'rate', ...rateOut })

    // 2) Buy the label as a 4x6 PNG (was PDF_4x6). PNG so the label can be embedded as an
    // <img> into our OWN same-origin combined print document (label+slip interleaved, one
    // print job) — a cross-origin PDF can't be pulled into another page's print. The Rollo
    // is a normal system printer that consumes 4x6 PNG/HTML fine. See ADR 0007.
    const txnRes = await fetch(`${SHIPPO_BASE}/transactions/`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ rate: ga.object_id, label_file_type: 'PNG', async: false })
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
          cost: ga.amount,
          currency: ga.currency,
          service: ga.servicelevel.token,
          is_cubic: isCubicEligible(parcel),
          zone: ga.zone || null,
          dest_zip: address_to.zip || null,
          weight_lb: Number(parcel.weight) || null,
          tracking_number: txn.tracking_number,
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
      cost: ga.amount,            // actual charged = the bought rate's amount
      tracking_number: txn.tracking_number,
      tracking_url: txn.tracking_url_provider,
      label_url: txn.label_url,
      label_file_type: 'PNG',
      shippo_object_id: txn.object_id,
      test: txn.test === true,
      cost_logged, cost_log_error
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
