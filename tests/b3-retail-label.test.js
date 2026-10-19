// B3 server gates (retail label buying) and B6 (void), docs/TESTS.md. No network: fetch is
// stubbed, so nothing is bought or voided.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')

// ── fetch stub, installed before the API modules load (they capture fetch at require) ──
const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
let calls = [], respond = () => { throw new Error('unexpected fetch') }
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  const headers = opts.headers || {}
  if (url.endsWith('/auth/v1/user')) {
    const ok = headers.Authorization === `Bearer ${USER_TOKEN}`
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'u1', app_metadata: { portal_staff: true } } : {}), text: async () => (ok ? '' : 'invalid JWT') }
  }
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url, body, headers })
  const out = respond(url, body, headers)
  const status = out.status || 200
  return { ok: status < 400, status, json: async () => out.json, text: async () => JSON.stringify(out.json) }
}
Object.assign(process.env, {
  SHIPPO_TOKEN: 'shippo_test_stub', SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_STORE_HANDLE: 'store', PORTAL_AUTH_ENFORCE: '1'
})
const shippoLabel = require('../api/shippo-label.js')
const { dropToken } = require('../api/_shopify.js')
const RAW = require('./fixtures/retail-orders.json').orders

const UPS_ACCOUNT = '21db4cf80df74a2cb27fc20948862003'
const OID = 'gid://shopify/Order/8333'
// A fixture order as Shopify returned it, open again (the fixtures are past orders).
const node = (name, over = {}) => ({ ...RAW.find(n => n.name === name), id: OID, displayFulfillmentStatus: 'UNFULFILLED', ...over })
const ADDR = { name: 'Pat Doe', street1: '1 Main St', city: 'Queens', state: 'NY', zip: '11418', country: 'US' }
// #8333: 2 x 12 oz -> one 12x8x6 at 2 lb (B2, Phase A).
const BODY = { kind: 'retail', address_to: ADDR, parcel: { length: 12, width: 8, height: 6, weight: 2 }, carrier: 'ups', weight_basis: 'packed',
  expected_amount: '9.10', order_id: OID, order_name: '#8333', box_index: 1, box_count: 1, pack_sig: '12x8x6@2' }
const TXN = 'd'.repeat(32)

let tokenLife = 86399
// The happy path. `order` is the GraphQL node (null = no such order); `prior` the label rows.
const world = ({ order = node('#8333'), prior = [], rest = { id: 8333, name: '#8333', cancelled_at: null, fulfillment_status: null, line_items: [{ fulfillment_status: null }] }, refund = { status: 'QUEUED', object_id: 'ref_1', transaction: TXN }, marked = 1 } = {}) => (url) => {
  if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok', scope: 'read_orders', expires_in: tokenLife } }
  if (url.includes('/graphql.json')) return { json: { data: { order } } }
  if (url.includes('/orders/8333.json')) return { json: { order: rest } }
  if (url.includes('/rpc/ship_labels_for_order')) return { json: prior }
  if (url.includes('/rpc/claim_label_box') || url.includes('/rpc/release_label_box')) return { json: true }
  if (url.includes('/rpc/mark_ship_label_voided')) return { json: marked }
  if (url.endsWith('/shipments/')) return { json: { rates: [{ object_id: 'rate_1', amount: '9.10', currency: 'USD', carrier_account: UPS_ACCOUNT, servicelevel: { token: 'ups_ground', name: 'Ground' } }] } }
  if (url.endsWith('/transactions/')) return { json: { status: 'SUCCESS', tracking_number: '1ZRETAIL', label_url: 'https://deliver.goshippo.com/x.pdf', object_id: TXN } }
  if (url.endsWith(`/transactions/${TXN}`)) return { json: { object_id: TXN, status: 'SUCCESS', tracking_number: '1ZRETAIL', label_url: 'https://deliver.goshippo.com/x.pdf' } }
  if (url.endsWith('/refunds/')) return { status: refund.status === 'ERROR' ? 400 : 201, json: refund }
  if (url.includes('/rest/v1/shipping_labels')) return { status: 201, json: null }
  throw new Error('unexpected ' + url)
}
function reset(fn) { calls = []; respond = fn }
async function call(query, body, headers = { authorization: `Bearer ${USER_TOKEN}` }) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this } }
  await shippoLabel({ method: 'POST', query, body, headers, url: '/api/shippo-label' }, res)
  return res
}
const label = body => call({ action: 'label' }, body)
const bought = () => calls.filter(c => c.url.endsWith('/transactions/')).length
const n = part => calls.filter(c => c.url.includes(part)).length

