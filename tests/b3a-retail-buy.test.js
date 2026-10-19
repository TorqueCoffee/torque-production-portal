// B3a gates (docs/TESTS.md): Buy and print on the Retail tab. The page's own functions are loaded
// out of index.html into a sandbox with a fake server; nothing is bought.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const { inlineScripts, declarationSource } = require('./helpers/index-html')

const NAMES = ['escHtml', 'safeUrl', 'SHIP_CARRIER', 'SHIP_WEIGHT_BASIS', 'RETAIL_MAX_BATCH', 'RETAIL_BUY_ENABLED', 'RETAIL_BUY_PARALLEL', 'RETAIL_BUSY_WAIT_MS', 'RETAIL_AGE_CHIP_DAYS',
  'RETAIL_CARTONS', 'RETAIL_CARTON_DESC', 'RETAIL_HOLD_TEXT', 'RETAIL_HOLD_DETAIL_TEXT', 'RETAIL_EXCLUDED_TEXT', 'RETAIL_ROW_TEXT', 'RETAIL_ROW_CHIP',
  'retailOrders', 'retailExcluded', 'retailLoadedAt', 'retailLoadSeq', 'retailLoading', 'retailError', 'retailSel', 'retailMsg', 'retailShowHold',
  'retailPending', 'retailPendingError', 'retailBatch', 'retailBuyInFlight', 'retailReprinting',
  'RETAIL_UNRECORDED_KEY', 'RETAIL_UNRECORDED_DAYS', 'retailReadUnrecorded', 'retailSaveUnrecorded', 'retailUnrecorded', 'retailMergeUnrecorded', 'retailRemember', 'retailForget', 'retailClearUnrecorded', 'retailApplyShipTo',
  'retailCartonLabel', 'retailSizeLabel', 'retailAgeDays', 'retailGroups', 'retailReadyOrders', 'retailSelectAllIds', 'retailBilledLb', 'retailApplySubscriptions',
  'loadRetailOrders', 'loadRetailPending', 'retailToggle', 'retailToggleAll', 'retailChip', 'retailChips', 'retailShipTo', 'retailLines', 'retailShopifyLink', 'retailRow',
  'RETAIL_ROW_BAD', 'retailMoney', 'retailShippoAddress', 'retailPacificDate', 'retailSlip', 'retailBoughtRow', 'retailGoneRow', 'retailBuyAndPrint', 'retailPdfTab',
  'retailRun', 'retailPost', 'retailRequest', 'retailTooMany', 'retailQuote', 'retailBuyOne', 'retailRowAction', 'retailPdfRows', 'retailOpenPdf', 'retailPdfFresh',
  'retailPdfButton', 'retailReprintBought', 'retailBackToQueue',
  'renderRetailBatch', 'renderRetail']

const P = { '8x6x3': { length: 8, width: 6, height: 3, weight: 1 }, '12x8x6': { length: 12, width: 8, height: 6, weight: 2 }, '14x10x10': { length: 14, width: 10, height: 10, weight: 5 } }
let seq = 0
const order = (o = {}) => {
  const n = ++seq
  return { order_id: `gid://shopify/Order/${n}`, order_name: `#${9000 + n}`, created_at: `2026-10-${String(1 + (n % 27)).padStart(2, '0')}T20:00:00Z`, decision: 'LIST', class: 'ELIGIBLE',
    flags: [], note: '', discount_codes: [], subscription: null,
    shipping_address: { name: `Pat ${n}`, address1: `${n} Main St`, address2: '', city: 'San Diego', province: 'CA', zip: '92104', country: 'US', phone: '' },
    items: [{ product_name: 'La Mora - Rodrigo Sanchez, Colombia', variant_title: '12oz', qty: 1, weight_lb: 0.75 }], parcel: P['8x6x3'], fix: null,
    admin_url: `https://admin.shopify.com/store/s/orders/${n}`, ...o,
    pack_sig: o.pack_sig || (() => { const p = o.parcel || P['8x6x3']; return `${p.length}x${p.width}x${p.height}@${p.weight}` })() }
}

// The fake server. `rate` and `label` decide per order (by id); default: rate 6.43, buy.
function server({ rate = () => ({ status: 200, json: { ok: true, amount: '6.43', currency: 'USD' } }), label, pdf = () => ({ status: 200 }), pending = [], labelsFor = () => [], hold } = {}) {
  const log = []
  let inFlight = 0, maxInFlight = 0
  const defaultLabel = (b) => ({ status: 200, json: { ok: true, cost: b.expected_amount, tracking_number: `1Z${b.order_id.replace(/\D/g, '').padStart(16, '0')}`, label_url: `https://deliver.goshippo.com/${b.order_id.replace(/\D/g, '')}.pdf`, shippo_object_id: 'x' } })
  const apiFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null
    const entry = { url, body, at: log.length, busy: inFlight }   // busy: requests already in flight when this one started
    log.push(entry)
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (hold) await hold(url, body)
      await new Promise(r => setTimeout(r, 1))
      let out
      if (url === '/api/shippo-label?action=rate') out = rate(body)
      else if (url === '/api/shippo-label?action=label') out = (label || defaultLabel)(body) || defaultLabel(body)
      else if (url === '/api/ship-doc') out = pdf(body)
      else throw new Error('unexpected ' + url)
      if (out.throw) throw new Error(out.throw)
      const status = out.status || 200
      return { ok: status < 400, status, json: async () => out.json || {}, blob: async () => ({ size: 1, type: out.type || 'application/pdf' }) }
    } finally { inFlight-- }
  }
  return { log, apiFetch, get maxInFlight() { return maxInFlight }, pending, labelsFor,
    calls: part => log.filter(e => e.url.includes(part)) }
}

