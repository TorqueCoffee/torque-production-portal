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
  if (out.throw) throw new Error(out.throw)
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
// The fixtures keep only state and ZIP (privacy); a street and city stand in, since the server
// refuses an address without them (B3a).
const node = (name, over = {}) => {
  const n = RAW.find(x => x.name === name)
  return { ...n, id: OID, displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: { name: 'Pat Doe', address1: '1 Main St', city: 'Town', ...n.shippingAddress }, ...over }
}
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

// ── B3a: the cost row says which tab the label belongs to (ADR 0028) ──────────────────────
test('B3a K7: a retail cost row carries channel retail (B2B rows send none: tests/b0-ups.test.js)', async () => {
  dropToken(); reset(world())
  const r = await label(BODY)
  assert.equal(r.code, 200)
  assert.equal(r.payload.cost_logged, true)
  const rows = calls.filter(c => c.url.includes('/rest/v1/shipping_labels'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].body.channel, 'retail')
  assert.equal(rows[0].body.order_id, OID)
})

test('B3a K7: before the channel migration the retail row is written without it, never lost', async () => {
  dropToken()
  const base = world()
  reset((url, body) => url.includes('/rest/v1/shipping_labels') && body && body.channel
    ? { status: 400, json: { code: 'PGRST204', message: "Could not find the 'channel' column of 'shipping_labels' in the schema cache" } }
    : base(url, body))
  const r = await label(BODY)
  assert.equal(r.code, 200)
  assert.equal(r.payload.cost_logged, true)
  const rows = calls.filter(c => c.url.includes('/rest/v1/shipping_labels'))
  assert.deepEqual(rows.map(c => 'channel' in c.body), [true, false])
  assert.equal(rows[1].body.tracking_number, '1ZRETAIL')
  // Any other refusal is not retried and is reported.
  reset((url, body) => url.includes('/rest/v1/shipping_labels') ? { status: 403, json: { message: 'new row violates row-level security policy' } } : base(url, body))
  const r2 = await label(BODY)
  assert.equal(r2.code, 200)
  assert.equal(r2.payload.cost_logged, false)
  assert.equal(n('/rest/v1/shipping_labels'), 1)
})

// ── B3a review fixes (ADR 0028) ───────────────────────────────────────────────────────────
const SHOPIFY_ADDR = { name: 'Pat Doe', company: null, address1: '9 New Street', address2: 'Apt 4', city: 'Queens', provinceCode: 'NY', zip: '11419', countryCodeV2: 'US', phone: '7185550100' }
test('B3a: retail buys at the address Shopify has now, not the page\'s', async () => {
  dropToken(); reset(world({ order: node('#8333', { shippingAddress: SHOPIFY_ADDR }) }))
  const r = await label({ ...BODY, address_to: { ...ADDR, street1: '1 Old Street' } })
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  const to = calls.find(c => c.url.endsWith('/shipments/')).body.address_to
  assert.deepEqual([to.street1, to.street2, to.zip, to.phone, to.company], ['9 New Street', 'Apt 4', '11419', '7185550100', ''])
  assert.equal(calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body.dest_zip, '11419')
})

test('B3a: a retail quote with order_id is for Shopify\'s address; a P.O. box or a long line there is refused, nothing rated', async () => {
  dropToken(); reset(world({ order: node('#8333', { shippingAddress: SHOPIFY_ADDR }) }))
  const r = await call({ action: 'rate' }, { ...BODY, address_to: { ...ADDR, street1: '1 Old Street' } })
  assert.equal(r.code, 200)
  assert.equal(calls.find(c => c.url.endsWith('/shipments/')).body.address_to.street1, '9 New Street')
  for (const bad of [{ address1: 'PO Box 12' }, { address1: 'x'.repeat(36) }]) {
    for (const action of ['rate', 'label']) {
      reset(world({ order: node('#8333', { shippingAddress: { ...SHOPIFY_ADDR, ...bad } }) }))
      const b = await call({ action }, BODY)
      assert.equal(b.code, 409, `${action} ${JSON.stringify(bad)}`)
      assert.equal(b.payload.code, 'address')
      assert.equal(n('/shipments/') + bought(), 0)
    }
  }
  // No order_id on a rate (an older page): the page's address, as before.
  reset(world())
  const { order_id, ...noId } = BODY
  assert.equal((await call({ action: 'rate' }, noId)).code, 200)
  assert.equal(n('/graphql.json'), 0)
})