// ── B3: retail labels ─────────────────────────────────────────────────────────────────────
test('B3: a LIST order with the server\'s own pack buys one UPS Ground label', async () => {
  dropToken(); reset(world())
  const r = await label(BODY)
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.tracking_number, '1ZRETAIL')
  assert.equal(bought(), 1)
  const gql = calls.find(c => c.url.includes('/graphql.json'))
  assert.match(gql.url, /\/admin\/api\/2025-10\/graphql\.json$/)
  assert.equal(gql.body.variables.id, OID)
  assert.equal(n('/orders/8333.json'), 0)                                  // retail never reads the REST order
  const parcel = calls.find(c => c.url.endsWith('/shipments/')).body.parcels[0]
  assert.deepEqual([parcel.length, parcel.width, parcel.height, parcel.weight], ['12', '8', '6', '2'])
  // Order kept: lookup -> pack check -> rate -> claim -> buy -> cost row.
  const order = ['ship_labels_for_order', 'graphql.json', '/shipments/', 'claim_label_box', '/transactions/', 'shipping_labels']
  const idx = order.map(p => calls.findIndex(c => c.url.includes(p)))
  assert.deepEqual([...idx].sort((a, b) => a - b), idx)
})

test('B3: every listed carton buys at its billed pounds', async () => {
  for (const [name, sig] of [['#8331', '8x6x3@1'], ['#8289', '12x8x6@6'], ['#7388', '14x10x10@7'], ['#8291', '8x6x3@1']]) {
    reset(world({ order: node(name) }))
    const [l, w, h, lb] = sig.split(/[x@]/).map(Number)
    const r = await label({ ...BODY, pack_sig: sig, parcel: { length: l, width: w, height: h, weight: lb } })
    assert.equal(r.code, 200, `${name} ${JSON.stringify(r.payload)}`)
  }
})

test('B3: a wrong pack is refused with pack_changed, nothing claimed or bought', async () => {
  for (const [why, body] of [
    ['lighter', { ...BODY, parcel: { ...BODY.parcel, weight: 1 } }],
    ['carton', { ...BODY, parcel: { length: 8, width: 6, height: 3, weight: 2 }, pack_sig: '8x6x3@2' }],
    ['sig', { ...BODY, pack_sig: '12x8x6@3' }],
    ['two boxes', { ...BODY, box_index: 1, box_count: 2 }],
    ['the b2b pack', { ...BODY, pack_sig: '14x10x10@3', parcel: { length: 14, width: 10, height: 10, weight: 3 } }]
  ]) {
    reset(world())
    const r = await label(body)
    assert.equal(r.code, 409, why)
    assert.equal(r.payload.code, 'pack_changed', why)
    assert.equal(bought() + n('claim_label_box') + n('/shipments/'), 0, why)
  }
  // An order edited since it was listed: a third bag now.
  const o = node('#8333')
  reset(world({ order: { ...o, lineItems: { ...o.lineItems, nodes: [{ ...o.lineItems.nodes[0], currentQuantity: 2 }, o.lineItems.nodes[1]] } } }))
  const r = await label(BODY)
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /12x8x6@3/)
  assert.equal(bought(), 0)
})

test('B3: HOLD and EXCLUDE orders are refused with their class', async () => {
  const cases = [
    ['HI', node('#7297'), 'HI_AK_PR_APO'],
    ['vendor', node('#7482'), 'NON_TORQUE_VENDOR'],
    ['company', node('#8320'), 'COMPANY_B2B'],
    ['pickup', node('#8284', { displayFulfillmentStatus: 'UNFULFILLED' }), 'PICKUP'],
    ['cancelled since listed', node('#8333', { cancelledAt: '2026-10-19T00:00:00Z' }), 'CANCELLED'],
    ['fulfilled by hand', node('#8333', { displayFulfillmentStatus: 'FULFILLED' }), 'NOT_OPEN'],
    ['refunded', node('#8333', { displayFinancialStatus: 'REFUNDED' }), 'REFUNDED'],
    ['partly shipped', node('#8333', { displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }), 'NOT_UNFULFILLED']
  ]
  for (const [why, order, cls] of cases) {
    reset(world({ order }))
    const r = await label(BODY)
    assert.equal(r.code, 409, why)
    assert.equal(r.payload.code, 'not_listed', why)
    assert.equal(r.payload.class, cls, why)
    assert.match(r.payload.error, /Nothing was bought/)
    assert.equal(bought() + n('/shipments/'), 0, why)
  }
})