function page({ srv = server(), enabled = true, popup = true, storage = {} } = {}) {
  const src = inlineScripts().join('\n')
  const el = { innerHTML: '' }
  const opened = [], longTimers = []
  const ctx = {
    SHIP_RULES_LOADED: true, scheduleData: [], applySubscriptionSubstitution: x => x, Date, URL: Object.assign(class extends URL {}, { createObjectURL: () => 'blob:pdf', revokeObjectURL() {} }),
    console, Promise, alerts: [],
    localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v) } },
    // Timers of a minute or more (freeing a PDF) are held for the test to fire; they must not keep
    // the test process alive.
    setTimeout: (f, ms) => { if (ms >= 60000) { longTimers.push(f); return 0 } return setTimeout(f, ms) },
    alert(m) { ctx.alerts.push(m) }, confirm() { throw new Error('no confirm dialog in the 2-click flow') },
    apiFetch: srv.apiFetch, ensureScheduleData: async () => {},
    sb: { rpc: async (fn, args) => fn === 'ship_labels_pending' ? { data: srv.pending, error: null } : fn === 'ship_labels_for_order' ? { data: srv.labelsFor(args.p_order_id), error: null } : { error: new Error(fn) } },
    window: { open: () => { const w = { closed: false, location: { href: '' }, document: { title: '', body: { innerHTML: '' } }, close() { this.closed = true } }; opened.push({ w, before: srv.log.length }); return popup ? w : null } },
    document: { getElementById: id => (id === 'retailBody' ? el : null) }
  }
  const code = NAMES.map(n => declarationSource(src, n).replace(/^const (RETAIL_BUY_ENABLED|RETAIL_BUY_PARALLEL|RETAIL_BUSY_WAIT_MS)/, 'let $1')).join('\n') + `
;({ set(o) { if ('orders' in o) { retailOrders = o.orders; retailLoadedAt = Date.now() } if ('enabled' in o) RETAIL_BUY_ENABLED = o.enabled
    if ('sel' in o) retailSel = new Set(o.sel); if ('pending' in o) retailPending = o.pending; if ('parallel' in o) RETAIL_BUY_PARALLEL = o.parallel; if ('busyWait' in o) RETAIL_BUSY_WAIT_MS = o.busyWait },
  get batch() { return retailBatch }, get unrecorded() { return retailUnrecorded }, set loading(v) { retailLoading = v }, get inFlight() { return retailBuyInFlight }, get sel() { return [...retailSel] }, get pending() { return retailPending },
  buy: retailBuyAndPrint, toggle: retailToggle, toggleAll: retailToggleAll, row: retailRowAction, pdf: retailPdfButton, reprint: retailReprintBought,
  back: retailBackToQueue, load: loadRetailOrders, groups: retailGroups, slip: retailSlip, render: renderRetail })`
  const api = vm.runInNewContext(code, ctx)
  api.set({ enabled, busyWait: 5 })                   // the real 1.5 s wait has its own test
  api.html = () => el.innerHTML
  api.opened = opened
  api.ctx = ctx
  api.storage = storage
  api.fireLongTimers = () => longTimers.splice(0).forEach(f => f())
  return api
}
// Sandbox values come from another realm: compare them as plain JSON.
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m)
const rowOf = (p, o) => p.batch.rows.find(r => r.order.order_id === o.order_id)

// ── R1, R2: two taps; what each request carries ─────────────────────────────────────────────
test('B3a R1: Select all, then Buy and print: every order bought and one PDF, no confirm, the tab opened in the tap', async () => {
  const srv = server()
  const p = page({ srv })
  const orders = [order(), order({ parcel: P['12x8x6'] }), order({ parcel: P['14x10x10'] })]
  p.set({ orders })
  p.toggleAll()                                         // tap 1
  await p.buy()                                         // tap 2
  eq(p.batch.rows.map(r => r.status), ['bought', 'bought', 'bought'])
  assert.equal(srv.calls('action=rate').length, 3)
  assert.equal(srv.calls('action=label').length, 3)
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.equal(p.opened.length, 1)
  assert.equal(p.opened[0].before, 0)                   // opened before any request: inside the tap, so Safari allows it
  // Safari allows window.open only in the tap itself: before the first await in each handler.
  const src = inlineScripts().join('\n')
  for (const fn of ['retailBuyAndPrint', 'retailPdfButton', 'retailReprintBought']) {
    const code = declarationSource(src, fn)
    assert.ok(code.indexOf('retailPdfTab(') > 0 && code.indexOf('retailPdfTab(') < code.indexOf('await '), fn)
  }
  assert.equal(p.opened[0].w.location.href, 'blob:pdf')
  assert.equal(p.inFlight, false)
  assert.match(p.html(), /Bought 3 of 3 labels/)
  assert.match(p.html(), /Spent \$19\.29/)
})

test('B3a R2: every label request is retail, UPS, packed, priced at the quote, box 1 of 1, with the server\'s pack', async () => {
  const srv = server({ rate: b => ({ json: { ok: true, amount: b.parcel.weight === 2 ? '9.1' : '6.43' } }) })
  const p = page({ srv })
  const a = order({ shipping_address: { name: 'Ana', address1: '1 A St', address2: 'Apt 2', city: 'Queens', province: 'NY', zip: '11418', country: 'US', phone: '555' } })
  const b = order({ parcel: P['12x8x6'] })
  p.set({ orders: [a, b], sel: [a.order_id, b.order_id] })
  await p.buy()
  for (const c of [...srv.calls('action=rate'), ...srv.calls('action=label')]) {
    assert.equal(c.body.kind, 'retail')
    assert.match(c.body.order_id, /^gid:\/\/shopify\/Order\/\d+$/)   // the server quotes and buys at Shopify's address for it
    assert.equal(c.body.carrier, 'ups')
    assert.equal(c.body.weight_basis, 'packed')
    assert.equal('email' in c.body.address_to, false)
  }
  const la = srv.calls('action=label').find(c => c.body.order_id === a.order_id).body
  assert.deepEqual(structuredClone(la.address_to), { name: 'Ana', company: '', street1: '1 A St', street2: 'Apt 2', city: 'Queens', state: 'NY', zip: '11418', country: 'US', phone: '555' })
  assert.equal(la.expected_amount, '6.43')
  assert.deepEqual([la.box_index, la.box_count, la.pack_sig, la.order_name], [1, 1, '8x6x3@1', a.order_name])
  const lb = srv.calls('action=label').find(c => c.body.order_id === b.order_id).body
  assert.equal(lb.expected_amount, '9.10')
  assert.equal(lb.pack_sig, '12x8x6@2')
})

