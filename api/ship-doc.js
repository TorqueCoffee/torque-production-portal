// api/ship-doc.js — builds ONE native 4x6 PDF (labels + packing slips, interleaved in
// packing order) for the Ship tab's "print" buttons. Replaces the old HTML/@page/iframe
// print path, which iOS Safari cannot render correctly (see ADR 0009):
//   - Safari does not support the @page { size } descriptor — the 4x6 page geometry was
//     silently ignored, so content printed at the wrong scale.
//   - iOS Safari iframe printing is broken — contentWindow.print() prints the parent
//     document or nothing.
//   - Printing an image label through AirPrint mis-sizes it — AirPrint scales/fits images
//     to the paper it thinks it has, rather than treating the image as the physical page.
//
// A native 4x6 PDF sidesteps all three: it's opened directly in a Safari tab, and iOS's
// Share > Print sheet treats the PDF's own MediaBox as the physical page.
//
//   POST /api/ship-doc   { order_name, company_name, boxes: [...], include_labels, include_slips }
//     -> application/pdf, one page per label and/or slip, in packing order.

const fetch = globalThis.fetch || require('node-fetch')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

const PT = 72
const PAGE_W = 4 * PT   // 288
const PAGE_H = 6 * PT   // 432
const MARGIN = 14

const TORQUE_LOGO_URL = 'https://cdn.shopify.com/s/files/1/0622/2866/0444/files/Torque-logo.png?v=1647031588'

function isShippoHost(hostname) {
  return hostname.endsWith('.goshippo.com') ||
    (hostname.endsWith('.amazonaws.com') && hostname.includes('shippo'))
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}') } catch { return {} } }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