test('B3: missing order, Shopify errors or a bad id buy nothing', async () => {
  const cases = [
    ['missing', world({ order: null }), 409],
    ['graphql errors', (url) => url.includes('/graphql.json') ? { json: { errors: [{ message: 'Throttled' }] } } : world()(url), 503],
    ['shopify 500', (url) => url.includes('/graphql.json') ? { status: 500, json: {} } : world()(url), 503],
    ['no token', (url) => url.includes('/oauth/') ? { json: { error: 'invalid_client' } } : world()(url), 503]
  ]
  for (const [why, fn, code] of cases) {
    dropToken(); reset(fn)
    const r = await label(BODY)
    assert.equal(r.code, code, why)
    assert.equal(bought(), 0, why)
  }
  reset(world())
  assert.equal((await label({ ...BODY, order_id: 'gid://shopify/Product/1' })).code, 400)
  assert.equal(n('graphql.json'), 0)
})

test('B3: kind must be b2b or retail; an already-bought retail box is handed back, not rebought', async () => {
  reset(world())
  assert.equal((await label({ ...BODY, kind: 'Retail' })).code, 400)
  assert.equal((await call({ action: 'rate' }, { ...BODY, kind: 'usps' })).code, 400)
  assert.equal(calls.length, 0)
  reset(world({ prior: [{ box_index: 1, status: 'purchased', tracking_number: '1ZRETAIL', shippo_object_id: TXN }] }))
  const r = await label(BODY)
  assert.equal(r.payload.error, 'Already bought')
  assert.equal(bought() + n('graphql.json'), 0)
})

test('B3: the Shopify token is exchanged once for a batch, renewed near expiry and after a 401', async () => {
  dropToken(); tokenLife = 86399; reset(world())
  for (let i = 0; i < 3; i++) assert.equal((await label(BODY)).code, 200)
  assert.equal(n('/oauth/access_token'), 1)
  assert.equal(n('graphql.json'), 3)                                        // one order read per order
  // Shopify refuses the cached token: dropped, one fresh exchange, the read retried.
  let refused = false
  reset((url, body, headers) => {
    if (url.includes('/graphql.json') && headers['X-Shopify-Access-Token'] === 'tok' && !refused) { refused = true; return { status: 401, json: { errors: 'Invalid API key or access token' } } }
    return world()(url)
  })
  assert.equal((await label(BODY)).code, 200)
  assert.equal(n('/oauth/access_token'), 1)
  assert.equal(n('graphql.json'), 2)
  // A token that says nothing about expiry, or expires within the margin, is never kept.
  for (const life of [undefined, 200]) {
    dropToken(); tokenLife = life; reset(world())
    await label(BODY); await label(BODY)
    assert.equal(n('/oauth/access_token'), 2, String(life))
  }
  tokenLife = 86399
})

test('B3: a page without kind is still B2B (REST order, B2B packer)', async () => {
  dropToken()
  const { kind, ...old } = BODY
  reset((url) => url.includes('/orders/8333.json')
    ? { json: { order: { id: 8333, name: '#8333', cancelled_at: null, line_items: [{ vendor: 'Torque Coffees', title: 'Gum Drop', variant_title: '12oz', quantity: 2, grams: 340, fulfillment_status: null }] } } }
    : world()(url))
  const r = await label(old)                                                // 2 x 12 oz in B2B = one 14x10x10 at 3 lb
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /14x10x10@3/)
  assert.equal(n('graphql.json'), 0)
  reset((url) => url.includes('/orders/8333.json')
    ? { json: { order: { id: 8333, name: '#8333', cancelled_at: null, line_items: [{ vendor: 'Torque Coffees', title: 'Gum Drop', variant_title: '12oz', quantity: 2, grams: 340, fulfillment_status: null }] } } }
    : world()(url))
  assert.equal((await label({ ...old, pack_sig: '14x10x10@3', parcel: { length: 14, width: 10, height: 10, weight: 3 } })).code, 200)
})

// ── B6: void ──────────────────────────────────────────────────────────────────────────────
const PRIOR = [{ box_index: 1, status: 'purchased', tracking_number: '1ZRETAIL', shippo_object_id: TXN }]
const voidIt = (body = { order_id: OID, box_index: 1 }, headers) => call({ action: 'void' }, body, headers)
const refunds = () => calls.filter(c => c.url.endsWith('/refunds/'))

test('B6: an unused label is refunded through Shippo and its row marked voided', async () => {
  reset(world({ prior: PRIOR }))
  const r = await voidIt()
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  assert.deepEqual([r.payload.voided, r.payload.row_marked, r.payload.refund_status], [true, true, 'QUEUED'])
  assert.deepEqual(refunds().map(c => c.body), [{ transaction: TXN, async: false }])
  assert.equal(refunds()[0].headers.Authorization, 'ShippoToken shippo_test_stub')
  const mark = calls.find(c => c.url.includes('mark_ship_label_voided'))
  assert.deepEqual(mark.body, { p_order_id: OID, p_box_index: 1, p_shippo_object_id: TXN })
  assert.equal(mark.headers.Authorization, `Bearer ${USER_TOKEN}`)          // as the caller (RLS)
  // Order: row -> Shopify -> Shippo confirms -> refund -> mark.
  const idx = ['ship_labels_for_order', '/orders/8333.json', `/transactions/${TXN}`, '/refunds/', 'mark_ship_label_voided'].map(p => calls.findIndex(c => c.url.includes(p)))
  assert.deepEqual([...idx].sort((a, b) => a - b), idx)
  assert.equal(bought(), 0)
})