test('B3a: nothing happens while buying is switched off, or past 25, or for an order that is not ticked and ready', async () => {
  const srv = server()
  const p = page({ srv, enabled: false })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.equal(srv.log.length, 0)
  assert.equal(p.opened.length, 0)
  const q = page({ srv })
  const many = Array.from({ length: 26 }, () => order())
  q.set({ orders: many, sel: many.map(x => x.order_id) })          // forced past the cap
  await q.buy()
  assert.equal(srv.log.length, 0)
  const fixed = order({ fix: { code: 'PO_BOX', text: 'x' } })
  q.set({ orders: [fixed], sel: [fixed.order_id] })
  await q.buy()
  assert.equal(srv.log.length, 0)
})

// ── R3: no rate (Andy: buy the rated ones at once, show the rest after) ─────────────────────
test('B3a R3: an order with no UPS rate is not bought; the others are; Re-rate then Buy buys it alone', async () => {
  const bad = order({ order_name: '#8301' })
  let fixedAddress = false
  const srv = server({ rate: b => (b.address_to.street1 === bad.shipping_address.address1 && !fixedAddress
    ? { status: 422, json: { error: 'No UPS Ground rate returned', messages: [{ text: 'Address not valid' }], rates: [] } }
    : { json: { ok: true, amount: '7.00' } }) })
  const p = page({ srv })
  const orders = [order(), bad, order()]
  p.set({ orders, sel: orders.map(o => o.order_id) })
  await p.buy()
  assert.equal(rowOf(p, bad).status, 'norate')
  assert.equal(srv.calls('action=label').length, 2)
  assert.ok(srv.calls('action=label').every(c => c.body.order_id !== bad.order_id))
  const html = p.html()
  assert.match(html, /1 order has no UPS Ground rate, so it was not bought/)
  assert.match(html, /No UPS Ground rate returned · Address not valid/)
  assert.match(html, /href="https:\/\/admin\.shopify\.com\/store\/s\/orders\/\d+" target="_blank" rel="noopener">Open in Shopify</)
  assert.match(html, /data-what="rerate"/)
  // Re-rate: still none. Then the address is fixed: a quote, and a Buy for that row alone.
  await p.row(bad.order_id, 'rerate')
  assert.equal(rowOf(p, bad).status, 'norate')
  fixedAddress = true
  await p.row(bad.order_id, 'rerate')
  assert.equal(rowOf(p, bad).status, 'quoted')
  assert.match(p.html(), /Buy \$7\.00/)
  assert.equal(srv.calls('action=label').length, 2)          // a quote buys nothing
  await p.row(bad.order_id, 'buy')
  assert.equal(rowOf(p, bad).status, 'bought')
  const last = srv.calls('action=label').at(-1).body
  assert.equal(last.order_id, bad.order_id)
  assert.equal(last.expected_amount, '7.00')
  assert.match(p.html(), /Labels were bought after the PDF was made/)
})

// ── R4, R5: one failure does not stop the rest; the price guard ─────────────────────────────
test('B3a R4: a failed purchase on one order does not stop the others; Try again buys it', async () => {
  const sick = order()
  let fail = true
  const srv = server({ label: b => (b.order_id === sick.order_id && fail ? { status: 502, json: { error: 'Label purchase failed <b>x</b>' } } : null) })
  const p = page({ srv })
  const orders = [order(), order(), sick, order(), order()]
  p.set({ orders, sel: orders.map(o => o.order_id) })
  await p.buy()
  assert.equal(p.batch.rows.filter(r => r.status === 'bought').length, 4)
  assert.equal(rowOf(p, sick).status, 'failed')
  assert.match(p.html(), /Label purchase failed &lt;b&gt;x&lt;\/b&gt;/)       // escaped
  assert.match(p.html(), /4 bought/)
  assert.match(p.html(), /1 not bought/)
  fail = false
  await p.row(sick.order_id, 'retry')
  assert.equal(rowOf(p, sick).status, 'bought')
})

test('B3a R4: no answer from the server leaves the row "try again" (the server never buys a box twice)', async () => {
  const lost = order()
  const srv = server({ label: b => (b.order_id === lost.order_id ? { throw: 'Load failed' } : null) })
  const p = page({ srv })
  p.set({ orders: [lost, order()], sel: [lost.order_id] })
  await p.buy()
  assert.equal(rowOf(p, lost).status, 'failed')
  assert.match(p.html(), /No answer from the server \(Load failed\)\. Try again now; if it still fails, check Shippo before buying it again\./)
  assert.ok(p.unrecorded[lost.order_id])                     // remembered until a retry settles it
})

test('B3a R5: a price that rose is not bought; Re-rate, then Buy, at the new quote, for that row only', async () => {
  const up = order()
  const srv = server({
    rate: () => ({ json: { ok: true, amount: srv.repriced ? '8.25' : '6.43' } }),
    label: b => (b.order_id === up.order_id && b.expected_amount === '6.43' ? { status: 409, json: { error: 'Price changed', quoted: '6.43', amount: '8.25' } } : null)
  })
  const p = page({ srv })
  const other = order()
  p.set({ orders: [up, other], sel: [up.order_id, other.order_id] })
  await p.buy()
  assert.equal(rowOf(p, up).status, 'price')
  assert.equal(rowOf(p, other).status, 'bought')
  assert.match(p.html(), /UPS now charges \$8\.25, quoted \$6\.43\. Not bought\. Re-rate this row\./)
  assert.doesNotMatch(p.html(), /data-what="buy"/)            // no Buy until it is re-rated
  srv.repriced = true
  await p.row(up.order_id, 'rerate')
  await p.row(up.order_id, 'buy')
  assert.equal(rowOf(p, up).status, 'bought')
  const labels = srv.calls('action=label').filter(c => c.body.order_id === up.order_id).map(c => c.body.expected_amount)
  assert.deepEqual(labels, ['6.43', '8.25'])
  assert.equal(srv.calls('action=label').filter(c => c.body.order_id === other.order_id).length, 1)
})