// Truncate a line of Helvetica text to fit within maxWidth, appending an ellipsis if cut.
function truncateToWidth(font, size, text, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const candidate = text.slice(0, mid) + '…'
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

async function drawSlipPage(out, box, opts, fonts, logoImage) {
  const page = out.addPage([PAGE_W, PAGE_H])
  const { bold, regular } = fonts
  let y = PAGE_H - MARGIN

  // Header: logo + "TORQUE COFFEE" + rule.
  const logoH = 26
  if (logoImage) {
    const scale = logoH / logoImage.height
    const logoW = logoImage.width * scale
    page.drawImage(logoImage, { x: MARGIN, y: y - logoH, width: logoW, height: logoH })
    page.drawText('TORQUE COFFEE', {
      x: MARGIN + logoW + 8, y: y - logoH / 2 - 5, size: 15, font: bold, color: rgb(0, 0, 0)
    })
  } else {
    page.drawText('TORQUE COFFEE', { x: MARGIN, y: y - logoH / 2 - 5, size: 15, font: bold, color: rgb(0, 0, 0) })
  }
  y -= logoH + 6
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.5, color: rgb(0, 0, 0) })
  y -= 12

  // Sub line: order name + company.
  const sub = [opts.order_name, opts.company_name].filter(Boolean).join(' · ')
  if (sub) {
    page.drawText(truncateToWidth(regular, 8, sub, PAGE_W - MARGIN * 2), {
      x: MARGIN, y, size: 8, font: regular, color: rgb(0.2, 0.2, 0.2)
    })
  }
  y -= 16

  // Bordered box: BOX N OF M | weight.
  const boxH = 30
  const boxTop = y
  page.drawRectangle({
    x: MARGIN, y: boxTop - boxH, width: PAGE_W - MARGIN * 2, height: boxH,
    borderColor: rgb(0, 0, 0), borderWidth: 1.5
  })
  const boxLabel = `BOX ${box.box_index} OF ${box.box_count}`
  page.drawText(boxLabel, { x: MARGIN + 10, y: boxTop - boxH / 2 - 5, size: 15, font: bold, color: rgb(0, 0, 0) })
  const weightText = `${Number.isFinite(box.weight_lb) ? box.weight_lb.toFixed(1) : '?'} lb`
  const weightW = regular.widthOfTextAtSize(weightText, 12)
  page.drawText(weightText, { x: PAGE_W - MARGIN - 10 - weightW, y: boxTop - boxH / 2 - 4, size: 12, font: regular, color: rgb(0, 0, 0) })
  y = boxTop - boxH - 14

  // CONTENTS header + rule.
  page.drawText('CONTENTS', { x: MARGIN, y, size: 9, font: bold, color: rgb(0, 0, 0) })
  y -= 4
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: rgb(0, 0, 0) })
  y -= 14

  // Content lines.
  const items = box.contents || []
  const lineList = items.length ? items : [{ product_name: '(no items)', variant_title: '', qty: 0 }]
  for (const it of lineList) {
    if (y < 28) break   // ran out of room — footer still needs to fit
    const qtyPart = it.qty ? `${it.qty}x  ` : ''
    const namePart = it.variant_title ? `${it.product_name} (${it.variant_title})` : `${it.product_name || ''}`
    const line = truncateToWidth(regular, 10, qtyPart + namePart, PAGE_W - MARGIN * 2)
    page.drawText(line, { x: MARGIN, y, size: 10, font: regular, color: rgb(0, 0, 0) })
    y -= 14
  }

  // Footer.
  page.drawText('Packing list - not a shipping label', {
    x: MARGIN, y: MARGIN, size: 7, font: regular, color: rgb(0.35, 0.35, 0.35)
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  try {
    const body = await readJsonBody(req)
    const boxes = Array.isArray(body.boxes) ? body.boxes : []
    const includeLabels = !!body.include_labels
    const includeSlips = !!body.include_slips
    if (!boxes.length) return res.status(400).json({ error: 'boxes required' })

    for (const b of boxes) {
      if (!includeLabels) continue
      const url = b && b.label_url
      if (!url) continue
      let host
      try { host = new URL(url).hostname } catch { return res.status(400).json({ error: 'invalid label_url' }) }
      if (!isShippoHost(host)) return res.status(400).json({ error: 'label_url host not allowed: ' + host })
    }

    const out = await PDFDocument.create()
    const bold = await out.embedFont(StandardFonts.HelveticaBold)
    const regular = await out.embedFont(StandardFonts.Helvetica)
    const fonts = { bold, regular }

    let logoImage = null
    if (includeSlips) {
      try {
        const logoRes = await fetch(TORQUE_LOGO_URL)
        if (logoRes.ok) {
          const logoBytes = Buffer.from(await logoRes.arrayBuffer())
          logoImage = await out.embedPng(logoBytes)
        }
      } catch { logoImage = null }
    }

    const opts = { order_name: body.order_name || '', company_name: body.company_name || '' }

    for (const box of boxes) {
      if (includeLabels && box.label_url) {
        const labelRes = await fetch(box.label_url)
        if (!labelRes.ok) throw new Error('label fetch ' + labelRes.status)
        const contentType = labelRes.headers.get('content-type') || ''
        const bytes = Buffer.from(await labelRes.arrayBuffer())

        if (contentType.includes('pdf')) {
          const labelDoc = await PDFDocument.load(bytes)
          const [copiedPage] = await out.copyPages(labelDoc, [0])
          out.addPage(copiedPage)
        } else {
          let img
          try { img = await out.embedPng(bytes) } catch { img = await out.embedJpg(bytes) }
          const page = out.addPage([PAGE_W, PAGE_H])
          page.drawImage(img, { x: 0, y: 0, width: PAGE_W, height: PAGE_H })
        }
      }

      if (includeSlips) {
        await drawSlipPage(out, box, opts, fonts, logoImage)
      }
    }

    const pdfBytes = await out.save()
    res.setHeader('Content-Type', 'application/pdf')
    return res.status(200).send(Buffer.from(pdfBytes))
  } catch (err) {
    return res.status(502).json({ error: 'Could not build ship document', detail: err.message })
  }
}