test('B3a: a Shippo throttle is 429 and an outage 502, never "No UPS Ground rate"; nothing bought', async () => {
  for (const [status, want] of [[429, 429], [503, 502], [500, 502]]) {
    for (const action of ['rate', 'label']) {
      dropToken()
      const base = world()
      reset(url => (url.endsWith('/shipments/') ? { status, json: { detail: 'x' } } : base(url)))
      const r = await call({ action }, BODY)
      assert.equal(r.code, want, `${status} ${action}`)
      assert.doesNotMatch(r.payload.error, /No UPS Ground rate/)
      assert.equal(bought() + n('claim_label_box'), 0)
    }
  }
})

test('B3a: the cost row gets the validated box numbers, and one retry after a 5xx', async () => {
  dropToken(); reset(world())
  const r = await label({ ...BODY, box_index: '1e0', box_count: '1' })
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  const row = calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body
  assert.deepEqual([row.box_index, row.box_count], [1, 1])
  let tries = 0
  const base = world()
  reset((url, body) => (url.includes('/rest/v1/shipping_labels') && tries++ === 0 ? { status: 503, json: { message: 'upstream' } } : base(url, body)))
  const r2 = await label(BODY)
  assert.equal(r2.payload.cost_logged, true)
  assert.equal(n('/rest/v1/shipping_labels'), 2)
  // A 400 that only mentions "channel" (not PGRST204) is not retried without it.
  reset((url, body) => (url.includes('/rest/v1/shipping_labels') ? { status: 400, json: { code: '23514', message: "new row violates check constraint on 'channel'" } } : base(url, body)))
  const r3 = await label(BODY)
  assert.equal(r3.payload.cost_logged, false)
  assert.equal(n('/rest/v1/shipping_labels'), 1)
})


// ── B3a review round 2 fixes ──────────────────────────────────────────────────────────────
test('B3a: another spelling of the order id finds the same label; nothing is bought twice', async () => {
  for (const spelling of ['8333', '08333', 'gid://shopify/Order/08333']) {
    dropToken()
    reset(world({ prior: [{ order_id: OID, box_index: 1, status: 'purchased', tracking_number: '1ZRETAIL', shippo_object_id: TXN }] }))
    const r = await label({ ...BODY, order_id: spelling })
    assert.equal(r.code, 409, spelling)
    assert.equal(r.payload.error, 'Already bought')
    assert.equal(calls.find(c => c.url.includes('ship_labels_for_order')).body.p_order_id, OID)
    assert.equal(bought(), 0)
  }
  reset(world())
  assert.equal((await label({ ...BODY, order_id: 'abc' })).code, 400)
  dropToken(); reset(world())
  await label({ ...BODY, order_id: '8333' })
  const row = calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body
  assert.equal(row.order_id, OID)                                   // stored under the one spelling
  assert.equal(calls.find(c => c.url.includes('claim_label_box')).body.p_order_id, OID)
})

test('B3a: a retail quote reads the customer\'s order, so it needs a signed-in user even with enforcement off', async () => {
  const was = process.env.PORTAL_AUTH_ENFORCE
  delete process.env.PORTAL_AUTH_ENFORCE
  try {
    reset(world())
    const r = await call({ action: 'rate' }, BODY, {})
    assert.equal(r.code, 401)
    assert.equal(calls.length, 0)
    // A text/plain body arrives as a string: still refused.
    const s = await call({ action: 'rate' }, JSON.stringify(BODY), {})
    assert.equal(s.code, 401)
    assert.equal(calls.length, 0)
  } finally { process.env.PORTAL_AUTH_ENFORCE = was }
})

