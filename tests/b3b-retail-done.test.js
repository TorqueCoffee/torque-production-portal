// B3b gate D1 (docs/TESTS.md): Fulfill confirm, the Fulfill run and the Done screen. The page's
// own functions run in a sandbox with a fake server (tests/helpers/retail-page.js); no Shopify
// write happens: /api/shopify-fulfill is a stub that counts the fulfillments it "creates".
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { order, pendingRow, labelRow, server, page, eq } = require('./helpers/retail-page')

// A fake Shopify behind /api/shopify-fulfill: each order is fulfilled once; a retry answers
// alreadyFulfilled. `fail(order_id, n)` can answer something else on the nth call for it.
function shopify({ fail = () => null, lose = () => false } = {}) {
  const st = { creates: [], emails: 0, calls: [], fulfilled: new Set(), lost: new Set() }
  const fn = (body, srv) => {
    const n = st.calls.filter(c => c === body.order_id).length
    st.calls.push(body.order_id)
    const f = fail(body.order_id, n)
    if (f) return f
    // The server refuses a held-back label, whatever the page thinks (api/shopify-fulfill.js).
    const held = srv.pending.find(p => p.order_id === body.order_id)
    if (held && held.held_back_at) return { status: 409, json: { code: 'held_back', error: 'This order is held back. Include it on the Pack screen first.' } }
    if (st.fulfilled.has(body.order_id)) return { json: { ok: true, alreadyFulfilled: true, notified: false, emailed: false } }
    st.fulfilled.add(body.order_id); st.creates.push(body.order_id); st.emails++
    const row = srv.pending.findIndex(p => p.order_id === body.order_id)
    if (lose(body.order_id, n)) { st.lost.add(body.order_id); return { throw: 'network lost' } }   // created, but the answer never arrives
    if (row >= 0) srv.pending.splice(row, 1)                                                        // the label rows flip to fulfilled
    return { json: { ok: true, notified: true, emailed: true, order: body.order_id } }
  }
  fn.st = st
  return fn
}
async function opened(orders, { held = [], sh = shopify(), srvOpts = {} } = {}) {
  const srv = server({ orders, pending: orders.map(o => pendingRow(o, held.includes(o) ? { held_back_at: 'x' } : {})), fulfill: sh, ...srvOpts })
  const p = page({ srv })
  await p.openPack()
  return { p, srv, sh }
}
const fulfillCalls = srv => srv.calls('/api/shopify-fulfill')
const tileOf = (html, label) => { const m = html.match(new RegExp(`<b>(\\d+)</b><span>${label}</span>`)); return m ? Number(m[1]) : null }

test('D1: Fulfill N orders opens an in-page confirm that counts only the included cards; nothing is sent yet', async () => {
  const os = [order(), order(), order(), order()]
  const { p, srv } = await opened(os, { held: [os[3]] })
  assert.match(p.html(), /Fulfill 3 orders/)
  p.ask()
  const html = p.html()
  assert.match(html, /3 of 4 packed\. Send 3 customer emails\?/)
  assert.match(html, /Writes UPS tracking to Shopify for 3 orders; Shopify sends one shipping email each\. 1 held back stays? open in the queue\./)
  assert.match(html, />Back</)
  assert.match(html, />Fulfill and send</)
  assert.equal(p.ctx.alerts.length + p.confirms.length, 0)         // not a browser confirm()
  assert.equal(fulfillCalls(srv).length, 0)
  p.askBack()
  assert.doesNotMatch(p.html(), /Fulfill and send/)
  assert.equal(fulfillCalls(srv).length, 0)
})