// ── R6: already bought; a reload ─────────────────────────────────────────────────────────────
test('B3a R6: "Already bought" counts as bought and costs nothing more', async () => {
  const twice = order()
  const srv = server({ label: b => (b.order_id === twice.order_id ? { status: 409, json: { error: 'Already bought', tracking_number: '1ZOLD', label_url: 'https://deliver.goshippo.com/old.pdf' } } : null) })
  const p = page({ srv })
  p.set({ orders: [twice], sel: [twice.order_id] })
  await p.buy()
  assert.equal(rowOf(p, twice).status, 'bought')
  assert.equal(rowOf(p, twice).label.recovered, true)
  assert.match(p.html(), /Bought earlier; not charged again/)
  assert.match(p.html(), /Spent \$0\.00 · 1 bought earlier/)
  assert.ok(p.pending[twice.order_id])
  assert.equal(srv.calls('/api/ship-doc')[0].body.orders[0].label_url, 'https://deliver.goshippo.com/old.pdf')
})

test('B3a R6: after a reload, orders with a retail label bought are in Bought, never ticked, never sent to Buy', async () => {
  const done = order(), fresh = order()
  const srv = server({ pending: [{ order_id: done.order_id, order_name: done.order_name, labels_bought: 1, channel: 'retail' },
    { order_id: 'gid://shopify/Order/77', order_name: '#B2B', labels_bought: 2, channel: 'b2b' }] })
  const p = page({ srv })
  p.set({ orders: [done, fresh] })
  // What loadRetailOrders does with the RPC: retail rows only.
  const res = { ok: true, json: async () => ({ orders: [done, fresh], excluded: {} }) }
  p.ctx.apiFetch = async () => res
  await p.load()
  eq(Object.keys(p.pending), [done.order_id])
  const g = p.groups([done, fresh])
  eq(g.bought.map(o => o.order_id), [done.order_id])
  eq(g.ready['8x6x3'].map(o => o.order_id), [fresh.order_id])
  p.toggleAll()
  eq(p.sel, [fresh.order_id])
  p.toggle(done.order_id)
  eq(p.sel, [fresh.order_id])
  const html = p.html()
  assert.match(html, /Bought, not fulfilled · 1/)
  assert.match(html, new RegExp(`${done.order_name}[\\s\\S]*Label bought[\\s\\S]*>Reprint<`))
})

test('B3a R6: a failed label lookup keeps the queue and says so; buying stays guarded by the server', async () => {
  const p = page()
  p.ctx.sb.rpc = async () => ({ data: null, error: new Error('permission denied') })
  const o = order()
  p.ctx.apiFetch = async () => ({ ok: true, json: async () => ({ orders: [o], excluded: {} }) })
  await p.load()
  assert.match(p.html(), /Couldn't check which orders already have a label \(permission denied\)\. Orders this device knows are bought still show in Bought/)
})

// ── R7: the lock ─────────────────────────────────────────────────────────────────────────────
test('B3a R7: while buying, ticking, Refresh, Back, a second Buy and row actions do nothing; the screen has no buttons to tap', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const srv = server({ hold: url => (url.includes('action=label') ? gate : null) })
  const p = page({ srv })
  const a = order(), b = order()
  p.set({ orders: [a, b], sel: [a.order_id] })
  const running = p.buy()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(p.inFlight, true)
  p.toggle(b.order_id); p.toggleAll()
  eq(p.sel, [])
  let reloaded = false
  p.ctx.apiFetch = async () => { reloaded = true; throw new Error('no') }
  await p.load()
  assert.equal(reloaded, false)
  p.back()
  assert.ok(p.batch)
  await p.buy()
  await p.row(a.order_id, 'retry')
  await p.pdf()
  const html = p.html()
  assert.match(html, /Nothing to click while this runs/)
  assert.doesNotMatch(html, /Back to queue|data-what=/)
  assert.match(html, /onclick="retailPdfButton\(false\)" disabled/)
  assert.match(html, /onclick="retailPdfButton\(true\)" disabled/)
  p.ctx.apiFetch = srv.apiFetch
  release()
  await running
  assert.equal(p.inFlight, false)
  assert.equal(srv.calls('action=label').length, 1)
  assert.match(p.html(), /Back to queue/)
})

// ── R8: the PDF ──────────────────────────────────────────────────────────────────────────────
test('B3a R8: the PDF is label then slip per order, by carton then oldest; Open PDF and Reprint never buy', async () => {
  const srv = server()
  const p = page({ srv })
  const big = order({ parcel: P['14x10x10'], created_at: '2026-10-01T10:00:00Z' })
  const mid = order({ parcel: P['12x8x6'], created_at: '2026-10-03T10:00:00Z' })
  const small2 = order({ created_at: '2026-10-05T10:00:00Z' })
  const small1 = order({ created_at: '2026-10-02T10:00:00Z' })
  p.set({ orders: [big, mid, small2, small1], sel: [big, mid, small2, small1].map(o => o.order_id) })
  await p.buy()
  const doc = srv.calls('/api/ship-doc')[0].body
  assert.equal(doc.kind, 'retail')
  assert.deepEqual([doc.include_labels, doc.include_slips], [true, true])
  eq(doc.orders.map(o => o.slip.order_name), [small1, small2, mid, big].map(o => o.order_name))
  eq(p.batch.rows.map(r => r.order.order_id), [small1, small2, mid, big].map(o => o.order_id))   // the screen too
  const buys = srv.calls('action=').length
  await p.pdf(false)                                  // Open PDF: the PDF already made, no new build
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  await p.pdf(true)                                   // Reprint: a new one from the server
  await p.pdf(true)
  assert.equal(srv.calls('/api/ship-doc').length, 3)
  assert.equal(srv.calls('action=').length, buys)
  assert.equal(p.opened.length, 4)
})

