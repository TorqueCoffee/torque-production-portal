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

    // PRODUCTS endpoint
   if (req.query.type === 'products') {
  const pRes = await fetch(`${baseUrl}/products.json?limit=5&status=active`, { headers })
  const pData = await pRes.json()
  return res.status(200).json({
    total_returned: (pData.products||[]).length,
    shopify_error: pData.errors || null,
    sample_vendors: (pData.products||[]).slice(0,5).map(p => ({
      title: p.title,
      vendor: p.vendor,
      status: p.status
    }))
  })
}
    // Fetch all unfulfilled orders
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
      })).sort((a, b) => a.company_name.localeCompare(b.company_name))
      return res.status(200).json({ companies })
    }

    // ORDERS endpoint (default)
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
