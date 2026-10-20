// B3b gate V1 (docs/TESTS.md): the Void button (B6 UI). A fake server answers /api/shippo-label?action=void;
// nothing is voided or refunded.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { order, pendingRow, server, page, eq } = require('./helpers/retail-page')

// What the real endpoint does to the DB on success: the row is voided, so it leaves the pending list.
const marks = (body, srv) => { srv.pending.splice(srv.pending.findIndex(r => r.order_id === body.order_id), 1); return { json: { ok: true, voided: true, row_marked: true } } }
async function queue(listed, { gone = [], held = [], voidLabel = marks, confirmAnswer = true, storage = {} } = {}) {
  const srv = server({ orders: listed, pending: [...listed, ...gone].map(o => pendingRow(o, held.includes(o) ? { held_back_at: 'x' } : {})), voidLabel })
  const p = page({ srv, confirmAnswer, storage })
  await p.load()
  return { p, srv }
}
const voids = srv => srv.calls('action=void')
const lastAlert = p => p.ctx.alerts.at(-1)

test('V1: no confirm, no request; the confirm says what Void does', async () => {
  const a = order()
  const { p, srv } = await queue([a], { confirmAnswer: false })
  await p.voidLabel(a.order_id)
  assert.equal(voids(srv).length, 0)
  assert.equal(p.confirms.length, 1)
  assert.equal(p.confirms[0], `Void ${a.order_name}'s label? Only if UPS hasn't scanned it. The order goes back to the queue to buy again.`)
  assert.equal(p.ctx.alerts.length, 0)
  assert.ok(p.pending[a.order_id])
})

test('V1: a confirmed Void posts the order and box 1 to the void action, and nothing else is called', async () => {
  const a = order()
  const { p, srv } = await queue([a])
  await p.voidLabel(a.order_id)
  eq(voids(srv).map(c => c.body), [{ order_id: a.order_id, box_index: 1 }])
  assert.equal(srv.calls('shopify-fulfill').length, 0)
  assert.equal(srv.calls('action=label').length + srv.calls('action=rate').length, 0)
})

test('V1: row marked: "Voided", the list is read again, and the order is a ready row again (acceptance check 9)', async () => {
  const [a, b] = [order(), order()]
  const { p, srv } = await queue([a, b])
  assert.equal(p.groups([a, b]).bought.length, 2)
  const reads = srv.calls('retail-ship').length
  await p.voidLabel(a.order_id)
  assert.equal(lastAlert(p), `Voided. ${a.order_name} is back in the queue.`)
  assert.equal(srv.calls('retail-ship').length, reads + 1)
  assert.equal(p.pending[a.order_id], undefined)
  eq(p.groups([a, b]).ready['8x6x3'].map(o => o.order_id), [a.order_id])      // buyable again
  eq(p.groups([a, b]).bought.map(o => o.order_id), [b.order_id])
  assert.equal(p.voiding, false)
})

test('V1: refunded but the row not marked: the server\'s words, and the order stays flagged on this device through a reload', async () => {
  const [a, b] = [order(), order()]
  const err = "The label is voided in Shippo, but the portal's record wasn't updated. Tell Andy before rebuying this box."
  const { p, srv } = await queue([a, b], { voidLabel: () => ({ json: { ok: true, voided: true, row_marked: false, error: err } }) })
  await p.voidLabel(a.order_id)
  assert.equal(lastAlert(p), err)
  assert.equal(p.pending[a.order_id].unrecorded, true)                          // the DB still says purchased
  assert.equal(p.unrecorded[a.order_id].why, 'voided, not recorded')
  await p.load()                                                                // another read: the DB still has the row
  assert.equal(p.pending[a.order_id].unrecorded, true)
  assert.match(p.html(), /Voided, not recorded\. Do not buy or ship\. Tell Andy/)
  assert.doesNotMatch(p.html(), /Shippo shows none/)
  // It is not in the open batch: no card, no Fulfill, no Void, no Reprint on it.
  eq(p.cards().map(c => c.order.order_id), [b.order_id])
  assert.equal(p.batchOpen(), true)                                             // b is still open
  const row = p.html().split('<div class="rt-row dis">').find(x => x.includes(a.order_name))
  assert.doesNotMatch(row, />Void<|>Reprint</)
  // A new page on this device knows too.
  const q = page({ srv, storage: p.storage })
  await q.load()
  assert.equal(q.pending[a.order_id].unrecorded, true)
})

test('V1: a Shippo refusal (502) says the label stays on and to log it, with the server\'s message', async () => {
  const a = order()
  const { p } = await queue([a], { voidLabel: () => ({ status: 502, json: { error: 'Shippo refused the void. The label is still live; nothing was changed.' } }) })
  await p.voidLabel(a.order_id)
  assert.match(lastAlert(p), /^Shippo refused the void, likely already scanned by UPS\. The label stays on\. Log this order in the incident log\. Shippo refused the void\./)
  assert.ok(p.pending[a.order_id])
  assert.equal(p.voiding, false)
})

test('V1: 409, 404 and 503 show the server\'s words and "Nothing was voided."', async () => {
  for (const [status, error] of [[409, 'This order is already fulfilled in Shopify (the customer has the tracking number). Nothing was voided.'], [404, 'This box has no label to void.'], [503, "Couldn't check the order in Shopify, so nothing was voided. Try again in a minute."]]) {
    const a = order()
    const { p } = await queue([a], { voidLabel: () => ({ status, json: { error } }) })
    await p.voidLabel(a.order_id)
    assert.equal(lastAlert(p), `${error} Nothing was voided.`, String(status))
    assert.ok(p.pending[a.order_id], String(status))
  }
})