test('B3a R8: a blocked tab or a failed PDF says what to do; nothing is bought again', async () => {
  const p = page({ popup: false })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.match(p.html(), /The PDF tab was blocked\. Tap Open PDF\./)
  const srv = server({ pdf: () => ({ status: 502, json: { error: 'Could not build ship document', detail: 'label for #1: status 403' } }) })
  const q = page({ srv })
  q.set({ orders: [o], sel: [o.order_id] })
  await q.buy()
  assert.match(q.html(), /Couldn&#39;t build the PDF: Could not build ship document \(label for #1: status 403\)\. Nothing was bought again\./)
  assert.equal(q.opened[0].w.closed, true)
  assert.equal(srv.calls('action=label').length, 1)
})

test('B3a R8: a batch where nothing was bought closes the tab and makes no PDF', async () => {
  const srv = server({ rate: () => ({ status: 422, json: { error: 'No UPS Ground rate returned' } }) })
  const p = page({ srv })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.equal(srv.calls('/api/ship-doc').length, 0)
  assert.equal(p.opened[0].w.closed, true)
})

test('B3a R8: the slip carries what retail_slip_spec.md prints, from the queue order', () => {
  const p = page()
  const o = order({ order_name: '#8291', created_at: '2026-10-14T03:30:00Z', flags: ['REPLACEMENT'], discount_codes: ['MISSHIP-8255'], subscription: 'FIRST', note: 'Side door',
    items: [{ product_name: 'Dark Drop', variant_title: '8 xPods', qty: 1, weight_lb: 0.75 }, { product_name: 'Cocoa Drop', variant_title: '2lb', qty: 2, weight_lb: 2 }], parcel: P['12x8x6'] })
  assert.deepEqual(structuredClone(p.slip(o)), {
    order_name: '#8291', date: '2026-10-13',                         // 03:30 UTC is the evening before in San Diego
    subscription: 'FIRST', replacement: 'MISSHIP-8255', name: o.shipping_address.name, city_line: 'San Diego, CA 92104',
    lines: [{ qty: 1, size: '8 xPods', name: 'Dark Drop' }, { qty: 2, size: '2lb', name: 'Cocoa Drop' }],
    note: 'Side door', carton: '12x8x6', billed_lb: 2 })
  assert.equal(p.slip(order()).replacement, null)
  assert.equal(p.slip(order({ flags: ['REPLACEMENT'] })).replacement, '')   // the slip says "reason not recorded"
})

test('B3a R8: Reprint from the queue sends the saved label and the slip, and buys nothing', async () => {
  const done = order()
  // The voided label is the newer one: it must still never be printed.
  const srv = server({ labelsFor: () => [{ box_index: 1, status: 'purchased', label_url: 'https://deliver.goshippo.com/live.pdf', created_at: '2026-10-19T01:00:00Z' },
    { box_index: 1, status: 'voided', label_url: 'https://deliver.goshippo.com/void.pdf', created_at: '2026-10-19T02:00:00Z' }] })
  const p = page({ srv })
  p.set({ orders: [done], pending: { [done.order_id]: { order_id: done.order_id } } })
  await p.reprint(done.order_id)
  const doc = srv.calls('/api/ship-doc')
  assert.equal(doc.length, 1)
  assert.deepEqual(doc[0].body.orders.map(o => o.label_url), ['https://deliver.goshippo.com/live.pdf'])
  assert.equal(srv.calls('action=').length, 0)
  // Two live labels on record (one planted, or a fault): nothing is printed; it says so.
  srv.labelsFor = () => [{ box_index: 1, status: 'purchased', label_url: 'https://deliver.goshippo.com/a.pdf' }, { box_index: 1, status: 'purchased', label_url: 'https://deliver.goshippo.com/b.pdf' }]
  await p.reprint(done.order_id)
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.match(p.ctx.alerts.at(-1), /2 labels on record for this order\. Tell Andy/)
})

// ── R9: escaping ─────────────────────────────────────────────────────────────────────────────
test('B3a R9: order names, coffees, notes and server reasons are escaped on the Buying screen', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const o = order({ order_name: evil, note: evil, items: [{ product_name: evil, variant_title: '12oz', qty: 1, weight_lb: 0.75 }] })
  const srv = server({ rate: () => ({ status: 422, json: { error: evil, messages: [{ text: evil }] } }) })
  const p = page({ srv })
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.doesNotMatch(p.html(), /<img/)
  assert.match(p.html(), /&lt;img src=x onerror=alert\(1\)&gt;/)
})

// ── R10: the B2B tab ─────────────────────────────────────────────────────────────────────────
test('B3a R10: the B2B Ship tab\'s "never fulfilled" banner leaves retail labels out (rows from before the migration are B2B)', async () => {
  const rows = [{ order_id: 'b2b-new', channel: 'b2b' }, { order_id: 'retail', channel: 'retail' }, { order_id: 'b2b-old' }]
  const src = inlineScripts().join('\n')
  const api = vm.runInNewContext(['shipPending', 'loadShipPending'].map(n => declarationSource(src, n)).join('\n') +
    '\n;({ load: loadShipPending, get pending() { return shipPending } })', { sb: { rpc: async () => ({ data: rows, error: null }) }, console })
  await api.load()
  assert.deepEqual(Object.keys(api.pending).sort(), ['b2b-new', 'b2b-old'])
})

