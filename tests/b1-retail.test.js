// B1 gates (docs/TESTS.md): the retail order list classifies the 30 Phase A acceptance orders
// exactly as docs/acceptance_fixtures.json says. No network: fetch is stubbed.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
// ── fetch stub, installed before the API modules load (they capture fetch at require) ──
const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
let pages = []
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  if (url.endsWith('/auth/v1/user')) {
    const ok = (opts.headers || {}).Authorization === `Bearer ${USER_TOKEN}`
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'u1', app_metadata: { portal_staff: true } } : {}) }
  }
  if (url.includes('/oauth/access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
  if (url.includes('/graphql.json')) { const p = pages.shift(); return { ok: !!p, status: p ? 200 : 500, json: async () => p || {} } }
  throw new Error('unexpected ' + url)
}
Object.assign(process.env, { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_STORE_HANDLE: 'store', PORTAL_AUTH_ENFORCE: '' })
const { classifyRetailOrder, retailShipItems, shippingCharged } = require('../lib/ship-rules.js')
const { normalizeRetailOrder } = require('../api/_retail.js')

const ACCEPT = require('../docs/acceptance_fixtures.json').fixtures
const RAW = require('./fixtures/retail-orders.json').orders
// The fixtures are past orders, mostly fulfilled since. Classify them as they stood when they
// were open: unfulfilled, with the current quantity still to ship. Cancelled and pickup orders
// keep their own status (those rules come first anyway).
const asListed = n => n.cancelledAt || n.displayFulfillmentStatus === 'READY_FOR_PICKUP' ? n : { ...n, displayFulfillmentStatus: 'UNFULFILLED' }
const byName = Object.fromEntries(RAW.map(n => [n.name, normalizeRetailOrder(asListed(n))]))

test('B1: all 30 acceptance orders are in the fixture', () => {
  assert.deepEqual(Object.keys(byName).sort(), ACCEPT.map(f => f.order).sort())
})

test('B1: every acceptance order lists, holds or is excluded exactly as Phase A decided', () => {
  for (const f of ACCEPT) {
    const c = classifyRetailOrder(byName[f.order])
    assert.equal(c.decision, f.decision, `${f.order} decision`)
    if (f.class) assert.equal(c.class, f.class, `${f.order} class`)
  }
  assert.equal(classifyRetailOrder(byName['#7367']).class, 'FELLOW')   // fixture has no class, reason "Fellow tag"
})

test('B1: listed orders carry the bags Phase A counted, and the flags', () => {
  const bags = o => retailShipItems(o).map(i => `${i.qty}x${i.weight_lb}`).sort().join('+')
  assert.equal(bags(byName['#8331']), '1x0.75')
  assert.equal(bags(byName['#8298']), '1x0.75+1x2')
  assert.equal(bags(byName['#8255']), '1x0.75')                      // xPods = 12 oz (R3)
  assert.equal(bags(byName['#7388']), '2x0.75+2x0.75+3x0.75')
  assert.equal(bags(byName['#8322']), '1x0.75+1x0.75+1x0.75')        // a 0 oz catalog weight: the title wins (R10)
  assert.deepEqual(classifyRetailOrder(byName['#8331']).flags, ['SUBSCRIPTION'])
  assert.deepEqual(classifyRetailOrder(byName['#8291']).flags, ['REPLACEMENT'])
  assert.deepEqual(classifyRetailOrder(byName['#8322']).flags, ['FREE_SHIPPING'])
  assert.deepEqual(classifyRetailOrder(byName['#8333']).flags, [])
  // R11 shipping charged, against Phase A's numbers
  for (const f of ACCEPT.filter(f => f.decision === 'LIST' && f.shipping_charged_usd_discounted != null)) {
    assert.equal(shippingCharged(byName[f.order]), Number(f.shipping_charged_usd_discounted), f.order)
  }
})

test('B1: holds and exclusions the fixtures do not cover', () => {
  const base = byName['#8333']
  const C = o => classifyRetailOrder(o).class
  const D = o => classifyRetailOrder(o).decision
  assert.equal(C({ ...base, fulfillment_status: 'PARTIALLY_FULFILLED' }), 'NOT_UNFULFILLED')   // R1a: no partial shipments
  assert.equal(D({ ...base, fulfillment_status: 'PARTIALLY_FULFILLED' }), 'HOLD')
  assert.equal(C({ ...base, fulfillment_status: 'FULFILLED' }), 'NOT_OPEN')
  assert.equal(C({ ...base, financial_status: 'REFUNDED' }), 'REFUNDED')                        // #7453
  assert.equal(C({ ...base, delivery_methods: ['LOCAL'] }), 'LOCAL_DELIVERY')
  assert.equal(C({ ...base, delivery_methods: [] }), 'NO_SHIPPING')
  assert.equal(C({ ...base, address: { ...base.address, country: 'CA' } }), 'NO_US_ADDRESS')
  assert.equal(C({ ...base, address: null }), 'NO_US_ADDRESS')
  assert.equal(C({ ...base, lines_truncated: true }), 'TOO_MANY_LINES')
  assert.equal(C({ ...base, lines: [{ ...base.lines[0], variant_title: '2 x 12oz', title: 'Pack', grams: null }] }), 'NO_WEIGHT')
  assert.equal(C({ ...base, lines: [{ ...base.lines[0], qty: 40 }] }), 'OVER_30_BAGS')
  assert.equal(C({ ...base, lines: [{ ...base.lines[0], qty: 30 }] }), 'ELIGIBLE')             // 30 is allowed
  assert.equal(C({ ...base, lines: base.lines.map(l => ({ ...l, qty: 0 })) }), 'NO_SHIPPING')    // nothing left to ship
  assert.equal(C({ ...base, lines: [...base.lines, { ...base.lines[0], is_gift_card: true, product_vendor: null, has_variant: false }] }), 'ELIGIBLE')
})

test('B1: the GraphQL node is read as Shopify sends it', () => {
  const n = RAW.find(o => o.name === '#8301')
  const o = normalizeRetailOrder({ ...n, id: 'gid://shopify/Order/9', lineItems: { pageInfo: { hasNextPage: true }, nodes: n.lineItems.nodes.map(l => ({ ...l, unfulfilledQuantity: 3 })) } })
  assert.equal(o.order_id, 'gid://shopify/Order/9')
  assert.equal(o.lines[0].qty, 3)                     // unfulfilledQuantity beats currentQuantity
  assert.equal(o.lines_truncated, true)
  assert.equal(o.lines[0].grams, 340.2)               // 12 OUNCES
  assert.equal(o.address.province, 'FL')
})

const shopifyToken = require('../api/shopify-token.js')
async function call(headers = { authorization: `Bearer ${USER_TOKEN}` }) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this } }
  await shopifyToken({ method: 'GET', query: { type: 'retail-ship' }, headers, url: '/api/shopify-token' }, res)
  return res
}
const page = (nodes, next) => ({ data: { orders: { pageInfo: { hasNextPage: !!next, endCursor: next || null }, nodes } } })

