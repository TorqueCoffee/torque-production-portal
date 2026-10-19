// api/_retail.js — the open retail orders from Shopify, in the plain shape that
// classifyRetailOrder (lib/ship-rules.js, B1) reads. Not an endpoint (leading "_").
// GraphQL, not REST: R1 needs the fulfillment orders' delivery method and each variant's
// product vendor, which REST orders don't carry.

const fetch = globalThis.fetch || require('node-fetch')

const GQL_VERSION = '2025-10'
const PAGE = 25            // orders per page; 25 x 30 lines keeps the query cost under Shopify's 1000
const MAX_LINES = 30       // an order with more lines is held (TOO_MANY_LINES), never half-read
const MAX_PAGES = 20       // 500 open orders; more than that is an error, not a silent cut
// Open and not (fully) fulfilled, Fellow left out at the source (676 a month when it ran).
const SEARCH = 'status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial) AND -tag:Fellow'

const QUERY = `query($after: String, $q: String!) {
  orders(first: ${PAGE}, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus sourceName tags discountCodes
      shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
      shippingLines(first: 5) { nodes { title discountedPriceSet { shopMoney { amount } } } }
      totalRefundedShippingSet { shopMoney { amount } }
      fulfillmentOrders(first: 5) { nodes { deliveryMethod { methodType } } }
      lineItems(first: ${MAX_LINES}) {
        pageInfo { hasNextPage }
        nodes {
          title variantTitle currentQuantity unfulfilledQuantity requiresShipping isGiftCard sku customAttributes { key }
          variant { product { vendor } inventoryItem { measurement { weight { unit value } } } }
        }
      }
    }
  }
}`

const GRAMS_PER = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 }
function grams(weight) {
  const g = weight && GRAMS_PER[weight.unit] ? Number(weight.value) * GRAMS_PER[weight.unit] : NaN
  return Number.isFinite(g) && g > 0 ? Math.round(g * 10) / 10 : null
}
const money = set => (set && set.shopMoney ? set.shopMoney.amount : '0')

// One GraphQL order node -> the shape classifyRetailOrder reads. Quantity is what is left to
// ship (unfulfilledQuantity; currentQuantity when the node has no unfulfilledQuantity).
function normalizeRetailOrder(n) {
  const a = n.shippingAddress
  const items = (n.lineItems && n.lineItems.nodes) || []
  return {
    order_id: n.id || null,
    order_name: n.name,
    created_at: n.createdAt || null,
    cancelled: !!n.cancelledAt,
    fulfillment_status: n.displayFulfillmentStatus,
    financial_status: n.displayFinancialStatus,
    source: n.sourceName || '',
    tags: n.tags || [],
    discount_codes: n.discountCodes || [],
    address: a ? {
      name: a.name || '', company: a.company || '', address1: a.address1 || '', address2: a.address2 || '',
      city: a.city || '', province: a.provinceCode || '', zip: a.zip || '', country: a.countryCodeV2 || '', phone: a.phone || ''
    } : null,
    delivery_methods: ((n.fulfillmentOrders && n.fulfillmentOrders.nodes) || []).map(f => f.deliveryMethod && f.deliveryMethod.methodType).filter(Boolean),
    shipping_lines: ((n.shippingLines && n.shippingLines.nodes) || []).map(l => ({ title: l.title, amount: money(l.discountedPriceSet) })),
    refunded_shipping: money(n.totalRefundedShippingSet),
    lines_truncated: !!(n.lineItems && n.lineItems.pageInfo && n.lineItems.pageInfo.hasNextPage),
    lines: items.map(l => ({
      title: l.title,
      variant_title: l.variantTitle || '',
      qty: Number.isInteger(l.unfulfilledQuantity) ? l.unfulfilledQuantity : l.currentQuantity,
      requires_shipping: !!l.requiresShipping,
      is_gift_card: !!l.isGiftCard,
      sku: l.sku || null,
      has_variant: !!l.variant,
      product_vendor: l.variant && l.variant.product ? l.variant.product.vendor : null,
      grams: l.variant && l.variant.inventoryItem && l.variant.inventoryItem.measurement ? grams(l.variant.inventoryItem.measurement.weight) : null,
      attribute_keys: (l.customAttributes || []).map(x => x.key)
    }))
  }
}

// -> { ok: true, orders } (normalized) or { ok: false, status, why }. Every page or nothing.
async function fetchOpenRetailOrders(token) {
  const url = `https://${process.env.SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/${GQL_VERSION}/graphql.json`
  const orders = []
  let after = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { after, q: SEARCH } })
    })
    const d = await r.json().catch(() => null)
    if (!r.ok || !d || d.errors || !d.data || !d.data.orders) return { ok: false, status: 502, why: (d && d.errors) || `status ${r.status}` }
    for (const n of d.data.orders.nodes) orders.push(normalizeRetailOrder(n))
    if (!d.data.orders.pageInfo.hasNextPage) return { ok: true, orders }
    after = d.data.orders.pageInfo.endCursor
  }
  return { ok: false, status: 502, why: `more than ${MAX_PAGES * PAGE} open orders` }
}

module.exports = { SEARCH, QUERY, normalizeRetailOrder, fetchOpenRetailOrders }
