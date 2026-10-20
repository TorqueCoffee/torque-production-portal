// B3b gate R1 (docs/TESTS.md): the red banner: Retry fulfill for this session's failed Fulfills, and
// Clear for bought orders Shopify no longer lists. A fake server only: no Shopify write happens.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { order, pendingRow, server, page, eq } = require('./helpers/retail-page')

// A fake Shopify behind /api/shopify-fulfill. It really "creates" a fulfillment for any order that
// is open and is asked without only_if_fulfilled, so a Clear that created one would show.
function shopify({ fulfilled = [], fail = () => null, lose = () => false } = {}) {
  const st = { creates: [], emails: 0, calls: [], fulfilled: new Set(fulfilled) }
  const fn = (body, srv) => {
    const n = st.calls.filter(c => c === body.order_id).length
    st.calls.push(body.order_id)
    const f = fail(body.order_id, n, body)
    if (f) return f
    if (st.fulfilled.has(body.order_id)) {
      const row = srv.pending.findIndex(p => p.order_id === body.order_id)
      if (row >= 0) srv.pending.splice(row, 1)
      return { json: { ok: true, alreadyFulfilled: true, notified: false, emailed: false } }
    }
    if (body.only_if_fulfilled === true) return { status: 409, json: { error: 'Shopify still has unfulfilled items on this order, so nothing was changed.' } }
    st.fulfilled.add(body.order_id); st.creates.push(body.order_id); st.emails++
    if (lose(body.order_id, n)) return { throw: 'network lost' }
    const row = srv.pending.findIndex(p => p.order_id === body.order_id)
    if (row >= 0) srv.pending.splice(row, 1)
    return { json: { ok: true, notified: true, emailed: true } }
  }
  fn.st = st
  return fn
}
async function queue(listed, gone = [], { sh = shopify(), storage = {} } = {}) {
  const srv = server({ orders: listed, pending: [...listed, ...gone].map(o => pendingRow(o)), fulfill: sh })
  const p = page({ srv, storage })
  await p.load()
  return { p, srv, sh }
}
const fulfills = srv => srv.calls('/api/shopify-fulfill')
const banner = html => (html.match(/<div class="alert alert-red rt-banner">[\s\S]*?<\/div>(?=<div class="rt-title")/) || [''])[0]

test('R1: a bought order Shopify no longer lists is in the red banner with Clear; the row points to the banner', async () => {
  const [a, gone] = [order(), order()]
  const { p } = await queue([a], [gone])
  const html = p.html()
  assert.match(html, new RegExp(`Paid, not open in Shopify: <b>${gone.order_name}</b>`))
  assert.match(html, /data-id="[^"]+" onclick="retailClearGone\(this\.dataset\.id\)"[^>]*>Clear</)
  assert.match(html, /Clear or void it in the red box at the top/)
  assert.ok(html.indexOf('rt-banner') < html.indexOf('Retail shipping'))   // the top of the tab
  for (const tag of banner(html).match(/<button[^>]*>/g)) assert.match(tag, /rt-tap/)
})

test('R1: Clear sends only_if_fulfilled with notifyCustomer off and never creates anything; a hand-fulfilled order clears', async () => {
  const [a, gone] = [order(), order()]
  const sh = shopify({ fulfilled: [] })
  const { p, srv } = await queue([a], [gone], { sh })
  sh.st.fulfilled.add(gone.order_id)                              // fulfilled by hand in Shopify
  await p.clear(gone.order_id)
  const sent = fulfills(srv).map(c => c.body)
  eq(sent, [{ kind: 'retail', order_id: gone.order_id, notifyCustomer: false, only_if_fulfilled: true }])
  assert.equal(sh.st.creates.length, 0)
  assert.equal(sh.st.emails, 0)
  assert.doesNotMatch(p.html(), /Paid, not open in Shopify/)       // gone from the DB's pending list, so from the banner
  assert.equal(p.pending[gone.order_id], undefined)
})

