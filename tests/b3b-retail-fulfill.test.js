// B3b gate F1 (docs/TESTS.md): api/shopify-fulfill.js with kind 'retail'. No network: fetch is
// stubbed for Shopify GraphQL and the Supabase RPCs, so nothing is fulfilled and no email goes.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')

const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
let calls = [], respond = () => { throw new Error('unexpected fetch') }
globalThis.fetch = async (url, opts = {}) => {
  url = String(url)
  const headers = opts.headers || {}
  if (url.endsWith('/auth/v1/user')) {
    const ok = headers.Authorization === `Bearer ${USER_TOKEN}`
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'u1', app_metadata: { portal_staff: true } } : {}), text: async () => '' }
  }
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url, body, headers })
  const out = respond(url, body, headers)
  if (out.throw) { const e = new Error(out.throw); if (out.name) e.name = out.name; throw e }
  const status = out.status || 200
  return { ok: status < 400, status, json: async () => out.json, text: async () => JSON.stringify(out.json) }
}
Object.assign(process.env, {
  SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_STORE_HANDLE: 'store', PORTAL_AUTH_ENFORCE: '1'
})
const shopifyFulfill = require('../api/shopify-fulfill.js')
const { dropToken } = require('../api/_shopify.js')
const RAW = require('./fixtures/retail-orders.json').orders

