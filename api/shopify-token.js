const fetch = globalThis.fetch || require('node-fetch');

const EXCLUDE_TERMS = ['subscription', 'gift card', 'shirt', 'bean & bottle']

function isExcluded(title) {
  const t = title.toLowerCase()
  return EXCLUDE_TERMS.some(term => t.includes(term))
}

// Weight resolution for B2B cubic shipping. Prefer Shopify's per-line `grams` (the REST
// line item is always in grams), else parse the variant title. Returns POUNDS, or null
// if unknown — the packer flags null-weight items as unpackable rather than guessing.
const GRAMS_PER_LB = 453.59237
// Coffee bags come in clean 0.25-lb increments (12oz, 1/2/5 lb). Shopify stores grams
// rounded (a "5 lb" bag = 2270 g = 5.004 lb), which would push 4×5lb to 20.016 > the 20 lb
// cap and waste a box. Snap to the nearest quarter-pound to recover the nominal weight and
// honor the "4×5lb = 20 flat" decision.
function snapQuarterLb(lb) { return Math.round(lb * 4) / 4 }
function resolveWeightLb(item) {
  const g = Number(item && item.grams)
  if (Number.isFinite(g) && g > 0) return snapQuarterLb(g / GRAMS_PER_LB)
  return weightFromVariantTitle(item && item.variant_title)
}
function weightFromVariantTitle(variant) {
  if (!variant) return null
  const m = String(variant).match(/(\d+\.?\d*)\s*(lb|pound|oz|ounce)/i)
  if (!m) return null
  const n = parseFloat(m[1]), u = m[2].toLowerCase()
  if (u[0] === 'o') return Math.round((n / 16) * 1000) / 1000   // ounces → lb
  return n
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_HANDLE } = process.env

  try {
    const tokenRes = await fetch(
      `https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET
        })
      }
    )
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) {
      return res.status(500).json({ error: 'Token exchange failed', detail: tokenData })
    }
    const token = tokenData.access_token
    const baseUrl = `https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/2025-01`
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }

    // PRODUCTS endpoint — active products + roast-profile tagged drafts
    if (req.query.type === 'products') {
      let products = []

      // Fetch active Torque Coffees products
      let page = `${baseUrl}/products.json?limit=250&status=active`
      while (page) {
        const pRes = await fetch(page, { headers })
        const pData = await pRes.json()
        const filtered = (pData.products||[])
          .filter(p => p.vendor === 'Torque Coffees' && !isExcluded(p.title))
        products = products.concat(filtered.map(p => p.title))
        const linkHeader = pRes.headers.get('link') || ''
        const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
        page = next ? next[1] : null
      }

      // Fetch draft products tagged roast-profile
      let draftPage = `${baseUrl}/products.json?limit=250&status=draft`
      while (draftPage) {
        const pRes = await fetch(draftPage, { headers })
        const pData = await pRes.json()
        const filtered = (pData.products||[])
          .filter(p =>
            p.vendor === 'Torque Coffees' &&
            !isExcluded(p.title) &&
            p.tags && p.tags.toLowerCase().includes('roast-profile')
          )
        products = products.concat(filtered.map(p => p.title))
        const linkHeader = pRes.headers.get('link') || ''
        const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
        draftPage = next ? next[1] : null
      }

      products = [...new Set(products)].sort()
      return res.status(200).json({ products })
    }

    // Fetch all unfulfilled orders
    let orders = []
    let ordersPage = `${baseUrl}/orders.json?status=open&fulfillment_status=unfulfilled&limit=250`
    while (ordersPage) {
      const oRes = await fetch(ordersPage, { headers })
      const oData = await oRes.json()
      orders = orders.concat(oData.orders || [])
      const linkHeader = oRes.headers.get('link') || ''
      const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
      ordersPage = next ? next[1] : null
    }

    // B2B endpoint
    if (req.query.type === 'b2b') {
      const companyMap = {}
      for (const order of orders) {
        const companyName = order.billing_address?.company ||
          order.shipping_address?.company
        if (!companyName) continue
        if (!companyMap[companyName]) {
          companyMap[companyName] = {
            company_name: companyName,
            contact_name: [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '),
            email: order.customer?.email || '',
            order_count: 0,
            items: {}
          }
        }
        companyMap[companyName].order_count++
        for (const item of order.line_items) {
          if (item.vendor !== 'Torque Coffees') continue
          const key = `${item.title}||${item.variant_title || 'Default'}`
          if (!companyMap[companyName].items[key]) {
            companyMap[companyName].items[key] = {
              product_name: item.title,
              variant_title: item.variant_title || 'Default',
              qty: 0
            }
          }
          companyMap[companyName].items[key].qty += item.quantity
        }
      }
      const companies = Object.values(companyMap).map(c => ({
        ...c,
        items: Object.values(c.items)
      })).sort((a,b) => a.company_name.localeCompare(b.company_name))
      return res.status(200).json({ companies })
    }

    // B2B per-order shipping endpoint — per-ORDER (not company-merged), with ship-to
    // address + per-line weight, ready for the cubic-shipping packer + label + fulfill flow.
    if (req.query.type === 'b2b-ship') {
      const shipOrders = []
      for (const order of orders) {
        const sa = order.shipping_address
        const company = (order.billing_address && order.billing_address.company) || (sa && sa.company) || null
        if (!company) continue   // B2B only — wholesale accounts carry a company
        if (!sa) continue        // can't ship without an address
        const items = (order.line_items || [])
          .filter(it => it.vendor === 'Torque Coffees' && it.fulfillment_status !== 'fulfilled')
          .map(it => ({
            product_name: it.title,
            variant_title: it.variant_title || 'Default',
            qty: it.quantity,
            grams: it.grams != null ? it.grams : null,
            weight_lb: resolveWeightLb(it)
          }))
        if (!items.length) continue
        shipOrders.push({
          order_id: order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
          order_name: order.name,
          fulfillment_status: order.fulfillment_status || 'unfulfilled',
          shipping_address: {
            name: sa.name || [sa.first_name, sa.last_name].filter(Boolean).join(' '),
            company,
            address1: sa.address1 || '',
            address2: sa.address2 || '',
            city: sa.city || '',
            province_code: sa.province_code || '',
            zip: sa.zip || '',
            country_code: sa.country_code || 'US',
            phone: sa.phone || ''
          },
          items
        })
      }
      shipOrders.sort((a, b) => (a.shipping_address.company || '').localeCompare(b.shipping_address.company || ''))
      return res.status(200).json({ orders: shipOrders })
    }

    // ORDERS endpoint (default)
    const aggregated = {}
    for (const order of orders) {
      const orderDate = order.created_at ? order.created_at.split('T')[0] : null
      for (const item of order.line_items) {
        if (item.vendor !== 'Torque Coffees') continue
        if (item.fulfillment_status === 'fulfilled') continue
        const key = `${item.sku || item.title}||${item.variant_title || 'Default'}`
        if (!aggregated[key]) {
          aggregated[key] = {
            sku: item.sku || key,
            product_name: item.title,
            variant_title: item.variant_title || 'Default',
            qty_needed: 0,
            oldest_order_date: orderDate
          }
        }
        aggregated[key].qty_needed += item.quantity
        if (orderDate && (!aggregated[key].oldest_order_date || orderDate < aggregated[key].oldest_order_date)) {
          aggregated[key].oldest_order_date = orderDate
        }
      }
    }
    res.status(200).json({ items: Object.values(aggregated) })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// Exposed for unit tests (Vercel still invokes module.exports(req, res) as the function).
module.exports.resolveWeightLb = resolveWeightLb
module.exports.weightFromVariantTitle = weightFromVariantTitle
