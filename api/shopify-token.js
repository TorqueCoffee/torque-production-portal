export default async function handler(req, res) {
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
    
    const ordersRes = await fetch(
      `https://${SHOPIFY_STORE_HANDLE}.myshopify.com/admin/api/2025-01/orders.json?status=unfulfilled&limit=250`,
      {
        headers: {
          'X-Shopify-Access-Token': tokenData.access_token,
          'Content-Type': 'application/json'
        }
      }
    )
    
    const ordersData = await ordersRes.json()
    const orders = ordersData.orders || []
    // Return just product names if requested
    if (req.query.productsOnly === 'true') {
      const names = [...new Set(orders.flatMap(o => 
        o.line_items.filter(i => i.vendor === 'Torque Coffees').map(i => i.title)
      ))].sort()
      return res.status(200).json({ products: names })
    }
    
    const aggregated = {}
    
    for (const order of orders) {
      for (const item of order.line_items) {
        if (item.vendor !== 'Torque Coffees') continue
        
        const key = `${item.sku}||${item.title}||${item.variant_title || 'Default'}`
        
        if (!aggregated[key]) {
          aggregated[key] = {
            sku: item.sku || key,
            product_name: item.title,
            variant_title: item.variant_title || 'Default',
            shopify_qty: 0
          }
        }
        aggregated[key].shopify_qty += item.quantity
      }
    }
    
    res.status(200).json({ items: Object.values(aggregated) })
    
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