const OID = 'gid://shopify/Order/8333'
// A fixture order as Shopify's retail read returns it, open again (the fixtures are past orders).
const retailNode = (name, over = {}) => ({ ...RAW.find(x => x.name === name), id: OID, displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: { name: 'Pat Doe', address1: '1 Main St', city: 'Town', ...RAW.find(x => x.name === name).shippingAddress }, ...over })
// #8333 = 2 x 12 oz -> one 12x8x6 at 2 lb.
const LABEL = { order_id: OID, order_name: '#8333', box_index: 1, box_count: 1, tracking_number: '1Z999AA10123456784', status: 'purchased', channel: 'retail', weight_lb: 2, held_back_at: null }
const OPEN = { id: OID, name: '#8333', email: 'pat@example.com', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN' } }] } }
const FULFILLED = { ...OPEN, displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/1', status: 'CLOSED' } }] } }

// The happy path. `shopify` is the order the fulfillment read returns (mutable: a create
// flips it to fulfilled, as Shopify does); `rows` the label rows; `retail` the retail read node.
function world({ shopify = OPEN, rows = [LABEL], retail = retailNode('#8333'), labelsReply, retailReply, marked = 1 } = {}) {
  const state = { shopify }
  const fn = (url, body) => {
    if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok', scope: 'read_orders', expires_in: 86399 } }
    if (url.includes('/graphql.json')) {
      if (body.query.includes('fulfillmentCreate')) {
        state.shopify = FULFILLED
        return { json: { data: { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', trackingInfo: [] }, userErrors: [] } } } }
      }
      if (body.query.includes('first: 50')) return { json: { data: { order: state.shopify } } }       // the fulfill step's own read
      return retailReply ? retailReply() : { json: { data: { order: retail } } }                      // fetchRetailOrder
    }
    if (url.includes('/rpc/ship_labels_for_order')) return labelsReply ? labelsReply() : { json: rows }
    if (url.includes('/rpc/mark_ship_labels_fulfilled')) return { json: marked }
    throw new Error('unexpected ' + url)
  }
  fn.state = state
  return fn
}
function reset(fn) { dropToken(); calls = []; respond = fn }
async function fulfill(body, headers = { authorization: `Bearer ${USER_TOKEN}` }) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this } }
  await shopifyFulfill({ method: 'POST', body, headers, url: '/api/shopify-fulfill' }, res)
  return res
}
const RETAIL = { order_id: OID, kind: 'retail' }
const creates = () => calls.filter(c => c.body && c.body.query && c.body.query.includes('fulfillmentCreate'))
const rpc = name => calls.filter(c => c.url.includes('/rpc/' + name))

test('F1: a retail fulfill takes its tracking from the DB, ignores the body, creates once and says emailed', async () => {
  reset(world())
  const r = await fulfill({ ...RETAIL, tracking: [{ number: '1ZFROMTHEPAGE00000' }], company: 'FedEx' })
  assert.equal(r.code, 200, JSON.stringify(r.payload))
  assert.equal(r.payload.emailed, true)
  assert.equal(r.payload.notified, true)
  assert.equal(creates().length, 1)
  const f = creates()[0].body.variables.fulfillment
  assert.deepEqual(f.trackingInfo, { company: 'UPS', numbers: ['1Z999AA10123456784'] })
  assert.equal(f.notifyCustomer, true)
  assert.deepEqual(f.lineItemsByFulfillmentOrder, [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/1' }])
  assert.equal(rpc('mark_ship_labels_fulfilled').length, 1)
  assert.equal(rpc('mark_ship_labels_fulfilled')[0].body.p_order_id, OID)
  // The label record was read as the signed-in user.
  assert.equal(rpc('ship_labels_for_order')[0].headers.Authorization, `Bearer ${USER_TOKEN}`)
  // An order that is fully open with a label bought passes the list rules (not NOT_UNFULFILLED).
  assert.ok(calls.some(c => c.url.includes('/graphql.json') && !c.body.query.includes('first: 50') && !c.body.query.includes('fulfillmentCreate')))
  // The fulfill step's own read asks for the order's email, which `emailed` is built from.
  assert.match(calls.find(c => c.url.includes('/graphql.json') && c.body.query.includes('first: 50')).body.query, /\bemail\b/)
})

test('F1: an order with no email is fulfilled but emailed is false; notifyCustomer false never says emailed', async () => {
  reset(world({ shopify: { ...OPEN, email: null } }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 200)
  assert.equal(r.payload.emailed, false)
  assert.equal(creates().length, 1)
  reset(world())
  r = await fulfill({ ...RETAIL, notifyCustomer: false })
  assert.equal(r.code, 200)
  assert.equal(r.payload.emailed, false)
  assert.equal(creates()[0].body.variables.fulfillment.notifyCustomer, false)
})

test('F1: no live retail label, two live labels, a voided-only or a B2B-channel row: 409 labels, nothing created', async () => {
  const cases = [
    ['none', [], /No live retail label/],
    ['two', [LABEL, { ...LABEL, tracking_number: '1Z999AA10123456785' }], /2 live labels on record\. Tell Andy/],
    ['voided only', [{ ...LABEL, status: 'voided' }], /No live retail label/],
    ['fulfilled only', [{ ...LABEL, status: 'fulfilled' }], /No live retail label/],
    ['b2b channel', [{ ...LABEL, channel: 'b2b' }], /No live retail label/],
    ['box 2 of 2', [{ ...LABEL, box_index: 2, box_count: 2 }], /not a single carton/]
  ]
  for (const [why, rows, msg] of cases) {
    reset(world({ rows }))
    const r = await fulfill(RETAIL)
    assert.equal(r.code, 409, why)
    assert.equal(r.payload.code, 'labels', why)
    assert.match(r.payload.error, msg, why)
    assert.equal(creates().length, 0, why)
  }
  // A voided row beside the live one is ignored: it still fulfills.
  reset(world({ rows: [{ ...LABEL, status: 'voided', tracking_number: '1Z999AA10123456700' }, LABEL] }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 200)
  assert.deepEqual(creates()[0].body.variables.fulfillment.trackingInfo.numbers, ['1Z999AA10123456784'])
})

test('F1: a held-back label is refused with held_back, nothing created, nothing flipped', async () => {
  reset(world({ rows: [{ ...LABEL, held_back_at: '2026-10-20T17:00:00Z' }] }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'held_back')
  assert.match(r.payload.error, /held back\. Include it on the Pack screen first/)
  assert.equal(creates().length, 0)
  assert.equal(rpc('mark_ship_labels_fulfilled').length, 0)
})

test('F1: a label that is not a UPS number is refused (400) before the repack check, nothing created', async () => {
  reset(world({ rows: [{ ...LABEL, tracking_number: '9400111899223197428490' }] }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 400)
  assert.match(r.payload.error, /Not a UPS tracking number/)
  assert.equal(creates().length, 0)
  // The UPS check comes before the Shopify repack: a USPS label on a changed order reads as USPS.
  reset(world({ rows: [{ ...LABEL, tracking_number: '9400111899223197428490', weight_lb: 9 }] }))
  const r2 = await fulfill(RETAIL)
  assert.equal(r2.code, 400)
  assert.equal(calls.filter(c => c.url.includes('/graphql.json') && !c.body.query.includes('first: 50')).length, 0)
})

test('F1: the pack changed since the label (billed lb differs) is refused, nothing created', async () => {
  for (const [why, lb] of [['label heavier', 3], ['label lighter', 1], ['no weight on record', null]]) {
    reset(world({ rows: [{ ...LABEL, weight_lb: lb }] }))
    const r = await fulfill(RETAIL)
    assert.equal(r.code, 409, why)
    assert.equal(r.payload.code, 'pack_changed', why)
    assert.match(r.payload.error, /Nothing was fulfilled/, why)
    assert.equal(creates().length, 0, why)
  }
  // The order itself changed: a third bag (3 x 12 oz -> 3 lb) against a 2 lb label.
  const o = retailNode('#8333')
  reset(world({ retail: { ...o, lineItems: { ...o.lineItems, nodes: [{ ...o.lineItems.nodes[0], currentQuantity: 2 }, o.lineItems.nodes[1]] } } }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'pack_changed')
  assert.match(r.payload.error, /label 2 lb, now 3 lb/)
  assert.equal(creates().length, 0)
})

test('F1: an order that is no longer LIST, gone from Shopify, or unreadable is refused, nothing created', async () => {
  reset(world({ retail: retailNode('#8333', { displayFinancialStatus: 'REFUNDED' }) }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'not_listed')
  assert.equal(r.payload.class, 'REFUNDED')
  reset(world({ retail: retailNode('#8333', { displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }) }))
  r = await fulfill(RETAIL)
  assert.equal(r.payload.code, 'not_listed')
  assert.equal(r.payload.class, 'NOT_UNFULFILLED')

  reset(world({ retail: null }))
  r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'pack_changed')

  reset(world({ retailReply: () => ({ status: 502, json: { errors: [{ message: 'down' }] } }) }))
  r = await fulfill(RETAIL)
  assert.equal(r.code, 503)
  assert.match(r.payload.error, /nothing was fulfilled/)
  assert.equal(creates().length, 0)
})

test('F1: an order already fulfilled takes the old path: no create, no email, rows flipped', async () => {
  reset(world({ shopify: FULFILLED }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 200)
  assert.equal(r.payload.alreadyFulfilled, true)
  assert.equal(r.payload.emailed, false)
  assert.equal(r.payload.notified, false)
  assert.equal(creates().length, 0)
  assert.equal(rpc('mark_ship_labels_fulfilled').length, 1)
  assert.equal(rpc('ship_labels_for_order').length, 0)   // nothing to check on an order that is done
})

test('F1: the cancelled, not-done and only_if_fulfilled guards still run first for retail', async () => {
  reset(world({ shopify: { ...OPEN, cancelledAt: '2026-10-19T00:00:00Z' } }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /cancelled/)
  reset(world({ shopify: { ...OPEN, fulfillmentOrders: { edges: [{ node: { id: 'f', status: 'ON_HOLD' } }] } } }))
  r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /ON_HOLD/)
  // Clear on a gone order: open items mean nothing is created and the label record isn't even read.
  reset(world())
  r = await fulfill({ ...RETAIL, notifyCustomer: false, only_if_fulfilled: true })
  assert.equal(r.code, 409)
  assert.equal(creates().length, 0)
  assert.equal(rpc('ship_labels_for_order').length, 0)
  // ...and on a fulfilled one it flips the rows and sends nothing.
  reset(world({ shopify: FULFILLED }))
  r = await fulfill({ ...RETAIL, notifyCustomer: false, only_if_fulfilled: true })
  assert.equal(r.payload.alreadyFulfilled, true)
  assert.equal(creates().length, 0)
})

test('F1: Shopify unreadable or the order missing before the retail checks: nothing created', async () => {
  reset(world({ shopify: null }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 404)
  assert.equal(creates().length, 0)
})

test('F1: a lost response, then a retry, creates exactly one fulfillment and sends one email across both', async () => {
  const w = world()
  reset(w)
  const first = await fulfill(RETAIL)
  assert.equal(first.payload.emailed, true)
  // The page never saw that answer. It retries.
  const retry = await fulfill(RETAIL)
  assert.equal(retry.code, 200)
  assert.equal(retry.payload.alreadyFulfilled, true)
  assert.equal(retry.payload.emailed, false)
  assert.equal(creates().length, 1)
})

test('F1: the label record cannot be read (500, timeout, not an array): 503, nothing created', async () => {
  for (const [why, labelsReply] of [
    ['500', () => ({ status: 500, json: {} })],
    ['timeout', () => ({ throw: 'aborted', name: 'AbortError' })],
    ['not rows', () => ({ json: { message: 'nope' } })],
    ['refused', () => ({ status: 401, json: {} })]
  ]) {
    reset(world({ labelsReply }))
    const r = await fulfill(RETAIL)
    assert.equal(r.code, 503, why)
    assert.match(r.payload.error, /nothing was fulfilled/, why)
    assert.equal(creates().length, 0, why)
  }
})

test('F1: no kind (or any other kind) is the B2B path: tracking required from the body, no DB label read', async () => {
  reset(world())
  let r = await fulfill({ order_id: OID, tracking: [{ number: '1Z999AA10123456784' }] })
  assert.equal(r.code, 200)
  assert.equal(rpc('ship_labels_for_order').length, 0)
  assert.equal(creates().length, 1)
  assert.equal(r.payload.emailed, true)   // the same Shopify email, now reported
  reset(world())
  r = await fulfill({ order_id: OID })
  assert.equal(r.code, 400)
  assert.match(r.payload.error, /tracking\[\] required/)
  for (const kind of ['Retail', 'b2b', ' retail', true, ['retail']]) {
    reset(world())
    r = await fulfill({ order_id: OID, kind })
    assert.equal(r.code, 400, String(kind))      // not retail: B2B, so a body with no tracking is refused
    assert.equal(creates().length, 0)
  }
  reset(world())
  r = await fulfill({ kind: 'retail' })
  assert.equal(r.code, 400)
  assert.equal(creates().length, 0)
})