test('R1: Clear on an order that is still open in Shopify clears nothing, creates nothing, and shows the server\'s words', async () => {
  const gone = order()
  const { p, srv, sh } = await queue([], [gone])
  await p.clear(gone.order_id)
  assert.equal(sh.st.creates.length, 0)
  assert.match(p.html(), /Shopify still has unfulfilled items on this order, so nothing was changed\./)
  assert.match(p.html(), /Paid, not open in Shopify/)
  assert.ok(p.pending[gone.order_id])
  // No answer: nothing changed, said so, and the button is back.
  const q = await queue([], [gone], { sh: shopify({ fail: () => ({ throw: 'offline' }) }) })
  await q.p.clear(gone.order_id)
  assert.match(q.p.html(), /No answer from the server \(offline\)\. Nothing was changed\./)
  assert.doesNotMatch(banner(q.p.html()), /Clear<\/button>[^]*disabled/)
})

test('R1: a Clear Shopify answers ok without alreadyFulfilled, or whose record flip did not happen, is not treated as cleared', async () => {
  const gone = order()
  const odd = await queue([], [gone], { sh: () => ({ json: { ok: true, notified: true } }) })
  await odd.p.clear(gone.order_id)
  assert.ok(odd.p.pending[gone.order_id])
  assert.match(odd.p.html(), /Paid, not open in Shopify/)
  assert.match(odd.p.html(), /Shopify did not confirm it is fulfilled \(status 200\)\. Nothing was changed\./)
  // Shopify says fulfilled, but the label rows stayed purchased (cost_updated false): the banner stays and says so.
  const stuck = await queue([], [gone], { sh: () => ({ json: { ok: true, alreadyFulfilled: true, cost_updated: false } }) })
  await stuck.p.clear(gone.order_id)
  assert.match(stuck.p.html(), /label record wasn&#39;t updated\. Tell Andy/)
})

test('R1: Clear works only for gone orders, and is locked while buying or fulfilling', async () => {
  const [a, gone] = [order(), order()]
  const { p, srv } = await queue([a], [gone])
  await p.clear(a.order_id)                                       // listed and bought: not a gone order
  await p.clear('gid://shopify/Order/999999')
  assert.equal(fulfills(srv).length, 0)
  await p.openPack()
  p.ask()
  const run = p.go()                                              // a Fulfill run is going
  await p.clear(gone.order_id)
  await run
  assert.equal(fulfills(srv).filter(c => c.body.only_if_fulfilled).length, 0)
})

test('R1: a failed Fulfill is in the banner with Retry fulfill; Retry with alreadyFulfilled clears it and sends no second email', async () => {
  const os = [order(), order()]
  const sh = shopify({ lose: (id, n) => id === os[0].order_id && n === 0 })    // created, answer lost
  const srv = server({ orders: os, pending: os.map(o => pendingRow(o)), fulfill: sh })
  const p = page({ srv })
  await p.openPack()
  p.ask(); await p.go()
  eq(Object.keys(p.failed), [os[0].order_id])
  const html = p.html()
  assert.match(html, new RegExp(`Paid, not fulfilled: <b>${os[0].order_name}</b>\\. Label bought, tracking not written to Shopify, so the customer has no email\\.`))
  assert.match(html, /onclick="retailRetryFulfill\(this\.dataset\.id\)"[^>]*>Retry fulfill</)
  assert.equal(sh.st.emails, 2)
  // The order was in fact fulfilled in Shopify; the retry finds that and sends nothing.
  await p.retry(os[0].order_id)
  assert.equal(sh.st.creates.filter(id => id === os[0].order_id).length, 1)
  assert.equal(sh.st.emails, 2)                                    // not counted as an email
  eq(Object.keys(p.failed), [])
  assert.equal(p.pending[os[0].order_id], undefined)               // the pending list was read again
  assert.doesNotMatch(p.html(), /Paid, not fulfilled/)
  const retry = fulfills(srv).at(-1).body
  eq(retry, { kind: 'retail', order_id: os[0].order_id })
})

test('R1: a Retry that fails again keeps the entry with the new reason; every try is the order alone', async () => {
  const os = [order()]
  const sh = shopify({ fail: (id, n) => (n < 2 ? { status: 502, json: { error: n === 0 ? 'fulfillmentCreate failed' : 'Shopify refused it' } } : null) })
  const srv = server({ orders: os, pending: os.map(o => pendingRow(o)), fulfill: sh })
  const p = page({ srv })
  await p.openPack(); p.ask(); await p.go()
  assert.match(p.failed[os[0].order_id].why, /fulfillmentCreate failed/)
  await p.retry(os[0].order_id)
  assert.match(p.html(), /Shopify refused it/)
  eq(Object.keys(p.failed), [os[0].order_id])
  await p.retry(os[0].order_id)                                    // third try works
  eq(Object.keys(p.failed), [])
  assert.equal(sh.st.creates.length, 1)
})

test('R1: after a reload the failed entries are gone and the order is in the open batch again; Fulfill retries it safely', async () => {
  const os = [order(), order()]
  const sh = shopify({ lose: (id, n) => id === os[1].order_id && n === 0 })
  const srv = server({ orders: os, pending: os.map(o => pendingRow(o)), fulfill: sh })
  const p = page({ srv })
  await p.openPack(); p.ask(); await p.go()
  const q = page({ srv })                                          // a reload: fresh page state
  await q.load()
  assert.doesNotMatch(q.html(), /Paid, not fulfilled/)
  assert.match(q.html(), /Batch open: 1 to fulfill, 0 held back/)
  await q.openPack(); q.ask(); await q.go()
  assert.equal(sh.st.creates.length, 2)                            // still one per order
  assert.equal(sh.st.emails, 2)
})

test('R1: the banner shows on Pack and Done too, escapes names, and drops an entry whose order is no longer bought', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const os = [order({ order_name: `#1${evil}` }), order()]
  const sh = shopify({ fail: id => (id === os[0].order_id ? { status: 502, json: { error: evil } } : null) })
  const srv = server({ orders: os, pending: os.map(o => pendingRow(o)), fulfill: sh })
  const p = page({ srv })
  await p.openPack(); p.ask(); await p.go()
  assert.match(p.html(), /Paid, not fulfilled/)                    // on Done
  assert.doesNotMatch(p.html(), /<img/i)
  p.backFromPack(); await p.openPack()
  assert.match(p.html(), /Paid, not fulfilled/)                    // on Pack
  srv.pending.splice(srv.pending.findIndex(r => r.order_id === os[0].order_id), 1)   // fulfilled by hand since
  await p.load()
  assert.doesNotMatch(p.html(), /Paid, not fulfilled/)
})

