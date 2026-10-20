// api/_shippo.js — asks Shippo whether a label is still live. Not an endpoint (leading "_").
//
// A shipping_labels row is only a record: a label voided by hand in the Shippo dashboard, or a row
// that was planted, still reads 'purchased'. Before a tracking number goes into the customer's
// shipping email (api/shopify-fulfill.js), Shippo has to say that the transaction exists, is
// SUCCESS (a refunded one reads REFUNDED or REFUNDPENDING) and carries the same tracking number.

const fetch = globalThis.fetch || require('node-fetch')

const SHIPPO_BASE = 'https://api.goshippo.com'
const SHIPPO_TIMEOUT_MS = 5000

// -> { ok: true }
//    { ok: false, status: 409, code: 'label_not_live', error }   Shippo says it is not a live label
//    { ok: false, status: 503, error }                           Shippo could not be asked
async function labelIsLive(row) {
  const token = process.env.SHIPPO_TOKEN
  if (!token) return { ok: false, status: 503, error: "Couldn't check the label with Shippo (no Shippo token here), so nothing was fulfilled. Tell Andy." }
  const id = String((row && row.shippo_object_id) || '')
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    return { ok: false, status: 409, code: 'label_not_live', error: "This label record has no Shippo transaction, so it can't be confirmed. Nothing was fulfilled. Tell Andy." }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SHIPPO_TIMEOUT_MS)
  try {
    const r = await fetch(`${SHIPPO_BASE}/transactions/${id}`, { headers: { Authorization: `ShippoToken ${token}` }, signal: ctrl.signal })
    if (r.status === 404) return { ok: false, status: 409, code: 'label_not_live', error: "Shippo has no such label. Nothing was fulfilled. Void it here and buy again, or fulfill by hand in Shopify." }
    if (r.status !== 200) return { ok: false, status: 503, error: "Couldn't check the label with Shippo, so nothing was fulfilled. Try again in a minute." }
    const t = await r.json()
    if (!t || t.status !== 'SUCCESS' || !t.tracking_number || t.tracking_number !== row.tracking_number) {
      return { ok: false, status: 409, code: 'label_not_live', error: `Shippo doesn't show this label as live (${(t && t.status) || 'unknown'}); it may have been voided there. Nothing was fulfilled. Void it here and buy again, or fulfill by hand in Shopify.` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, status: 503, error: "Couldn't check the label with Shippo, so nothing was fulfilled. Try again in a minute." }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { labelIsLive, SHIPPO_BASE }