// ── R11: three at a time; a busy server drops it to one ──────────────────────────────────────
test('B3a R11: never more than 3 requests at once; a "too many" answer drops to one at a time and retries the order', async () => {
  const srv = server()
  const p = page({ srv })
  const orders = Array.from({ length: 12 }, () => order())
  p.set({ orders, sel: orders.map(o => o.order_id) })
  await p.buy()
  assert.ok(srv.maxInFlight <= 3, `max in flight ${srv.maxInFlight}`)
  assert.ok(srv.maxInFlight >= 2, 'runs in parallel')
  assert.ok(p.batch.rows.every(r => r.status === 'bought'))

  let busy = 1
  const srv2 = server({ label: b => (busy-- > 0 ? { status: 429, json: { error: 'Too many requests' } } : null) })
  const q = page({ srv: srv2 })
  q.set({ orders, sel: orders.map(o => o.order_id) })
  await q.buy()
  assert.equal(q.batch.limit, 1)
  assert.ok(q.batch.rows.every(r => r.status === 'bought'))
  assert.equal(srv2.calls('action=label').length, 13)               // the refused one, tried again
  // Once the requests already running have finished, it really is one at a time.
  assert.deepEqual(srv2.log.slice(-8).map(e => e.busy), [0, 0, 0, 0, 0, 0, 0, 0])
})


// ── Round 1 review fixes (docs/JOURNAL.md, B3a) ─────────────────────────────────────────────
test('B3a: a label bought but not recorded says so loudly, on the row and above the table', async () => {
  const lost = order()
  const srv = server({ label: b => (b.order_id === lost.order_id ? { json: { ok: true, cost: '6.43', tracking_number: '1ZLOST', label_url: 'https://deliver.goshippo.com/l.pdf', cost_logged: false } } : null) })
  const p = page({ srv })
  p.set({ orders: [order(), lost], sel: [lost.order_id] })
  await p.buy()
  assert.equal(rowOf(p, lost).status, 'bought')
  assert.match(p.html(), new RegExp(`${lost.order_name}: bought, but not recorded in the portal\\. Do not buy it again`))
  assert.match(p.html(), /Bought, but not recorded in the portal\. Do not buy this order again\. Tell Andy\./)
})

test('B3a: a "too many" answer that lands after the other workers finished is still retried (no row left Waiting)', async () => {
  const late = order({ created_at: '2026-10-09T00:00:00Z' })   // newest: the third worker gets it
  let first = true
  const srv = server({
    hold: async (url, b) => { if (url.includes('action=label') && b.order_id === late.order_id && first) await new Promise(r => setTimeout(r, 40)) },
    label: b => (b.order_id === late.order_id && first ? (first = false, { status: 429, json: { error: 'busy' } }) : null)
  })
  const p = page({ srv })
  const orders = [order({ created_at: '2026-10-01T00:00:00Z' }), order({ created_at: '2026-10-02T00:00:00Z' }), late]
  p.set({ orders, sel: orders.map(o => o.order_id) })
  await p.buy()
  assert.equal(p.batch.rows[2].order.order_id, late.order_id)
  eq(p.batch.rows.map(r => r.status), ['bought', 'bought', 'bought'])
  assert.equal(p.inFlight, false)
})

test('B3a: a "too many" answer at the quote step is retried; three in a row gives up with a message', async () => {
  let busy = 1
  const srv = server({ rate: () => (busy-- > 0 ? { status: 429, json: {} } : { json: { ok: true, amount: '6.43' } }) })
  const p = page({ srv })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.equal(rowOf(p, o).status, 'bought')
  const srv2 = server({ rate: () => ({ status: 429, json: {} }) })
  const q = page({ srv: srv2 })
  q.set({ orders: [o], sel: [o.order_id] })
  await q.buy()
  assert.equal(rowOf(q, o).status, 'failed')
  assert.equal(srv2.calls('action=rate').length, 4)
  assert.match(q.html(), /Shippo is busy\. Try again in a minute\./)
})

test('B3a: an order that changed in Shopify is not offered Try again; a Shopify address problem offers Open in Shopify and Re-rate', async () => {
  const changed = order(), unlisted = order(), pobox = order()
  const srv = server({ label: b => (b.order_id === changed.order_id ? { status: 409, json: { error: 'This order changed since the list was loaded.', code: 'pack_changed' } }
    : b.order_id === unlisted.order_id ? { status: 409, json: { error: 'No longer shippable here.', code: 'not_listed', class: 'CANCELLED' } }
    : b.order_id === pobox.order_id ? { status: 409, json: { error: 'UPS does not deliver to P.O. boxes.', code: 'address' } } : null) })
  const p = page({ srv })
  p.set({ orders: [changed, unlisted, pobox], sel: [changed, unlisted, pobox].map(o => o.order_id) })
  await p.buy()
  for (const o of [changed, unlisted]) {
    assert.equal(rowOf(p, o).final, true)
    assert.doesNotMatch(p.html(), new RegExp(`data-id="${o.order_id}" data-what`))
    await p.row(o.order_id, 'retry')
  }
  assert.match(p.html(), /This order changed since the list was loaded\. Refresh orders after this batch\./)
  assert.equal(srv.calls('action=label').length, 3)                                  // retries refused
  assert.equal(rowOf(p, pobox).status, 'norate')
  assert.match(p.html(), new RegExp(`data-id="${pobox.order_id}" data-what="rerate"`))
})

test('B3a: a 200 without a tracking number is not bought; actions on a bought row do nothing', async () => {
  const odd = order(), fine = order()
  const srv = server({ label: b => (b.order_id === odd.order_id ? { json: { ok: true, cost: '6.43' } } : null) })
  const p = page({ srv })
  p.set({ orders: [odd, fine], sel: [odd.order_id, fine.order_id] })
  await p.buy()
  assert.equal(rowOf(p, odd).status, 'failed')
  const n = srv.log.length
  for (const what of ['retry', 'buy', 'rerate']) await p.row(fine.order_id, what)
  assert.equal(srv.log.length, n)
})