test('D1: Fulfill and send posts kind retail for the included orders only; held ids are never sent; cards are locked while it runs', async () => {
  const os = [order(), order(), order()]
  const { p, srv, sh } = await opened(os, { held: [os[1]] })
  p.ask()
  const run = p.go()
  assert.equal(p.pack.fulfilling, true)
  assert.doesNotMatch(p.html().replace(/<button[^>]*disabled[^>]*>/g, ''), /<button[^>]*onclick="(retailSetHeld|retailReprintBought|retailBackFromPack|loadRetailOrders|retailFulfillAsk)/)   // every control is off
  await p.setHeld(os[0].order_id, true)                             // ignored
  await run
  const bodies = fulfillCalls(srv).map(c => c.body)
  assert.deepEqual(bodies.map(b => b.order_id).sort(), [os[0].order_id, os[2].order_id].sort())
  for (const b of bodies) assert.deepEqual(Object.keys(b).sort(), ['kind', 'order_id'])
  for (const b of bodies) assert.equal(b.kind, 'retail')
  assert.equal(srv.rpcs('set_ship_label_held_back').length, 0)
  assert.equal(sh.st.creates.length, 2)
  assert.equal(p.pack.fulfilling, false)
})

test('D1: a double tap on Fulfill and send, or a second Fulfill during the run, makes no extra calls', async () => {
  const os = [order(), order(), order()]
  const { p, srv, sh } = await opened(os)
  p.ask()
  const first = p.go()
  const second = p.go()                                              // double tap
  p.ask()                                                            // a second Fulfill during the run
  const third = p.go()
  await Promise.all([first, second, third])
  assert.equal(fulfillCalls(srv).length, 3)
  assert.equal(sh.st.creates.length, 3)
  assert.equal(srv.maxInFlight <= 3, true)
})

test('D1: the Done counts equal the fulfillments Shopify created (acceptance check 8)', async () => {
  const os = [order(), order(), order(), order(), order()]
  const { p, sh } = await opened(os, { held: [os[4]] })
  p.ask(); await p.go()
  const html = p.html()
  assert.match(html, /Batch done/)
  assert.equal(sh.st.creates.length, 4)
  assert.equal(tileOf(html, 'Shipped'), sh.st.creates.length)
  assert.equal(tileOf(html, 'Customer emails sent'), sh.st.emails)
  assert.equal(tileOf(html, 'Parcels for pickup'), sh.st.creates.length)
  assert.equal(tileOf(html, 'Still open'), 1)
  assert.match(html, new RegExp(`${os[4].order_name}</b> was held back`))
  assert.match(html, /Show in queue/)
  assert.match(html, /Done for you/)
  assert.match(html, />Back to queue</)
  assert.match(html, />Reprint this batch</)
})

test('D1: one failure (502) does not stop the rest; the failed order is Still open with its reason, and is remembered for the session', async () => {
  const os = [order(), order(), order()]
  const sh = shopify({ fail: id => (id === os[1].order_id ? { status: 502, json: { error: 'fulfillmentCreate failed' } } : null) })
  const { p } = await opened(os, { sh })
  p.ask(); await p.go()
  assert.equal(sh.st.creates.length, 2)
  assert.equal(tileOf(p.html(), 'Shipped'), 2)
  assert.equal(tileOf(p.html(), 'Still open'), 1)
  assert.match(p.html(), new RegExp(`${os[1].order_name}</b>[^<]*[\\s\\S]*fulfillmentCreate failed`))
  eq(Object.keys(p.failed), [os[1].order_id])
  assert.equal(p.failed[os[1].order_id].order_name, os[1].order_name)
  assert.match(p.failed[os[1].order_id].why, /fulfillmentCreate failed/)
})

test('D1: a lost answer, then Fulfill again: one create across both, and the email count does not rise on alreadyFulfilled', async () => {
  const os = [order(), order()]
  const sh = shopify({ lose: (id, n) => id === os[0].order_id && n === 0 })
  const { p, srv } = await opened(os, { sh })
  p.ask(); await p.go()
  assert.equal(tileOf(p.html(), 'Shipped'), 1)
  assert.equal(tileOf(p.html(), 'Customer emails sent'), 1)
  assert.equal(tileOf(p.html(), 'Still open'), 1)
  assert.match(p.html(), /No answer from the server/)
  // Back to the queue, resume, Fulfill the open one again: Shopify answers alreadyFulfilled.
  p.backFromPack()
  await p.openPack()
  eq(p.cards().map(c => c.order.order_id), [os[0].order_id])      // the lost one is still in the open batch
  p.ask(); await p.go()
  assert.equal(sh.st.creates.filter(id => id === os[0].order_id).length, 1)
  assert.equal(sh.st.emails, 2)                                                  // two orders, two emails, no third
  assert.equal(tileOf(p.html(), 'Shipped'), 1)
  assert.equal(tileOf(p.html(), 'Customer emails sent'), 0)
  assert.match(p.html(), /already/i)
})

test('D1: after a 429 the rest of the batch goes one request at a time', async () => {
  const os = Array.from({ length: 7 }, () => order())
  const sh = shopify({ fail: (id, n) => (id === os[0].order_id && n === 0 ? { status: 429, json: { error: 'busy' } } : null) })
  const { p, srv } = await opened(os, { sh })
  p.ask(); await p.go()
  const calls = srv.log.filter(e => e.url === '/api/shopify-fulfill')
  assert.equal(calls.length, 8)                                      // seven orders, one of them twice
  assert.equal(Math.max(...calls.slice(0, 3).map(c => c.busy)), 2)   // the first three ran together
  assert.ok(calls.slice(4).every(c => c.busy === 0), 'one at a time after the 429')
  assert.equal(sh.st.creates.length, 7)
})

test('D1: a 429 or 503 drops to one at a time and the order is tried again after a wait (the first try and three more)', async () => {
  const os = [order(), order(), order(), order()]
  const sh = shopify({ fail: (id, n) => (id === os[0].order_id && n < 2 ? { status: n === 0 ? 429 : 503, json: { error: 'busy' } } : null) })
  const { p, srv } = await opened(os, { sh })
  p.ask(); await p.go()
  assert.equal(fulfillCalls(srv).filter(c => c.body.order_id === os[0].order_id).length, 3)
  assert.equal(sh.st.creates.length, 4)
  // After the first 429 nothing else ran in parallel with a later request.
  const calls = srv.log.filter(e => e.url === '/api/shopify-fulfill')
  const retry = calls.findIndex((e, i) => i > 0 && e.body.order_id === os[0].order_id)
  assert.ok(retry > 0 && calls.slice(retry).every(e => e.busy === 0), 'one at a time after a 429')
  // Three busy answers in a row give up, with a reason.
  const sh2 = shopify({ fail: id => (id === os[0].order_id ? { status: 429, json: { error: 'busy' } } : null) })
  const q = await opened(os.map(o => ({ ...o })), { sh: sh2 })
  q.p.ask(); await q.p.go()
  assert.equal(fulfillCalls(q.srv).filter(c => c.body.order_id === os[0].order_id).length, 4)      // the first try and three more, after 1.5, 3 and 4.5 s
  assert.equal(tileOf(q.p.html(), 'Still open'), 1)
  assert.match(q.p.html(), /busy/)
})

test('D1: Reprint this batch rebuilds one PDF from the saved fulfilled labels, opened in the tap, and never buys', async () => {
  const os = [order(), order(), order()]
  const { p, srv } = await opened(os, { srvOpts: {
    labelsFor: id => { const o = os.find(x => x.order_id === id); return [labelRow(o, { status: 'fulfilled' })] } } })
  p.ask(); await p.go()
  const before = srv.log.length
  const run = p.reprintBatch()
  assert.equal(p.opened.length, 1)
  assert.equal(p.opened[0].before, before)                           // opened before any request: inside the tap
  await run
  const docs = srv.calls('/api/ship-doc')
  assert.equal(docs.length, 1)
  assert.equal(docs[0].body.orders.length, 3)
  assert.equal(srv.calls('shippo-label').length, 0)
  assert.equal(srv.calls('shopify-fulfill').length, 3)               // none added
  assert.equal(p.opened[0].w.location.href, 'blob:pdf')
})

test('D1: Reprint this batch builds at most 25 labels and says what it left out', async () => {
  const os = Array.from({ length: 27 }, () => order())
  const { p, srv } = await opened(os, { srvOpts: { labelsFor: id => [labelRow(os.find(x => x.order_id === id), { status: 'fulfilled' })] } })
  p.ask(); await p.go()
  await p.reprintBatch()
  assert.equal(srv.calls('/api/ship-doc')[0].body.orders.length, 25)
})

test('D1: calling the run twice (or the same ids twice) does not send anything twice', async () => {
  const os = [order(), order()]
  const { p, srv, sh } = await opened(os)
  const ids = os.map(o => o.order_id)
  await Promise.all([p.run(ids), p.run(ids)])
  assert.equal(fulfillCalls(srv).length, 2)
  assert.equal(sh.st.creates.length, 2)
})

test('D1: Fulfill is off when every order is held back, and the cards are locked while the confirm is open', async () => {
  const os = [order(), order()]
  const { p, srv } = await opened(os, { held: os })
  assert.match(p.html(), /rt-fulfill" onclick="retailFulfillAsk\(\)" disabled>Fulfill 0 orders</)
  p.ask()
  assert.doesNotMatch(p.html(), /Fulfill and send/)
  const q = await opened([order(), order()])
  q.p.ask()
  const html = q.p.html()
  for (const tag of html.match(/<button[^>]*(retailSetHeld|retailReprintBought|retailBackFromPack|loadRetailOrders|retailFulfillAsk)[^>]*>/g)) assert.match(tag, /disabled/, tag)
  await q.p.setHeld(q.p.cards()[0].order.order_id, true)            // ignored while the confirm is open
  assert.equal(q.srv.rpcs('set_ship_label_held_back').length, 0)
  q.p.askBack()
  assert.doesNotMatch(q.p.html(), /Fulfill and send/)
})

test('D1: an error inside the run still unlocks the screen, and a failed order stays in the open batch', async () => {
  const os = [order(), order()]
  const { p, srv } = await opened(os)
  p.ask()
  let boom = true
  const el = p.ctx.document.getElementById('retailBody')
  let html = el.innerHTML
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: v => { if (boom && /Nothing to click while this runs/.test(v) && /1 of 2 done/.test(v)) { boom = false; throw new Error('render broke') } html = v } })
  await assert.rejects(p.go(), /render broke/)
  assert.equal(p.pack.fulfilling, false)
  assert.equal(p.sel.length, 0)
})

