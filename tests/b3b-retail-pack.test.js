// B3b gate P1 (docs/TESTS.md): the Pack screen, Hold back and Include, the Resume banner and the
// Buy block. The page's own functions run in a sandbox with a fake server and a fake DB
// (tests/helpers/retail-page.js); nothing is bought, fulfilled or written.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { INDEX } = require('./helpers/index-html')
const { P, order, pendingRow, server, page, eq } = require('./helpers/retail-page')

// A page opened on the Pack screen over the given orders; `held` lists orders held in the DB.
async function packed(orders, { held = [], srvOpts = {}, pageOpts = {} } = {}) {
  const srv = server({ orders, pending: orders.map(o => pendingRow(o, held.includes(o) ? { held_back_at: '2026-10-20T16:00:00Z' } : {})), ...srvOpts })
  const p = page({ srv, ...pageOpts })
  await p.openPack()
  return p
}
const names = html => [...html.matchAll(/<div class="rt-pc(?: off)?">\s*<div class="rt-pc-head"><b>([^<]*)<\/b>/g)].map(m => m[1])
// The markup of one card (from its opening tag to the next card), by order name.
const cardOf = (html, name) => html.split(/(?=<div class="rt-pc(?: off)?">)/).find(x => x.startsWith('<div class="rt-pc') && x.includes(`<b>${name}</b>`))

test('P1: the cards are the DB\'s pending labels joined to the order list, not any in-page batch', async () => {
  const [a, b, c] = [order(), order(), order()]
  const srv = server({ orders: [a, b, c], pending: [pendingRow(a), pendingRow(c)] })
  const p = page({ srv })
  assert.equal(p.batch, null)
  await p.openPack()
  eq(p.cards().map(x => x.order.order_id), [a.order_id, c.order_id])
  assert.deepEqual(names(p.html()), [a.order_name, c.order_name])
  assert.match(p.html(), /Pack and fulfill/)
  assert.match(p.html(), /2 to fulfill/)
  assert.match(p.html(), /0 held back/)
  assert.match(p.html(), /Every order starts included\. <\/b>|Every order starts included\./)
  assert.match(p.html(), /tap Hold back only for one you cannot send\./)
  assert.equal(srv.calls('retail-ship').length, 1)        // Pack opens on a fresh read
  assert.equal(srv.rpcs('ship_labels_pending').length, 1)
})

test('P1: gone orders (not in the list) and unrecorded ones get no card', async () => {
  const [a, gone, lost] = [order(), order(), order()]
  const storage = { 'tq.retail.unrecorded': JSON.stringify({ [lost.order_id]: { order_name: lost.order_name, at: Date.now() } }) }
  const srv = server({ orders: [a, lost], pending: [pendingRow(a), pendingRow(gone)] })   // the DB has no row for `lost`: this device's note keeps it in Bought
  const p = page({ srv, storage })
  await p.openPack()
  assert.deepEqual(names(p.html()), [a.order_name])
  assert.equal(p.pending[lost.order_id].unrecorded, true)
  assert.match(p.html().split('rt-packgrid')[0], new RegExp(`Paid, not open in Shopify: <b>${gone.order_name}</b>`))   // it goes to the red banner, not to a card
  // A gone or unrecorded row is not "an open batch to fulfill" in the counts either.
  assert.match(p.html(), /1 to fulfill/)
})

test('P1: held state is the label row\'s held_back_at, so it survives a reload and shows on another device', async () => {
  const [a, b] = [order(), order()]
  const srv = server({ orders: [a, b], pending: [pendingRow(a), pendingRow(b)] })
  const p = page({ srv })
  await p.openPack()
  await p.setHeld(b.order_id, true)
  assert.match(p.html(), /1 to fulfill/)
  assert.match(p.html(), /1 held back/)
  // A new page (a reload; the same DB) sees it held, with Include and "Stays open".
  const q = page({ srv })
  await q.openPack()
  const held = cardOf(q.html(), b.order_name)
  assert.match(held, /^<div class="rt-pc off">/)
  assert.match(held, /Stays open/)
  assert.match(held, /data-held="0"[^>]*>Include</)
  assert.match(cardOf(q.html(), a.order_name), /data-held="1"[^>]*>Hold back</)
  // The queue's Bought row says Held back for it, and still offers Reprint.
  await q.backFromPack()
  await new Promise(r => setTimeout(r, 20))
  assert.match(q.html(), /Held back/)
})