test('B3a: the PDF is made with the screen locked: no Back, no Open PDF, no second build', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const sick = order()
  const srv = server({ hold: url => (url === '/api/ship-doc' && !release.done ? gate : null),
    label: b => (b.order_id === sick.order_id ? { status: 502, json: { error: 'Label purchase failed' } } : null) })
  const p = page({ srv })
  const o = order()
  p.set({ orders: [o, sick], sel: [o.order_id, sick.order_id] })
  const running = p.buy()
  for (let i = 0; i < 20 && !srv.calls('/api/ship-doc').length; i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.equal(p.batch.printing, true)
  assert.doesNotMatch(p.html(), /Back to queue/)
  assert.match(p.html(), /Making the PDF/)
  p.back()
  await p.pdf(true); await p.pdf(false)
  await p.row(sick.order_id, 'retry')
  assert.ok(p.batch)
  assert.equal(srv.calls('action=label').length, 2)
  release.done = true; release()
  await running
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.equal(p.opened.length, 1)
  assert.match(p.html(), /Back to queue/)
})

test('B3a: a label with no file, a tab closed early, or a reply that is not a PDF each say what to do', async () => {
  const nofile = order(), ok = order()
  const srv = server({ label: b => (b.order_id === nofile.order_id ? { status: 409, json: { error: 'Already bought', tracking_number: '1ZX', label_url: null } } : null) })
  const p = page({ srv })
  p.set({ orders: [nofile, ok], sel: [nofile.order_id, ok.order_id] })
  await p.buy()
  eq(srv.calls('/api/ship-doc')[0].body.orders.map(o => o.slip.order_name), [ok.order_name])
  assert.match(p.html(), new RegExp(`No label file to print for ${nofile.order_name}\\. Reprint it from Shippo\\.`))

  const q = page()
  q.set({ orders: [ok], sel: [ok.order_id] })
  const buying = q.buy()
  q.opened[0].w.closed = true                          // closed by hand while buying ran
  await buying
  assert.match(q.html(), /The PDF tab was closed\. Tap Open PDF\./)

  const r = page({ srv: server({ pdf: () => ({ status: 200, type: 'text/html' }) }) })
  r.set({ orders: [ok], sel: [ok.order_id] })
  await r.buy()
  assert.match(r.html(), /the server did not send a PDF/)
})

test('B3a: a subscription line with no coffee set this week says so on the slip', () => {
  const p = page()
  const o = order({ items: [{ product_name: 'Classicist - Coffee Subscription', variant_title: '12oz', qty: 1, weight_lb: 0.75, note: '⚠ No coffee set for this week' }] })
  assert.equal(p.slip(o).lines[0].name, 'Classicist - Coffee Subscription (NO COFFEE SET)')
})


// ── Round 2 review fixes ─────────────────────────────────────────────────────────────────────
test('B3a: a label bought but not recorded stays in Bought after Back, a reload and on the next page load, until the DB has it', async () => {
  const lost = order(), other = order()
  const srv = server({ label: b => (b.order_id === lost.order_id ? { json: { ok: true, cost: '6.43', tracking_number: '1ZLOST', label_url: 'https://deliver.goshippo.com/l.pdf', cost_logged: false } } : null) })
  const storage = {}
  storage['tq.retail.unrecorded'] = JSON.stringify({ bad: null, old: { order_name: '#1', at: 1 } })   // junk and a stale entry are dropped
  const p = page({ srv, storage })
  p.set({ orders: [lost, other], sel: [lost.order_id] })
  await p.buy()
  p.ctx.apiFetch = async () => ({ ok: true, json: async () => ({ orders: [lost, other], excluded: {} }) })
  p.back()                                                    // reloads; the DB has no row for it
  await new Promise(r => setTimeout(r, 20))
  const g = p.groups([lost, other])
  eq(g.bought.map(o => o.order_id), [lost.order_id])
  p.toggleAll()
  eq(p.sel, [other.order_id])
  assert.match(p.html(), /Bought, not recorded\. Do not buy again\. Tell Andy/)
  // Another page load on this device (a reload) still knows.
  const q = page({ srv, storage })
  q.ctx.apiFetch = p.ctx.apiFetch
  await q.load()
  eq(q.groups([lost, other]).bought.map(o => o.order_id), [lost.order_id])
  // Once the DB has the row, the device's note is dropped.
  srv.pending.push({ order_id: lost.order_id, order_name: lost.order_name, channel: 'retail' })
  await q.load()
  eq(Object.keys(q.unrecorded), [])
})

test('B3a: the screen and the slip show the ship-to the server used, not the one from when the list loaded', async () => {
  const moved = order({ shipping_address: { name: 'Old Name', address1: '1 Old St', city: 'Oldtown', province: 'CA', zip: '92104', country: 'US' } })
  const srv = server({ rate: () => ({ json: { ok: true, amount: '6.43', ship_to: { name: 'New Name', city: 'Newtown', province: 'OR', zip: '97365' } } }) })
  const p = page({ srv })
  p.set({ orders: [moved], sel: [moved.order_id] })
  await p.buy()
  const slip = srv.calls('/api/ship-doc')[0].body.orders[0].slip
  assert.deepEqual([slip.name, slip.city_line], ['New Name', 'Newtown, OR 97365'])
  assert.match(p.html(), /OR 97365/)
  assert.doesNotMatch(p.html(), /CA 92104/)
})

test('B3a: after "too many requests" the order waits before it is tried again', async () => {
  const at = []
  let busy = 1
  const srv = server({ rate: () => { at.push(Date.now()); return busy-- > 0 ? { status: 429, json: {} } : { json: { ok: true, amount: '6.43' } } } })
  const p = page({ srv })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id], busyWait: 1500 })
  await p.buy()
  assert.equal(rowOf(p, o).status, 'bought')
  assert.ok(at[1] - at[0] >= 1400, `waited ${at[1] - at[0]} ms`)
})

