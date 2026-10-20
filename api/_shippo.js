// api/_shippo.js — asks Shippo about a label's transaction. Not an endpoint (leading "_").
//
// A shipping_labels row is only a record: a label voided by hand in the Shippo dashboard, or a row
// that was planted, still reads 'purchased'. Before a tracking number goes into the customer's
// shipping email (api/shopify-fulfill.js), and before a label is refunded or handed back
// (api/shippo-label.js), Shippo has to say that the transaction exists, is SUCCESS (a refunded one
// reads REFUNDED or REFUNDPENDING), carries the same tracking number and, for a retail label, was
// bought for this order (the label step sends the order id as the transaction's `metadata`).

const fetch = globalThis.fetch || require('node-fetch')

const SHIPPO_BASE = 'https://api.goshippo.com'
const SHIPPO_TIMEOUT_MS = 5000

// One transaction by id. -> { ok: true, t }, { ok: false, missing: true } (Shippo has no such
// transaction or the id is not one), or { ok: false } (Shippo could not be asked).
async function getTransaction(id, auth) {
  id = String(id || '')
  if (!/^[0-9a-f]{32}$/i.test(id)) return { ok: false, missing: true }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SHIPPO_TIMEOUT_MS)
  try {
    const r = await fetch(`${SHIPPO_BASE}/transactions/${id}`, { headers: auth, signal: ctrl.signal })
    if (r.status === 404) return { ok: false, missing: true }
    if (r.status !== 200) return { ok: false }
    const t = await r.json()
    return t ? { ok: true, t } : { ok: false }
  } catch (e) {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

// Is this transaction the live label the row says it is? `orderId` is the canonical order id a
// retail label was bought for (null for a B2B label, which carries no such mark).
function transactionMatches(t, row, orderId) {
  return !!t && t.status === 'SUCCESS' && !!t.tracking_number && t.tracking_number === row.tracking_number &&
    (orderId == null || t.metadata === orderId)
}

// -> { ok: true }
//    { ok: false, status: 409, code: 'label_not_live', error }   Shippo says it is not a live label of this order
//    { ok: false, status: 503, error }                           Shippo could not be asked
async function labelIsLive(row, orderId) {
  const token = process.env.SHIPPO_TOKEN
  if (!token) return { ok: false, status: 503, error: "Couldn't check the label with Shippo (no Shippo token here), so nothing was fulfilled. Tell Andy." }
  const got = await getTransaction(row && row.shippo_object_id, { Authorization: `ShippoToken ${token}` })
  if (!got.ok) {
    return got.missing
      ? { ok: false, status: 409, code: 'label_not_live', error: "Shippo has no such label for this record, so it can't be confirmed. Nothing was fulfilled. Void it here and buy again, or fulfill by hand in Shopify." }
      : { ok: false, status: 503, error: "Couldn't check the label with Shippo, so nothing was fulfilled. Try again in a minute." }
  }
  if (!transactionMatches(got.t, row, orderId)) {
    return { ok: false, status: 409, code: 'label_not_live', error: `Shippo doesn't show this label as a live one of this order (${got.t.status || 'unknown'}); it may have been voided there. Nothing was fulfilled. Void it here and buy again, or fulfill by hand in Shopify.` }
  }
  return { ok: true }
}

module.exports = { getTransaction, transactionMatches, labelIsLive, SHIPPO_BASE }
