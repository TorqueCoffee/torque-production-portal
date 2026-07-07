// Same-origin proxy for Shippo label PNGs.
// WHY: iOS Safari won't paint a cross-origin <img> into a print snapshot, so labels printed
// blank in "Open + print all"; and the raw cross-origin PNG can't be pulled into a data: URL
// client-side because Shippo's label CDN doesn't send CORS headers. This fetches the label
// server-side and serves the bytes from our own origin, so the client can inline it as a
// data: URL and print it reliably. Read-only; host-allowlisted to Shippo so it isn't an open proxy.
const fetch = require('node-fetch');

function isAllowedLabelHost(u) {
  let host;
  try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  if (host === 'goshippo.com' || host.endsWith('.goshippo.com')) return true;
  // Shippo also serves labels from its S3 delivery buckets (e.g. shippo-delivery-east.s3.amazonaws.com)
  if (host.endsWith('.amazonaws.com') && host.includes('shippo')) return true;
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.query && req.query.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }
  if (!isAllowedLabelHost(url)) {
    res.status(400).json({ error: 'host not allowed' });
    return;
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({ error: 'upstream ' + upstream.status });
      return;
    }
    const buf = await upstream.buffer();
    const ct = upstream.headers.get('content-type') || 'image/png';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).json({ error: 'fetch failed', detail: String((e && e.message) || e) });
  }
};