test('D1: after the run the pending list is read again, so an order held back on another device counts as Still open', async () => {
  const os = [order(), order(), order()]
  const sh = shopify()
  const { p, srv } = await opened(os, { sh })
  p.ask()
  const reads = srv.rpcs('ship_labels_pending').length
  const orig = sh
  // While the run is going, another device holds the third order back (the DB row changes).
  srv.pending.find(r => r.order_id === os[2].order_id).held_back_at = 'x'
  await p.go()
  assert.equal(srv.rpcs('ship_labels_pending').length, reads + 1)
  assert.equal(tileOf(p.html(), 'Still open'), 1)
  assert.match(p.html(), new RegExp(`${os[2].order_name}</b> was held back`))
  eq(Object.keys(p.failed), [])                                        // refused as held back: not a failure for the red banner
  assert.equal(tileOf(p.html(), 'Shipped'), 2)
})

test('D1: a failed order is dropped from the session list once a later Fulfill ships it', async () => {
  const os = [order()]
  const sh = shopify({ fail: (id, n) => (n === 0 ? { status: 502, json: { error: 'fulfillmentCreate failed' } } : null) })
  const { p } = await opened(os, { sh })
  p.ask(); await p.go()
  eq(Object.keys(p.failed), [os[0].order_id])
  p.backFromPack(); await p.openPack()
  p.ask(); await p.go()
  eq(Object.keys(p.failed), [])
  assert.equal(tileOf(p.html(), 'Shipped'), 1)
})