test('B1: ?type=retail-ship needs a signed-in staff user even before enforcement', async () => {
  pages = []
  assert.equal((await call({})).code, 401)
})

test('B1: ?type=retail-ship returns LIST and HOLD orders across pages and counts the rest', async () => {
  const live = RAW.map(asListed)
  pages = [page(live.slice(0, 15), 'c1'), page(live.slice(15))]
  const r = await call()
  assert.equal(r.code, 200)
  const want = ACCEPT.filter(f => f.decision !== 'EXCLUDE').map(f => f.order).sort()
  assert.deepEqual(r.payload.orders.map(o => o.order_name).sort(), want)
  assert.equal(Object.values(r.payload.excluded).reduce((a, b) => a + b, 0), ACCEPT.filter(f => f.decision === 'EXCLUDE').length)
  const o = r.payload.orders.find(x => x.order_name === '#8333')
  assert.equal(o.decision, 'LIST'); assert.equal(o.shipping_charged, '8.00'); assert.equal(o.delivery_method, 'SHIPPING')
  assert.equal(o.shipping_address.province, 'NY')
  assert.equal(r.payload.orders.find(x => x.order_name === '#7297').class, 'HI_AK_PR_APO')
  assert.deepEqual(o.parcel, { length: 12, width: 8, height: 6, weight: 2 })         // B2: 2 x 12 oz
  assert.equal(r.payload.orders.find(x => x.order_name === '#7297').parcel, null)   // HOLD: no carton
})

test('B1: a failed page fails the whole list (never a partial list)', async () => {
  pages = [page(RAW.slice(0, 5).map(asListed), 'c1')]                       // second page -> 500
  const r = await call()
  assert.equal(r.code, 502)
})
