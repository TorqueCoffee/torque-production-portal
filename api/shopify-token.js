const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_HANDLE } = process.env

  try {
    // Get access token
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

    // Fetch all unfulfilled orders — shared by orders + b2b + debug endpoints
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

    // DEBUG endpoint — shows raw company fields on first 5 orders
    if (req.query.type === 'debug') {
      return res.status(200).json({
        total_orders: orders.length,
        sample: orders.slice(0, 5).map(o => ({
          order_id: o.id,
          order_name: o.name,
          customer_company: o.customer?.compan