test('V1: no answer says nothing may have been voided; another error says check Shippo', async () => {
  const a = order()
  const { p, srv } = await queue([a], { voidLabel: () => ({ throw: 'offline' }) })
  await p.voidLabel(a.order_id)
  assert.equal(lastAlert(p), 'No answer. Nothing may have been voided; check Shippo before trying again.')
  assert.ok(p.pending[a.order_id])
  assert.equal(p.voiding, false)
  const b = order()
  const q = await queue([b], { voidLabel: () => ({ status: 500, json: { error: 'boom' } }) })
  await q.p.voidLabel(b.order_id)
  assert.match(lastAlert(q.p), /^boom\. Nothing may have been voided; check Shippo before trying again\.$/)
})

test('V1: Void is on Bought rows, held-back cards and gone orders; never on included cards or unrecorded rows', async () => {
  const [a, held, inc, gone] = [order(), order(), order(), order()]
  const storage = { 'tq.retail.unrecorded': JSON.stringify({ 'gid://shopify/Order/777': { order_name: '#777', at: Date.now() } }) }
  const { p } = await queue([a, held, inc], { gone: [gone], held: [held], storage })
  const queueHtml = p.html()
  const voidIds = html => [...html.matchAll(/data-id="([^"]+)" onclick="retailVoid\(this\.dataset\.id\)"/g)].map(m => m[1]).sort()
  eq(voidIds(queueHtml), [a.order_id, held.order_id, inc.order_id, gone.order_id, gone.order_id].sort())   // Bought rows (3), the gone row and its banner entry
  assert.doesNotMatch(queueHtml, /777[^]*retailVoid/)
  await p.openPack()
  const pack = p.html()
  const cardOf = name => pack.split(/(?=<div class="rt-pc(?: off)?">)/).find(x => x.startsWith('<div class="rt-pc') && x.includes(`<b>${name}</b>`))
  assert.match(cardOf(held.order_name), /onclick="retailVoid\(this\.dataset\.id\)"/)
  assert.doesNotMatch(cardOf(a.order_name), /retailVoid/)
  assert.doesNotMatch(cardOf(inc.order_name), /retailVoid/)
  assert.match(pack, new RegExp(`data-id="${gone.order_id}" onclick="retailVoid\\(this\\.dataset\\.id\\)"`))   // the gone order's banner entry
})

test('V1: an unrecorded order, or one that is not bought, is never voided from here', async () => {
  const a = order()
  const storage = { 'tq.retail.unrecorded': JSON.stringify({ [a.order_id]: { order_name: a.order_name, at: Date.now() } }) }
  const srv = server({ orders: [a], pending: [] })
  const p = page({ srv, storage, confirmAnswer: true })
  await p.load()
  await p.voidLabel(a.order_id)
  await p.voidLabel('gid://shopify/Order/424242')
  assert.equal(voids(srv).length, 0)
  assert.equal(p.confirms.length, 0)
})

test('V1: Void does nothing while buying, fulfilling, or another Void runs, and its buttons are off', async () => {
  const [a, b] = [order(), order()]
  let release
  const gate = new Promise(r => { release = r })
  const { p, srv } = await queue([a, b], { voidLabel: async () => { await gate; return { json: { ok: true, row_marked: false, error: 'x' } } } })
  const orig = srv.apiFetch
  let started = 0
  p.ctx.apiFetch = async (url, o) => { if (url.includes('action=void')) { started++; await gate } return orig(url, o) }
  const first = p.voidLabel(a.order_id)
  await p.voidLabel(b.order_id)                                              // a second Void while one runs
  assert.equal(started, 1)
  assert.equal(p.confirms.length, 1)
  for (const tag of p.html().match(/<button[^>]*retailVoid[^>]*>/g)) assert.match(tag, /disabled/)
  release(); await first
  // Fulfilling: no Void, and the buttons are off.
  const [c, d] = [order(), order()]
  const q = await queue([c, d], { held: [c] })
  await q.p.openPack()
  q.p.ask()
  for (const tag of q.p.html().match(/<button[^>]*retailVoid[^>]*>/g)) assert.match(tag, /disabled/)
  const run = q.p.go()
  await q.p.voidLabel(c.order_id)
  await run
  assert.equal(voids(q.srv).length, 0)
})

test('V1: the tests of the void endpoint and its migration still stand (B3 V1–V4, DB V5)', () => {
  const fs = require('fs')
  assert.ok(fs.readFileSync(require('path').join(__dirname, 'b3-retail-label.test.js'), 'utf8').includes('B6'))
  assert.ok(fs.existsSync(require('path').join(__dirname, 'db', 'label-void.test.js')))
})

test('V1: Void does nothing while labels are being bought', async () => {
  const [bought, fresh] = [order(), order()]
  let release
  const gate = new Promise(r => { release = r })
  const srv = server({ orders: [bought, fresh], pending: [pendingRow(bought)], voidLabel: marks })
  const p = page({ srv, confirmAnswer: true })
  await p.load()
  p.set({ orders: [bought, fresh], sel: [fresh.order_id] })
  const orig = srv.apiFetch
  p.ctx.apiFetch = async (url, o) => { if (url.includes('action=rate')) await gate; return orig(url, o) }
  // Buy is blocked by the open batch, so hold that batch back first to let a buy start.
  srv.pending[0].held_back_at = 'x'
  await p.load()
  p.set({ sel: [fresh.order_id] })
  const buying = p.buy()
  assert.equal(p.inFlight, true)
  await p.voidLabel(bought.order_id)
  assert.equal(voids(srv).length, 0)
  assert.equal(p.confirms.length, 0)
  release(); await buying
})