test('B3a: Re-rate that hits "too many requests" is not left Waiting; a quote refused for the address or a gone order says so', async () => {
  const o = order(), gone = order(), pobox = order()
  let mode = 'norate'
  const srv = server({ rate: b => (b.order_id === gone.order_id ? { status: 409, json: { error: 'Shopify has no such order. Refresh the orders.', code: 'not_listed' } }
    : b.order_id === pobox.order_id ? { status: 409, json: { error: 'UPS does not deliver to P.O. boxes.', code: 'address' } }
    : mode === 'norate' ? { status: 422, json: { error: 'No UPS Ground rate returned' } } : { status: 429, json: {} }) })
  const p = page({ srv })
  p.set({ orders: [o, gone, pobox], sel: [o, gone, pobox].map(x => x.order_id) })
  await p.buy()
  mode = 'busy'
  await p.row(o.order_id, 'rerate')
  assert.equal(rowOf(p, o).status, 'failed')
  assert.match(p.html(), /Shippo is busy/)
  assert.equal(rowOf(p, gone).final, true)
  assert.match(p.html(), /Shopify has no such order\. Refresh the orders\. Refresh orders after this batch\./)
  assert.equal(rowOf(p, pobox).status, 'norate')
})

test('B3a: a label Shippo is still working on is never offered Try again', async () => {
  const o = order()
  const srv = server({ label: () => ({ status: 502, json: { error: "Shippo hasn't finished this label (QUEUED). Don't buy it again.", code: 'label_pending' } }) })
  const p = page({ srv })
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.equal(rowOf(p, o).final, true)
  assert.doesNotMatch(p.html(), /data-what="retry"/)
  await p.row(o.order_id, 'retry')
  assert.equal(srv.calls('action=label').length, 1)
})

test('B3a: once the PDF is freed, Open PDF makes a new one instead of opening a dead link', async () => {
  const srv = server()
  const p = page({ srv })
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  p.fireLongTimers()                                         // ten minutes later
  assert.equal(p.batch.pdfUrl, null)
  await p.pdf(false)
  assert.equal(srv.calls('/api/ship-doc').length, 2)
})

test('B3a: Buy waits for a list load still running; Reprint ignores a second tap while it works', async () => {
  const p = page()
  const o = order()
  p.set({ orders: [o], sel: [o.order_id] })
  p.loading = true
  await p.buy()
  assert.equal(p.batch, null)
  p.render()
  assert.match(p.html(), /onclick="retailBuyAndPrint\(\)" disabled/)
  p.loading = false
  let release
  const gate = new Promise(r => { release = r })
  const srv = server({ hold: () => gate, labelsFor: () => [{ box_index: 1, status: 'purchased', label_url: 'https://deliver.goshippo.com/a.pdf' }] })
  const q = page({ srv })
  q.set({ orders: [o], pending: { [o.order_id]: { order_id: o.order_id } } })
  const one = q.reprint(o.order_id)
  await new Promise(r => setTimeout(r, 5))
  const two = q.reprint(o.order_id)                    // a second tap while the first is still working
  release(); await Promise.all([one, two])
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.equal(q.opened.length, 1)
})


test('B3a R9: the "not open any more" row and a tracking number are escaped too', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const o = order()
  const srv = server({ label: () => ({ json: { ok: true, cost: '6.43', tracking_number: evil, label_url: 'https://deliver.goshippo.com/x.pdf' } }) })
  const p = page({ srv })
  p.set({ orders: [o], sel: [o.order_id] })
  await p.buy()
  assert.doesNotMatch(p.html(), /<img/)
  const q = page()
  q.set({ orders: [], pending: { gone: { order_id: 'gone', order_name: evil, unrecorded: true } } })
  q.render()
  assert.match(q.html(), /Not open in Shopify any more/)
  assert.doesNotMatch(q.html(), /<img/)
})

// ── Focused review (round 3) fixes ───────────────────────────────────────────────────────────
test('B3a: an order Shippo may have bought is remembered: in Bought after a reload, even when the lookup fails; "Shippo shows none" clears it', async () => {
  const maybe = order(), retried = order()
  let first = true
  const srv = server({ label: b => (b.order_id === maybe.order_id ? { status: 502, json: { error: "Shippo hasn't finished this label (QUEUED).", code: 'label_pending' } }
    : b.order_id === retried.order_id && first ? (first = false, { throw: 'Load failed' }) : null) })
  const storage = {}
  const p = page({ srv, storage })
  p.set({ orders: [maybe, retried], sel: [maybe.order_id, retried.order_id] })
  await p.buy()
  assert.match(p.html(), /Shippo may have bought this label\. Do not buy it again/)
  assert.ok(p.unrecorded[maybe.order_id] && p.unrecorded[retried.order_id])
  await p.row(retried.order_id, 'retry')                       // bought and recorded this time: its note goes
  assert.equal(rowOf(p, retried).status, 'bought')
  assert.equal(p.unrecorded[retried.order_id], undefined)
  // A new page load whose label lookup fails still shows it in Bought.
  const q = page({ srv, storage })
  q.ctx.sb.rpc = async () => ({ data: null, error: new Error('down') })
  q.ctx.apiFetch = async () => ({ ok: true, json: async () => ({ orders: [maybe], excluded: {} }) })
  await q.load()
  eq(q.groups([maybe]).bought.map(o => o.order_id), [maybe.order_id])
  assert.match(q.html(), /Shippo shows none/)
  q.ctx.confirm = () => true
  vm.runInNewContext(`retailClearUnrecorded(${JSON.stringify(maybe.order_id)})`, q.ctx)
  eq(q.groups([maybe]).ready['8x6x3'].map(o => o.order_id), [maybe.order_id])
  assert.equal(JSON.parse(storage['tq.retail.unrecorded'])[maybe.order_id], undefined)
})