test('R1: Retry and Clear are off while the list loads, and a tap on a busy entry is ignored', async () => {
  const [a, gone] = [order(), order()]
  let release
  const gate = new Promise(r => { release = r })
  const sh = shopify({ fail: () => null })
  const { p, srv } = await queue([a], [gone], { sh })
  sh.st.fulfilled.add(gone.order_id)
  const orig = srv.apiFetch
  p.ctx.apiFetch = async (url, o) => { if (url === '/api/shopify-fulfill') await gate; return orig(url, o) }
  const first = p.clear(gone.order_id)
  await p.clear(gone.order_id)
  assert.match(banner(p.html()), /Clear<\/button>/)
  assert.match(banner(p.html()), /disabled>Clear</)
  release(); await first
  assert.equal(sh.st.calls.length, 1)
})

test('R1: an unrecorded order that is not listed gets no Clear (its claim is unknown); a Retry refused as held back is not a failure', async () => {
  const lost = order()
  const storage = { 'tq.retail.unrecorded': JSON.stringify({ [lost.order_id]: { order_name: lost.order_name, at: Date.now() } }) }
  const { p } = await queue([], [], { storage })
  assert.equal(p.pending[lost.order_id].unrecorded, true)
  assert.doesNotMatch(p.html(), /Paid, not open in Shopify|Clear</)
  const os = [order()]
  const sh = shopify({ fail: (id, n) => (n === 0 ? { status: 502, json: { error: 'fulfillmentCreate failed' } } : { status: 409, json: { code: 'held_back', error: 'This order is held back. Include it on the Pack screen first.' } }) })
  const srv = server({ orders: os, pending: os.map(o => pendingRow(o)), fulfill: sh })
  const q = page({ srv })
  await q.openPack(); q.ask(); await q.go()
  eq(Object.keys(q.failed), [os[0].order_id])
  await q.retry(os[0].order_id)
  eq(Object.keys(q.failed), [])
}) 