test('P1: cards sort by carton (8x6x3, 12x8x6, 14x10x10), then oldest first', async () => {
  const mk = (carton, day) => order({ parcel: P[carton], created_at: `2026-10-${day}T20:00:00Z` })
  const big = mk('14x10x10', '01'), mid2 = mk('12x8x6', '09'), small2 = mk('8x6x3', '12'), mid1 = mk('12x8x6', '03'), small1 = mk('8x6x3', '05')
  const p = await packed([big, mid2, small2, mid1, small1])
  assert.deepEqual(names(p.html()), [small1, small2, mid1, mid2, big].map(o => o.order_name))
})

test('P1: every data field is escaped (name, note, coffee, ship-to, reason)', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const o = order({ order_name: `#1${evil}`, note: `n${evil}`, flags: ['REPLACEMENT'], discount_codes: [evil],
    shipping_address: { name: 'x', address1: 'x', city: 'x', province: evil, zip: evil },
    items: [{ product_name: `Coffee${evil}`, variant_title: '12oz', qty: 1, weight_lb: 0.75, note: evil }] })
  const p = await packed([o], { held: [o] })
  const html = p.html()
  assert.doesNotMatch(html, /<img/i)
  assert.ok(html.includes('&lt;img'))
  assert.doesNotMatch(html, /onerror=alert\(1\)>/)
})

test('P1: inline handlers read data-id (never a quoted order id) and every button is a 44px tap target', async () => {
  const [a, b] = [order(), order()]
  const p = await packed([a, b], { held: [b] })
  const html = p.html()
  const handlers = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => m[1])
  assert.ok(handlers.length >= 6)
  for (const h of handlers) assert.doesNotMatch(h, /gid:|'#|"#|\d{4}/, h)
  assert.ok(handlers.includes("retailSetHeld(this.dataset.id, this.dataset.held === '1')"))
  assert.ok(handlers.includes('retailReprintBought(this.dataset.id)'))
  for (const tag of html.match(/<button[^>]*>/g)) assert.match(tag, /rt-tap/, tag)
  assert.ok(html.includes(`data-id="${a.order_id}"`))
})

test('P1: Hold back asks the DB, then reads the pending list again; the card changes only then', async () => {
  const [a, b] = [order(), order()]
  const p = await packed([a, b])
  const reads = p.srv.rpcs('ship_labels_pending').length
  await p.setHeld(a.order_id, true)
  eq(p.srv.rpcs('set_ship_label_held_back').map(r => r.args), [{ p_order_id: a.order_id, p_held: true }])
  assert.equal(p.srv.rpcs('ship_labels_pending').length, reads + 1)
  assert.equal(p.cards().find(c => c.order.order_id === a.order_id).held, true)
  await p.setHeld(a.order_id, false)
  eq(p.srv.rpcs('set_ship_label_held_back').at(-1).args, { p_order_id: a.order_id, p_held: false })
  assert.equal(p.cards().find(c => c.order.order_id === a.order_id).held, false)
  assert.equal(p.srv.calls('shippo-label').length + p.srv.calls('shopify-fulfill').length, 0)   // nothing is bought or written to Shopify
})

test('P1: a Hold back that fails (RPC error, or the DB changes 0 rows) leaves the card as it was and says so', async () => {
  const [a, b] = [order(), order()]
  for (const [why, hold] of [['error', () => ({ data: null, error: new Error('permission denied') })], ['zero', () => ({ data: 0, error: null })], ['two', () => ({ data: 2, error: null })]]) {
    const p = await packed([a, b], { srvOpts: { hold } })
    const reads = p.srv.rpcs('ship_labels_pending').length
    await p.setHeld(a.order_id, true)
    assert.equal(p.cards().find(c => c.order.order_id === a.order_id).held, false, why)
    assert.equal(p.srv.rpcs('ship_labels_pending').length, reads, `${why}: no re-read`)
    assert.match(p.html(), new RegExp(`Couldn(?:'|&#39;)t hold back ${a.order_name}: .*Nothing changed`), why)
    assert.equal(p.pack.busy.size, 0, why)
    // Include fails the same way, in its own words.
    await p.setHeld(b.order_id, false)
    assert.match(p.html(), new RegExp(`Couldn(?:'|&#39;)t include ${b.order_name}: .*Nothing changed`), why)
  }
})

test('P1: a second tap on a card in flight, or any tap while the screen loads, does nothing', async () => {
  const [a, b] = [order(), order()]
  let release
  const gate = new Promise(r => { release = r })
  const p = await packed([a, b], { srvOpts: { hold: async args => { await gate; return { data: 1, error: null } } } })
  const first = p.setHeld(a.order_id, true)
  await p.setHeld(a.order_id, true)
  await p.setHeld(a.order_id, false)
  assert.equal(p.srv.rpcs('set_ship_label_held_back').length, 1)
  assert.match(cardOf(p.html(), a.order_name), /data-held="1"[^>]*disabled/)
  release(); await first
  assert.equal(p.cards().find(c => c.order.order_id === a.order_id).held, false)   // the stub never marked the row; the re-read says so
  // While the list loads, nothing can be held back.
  const q = await packed([a, b])
  q.ctx.apiFetch = () => new Promise(() => {})
  q.load()
  assert.equal(q.loading, true)
  await q.setHeld(a.order_id, true)
  assert.equal(q.srv.rpcs('set_ship_label_held_back').length, 0)
  assert.match(q.html(), /Refreshing…/)
})

