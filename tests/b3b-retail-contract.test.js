// B3b gate X1 (docs/TESTS.md): the page and the real api/shopify-fulfill.js handler agree. The page's
// own functions (tests/helpers/retail-page.js) call the REAL handler through its apiFetch; only the
// network behind the handler is fake (Shopify GraphQL, Supabase RPCs, Shippo), and it keeps state
// the way the real ones do (a create closes the fulfillment order, a fulfill flips the label rows,
// a claim is held). So a renamed code or field on one side shows up here, not live.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')

const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
const world = { srv: null, shopify: new Map(), claims: new Set(), creates: [], emails: 0, retailNodes: new Map(), rows: new Map(), shippo: () => 'SUCCESS' }
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  const headers = opts.headers || {}
  const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) })
  if (url.endsWith('/auth/v1/user')) return reply({ id: 'u1', app_metadata: { portal_staff: true } })
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  if (url.includes('/oauth/access_token')) return reply({ access_token: 'tok', scope: 'read_orders', expires_in: 86399 })
  if (url.includes('/graphql.json')) {
    const q = body.query
    if (q.includes('fulfillmentCreate')) {
      const o = world.shopify.get(body.variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId.split('/').pop())
      if (!o || o.status === 'FULFILLED') return reply({ data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ message: 'already fulfilled' }] } } })
      o.status = 'FULFILLED'; world.creates.push(o.id); if (body.variables.fulfillment.notifyCustomer && o.email) world.emails++
      return reply({ data: { fulfillmentCreate: { fulfillment: { id: 'f1', status: 'SUCCESS', trackingInfo: [] }, userErrors: [] } } })
    }
    const id = body.variables.id.split('/').pop()
    if (q.includes('first: 50')) {
      const o = world.shopify.get(id)
      const done = o.status === 'FULFILLED'
      return reply({ data: { order: { id: body.variables.id, name: o.name, email: o.email, cancelledAt: null, displayFulfillmentStatus: done ? 'FULFILLED' : 'UNFULFILLED',
        fulfillmentOrders: { edges: [{ node: { id: `gid://shopify/FulfillmentOrder/${id}`, status: done ? 'CLOSED' : 'OPEN' } }] } } } })
    }
    return reply({ data: { order: world.retailNodes.get(id) } })
  }
  if (url.includes('/rpc/ship_labels_for_order')) return reply([...(world.rows.get(body.p_order_id) || [])])
  if (url.includes('/rpc/claim_order_fulfill')) { if (world.claims.has(body.p_order_id)) return reply(false); world.claims.add(body.p_order_id); return reply(true) }
  if (url.includes('/rpc/release_order_fulfill')) return reply(world.claims.delete(body.p_order_id))
  if (url.includes('/rpc/mark_ship_labels_fulfilled')) {
    const had = world.srv.pending.filter(p => p.order_id === body.p_order_id).length
    world.srv.pending = world.srv.pending.filter(p => p.order_id !== body.p_order_id)
    return reply(had)
  }
  if (url.startsWith('https://api.goshippo.com/transactions/')) return reply({ status: world.shippo(), tracking_number: [...world.rows.values()].flat().find(r => r.shippo_object_id === url.split('/').pop()).tracking_number })
  throw new Error('unexpected ' + url)
}
Object.assign(process.env, { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SHIPPO_TOKEN: 'shippo_test_stub',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_STORE_HANDLE: 'store', PORTAL_AUTH_ENFORCE: '1' })
const handler = require('../api/shopify-fulfill.js')
const { dropToken } = require('../api/_shopify.js')
const RAW = require('./fixtures/retail-orders.json').orders
const { P, order, pendingRow, server, page, eq } = require('./helpers/retail-page')

// The real handler behind the page's apiFetch: the answer comes back the way fetch would hand it over.
async function realFulfill(body, srv, { loseAnswer = false } = {}) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this } }
  await handler({ method: 'POST', body, headers: { authorization: `Bearer ${USER_TOKEN}` }, url: '/api/shopify-fulfill' }, res)
  if (loseAnswer) throw new Error('network lost')
  return { status: res.code, json: res.payload }
}
// Page orders (12x8x6 at 2 lb, like fixture #8333) with a Shopify order and a label row each.
async function opened(n, { held = [], bridge = realFulfill } = {}) {
  dropToken()
  Object.assign(world, { shopify: new Map(), claims: new Set(), creates: [], emails: 0, retailNodes: new Map(), rows: new Map(), shippo: () => 'SUCCESS' })
  const base = RAW.find(x => x.name === '#8333')
  const orders = Array.from({ length: n }, () => order({ parcel: P['12x8x6'] }))
  for (const o of orders) {
    const id = o.order_id.split('/').pop()
    world.shopify.set(id, { id, name: o.order_name, email: 'pat@example.com', status: 'OPEN' })
    world.retailNodes.set(id, { ...base, id: o.order_id, name: o.order_name, displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: { name: 'Pat Doe', address1: '1 Main St', city: 'Town', ...base.shippingAddress } })
    world.rows.set(o.order_id, [{ order_id: o.order_id, order_name: o.order_name, box_index: 1, box_count: 1, tracking_number: `1Z${id.padStart(16, '0')}`, status: 'purchased', channel: 'retail',
      weight_lb: 2, held_back_at: held.includes(o) ? 'x' : null, dest_zip: '11418', shippo_object_id: id.padStart(32, 'a') }])
  }
  const srv = server({ orders, pending: orders.map(o => pendingRow(o, held.includes(o) ? { held_back_at: 'x' } : {})), fulfill: (b, s) => bridge(b, s) })
  world.srv = srv
  const p = page({ srv })
  await p.openPack()
  return { p, srv, orders }
}
const tile = (html, label) => { const m = html.match(new RegExp(`<b>(\\d+)</b><span>${label}</span>`)); return m ? Number(m[1]) : null }

