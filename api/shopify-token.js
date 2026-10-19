const fetch = globalThis.fetch || require('node-fetch');
const { requireUser } = require('./_auth')
const { API_VERSION, getToken } = require('./_shopify')
const { b2bShipItems, classifyRetailOrder, retailShipItems, shippingCharged, packRetail, boxParcel, addressProblem, packSignature } = require('../lib/ship-rules.js')
const { fetchOpenRetailOrders } = require('./_retail')

const EXCLUDE_TERMS = ['subscription', 'gift card', 'shirt', 'bean & bottle']

function isExcluded(title) {
  const t = title.toLowerCase()
  return EXCLUDE_TERMS.some(term => t.includes(term))
}

// Which Shopify products count as a "coffee" in the portal's lists. Vendor is already
// filtered in the query. Active + unlisted (still purchasable by link) always count;
// drafts only when tagged roast-profile (coffees in development). xBloom/xPod listings
// and shipping-weight fillers are planned separately and would otherwise show up as
// bogus coffees (e.g. "Gum Drop xPods") with their own settings rows.
const NOT_A_COFFEE_RX = /xbloom|xpods?|weight for shipping/i
function isCoffeeProduct(p) {
  const title = p.title || ''
  if (!title || isExcluded(title) || NOT_A_COFFEE_RX.test(title)) return false
  const status = String(p.status || '').toUpperCase()
  if (status === 'ACTIVE' || status === 'UNLISTED') return true
  return status === 'DRAFT' && (p.tags || []).some(t => String(t).toLowerCase().includes('roast-profile'))
}

// Weight (R10), which lines ship and the per-order items: lib/ship-rules.js (B2a), shared
// with the page and with the label check in api/shippo-label.js.

// Shopify variant text has drifted across relaunches - the same bag comes back as
// "12oz Coffee Bag", "12oz Bag", "12 oz bag / In Stock", etc. Worse, some coffees
// (Gum Drop, Dark Drop, BomBón, Decaf Drop) exist as two separate product records
// (old listing + relaunch) with the SAME title but DIFFERENT SKUs for the same
// physical size. Bucket every variant down to its size so orders for "the same
// coffee, the same size" land on one production row regardless of which listing
// or wording it came through. Only 4 sizes exist; anything that doesn't match is
// left alone (the xBloom bulk boxes' "Default Title", gift cards, etc).
const VARIANT_SIZES = [
  { label: '12oz',     rx: /^\s*12\s*oz/i },
  { label: '2lb',      rx: /^\s*2\s*lbs?\b/i },
  { label: '5lb',      rx: /^\s*5\s*lbs?\b/i },
  { label: '8 xPods',  rx: /^\s*8\s*x\s*pods?/i }
]
function canonicalVariant(variant) {
  const v = String(variant || '').trim()
  const hit = VARIANT_SIZES.find(s => s.rx.test(v))
  return hit ? hit.label : (v || 'Default')
}