test('P1: leaving Pack while a Hold back is in flight does not break; the answer is dropped on the queue', async () => {
  const [a] = [order()]
  let release
  const gate = new Promise(r => { release = r })
  const p = await packed([a], { srvOpts: { hold: async () => { await gate; return { data: null, error: new Error('late') } } } })
  const run = p.setHeld(a.order_id, true)
  p.backFromPack()
  release(); await run
  assert.equal(p.pack, null)
  assert.doesNotMatch(p.html(), /hold back #|Couldn/)
})

test('P1: the Resume banner counts to fulfill and held back, and hides when all are held or none are bought', async () => {
  const [a, b, c] = [order(), order(), order()]
  const srv = server({ orders: [a, b, c], pending: [pendingRow(a), pendingRow(b, { held_back_at: 'x' })] })
  const p = page({ srv })
  await p.load()
  assert.match(p.html(), /Batch open: 1 to fulfill, 1 held back/)
  assert.match(p.html(), /onclick="retailOpenPack\(\)"[^>]*>Resume batch</)
  srv.pending[0].held_back_at = 'x'                              // everything held
  await p.load()
  assert.doesNotMatch(p.html(), /Batch open|Resume batch/)
  srv.pending.length = 0                                          // nothing bought
  await p.load()
  assert.doesNotMatch(p.html(), /Batch open|Resume batch/)
  // A pending order the list no longer has is not counted (it is "gone").
  srv.pending.push(pendingRow(order()))
  await p.load()
  assert.doesNotMatch(p.html(), /Batch open/)
})

test('P1: Resume batch opens Pack; Pack\'s Back to queue returns to the queue (disabled while loading)', async () => {
  const [a] = [order()]
  const srv = server({ orders: [a], pending: [pendingRow(a)] })
  const p = page({ srv })
  await p.load()
  await p.openPack()
  assert.ok(p.pack)
  assert.match(p.html(), /onclick="retailBackFromPack\(\)"[^>]*>Back to queue</)
  p.backFromPack()
  assert.equal(p.pack, null)
  await new Promise(r => setTimeout(r, 20))
  assert.match(p.html(), /Retail shipping/)
})

test('P1: Buy is blocked while a retail batch is open: no request, the button off, the message and a Resume link', async () => {
  const [open, ready] = [order(), order()]
  const srv = server({ orders: [open, ready], pending: [pendingRow(open)] })
  const p = page({ srv })
  await p.load()
  p.set({ sel: [ready.order_id] })
  p.render()
  assert.equal(p.batchOpen(), true)
  const before = srv.log.length
  await p.buy()
  assert.equal(srv.log.length, before)
  assert.equal(p.opened.length, 0)
  assert.equal(p.batch, null)
  assert.match(p.html(), /Fulfill or hold back the open batch first\./)
  assert.match(p.html(), /Resume batch/)
  assert.match(p.html(), /class="btn btn-primary rt-buy" onclick="retailBuyAndPrint\(\)" disabled/)
  // Held back (nothing to fulfill): buying is free again.
  srv.pending[0].held_back_at = 'x'
  await p.load()
  p.set({ sel: [ready.order_id] })
  p.render()
  assert.equal(p.batchOpen(), false)
  assert.doesNotMatch(p.html(), /open batch first/)
  assert.doesNotMatch(p.html(), /rt-buy" onclick="retailBuyAndPrint\(\)" disabled/)
  await p.buy()
  assert.equal(srv.calls('action=label').length, 1)
})

test('P1: a run where every row is bought goes straight to Pack, from the DB', async () => {
  const orders = [order(), order({ parcel: P['12x8x6'] })]
  const srv = server({ orders })
  const p = page({ srv })
  p.set({ orders, sel: orders.map(o => o.order_id) })
  await p.buy()
  assert.equal(srv.calls('action=label').length, 2)
  assert.equal(srv.calls('/api/ship-doc').length, 1)
  assert.equal(p.batch, null)
  assert.ok(p.pack)
  assert.deepEqual(names(p.html()), orders.map(o => o.order_name))
  assert.equal(srv.calls('retail-ship').length, 1)
  assert.equal(p.inFlight, false)
})

test('P1: a mixed run stays on Buying; Back to queue is "Pack and fulfill", which opens Pack with the bought ones', async () => {
  const [ok, bad] = [order(), order()]
  const srv = server({ orders: [ok, bad], label: b => (b.order_id === bad.order_id ? { status: 502, json: { error: 'Label purchase failed' } } : null) })
  const p = page({ srv })
  p.set({ orders: [ok, bad], sel: [ok.order_id, bad.order_id] })
  await p.buy()
  assert.ok(p.batch)
  assert.equal(p.pack, null)
  assert.match(p.html(), /onclick="retailPackAndFulfill\(\)">Pack and fulfill</)
  assert.doesNotMatch(p.html(), /Back to queue/)
  await p.packAndFulfill()
  assert.equal(p.batch, null)
  assert.deepEqual(names(p.html()), [ok.order_name])
})

test('P1: a run with nothing bought keeps "Back to queue"; an unrecorded or PDF-less run does not jump to Pack', async () => {
  const [a] = [order()]
  const srv = server({ orders: [a], label: () => ({ status: 502, json: { error: 'x' } }) })
  const p = page({ srv })
  p.set({ orders: [a], sel: [a.order_id] })
  await p.buy()
  assert.match(p.html(), /Back to queue/)
  assert.doesNotMatch(p.html(), /Pack and fulfill/)
  // Bought but not recorded: stays, so the warning is read.
  const b = order()
  const srv2 = server({ orders: [b], label: bb => ({ json: { ok: true, cost: bb.expected_amount, tracking_number: '1ZX', label_url: 'https://deliver.goshippo.com/x.pdf', cost_logged: false } }) })
  const q = page({ srv: srv2 })
  q.set({ orders: [b], sel: [b.order_id] })
  await q.buy()
  assert.ok(q.batch)
  assert.match(q.html(), /not recorded in the portal/)
  // The PDF tab was blocked: stays, so Open PDF is there.
  const c = order()
  const srv3 = server({ orders: [c] })
  const r = page({ srv: srv3, popup: false })
  r.set({ orders: [c], sel: [c.order_id] })
  await r.buy()
  assert.ok(r.batch)
  assert.match(r.html(), /Open PDF/)
})

test('P1: Reprint on a card builds that order\'s PDF from its saved label and never buys', async () => {
  const [a, b] = [order(), order()]
  const p = await packed([a, b])
  await p.reprint(b.order_id)
  assert.equal(p.srv.calls('/api/ship-doc').length, 1)
  assert.equal(p.srv.calls('/api/ship-doc')[0].body.orders.length, 1)
  assert.equal(p.srv.calls('shippo-label').length, 0)
  assert.equal(p.opened.length, 1)
})

test('P1: a failed load shows the error with Try again, and no cards', async () => {
  const [a] = [order()]
  const p = await packed([a], { srvOpts: { listFail: true } })
  assert.match(p.html(), /Couldn't load retail orders: Shopify is down/)
  assert.match(p.html(), /Try again/)
})

test('P1: the grid is 3 columns, 2 at iPad portrait, 1 on a phone; cards show the full note and the replacement chip', async () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  assert.match(html, /\.rt-packgrid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/)
  assert.match(html, /@media\(max-width:900px\)\{\.rt-packgrid\{grid-template-columns:repeat\(2,/)
  assert.match(html, /@media\(max-width:560px\)\{\.rt-packgrid\{grid-template-columns:minmax\(0,1fr\)\}\}/)
  const note = 'Leave at the side door. '.repeat(20)
  const o = order({ note, flags: ['REPLACEMENT'], discount_codes: ['MISSHIP'] })
  const p = await packed([o])
  assert.ok(p.html().includes(note.trim().slice(0, 200)))
  assert.ok(p.html().includes(note.trim()))                    // not cut at 200 characters
  assert.match(p.html(), /REPLACEMENT · MISSHIP/)
})

test('P1: an unrecorded order is not an open batch (it has no card to fulfill), and Buy is blocked while Pack is open', async () => {
  const [lost, ready] = [order(), order()]
  const storage = { 'tq.retail.unrecorded': JSON.stringify({ [lost.order_id]: { order_name: lost.order_name, at: Date.now() } }) }
  const srv = server({ orders: [lost, ready], pending: [] })
  const p = page({ srv, storage })
  await p.load()
  assert.equal(p.pending[lost.order_id].unrecorded, true)
  assert.equal(p.batchOpen(), false)
  assert.doesNotMatch(p.html(), /Batch open|open batch first/)
  // Pack open: a Buy that somehow arrives is ignored.
  await p.openPack()
  p.set({ sel: [ready.order_id] })
  const before = srv.log.length
  await p.buy()
  assert.equal(srv.log.length, before)
  assert.equal(p.opened.length, 0)
})
