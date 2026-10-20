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
  // A call that never answers, like a hung socket: it ends only when the caller's own timer aborts it.
  if (out.hang) return new Promise((_, rej) => opts.signal && opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }))
  if (out.throw) { const e = new Error(out.throw); if (out.name) e.name = out.name; throw e }
  const status = out.status || 200
  return { ok: status < 400, status, json: async () => out.json, text: async () => JSON.stringify(out.json) }
}
Object.assign(process.env, {
  SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SHIPPO_TOKEN: 'shippo_test_stub',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's', SHOPIFY_STORE_HANDLE: 'store', PORTAL_AUTH_ENFORCE: '1'
})
const shopifyFulfill = require('../api/shopify-fulfill.js')
const { dropToken } = require('../api/_shopify.js')
const RAW = require('./fixtures/retail-orders.json').orders

const OID = 'gid://shopify/Order/8333'
// A fixture order as Shopify's retail read returns it, open again (the fixtures are past orders).
const retailNode = (name, over = {}) => ({ ...RAW.find(x => x.name === name), id: OID, displayFulfillmentStatus: 'UNFULFILLED', shippingAddress: { name: 'Pat Doe', address1: '1 Main St', city: 'Town', ...RAW.find(x => x.name === name).shippingAddress }, ...over })
// #8333 = 2 x 12 oz -> one 12x8x6 at 2 lb.
const LABEL = { order_id: OID, order_name: '#8333', box_index: 1, box_count: 1, tracking_number: '1Z999AA10123456784', status: 'purchased', channel: 'retail', weight_lb: 2, held_back_at: null, dest_zip: '11418', shippo_object_id: 'a'.repeat(32) }
const OPEN = { id: OID, name: '#8333', email: 'pat@example.com', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN' } }] } }
const FULFILLED = { ...OPEN, displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/1', status: 'CLOSED' } }] } }

// The happy path. `shopify` is the order the fulfillment read returns (mutable: a create
// flips it to fulfilled, as Shopify does); `rows` the label rows; `retail` the retail read node.
function world({ shopify = OPEN, rows = [LABEL], retail = retailNode('#8333'), labelsReply, retailReply, marked = 1, claim, txn, createReply } = {}) {
  const state = { shopify, claimed: new Set() }
  const fn = (url, body) => {
    if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok', scope: 'read_orders', expires_in: 86399 } }
    if (url.includes('/graphql.json')) {
      if (body.query.includes('fulfillmentCreate')) {
        if (createReply) return createReply()
        state.shopify = FULFILLED
        return { json: { data: { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', trackingInfo: [] }, userErrors: [] } } } }
      }
      if (body.query.includes('first: 50')) return { json: { data: { order: state.shopify } } }       // the fulfill step's own read
      return retailReply ? retailReply() : { json: { data: { order: retail } } }                      // fetchRetailOrder
    }
    if (url.includes('/rpc/ship_labels_for_order')) return labelsReply ? labelsReply() : { json: rows }
    if (url.includes('/rpc/mark_ship_labels_fulfilled')) return typeof marked === 'function' ? marked() : { json: marked }
    if (url.includes('/rpc/claim_order_fulfill')) {
      if (claim) return claim(body)
      if (state.claimed.has(body.p_order_id)) return { json: false }
      state.claimed.add(body.p_order_id); return { json: true }
    }
    if (url.includes('/rpc/release_order_fulfill')) { const had = state.claimed.delete(body.p_order_id); return { json: had } }
    if (url.startsWith('https://api.goshippo.com/transactions/')) return txn ? txn() : { json: { object_id: 'a'.repeat(32), status: 'SUCCESS', tracking_number: '1Z999AA10123456784' } }
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
  assert.equal(rpc('claim_order_fulfill').length, 1)                                        // the order's lock was taken first and released
  assert.equal(rpc('release_order_fulfill').length, 1)
  assert.ok(calls.findIndex(c => c.url.includes('claim_order_fulfill')) < calls.findIndex(c => c.url.includes('/graphql.json')))
  // An order that is fully open with a label bought passes the list rules (not NOT_UNFULFILLED).
  assert.ok(calls.some(c => c.url.includes('/graphql.json') && !c.body.query.includes('first: 50') && !c.body.query.includes('fulfillmentCreate')))
  // The fulfill step's own read asks for the order's email, which `emailed` is built from.
  assert.match(calls.find(c => c.url.includes('/graphql.json') && c.body.query.includes('first: 50')).body.query, /\bemail\b/)
})

test('F1: an order with no email is fulfilled but emailed is false; a retail body can\'t turn the customer email off', async () => {
  reset(world({ shopify: { ...OPEN, email: null } }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 200)
  assert.equal(r.payload.emailed, false)
  assert.equal(creates().length, 1)
  reset(world())
  r = await fulfill({ ...RETAIL, notifyCustomer: false })
  assert.equal(r.code, 200)
  assert.equal(r.payload.emailed, true)                                       // forced on: a silent fulfill would also make the retry send nothing
  assert.equal(creates()[0].body.variables.fulfillment.notifyCustomer, true)
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
  // The UPS check comes before the Shopify repack and the Shippo check: a USPS label on a changed order reads as USPS.
  reset(world({ rows: [{ ...LABEL, tracking_number: '9400111899223197428490', weight_lb: 9 }] }))
  const r2 = await fulfill(RETAIL)
  assert.equal(r2.code, 400)
  assert.equal(calls.filter(c => c.url.includes('/graphql.json') && !c.body.query.includes('first: 50')).length, 0)
  assert.equal(calls.filter(c => c.url.includes('goshippo.com')).length, 0)
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

test('F1: no kind (or any other kind) and no live retail label is the B2B path: tracking from the body, no lock, no Shippo call', async () => {
  reset(world({ rows: [] }))
  let r = await fulfill({ order_id: OID, tracking: [{ number: '1Z999AA10123456784' }] })
  assert.equal(r.code, 200)
  assert.equal(rpc('claim_order_fulfill').length, 0)
  assert.equal(calls.filter(c => c.url.includes('goshippo.com')).length, 0)
  assert.equal(creates().length, 1)
  assert.equal(r.payload.emailed, true)   // the same Shopify email, now reported
  reset(world({ rows: [{ ...LABEL, channel: 'b2b' }] }))
  r = await fulfill({ order_id: OID, tracking: [{ number: '1Z999AA10123456784' }] })   // a B2B label row: still B2B
  assert.equal(r.code, 200)
  assert.equal(rpc('claim_order_fulfill').length, 0)
  reset(world({ rows: [] }))
  r = await fulfill({ order_id: OID })
  assert.equal(r.code, 400)
  assert.match(r.payload.error, /tracking\[\] required/)
  for (const kind of ['Retail', 'b2b', ' retail', true, ['retail']]) {
    reset(world({ rows: [] }))
    r = await fulfill({ order_id: OID, kind })
    assert.equal(r.code, 400, String(kind))      // not retail: B2B, so a body with no tracking is refused
    assert.equal(creates().length, 0)
  }
  reset(world())
  r = await fulfill({ kind: 'retail' })
  assert.equal(r.code, 400)
  assert.equal(creates().length, 0)
})

const released = () => rpc('release_order_fulfill').length
const claimed = () => rpc('claim_order_fulfill').length

test('F2: the order\'s lock is taken before anything is read and released on every path', async () => {
  const cases = [
    ['created', world(), 200],
    ['held back', world({ rows: [{ ...LABEL, held_back_at: 'x' }] }), 409],
    ['no label', world({ rows: [] }), 409],
    ['already fulfilled', world({ shopify: FULFILLED }), 200],
    ['cancelled', world({ shopify: { ...OPEN, cancelledAt: 'x' } }), 409],
    ['pack changed', world({ rows: [{ ...LABEL, weight_lb: 9 }] }), 409],
    ['shopify 502', world({ createReply: () => ({ json: { data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ message: 'no' }] } } } }) }), 502],
    ['shopify throws', world({ createReply: () => ({ throw: 'socket hang up' }) }), 500]
  ]
  for (const [why, w, code] of cases) {
    reset(w)
    const r = await fulfill(RETAIL)
    assert.equal(r.code, code, why)
    assert.equal(claimed(), 1, why)
    assert.equal(released(), 1, why)
    assert.ok(calls.findIndex(c => c.url.includes('claim_order_fulfill')) === 1 || calls[0].url.includes('claim_order_fulfill'), why)
    assert.equal(calls.at(-1).url.includes('release_order_fulfill'), true, `${why}: released last`)
  }
})

test('F2: a busy lock (another device fulfilling or voiding) is a 409 busy, with no Shopify read and nothing released', async () => {
  reset(world({ claim: () => ({ json: false }) }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'busy')
  assert.match(r.payload.error, /Another device is fulfilling or voiding this order/)
  assert.equal(calls.filter(c => c.url.includes('graphql') || c.url.includes('oauth')).length, 0)
  assert.equal(released(), 0)                                                  // not ours to release
  // The lock can't be taken (the SQL isn't applied, Supabase is down): 503, nothing read or created.
  for (const claim of [() => ({ status: 404, json: { message: 'function not found' } }), () => ({ status: 500, json: {} }), () => ({ throw: 'offline' })]) {
    reset(world({ claim }))
    const q = await fulfill(RETAIL)
    assert.equal(q.code, 503)
    assert.match(q.payload.error, /lock/)
    assert.equal(creates().length, 0)
    assert.equal(released(), 0)
  }
})

test('F2: two devices at once: one fulfills, the other is told busy; one create, one email', async () => {
  reset(world())
  const [a, b] = await Promise.all([fulfill(RETAIL), fulfill(RETAIL)])
  assert.deepEqual([a.code, b.code].sort(), [200, 409])
  assert.equal([a, b].find(r => r.code === 409).payload.code, 'busy')
  assert.equal(creates().length, 1)
  assert.equal(released(), 1)
  // And the loser's retry finds the order done: no second email.
  const c = await fulfill(RETAIL)
  assert.equal(c.payload.alreadyFulfilled, true)
  assert.equal(creates().length, 1)
})

test('F3: Shippo must confirm the label is live: a refunded, missing, mismatched or unreachable one is refused, nothing created', async () => {
  const cases = [
    ['refunded', () => ({ json: { status: 'REFUNDED', tracking_number: '1Z999AA10123456784' } }), 409, 'label_not_live'],
    ['refund pending', () => ({ json: { status: 'REFUNDPENDING', tracking_number: '1Z999AA10123456784' } }), 409, 'label_not_live'],
    ['other tracking number', () => ({ json: { status: 'SUCCESS', tracking_number: '1Z999AA10123456799' } }), 409, 'label_not_live'],
    ['no transaction at Shippo', () => ({ status: 404, json: {} }), 409, 'label_not_live'],
    ['Shippo down', () => ({ status: 500, json: {} }), 503, undefined],
    ['no answer', () => ({ throw: 'timeout' }), 503, undefined]
  ]
  for (const [why, txn, code, c] of cases) {
    reset(world({ txn }))
    const r = await fulfill(RETAIL)
    assert.equal(r.code, code, why)
    assert.equal(r.payload.code, c, why)
    assert.equal(creates().length, 0, why)
    assert.equal(rpc('mark_ship_labels_fulfilled').length, 0, why)
    assert.equal(released(), 1, why)
  }
  // A planted row (no 32-hex Shippo transaction) can't be confirmed.
  reset(world({ rows: [{ ...LABEL, shippo_object_id: null }] }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'label_not_live')
  assert.equal(creates().length, 0)
  assert.equal(calls.filter(c => c.url.includes('goshippo.com')).length, 0)
  // The check asks for that transaction with the Shippo token.
  reset(world())
  await fulfill(RETAIL)
  const ask = calls.find(c => c.url.includes('goshippo.com'))
  assert.equal(ask.url, `https://api.goshippo.com/transactions/${'a'.repeat(32)}`)
  assert.equal(ask.headers.Authorization, 'ShippoToken shippo_test_stub')
})

test('F3: with no Shippo token configured, nothing is fulfilled', async () => {
  const keep = process.env.SHIPPO_TOKEN
  delete process.env.SHIPPO_TOKEN
  try {
    reset(world())
    const r = await fulfill(RETAIL)
    assert.equal(r.code, 503)
    assert.equal(creates().length, 0)
  } finally { process.env.SHIPPO_TOKEN = keep }
})

test('F4: the ship-to ZIP the label was bought for must still be the order\'s; "92104-1234" equals "92104"', async () => {
  for (const [why, zip] of [['changed', '92104'], ['none on record', null], ['empty', '']]) {
    reset(world({ rows: [{ ...LABEL, dest_zip: zip }] }))
    const r = await fulfill(RETAIL)
    assert.equal(r.code, 409, why)
    assert.equal(r.payload.code, 'pack_changed', why)
    assert.match(r.payload.error, /ZIP/, why)
    assert.equal(creates().length, 0, why)
  }
  reset(world({ rows: [{ ...LABEL, dest_zip: '11418-0001' }] }))
  assert.equal((await fulfill(RETAIL)).code, 200)
  // The order's address changed in Shopify after the label.
  const o = retailNode('#8333')
  reset(world({ retail: { ...o, shippingAddress: { ...o.shippingAddress, zip: '10001' } } }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /label 11418, now 10001/)
})

test('F5: a request with no kind for an order that has a live retail label is retail: the DB number, the checks, the lock', async () => {
  reset(world())
  let r = await fulfill({ order_id: OID, tracking: [{ number: '1ZPLANTED0000000A0' }] })
  assert.equal(r.code, 200)
  assert.deepEqual(creates()[0].body.variables.fulfillment.trackingInfo.numbers, ['1Z999AA10123456784'])
  assert.equal(claimed(), 1)
  reset(world({ rows: [{ ...LABEL, held_back_at: 'x' }] }))
  r = await fulfill({ order_id: OID, tracking: [{ number: '1ZPLANTED0000000A0' }] })      // held back: the page's number can't get round it
  assert.equal(r.code, 409)
  assert.equal(r.payload.code, 'held_back')
  assert.equal(creates().length, 0)
  reset(world({ rows: [{ ...LABEL, weight_lb: 9 }] }))
  r = await fulfill({ order_id: OID, kind: 'b2b', tracking: [{ number: '1ZPLANTED0000000A0' }] })
  assert.equal(r.payload.code, 'pack_changed')
  assert.equal(creates().length, 0)
  // The label lookup failing leaves the B2B path as it was (it never needed it).
  reset(world({ labelsReply: () => ({ status: 500, json: {} }) }))
  r = await fulfill({ order_id: OID, tracking: [{ number: '1Z999AA10123456784' }] })
  assert.equal(r.code, 200)
  assert.equal(claimed(), 0)
})

test('F6: Shopify taking too long (read or create) is a 504 that says fulfilling again is safe; Supabase hanging after the create does not fail it', async () => {
  const abort = () => ({ throw: 'aborted', name: 'AbortError' })
  reset(world({ createReply: abort }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 504)
  assert.match(r.payload.error, /tap Fulfill again \(it never sends a second email\)/)
  assert.equal(released(), 1)
  // The fulfillment was created, then the label flip hangs: the fulfill still succeeds.
  reset(world({ marked: () => ({ throw: 'aborted', name: 'AbortError' }) }))
  r = await fulfill(RETAIL)
  assert.equal(r.code, 200)
  assert.equal(r.payload.cost_updated, false)
  assert.equal(creates().length, 1)
})

test('F7: a record without the new columns (the SQL is not applied) is a 503 that says so, not a blame on the order', async () => {
  const { held_back_at, ...old } = LABEL
  reset(world({ rows: [old] }))
  let r = await fulfill(RETAIL)
  assert.equal(r.code, 503)
  assert.match(r.payload.error, /db\/2026-10-20-label-held-back\.sql/)
  assert.equal(creates().length, 0)
  const { weight_lb, ...old2 } = LABEL
  reset(world({ rows: [old2] }))
  r = await fulfill(RETAIL)
  assert.equal(r.code, 503)
})

test('F8: the order id is read one way: "8333", a gid, and junk', async () => {
  reset(world())
  let r = await fulfill({ order_id: '8333', kind: 'retail' })
  assert.equal(r.code, 200)
  assert.equal(rpc('claim_order_fulfill')[0].body.p_order_id, OID)
  assert.equal(rpc('ship_labels_for_order')[0].body.p_order_id, OID)
  for (const bad of ['12/34', 'gid://shopify/Product/8333', 'abc', '8333; drop']) {
    reset(world())
    r = await fulfill({ order_id: bad, kind: 'retail' })
    assert.equal(r.code, 400, bad)
    assert.equal(creates().length, 0, bad)
    assert.equal(claimed(), 0, bad)
  }
})

test('F9: a Shopify call that never answers is cut off by its own timer (504), and the lock is released', async () => {
  const keep = shopifyFulfill.settings.shopifyTimeoutMs
  shopifyFulfill.settings.shopifyTimeoutMs = 20
  try {
    const w = world()
    reset((url, body, h) => (url.includes('/graphql.json') && body.query.includes('first: 50') ? { hang: true } : w(url, body, h)))
    let r = await fulfill(RETAIL)
    assert.equal(r.code, 504)
    assert.equal(creates().length, 0)
    assert.equal(released(), 1)
    // The create itself hangs: the fulfillment may exist, so the answer says to fulfill again.
    reset((url, body, h) => (url.includes('/graphql.json') && body.query.includes('fulfillmentCreate') ? { hang: true } : w(url, body, h)))
    r = await fulfill(RETAIL)
    assert.equal(r.code, 504)
    assert.match(r.payload.error, /Nothing may have been fulfilled/)
    assert.equal(released(), 1)
  } finally {
    shopifyFulfill.settings.shopifyTimeoutMs = keep
  }
})

test('F9: the Supabase helper cuts off a hung call (timeout) and reports why', async () => {
  const { rpc: callRpc } = require('../api/_supabase.js')
  reset(() => ({ hang: true }))
  const started = Date.now()
  const r = await callRpc('ship_labels_for_order', { p_order_id: OID }, USER_TOKEN, 25)
  assert.deepEqual([r.ok, r.why], [false, 'timeout'])
  assert.ok(Date.now() - started < 1000)
})

test('F4: a record with no dest_zip column at all (the SQL is not applied) is refused with the database-update message', async () => {
  const { dest_zip, ...noZipColumn } = LABEL
  reset(world({ rows: [noZipColumn] }))
  const r = await fulfill(RETAIL)
  assert.equal(r.code, 503)
  assert.match(r.payload.error, /label-held-back\.sql/)
  assert.equal(creates().length, 0)
})