module.exports = async function handler(req, res) {
  // Same-origin only: no CORS headers (the page is the only caller). Returns B2B customer
  // names and addresses, so it is behind the sign-in like the rest (ADR 0023).
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  // Customer names and addresses (b2b, b2b-ship) need a signed-in staff user from the first
  // deploy on; the product and order lists only once PORTAL_AUTH_ENFORCE=1.
  if (!(await requireUser(req, res, { always: ['b2b', 'b2b-ship', 'retail-ship'].includes(req.query.type) }))) return
  const { SHOPIFY_STORE_HANDLE } = process.env

  try {
    const tk = await getToken()
    if (tk.error) {
      return res.status(500).json({ error: 'Token exchange failed', detail: tk.error })
    }
    const token = tk.token
    const baseUrl = `https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/${API_VERSION}`
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }

    // PRODUCTS endpoint - the coffee list that drives dropdowns, blends and the
    // green_coffee_settings sync. Uses GraphQL (not REST) because REST's status filter
    // only knows active/draft/archived and silently drops UNLISTED products.
    if (req.query.type === 'products') {
      const gqlUrl = `https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/2025-10/graphql.json`
      const query = `query($after: String) {
        products(first: 250, after: $after, query: "vendor:'Torque Coffees' AND (status:active OR status:draft OR status:unlisted)") {
          pageInfo { hasNextPage endCursor }
          nodes { title status tags }
        }
      }`
      const titles = []
      let after = null
      do {
        const gRes = await fetch(gqlUrl, {
          method: 'POST', headers,
          body: JSON.stringify({ query, variables: { after } })
        })
        const gData = await gRes.json()
        // Fail loudly: the client deletes settings for anything missing from this list,
        // so a partial/empty answer must never look like success.
        if (!gRes.ok || gData.errors || !gData.data) {
          return res.status(502).json({ error: 'Shopify products query failed', detail: gData.errors || gData })
        }
        const conn = gData.data.products
        for (const p of conn.nodes) if (isCoffeeProduct(p)) titles.push(p.title.trim())
        after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
      } while (after)

      const products = [...new Set(titles)].sort()
      return res.status(200).json({ products })
    }

    // RETAIL per-order shipping list (B1): every open retail order, classified by R1/R1a
    // (classifyRetailOrder in lib/ship-rules.js). LIST and HOLD orders come back with the reason;
    // EXCLUDE orders are only counted. Customer names and addresses: signed-in staff only.
    if (req.query.type === 'retail-ship') {
      const got = await fetchOpenRetailOrders(token)
      if (!got.ok) return res.status(502).json({ error: 'Shopify retail orders query failed', detail: got.why })
      const out = [], excluded = {}
      for (const o of got.orders) {
        const c = classifyRetailOrder(o)
        if (c.decision === 'EXCLUDE') { excluded[c.class] = (excluded[c.class] || 0) + 1; continue }
        out.push({
          order_id: o.order_id, order_name: o.order_name, created_at: o.created_at,
          decision: c.decision, class: c.class, detail: c.detail || null, flags: c.flags || [],
          note: o.note, discount_codes: o.discount_codes,
          // The slip's subscription box (retail_slip_spec.md field 2): FIRST from Appstle's
          // first-order tag, otherwise any subscription order is RECURRING.
          subscription: (o.tags || []).some(t => String(t).toLowerCase() === 'appstle_subscription_first_order') ? 'FIRST'
            : (c.flags || []).includes('SUBSCRIPTION') ? 'RECURRING' : null,
          // Shopify admin link for the hold list; the handle is server config, not in the page.
          admin_url: /(\d+)$/.test(o.order_id || '') ? `https://admin.shopify.com/store/${SHOPIFY_STORE_HANDLE}/orders/${o.order_id.match(/(\d+)$/)[1]}` : null,
          // D5: an address purchase would refuse (P.O. box, a line over 35) -> the queue's
          // "Needs a fix" group. Only for LIST orders; the classifier is untouched.
          fix: c.decision === 'LIST' ? addressProblem(o.address) : null,
          delivery_method: o.delivery_methods[0] || null,
          shipping_charged: shippingCharged(o).toFixed(2),
          shipping_title: o.shipping_lines.map(l => l.title).join(', '),
          shipping_address: o.address,
          items: retailShipItems(o),
          // B2: the one carton and the declared (billed) pounds; null for a HOLD order.
          parcel: c.decision === 'LIST' ? boxParcel(packRetail(retailShipItems(o)).boxes[0]) : null,
          // B3a: the whole pack as the label endpoint compares it (packSignature), sent back unchanged.
          pack_sig: c.decision === 'LIST' ? packSignature(packRetail(retailShipItems(o)).boxes) : null
        })
      }
      return res.status(200).json({ orders: out, excluded })
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
          const canonVariant = canonicalVariant(item.variant_title)
          const key = `${item.title}||${canonVariant}`
          if (!companyMap[companyName].items[key]) {
            companyMap[companyName].items[key] = {
              product_name: item.title,
              variant_title: canonVariant,
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
        const items = b2bShipItems(order.line_items)
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
        // Key on title + canonical size, not SKU - two product records for the
        // same coffee/size (old listing vs relaunch) carry different SKUs and
        // would otherwise split into two production rows for the same bag.
        const canonVariant = canonicalVariant(item.variant_title)
        const key = `${item.title}||${canonVariant}`
        if (!aggregated[key]) {
          aggregated[key] = {
            sku: item.sku || key,
            product_name: item.title,
            variant_title: canonVariant,
            qty_needed: 0,
            oldest_order_date: orderDate
          }
        } else if (aggregated[key].sku === key && item.sku) {
          // Upgrade the placeholder sku the first time a real one shows up.
          aggregated[key].sku = item.sku
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
module.exports.canonicalVariant = canonicalVariant
module.exports.isCoffeeProduct = isCoffeeProduct
