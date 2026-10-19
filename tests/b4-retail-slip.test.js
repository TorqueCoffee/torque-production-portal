// B4 gates (docs/TESTS.md): the retail packing slip (api/_retail-slip.js) and the Retail tab's
// batch PDF (api/ship-doc.js, kind 'retail'). Label files are stubbed; nothing is fetched or bought.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
let calls = [], labelResponse = () => ({ status: 200 })
let LABEL_PDF = null, lastOpts = null
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  if (url.endsWith('/auth/v1/user')) {
    const ok = (opts.headers || {}).Authorization === `Bearer ${USER_TOKEN}`
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'u1', app_metadata: { portal_staff: true } } : {}), text: async () => '' }
  }
  calls.push(url)
  const out = labelResponse(url)
  if (out.throw) throw Object.assign(new Error(out.throw), { name: out.throw })
  if (out.hang) {                                   // never answers; only the caller's timer ends it
    await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  }
  calls.at(-1) && (lastOpts = opts)
  const hdr = { 'content-type': out.type || 'application/pdf', 'content-length': out.length != null ? String(out.length) : null }
  return { ok: out.status < 400, status: out.status, headers: { get: k => hdr[k.toLowerCase()] }, arrayBuffer: async () => out.bytes || LABEL_PDF }
}
Object.assign(process.env, { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', PORTAL_AUTH_ENFORCE: '1' })
const shipDoc = require('../api/ship-doc.js')
const { cleanSlip, drawRetailSlip, fitName, printable, rowsPerPage, NAME_W } = require('../api/_retail-slip.js')

// A label is a 4x6 page one point taller than a slip, so the two can be told apart in the output.
test.before(async () => {
  const d = await PDFDocument.create()
  d.addPage([288, 433])
  LABEL_PDF = await d.save()
})

const SLIP = (o = {}) => ({ order_name: '#8303', date: '2026-10-14', subscription: null, replacement: null, name: 'Pat Doe', city_line: 'Newport, OR 97365',
  lines: [{ qty: 1, size: '12oz', name: 'Centenario - Edwin Martinez, Guatemala' }], note: '', carton: '12x8x6', billed_lb: 4, ...o })
const ORDER = (n, o = {}) => ({ label_url: `https://deliver.goshippo.com/${n}.pdf`, slip: SLIP({ order_name: `#${n}` }), ...o })

async function call(body, authorization = `Bearer ${USER_TOKEN}`) {
  const res = { code: null, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(c) { this.code = c; return this },
    json(p) { this.payload = p; return this }, send(b) { this.payload = b; return this } }
  await shipDoc({ method: 'POST', query: {}, body, headers: { authorization }, url: '/api/ship-doc' }, res)
  return res
}
const pageHeights = async buf => (await PDFDocument.load(buf)).getPages().map(p => Math.round(p.getHeight()))
async function fonts() {
  const d = await PDFDocument.create()
  return { d, bold: await d.embedFont(StandardFonts.HelveticaBold), regular: await d.embedFont(StandardFonts.Helvetica) }
}

test('B4 S1: the batch PDF is label then slip for each order, in the order sent', async () => {
  calls = []; labelResponse = () => ({ status: 200 })
  const r = await call({ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1), ORDER(2), ORDER(3)] })
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  assert.equal(r.headers['Content-Type'], 'application/pdf')
  assert.deepEqual(await pageHeights(r.payload), [433, 432, 433, 432, 433, 432])
  assert.deepEqual(calls, [1, 2, 3].map(n => `https://deliver.goshippo.com/${n}.pdf`))
  // Labels only, slips only.
  assert.deepEqual(await pageHeights((await call({ kind: 'retail', include_labels: true, orders: [ORDER(1)] })).payload), [433])
  calls = []
  assert.deepEqual(await pageHeights((await call({ kind: 'retail', include_slips: true, orders: [ORDER(1, { label_url: null })] })).payload), [432])
  assert.equal(calls.length, 0)
})

test('B4 S2: refused before any label is fetched: a non-Shippo host, too many orders, a bad slip, nothing to print, no sign-in', async () => {
  calls = []
  const bad = [
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'https://shippo-labels.s3.amazonaws.com/x.pdf' })] }, /host not allowed/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'javascript:alert(1)' })] }, /host not allowed|invalid/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'http://deliver.goshippo.com/1.pdf' })] }, /host not allowed/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'https://deliver.goshippo.com:8443/1.pdf' })] }, /host not allowed/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'https://evil.goshippo.com/1.pdf' })] }, /host not allowed/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: 'https://u:p@deliver.goshippo.com/1.pdf' })] }, /host not allowed/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: Array.from({ length: 31 }, (_, i) => ORDER(i)) }, /1 to 30/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [] }, /1 to 30/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { slip: null })] }, /slip required/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { slip: SLIP({ lines: [] }) })] }, /1 to 30/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { slip: SLIP({ lines: [{ qty: 1.5, size: '12oz', name: 'x' }] }) })] }, /whole number \(#8303\)/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { slip: SLIP({ carton: '9x9x9' }) })] }, /carton/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { slip: SLIP({ billed_lb: 2.5 }) })] }, /billed_lb/],
    [{ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1, { label_url: '' })] }, /no label for #1/],
    [{ kind: 'retail', orders: [ORDER(1)] }, /nothing to print/],
    [{ kind: 'wholesale', boxes: [{}] }, /kind/]
  ]
  for (const [body, why] of bad) {
    const r = await call(body)
    assert.equal(r.code, 400, String(why))
    assert.match(r.payload.error, why)
  }
  assert.equal((await call({ kind: 'retail', include_slips: true, orders: [ORDER(1)] }, 'Bearer nope')).code, 401)
  assert.equal(calls.length, 0)
})