test('B3a: rate and label say which ship-to they used (no street); the cost row takes Shopify\'s order name', async () => {
  dropToken(); reset(world({ order: node('#8333', { shippingAddress: SHOPIFY_ADDR }) }))
  const q = await call({ action: 'rate' }, BODY)
  assert.deepEqual(q.payload.ship_to, { name: 'Pat Doe', city: 'Queens', province: 'NY', zip: '11419' })
  reset(world({ order: node('#8333', { shippingAddress: SHOPIFY_ADDR }) }))
  const r = await label({ ...BODY, order_name: '#FAKE' })
  assert.deepEqual(r.payload.ship_to, { name: 'Pat Doe', city: 'Queens', province: 'NY', zip: '11419' })
  assert.equal(JSON.stringify(r.payload.ship_to).includes('New Street'), false)
  assert.equal(calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body.order_name, '#8333')
})

test('B3a: a Shopify address with no street, a missing order at quote time, each refuse with nothing rated', async () => {
  dropToken(); reset(world({ order: node('#8333', { shippingAddress: { ...SHOPIFY_ADDR, address1: '' } }) }))
  const a = await call({ action: 'rate' }, BODY)
  assert.equal(a.code, 409); assert.equal(a.payload.code, 'address')
  reset(world({ order: null }))
  const b = await call({ action: 'rate' }, BODY)
  assert.equal(b.code, 409); assert.equal(b.payload.code, 'not_listed')
  assert.equal(n('/shipments/'), 0)
})

test('B3a: Shippo still working on a label keeps the claim and says not to buy again; a 429 on the buy frees it', async () => {
  dropToken()
  const base = world()
  reset(url => (url.endsWith('/transactions/') ? { status: 201, json: { status: 'QUEUED', object_id: TXN } } : base(url)))
  const r = await label(BODY)
  assert.equal(r.code, 502)
  assert.equal(r.payload.code, 'label_pending')
  assert.match(r.payload.error, /Don't buy it again/)
  assert.equal(n('release_label_box'), 0)
  reset(url => (url.endsWith('/transactions/') ? { status: 429, json: { detail: 'throttled' } } : base(url)))
  const t = await label(BODY)
  assert.equal(t.code, 429)
  assert.equal(n('release_label_box'), 1)
  reset(url => (url.endsWith('/transactions/') ? { status: 201, json: { status: 'ERROR', messages: [] } } : base(url)))
  assert.equal((await label(BODY)).code, 502)
  assert.equal(n('release_label_box'), 1)
})

test('B3a: the cost row survives a network error, and a retry that finds it already written counts as written', async () => {
  dropToken()
  const base = world()
  let tries = 0
  reset((url, body) => (url.includes('/rest/v1/shipping_labels') && tries++ === 0 ? { throw: 'socket hang up' } : base(url, body)))
  assert.equal((await label(BODY)).payload.cost_logged, true)
  tries = 0
  reset((url, body) => (url.includes('/rest/v1/shipping_labels') ? (tries++ === 0 ? { status: 504, json: {} } : { status: 409, json: { code: '23505', message: 'duplicate key value violates unique constraint' } }) : base(url, body)))
  const r = await label(BODY)
  assert.equal(r.payload.cost_logged, true)
  assert.equal(n('/rest/v1/shipping_labels'), 2)
  // A duplicate on the first try (no retry) is not proof of anything: reported.
  reset((url, body) => (url.includes('/rest/v1/shipping_labels') ? { status: 409, json: { code: '23505' } } : base(url, body)))
  assert.equal((await label(BODY)).payload.cost_logged, false)
})

test('B3a: the box is freed only when Shippo plainly bought nothing; any doubt keeps the claim', async () => {
  const base = world()
  for (const [why, out, freed] of [
    ['SUCCESS without tracking', { status: 201, json: { status: 'SUCCESS', object_id: TXN } }, false],
    ['5xx with JSON', { status: 503, json: { detail: 'upstream' } }, false],
    ['ERROR', { status: 201, json: { status: 'ERROR', messages: [] } }, true],
    ['4xx refusal', { status: 400, json: { detail: 'bad rate' } }, true]
  ]) {
    dropToken()
    reset(url => (url.endsWith('/transactions/') ? out : base(url)))
    const r = await label(BODY)
    assert.equal(n('release_label_box'), freed ? 1 : 0, why)
    if (!freed) assert.equal(r.payload.code, 'label_pending', why)
    assert.equal(n('/rest/v1/shipping_labels'), 0, why)
  }
})
