export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  
  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE_HANDLE } = process.env
  
  // Debug: check env vars are present
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_STORE_HANDLE) {
    return res.status(500).json({ 
      error: 'Missing env vars',
      has_client_id: !!SHOPIFY_CLIENT_ID,
      has_client_secret: !!SHOPIFY_CLIENT_SECRET,
      has_store_handle: !!SHOPIFY_STORE_HANDLE
    })
  }

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
    
    // Get raw text first so we can see exactly what Shopify returns
    const rawText = await tokenRes.text()
    
    return res.status(200).json({
      shopify_status: tokenRes.status,
      shopify_response: rawText
    })
    
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