test('B4 S3: a label that can\'t be fetched fails the PDF and names the order', async () => {
  labelResponse = url => (url.endsWith('/2.pdf') ? { status: 403 } : { status: 200 })
  const r = await call({ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1), ORDER(2)] })
  assert.equal(r.code, 502)
  assert.match(r.payload.detail, /label for #2: status 403/)
  // A label server that never answers is cut off by ship-doc's own timer (shortened here).
  const { LIMITS } = require('../api/ship-doc.js')
  const was = LIMITS.fetchMs
  LIMITS.fetchMs = 30
  labelResponse = url => (url.endsWith('/1.pdf') ? { hang: true } : { status: 200 })
  try {
    assert.match((await call({ kind: 'retail', include_labels: true, include_slips: true, orders: [ORDER(1)] })).payload.detail, /label for #1: timed out/)
  } finally { LIMITS.fetchMs = was }
  // Never follows a redirect; only a PDF; never more than 2 MB.
  labelResponse = () => ({ status: 200 })
  await call({ kind: 'retail', include_labels: true, orders: [ORDER(1)] })
  assert.equal(lastOpts.redirect, 'error')
  for (const [resp, why] of [[{ status: 200, type: 'text/html' }, /not a PDF/], [{ status: 200, length: 3e6 }, /too large/], [{ status: 200, bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }, /too large/]]) {
    labelResponse = () => resp
    const r = await call({ kind: 'retail', include_labels: true, orders: [ORDER(1)] })
    assert.equal(r.code, 502)
    assert.match(r.payload.detail, why)
  }
  labelResponse = () => ({ status: 200 })
})

test('B4 S4: text the PDF font can\'t draw (emoji, Vietnamese, CJK, control characters) never sinks the batch', async () => {
  const slip = SLIP({ name: 'Nguyễn Văn An 😀', note: 'Leave at door 🚪\u0007 — thanks 日本', city_line: 'Zürich-ish, CA 92104',
    lines: [{ qty: 2, size: '12oz', name: 'Café “Señor” ½ - Ñandú Farms, Perú 🇵🇪' }], replacement: 'MISSHIP 😬', subscription: 'FIRST' })
  const r = await call({ kind: 'retail', include_slips: true, orders: [{ slip }] })
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  const { regular } = await fonts()
  assert.equal(printable(regular, 'Nguyễn 😀 é'), 'Nguyen ? é')
  assert.equal(printable(regular, 'a\u0007b\nc'), 'a b c')
})

test('B4 S5: the name column steps 10, 9, 8.5, 8 pt, then drops the country, then cuts with "..." (never inside the coffee name)', async () => {
  const { regular } = await fonts()
  assert.deepEqual(fitName(regular, 'Cocoa Drop'), { text: 'Cocoa Drop', size: 10 })
  const country = fitName(regular, 'Yellow Diamond - Francisca Cubillo Esquivel, Costa Rica')
  assert.equal(country.text, 'Yellow Diamond - Francisca Cubillo Esquivel')
  assert.equal(country.size, 8)
  const cut = fitName(regular, 'Grondin Community Bridge Composition - Grondin Community Washing Station, Ethiopia')
  assert.match(cut.text, /^Grondin Community Bridge Composition - .*\.\.\.$/)
  assert.ok(regular.widthOfTextAtSize(cut.text, 8) <= NAME_W)
  const long = fitName(regular, 'A Coffee Name So Long That It Cannot Possibly Fit In The Column - Producer')
  assert.ok(regular.widthOfTextAtSize(long.text, 8) <= NAME_W)
  // A comma inside the coffee name is not the country: the cut keeps "..." and the name.
  const inName = fitName(regular, 'Cherry, Honey & Natural Lot Blend - Some Very Long Producer Cooperative Name Here')
  assert.match(inName.text, /^Cherry, Honey & Natural Lot Blend - .*\.\.\.$/)
  assert.ok(fitName(regular, ',' + 'x'.repeat(80)).text.length > 3)
  for (const n of ['Centenario - Edwin Martinez, Guatemala', 'x'.repeat(200)]) assert.ok(regular.widthOfTextAtSize(fitName(regular, n).text, fitName(regular, n).size) <= NAME_W)
})

test('B4 S6: 12 lines fit a page, 11 with a note; more go on a second page of the same slip', async () => {
  assert.equal(rowsPerPage(false), 12)
  assert.equal(rowsPerPage(true), 11)
  const lines = n => Array.from({ length: n }, (_, i) => ({ qty: i + 1, size: '12oz', name: `Coffee ${i}` }))
  for (const [n, note, pages] of [[12, '', 1], [13, '', 2], [11, 'x', 1], [12, 'x', 2], [30, '', 3]]) {
    const { d, bold, regular } = await fonts()
    assert.equal(drawRetailSlip(d, cleanSlip(SLIP({ lines: lines(n), note })).slip, { bold, regular }), pages, `${n} lines, note ${!!note}`)
    assert.equal(d.getPageCount(), pages)
  }
})

test('B4 S7: cleanSlip keeps only known fields, bounded', () => {
  const c = cleanSlip(SLIP({ subscription: 'WEEKLY', date: '10/14/2026', extra: 'x', order_name: '#1'.repeat(50), note: 'n'.repeat(5000) })).slip
  assert.equal(c.subscription, null)
  assert.equal(c.date, '')
  assert.equal('extra' in c, false)
  assert.equal(c.order_name.length, 40)
  assert.equal(c.note.length, 1000)
  assert.equal(cleanSlip([]).error, 'slip required')
})