test('B6: signed-in staff only, even without enforcement', async () => {
  const was = process.env.PORTAL_AUTH_ENFORCE
  process.env.PORTAL_AUTH_ENFORCE = ''
  reset(world({ prior: PRIOR }))
  assert.equal((await voidIt(undefined, {})).code, 401)
  assert.equal((await voidIt(undefined, { authorization: 'Bearer nope' })).code, 401)
  assert.equal(calls.length, 0)
  process.env.PORTAL_AUTH_ENFORCE = was
})

test('B6: never voids a label of an order already fulfilled, in the portal or in Shopify', async () => {
  const cases = [
    ['row fulfilled', { prior: [{ ...PRIOR[0], status: 'fulfilled' }] }],
    ['shopify fulfilled', { prior: PRIOR, rest: { id: 8333, cancelled_at: null, fulfillment_status: 'fulfilled', line_items: [{ fulfillment_status: 'fulfilled' }] } }],
    ['shopify partial', { prior: PRIOR, rest: { id: 8333, cancelled_at: null, fulfillment_status: 'partial', line_items: [{ fulfillment_status: null }, { fulfillment_status: 'fulfilled' }] } }],
    ['a fulfilled line', { prior: PRIOR, rest: { id: 8333, cancelled_at: null, fulfillment_status: null, line_items: [{ fulfillment_status: 'fulfilled' }] } }]
  ]
  for (const [why, w] of cases) {
    dropToken(); reset(world(w))
    const r = await voidIt()
    assert.equal(r.code, 409, why)
    assert.equal(refunds().length + n('mark_ship_label_voided'), 0, why)
  }
  // A cancelled, unfulfilled order is exactly what a void is for.
  reset(world({ prior: PRIOR, rest: { id: 8333, cancelled_at: '2026-10-19T00:00:00Z', fulfillment_status: null, line_items: [{ fulfillment_status: null }] } }))
  assert.equal((await voidIt()).code, 200)
})

test('B6: fails closed: no row, a voided row, a lookup or Shopify failure, or a label Shippo doesn\'t confirm', async () => {
  const cases = [
    ['no row', world({ prior: [] }), 404],
    ['already voided', world({ prior: [{ ...PRIOR[0], status: 'voided' }] }), 404],
    ['lookup down', (url) => url.includes('ship_labels_for_order') ? { status: 500, json: {} } : world({ prior: PRIOR })(url), 503],
    ['shopify down', (url) => url.includes('/orders/8333.json') ? { status: 500, json: {} } : world({ prior: PRIOR })(url), 503],
    ['no such order', (url) => url.includes('/orders/8333.json') ? { status: 404, json: {} } : world({ prior: PRIOR })(url), 409],
    ['planted row', (url) => url.endsWith(`/transactions/${TXN}`) ? { json: { object_id: TXN, status: 'SUCCESS', tracking_number: '1ZOTHER' } } : world({ prior: PRIOR })(url), 409]
  ]
  for (const [why, fn, code] of cases) {
    reset(fn)
    const r = await voidIt()
    assert.equal(r.code, code, why)
    assert.equal(refunds().length + n('mark_ship_label_voided'), 0, why)
  }
  reset(world({ prior: PRIOR }))
  for (const body of [{ order_id: OID }, { order_id: '../x', box_index: 1 }, { order_id: OID, box_index: 0 }]) {
    assert.equal((await voidIt(body)).code, 400, JSON.stringify(body))
  }
  assert.equal(calls.length, 0)
})

test('B6: a refused refund leaves the row alone; a refund whose row can\'t be marked says so', async () => {
  reset(world({ prior: PRIOR, refund: { status: 'ERROR', messages: [{ text: 'Label already used' }] } }))
  let r = await voidIt()
  assert.equal(r.code, 502)
  assert.match(r.payload.error, /still live/)
  assert.equal(n('mark_ship_label_voided'), 0)
  for (const marked of [0, { status: 500 }]) {
    reset((url) => url.includes('mark_ship_label_voided') && typeof marked === 'object' ? { status: 500, json: {} } : world({ prior: PRIOR, marked })(url))
    r = await voidIt()
    assert.equal(r.code, 200)
    assert.deepEqual([r.payload.voided, r.payload.row_marked], [true, false])
    assert.match(r.payload.error, /record wasn't updated/)
  }
})