test('X1: the page\'s Fulfill is accepted by the real handler: every included order ships once, and the Done counts equal Shopify\'s', async () => {
  const { p, orders } = await opened(3)
  p.ask(); await p.go()
  assert.equal(world.creates.length, 3)
  assert.equal(world.emails, 3)
  assert.equal(tile(p.html(), 'Shipped'), 3)
  assert.equal(tile(p.html(), 'Customer emails sent'), 3)
  assert.equal(tile(p.html(), 'Still open'), 0)
  eq(Object.keys(p.failed), [])
  assert.equal(p.pending[orders[0].order_id], undefined)                                  // the real flip emptied the pending list
})

test('X1: a second Fulfill of the same orders is "already fulfilled" to the real handler, and the page counts no extra email', async () => {
  const { p, srv, orders } = await opened(2)
  p.ask(); await p.go()
  srv.pending = orders.map(o => pendingRow(o))                                             // as if the flip hadn't happened yet
  world.srv = srv
  p.backFromPack(); await p.openPack()
  p.ask(); await p.go()
  assert.equal(world.creates.length, 2)
  assert.equal(world.emails, 2)
  assert.equal(tile(p.html(), 'Shipped'), 2)
  assert.equal(tile(p.html(), 'Customer emails sent'), 0)
  assert.match(p.html(), /already fulfilled in Shopify/)
})

test('X1: held back on another device after the confirm: the real handler says held_back, and the page lists it as held, not failed', async () => {
  const { p, srv, orders } = await opened(2)
  p.ask()
  world.rows.get(orders[1].order_id)[0].held_back_at = 'x'
  srv.pending.find(r => r.order_id === orders[1].order_id).held_back_at = 'x'
  await p.go()
  assert.equal(world.creates.length, 1)
  assert.equal(tile(p.html(), 'Shipped'), 1)
  assert.equal(tile(p.html(), 'Still open'), 1)
  assert.match(p.html(), new RegExp(`${orders[1].order_name}</b> was held back`))
  eq(Object.keys(p.failed), [])
})

test('X1: a lost answer: the real handler fulfilled and flipped the rows; the page shows it shipped, with no second email on the next Fulfill', async () => {
  let lose = true
  const { p } = await opened(2, { bridge: async (b, s) => { const r = await realFulfill(b, s, { loseAnswer: lose }); return r } })
  // The first call's answer is lost; the handler ran to the end first.
  const first = p.ask() || p.go()
  await first
  assert.equal(world.creates.length, 2)                                                    // both orders created (both answers lost)
  assert.equal(tile(p.html(), 'Shipped'), 2)
  assert.equal(tile(p.html(), 'Customer emails sent'), 0)
  assert.match(p.html(), /went through after the answer was lost/)
  assert.equal(world.emails, 2)
  eq(Object.keys(p.failed), [])
})

test('X1: another device holds the order\'s lock: the real handler says busy and the page keeps the order open and fails it with the reason; a retry after the lock is freed ships it', async () => {
  const { p, orders } = await opened(1)
  world.claims.add(orders[0].order_id)
  p.ask(); await p.go()
  assert.equal(world.creates.length, 0)
  assert.equal(tile(p.html(), 'Still open'), 1)
  assert.match(p.html(), /Another device is fulfilling or voiding this order/)
  world.claims.clear()
  await p.retry(orders[0].order_id)
  assert.equal(world.creates.length, 1)
  eq(Object.keys(p.failed), [])
})

test('X1: a label Shippo says is refunded is refused by the real handler, and the page tells the packer to hold it back and void or fulfill by hand', async () => {
  const { p } = await opened(1)
  world.shippo = () => 'REFUNDED'
  p.ask(); await p.go()
  assert.equal(world.creates.length, 0)
  assert.equal(tile(p.html(), 'Still open'), 1)
  assert.match(p.html(), /Shippo doesn&#39;t show this label as live/)
  assert.match(p.html(), /Hold it back on Pack, then Void its label and buy again, or fulfill it by hand in Shopify\./)
})

test('X1: an order whose billed pounds changed since the label is refused by the real handler (pack_changed), not fulfilled', async () => {
  const { p, orders } = await opened(1)
  world.rows.get(orders[0].order_id)[0].weight_lb = 5
  p.ask(); await p.go()
  assert.equal(world.creates.length, 0)
  assert.match(p.html(), /This order changed in Shopify since its label was bought/)
  assert.match(p.html(), /Hold it back on Pack, then Void its label/)                       // the page knows this code can't be retried
})
