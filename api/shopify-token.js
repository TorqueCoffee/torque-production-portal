const fetch = require('node-fetch');

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

    if (req.query.type === 'products') {
      let products = []
      let page = `${baseUrl}/products.json?limit=250&status=active`
      while (page) {
        const pRes = await fetch(page, { headers })
        const pData = await pRes.json()
        const filtered = (pData.products || []).filter(p => p.vendor === 'Torque Coffees')
        products = products.concat(filtered.map(p => p.title).sort())
        const linkHeader = pRes.headers.get('link') || ''
        const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
        page = next ? next[1] : null
      }
      return res.status(200).json({ products })
    }

    let orders = []
    let ordersPage = `${baseUrl}/orders.json?status=unfulfilled&limit=250`
    while (ordersPage) {
      const oRes = await fetch(ordersPage, { headers })
      const oData = await oRes.json()
      orders = orders.concat(oData.orders || [])
      const linkHeader = oRes.headers.get('link') || ''
      const next = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
      ordersPage = next ? next[1] : null
    }

    if (req.query.type === 'b2b') {
      const b2bOrders = orders.filter(o => o.shipping_address?.company && o.shipping_address.company.trim() !== '')
      const companyMap = {}
      for (const order of b2bOrders) {
        const companyName = order.shipping_address.company.trim()
        if (!companyMap[companyName]) {
          companyMap[companyName] = {
            company_name: companyName,
            contact_name: [order.shipping_address.first_name, order.shipping_address.last_name].filter(Boolean).join(' ') || null,
            email: order.email || null,
            order_count: 0,
            itemMap: {}
          }
        }
        companyMap[companyName].order_count += 1
        for (const item of order.line_items) {
          if (item.vendor !== 'Torque Coffees') continue
          const key = `${item.title}||${item.variant_title || 'Default'}`
          if (!companyMap[companyName].itemMap[key]) {
            companyMap[companyName].itemMap[key] = {
              product_name: item.title,
              variant_title: item.variant_title || 'Default',
              qty: 0
            }
          }
          companyMap[companyName].itemMap[key].qty += item.quantity
        }
      }
      const companies = Object.values(companyMap).map(c => ({
        company_name: c.company_name,
        contact_name: c.contact_name,
        email: c.email,
        order_count: c.order_count,
        items: Object.values(c.itemMap)
      })).sort((a, b) => a.company_name.localeCompare(b.company_name))
      return res.status(200).json({ companies })
    }

    const aggregated = {}
    for (const order of orders) {
      const orderDate = order.created_at ? order.created_at.split('T')[0] : null
      for (const item of order.line_items) {
        if (item.vendor !== 'Torque Coffees') continue
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
