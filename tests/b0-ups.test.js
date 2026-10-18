// B0 gates G1-G3 (docs/TESTS.md): every B2B order ships UPS Ground, declared weight
// includes tare, and the endpoints refuse anything else. No network: fetch is stubbed.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const path = require('path')
const vm = require('vm')
const { inlineScripts, loadFromIndex } = require('./helpers/index-html')

const ROOT = path.join(__dirname, '..')
const UPS_ACCOUNT = '21db4cf80df74a2cb27fc20948862003'
const CA_UPS_ACCOUNT = '588f0f77b8c54b1da58732df6e91575c'

// ── fetch stub, installed before the API modules load (they capture fetch at require) ──
let calls = [], respond = () => { throw new Error('unexpected fetch') }
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url: String(url), body })
  const out = respond(String(url), body)
  return { ok: out.status ? out.status < 400 : true, status: out.status || 200, json: async () => out.json, text: async () => out.text ?? JSON.stringify(out.json) }
}
function reset(fn) { calls = []; respond = fn }

Object.assign(process.env, {
  SHIPPO_TOKEN: 'shippo_test_stub', SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE_HANDLE: 'store'
})
const shippoLabel = require('../api/shippo-label.js')
const shopifyFulfill = require('../api/shopify-fulfill.js')
const { resolveWeightLb } = require('../api/shopify-token.js')

async function call(handler, { method = 'POST', query = {}, body } = {}) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this }, end() { return this } }
  await handler({ method, query, body }, res)
  return res
}

const ADDR = { name: 'Pete Smith', company: 'Best Coffee', street1: '1 Main St', street2: '', city: 'Goleta', state: 'CA', zip: '93117', country: 'US', phone: '' }
const PARCEL = { length: 14, width: 10, height: 10, weight: 22 }
const rate = (token, amount, account = UPS_ACCOUNT, id = `rate_${token}_${account.slice(0, 4)}`) =>
  ({ object_id: id, amount: String(amount), currency: 'USD', zone: null, estimated_days: 1, carrier_account: account, servicelevel: { token, name: token } })
const MIXED_RATES = [
  rate('ups_ground_saver', 12.00),
  rate('usps_ground_advantage', 10.95, 'usps_acct'),
  rate('ups_ground', 15.00, CA_UPS_ACCOUNT),
  rate('ups_ground', 16.43)
]

// ── G1 syntax ──────────────────────────────────────────────────────────────────────────
test('G1: every inline <script> in index.html parses', () => {
  const scripts = inlineScripts()
  assert.ok(scripts.length >= 2)
  scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `index.html#script${i}` })))
})

test('G1: api/*.js pass node --check', () => {
  for (const f of ['shippo-label.js', 'shopify-fulfill.js', 'shopify-token.js', 'ship-doc.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'api', f)])
  }
})

// ── G2 client: UPS only, declared weight ────────────────────────────────────────────────
const C = loadFromIndex(['PACK_BOX', 'SHIP_UNIT_OVERRIDES', 'expandShipItems', 'packBoxes', 'packAggregate',
  'SHIP_CARRIER', 'SHIP_CARRIER_LABEL', 'MEASURED_NET_LB', 'CARTON_TARE_LB', 'PACK_ALLOWANCE_LB',
  'declaredWeightLb', 'toShippoAddress', 'boxParcel'])
// Values built inside the vm sandbox have that realm's Array/Object prototypes; compare plain copies.
const plain = v => JSON.parse(JSON.stringify(v))
const box = (lines, label = '14x10x10') => ({ box_label: label, contents: lines.map(([unit, qty]) => ({ unit_weight_lb: unit, qty })) })

test('G2: the client sends UPS for every order and has no per-account routing left', () => {
  assert.equal(C.SHIP_CARRIER, 'ups')
  assert.equal(C.SHIP_CARRIER_LABEL, 'UPS')
  const src = inlineScripts().join('\n')
  assert.doesNotMatch(src, /carrierForOrder|UPS_COMPANIES|CARRIER_LABEL\[/)
  assert.doesNotMatch(src, /['"]usps['"]/)
})

test('G2: declared weight = ceil(measured net + 0.83 tare + 0.05)', () => {
  assert.equal(C.declaredWeightLb(box([[5, 4]])), 22)                       // 20.28 + 0.88 = 21.16
  assert.equal(C.declaredWeightLb(box([[5, 3]])), 17)                       // 15.21 + 0.88 = 16.09
  assert.equal(C.declaredWeightLb(box([[5, 1]])), 6)                        // 5.07 + 0.88 = 5.95
  assert.equal(C.declaredWeightLb(box([[2, 10]])), 22)                      // 20.30 + 0.88 = 21.18
  assert.equal(C.declaredWeightLb(box([[0.75, 26]])), 21)                   // 19.50 + 0.88 = 20.38
  assert.equal(C.declaredWeightLb(box([[5, 2], [2, 4], [0.75, 2]])), 21)    // 19.76 + 0.88 = 20.64
  assert.equal(C.declaredWeightLb(box([[20, 1]])), 21)                      // TCCDS-40 half: nominal 20
  assert.equal(C.declaredWeightLb(box([[1.12, 1]])), 2)                     // exactly 2.00: no float push to 3
})

test('G2: declared weight refuses to guess', () => {
  assert.equal(C.declaredWeightLb(box([[5, 1]], '12x12x12')), null)         // no tare for that carton
  assert.equal(C.declaredWeightLb(box([])), null)
  assert.equal(C.declaredWeightLb(box([[null, 2]])), null)
  assert.equal(C.declaredWeightLb(box([[5, 0]])), null)
})

test('G2: real order shape -> packer -> declared weight (#6486, 21 x 5 lb)', () => {
  const items = [{ product_name: 'Cocoa Drop', variant_title: '5lb', qty: 21, sku: 'X', weight_lb: resolveWeightLb({ grams: 2270, variant_title: '5lb' }) }]
  const pack = C.packBoxes(C.expandShipItems(items))
  assert.deepEqual(plain(pack.boxes.map(b => b.weight_lb)), [20, 20, 20, 20, 20, 5])
  assert.deepEqual(plain(pack.boxes.map(C.declaredWeightLb)), [22, 22, 22, 22, 22, 6])
  assert.deepEqual(plain(C.boxParcel(pack.boxes[0])), { length: 14, width: 10, height: 10, weight: 22 })
})

test('G2: TCCDS-40 ships as two 20 lb boxes declared at 21 lb', () => {
  const pack = C.packBoxes(C.expandShipItems([{ product_name: 'Cocoa Drops xBloom Bulk 40lb Box', variant_title: 'Default Title', qty: 1, sku: 'TCCDS-40', weight_lb: null }]))
  assert.deepEqual(plain(pack.boxes.map(C.declaredWeightLb)), [21, 21])
})

test('G2: client address carries no email', () => {
  const a = C.toShippoAddress({ name: 'A', company: 'B', address1: '1 St', city: 'X', province_code: 'CA', zip: '92104', country_code: 'US', phone: '', email: 'a@b.c' })
  assert.equal('email' in a, false)
})

// ── G3 server: shippo-label ─────────────────────────────────────────────────────────────
const shippoOk = (rates = MIXED_RATES) => (url) => {
  if (url.endsWith('/shipments/')) return { json: { rates, messages: [] } }
  if (url.endsWith('/transactions/')) return { json: { status: 'SUCCESS', tracking_number: '1Z29G1830300998096', tracking_url_provider: 'https://ups/t', label_url: 'https://shippo-delivery.s3.amazonaws.com/x.pdf', object_id: 'txn_1', test: false } }
  if (url.includes('/rest/v1/shipping_labels')) return { status: 201, text: '' }
  throw new Error('unexpected ' + url)
}

test('G3: rate pins the US UPS account, real origin phone, phone fallback, no email, declared weight', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { address_to: { ...ADDR, email: 'pete@best.coffee' }, parcel: PARCEL, carrier: 'ups' } })
  assert.equal(r.code, 200)
  assert.equal(calls.length, 1)
  const sent = calls[0].body
  assert.deepEqual(sent.carrier_accounts, [UPS_ACCOUNT])
  assert.equal(sent.address_from.phone, '6192305400')
  assert.equal(sent.address_from.zip, '92104')
  assert.equal(sent.address_to.phone, '6192305400')
  assert.equal('email' in sent.address_to, false)
  assert.equal(sent.parcels[0].weight, '22')
  assert.equal(r.payload.service, 'ups_ground')
  assert.equal(r.payload.amount, '16.43')        // the US-account ups_ground, not Saver/USPS/CA
  assert.equal(r.payload.is_cubic, false)
})

test('G3: recipient phone on the order is kept', async () => {
  reset(shippoOk())
  await call(shippoLabel, { query: { action: 'rate' }, body: { address_to: { ...ADDR, phone: '8055550100' }, parcel: PARCEL } })
  assert.equal(calls[0].body.address_to.phone, '8055550100')
})

test('G3: missing carrier defaults to UPS', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { address_to: ADDR, parcel: PARCEL } })
  assert.equal(r.code, 200)
  assert.equal(r.payload.service, 'ups_ground')
})

test('G3: carrier usps is refused before any Shippo call', async () => {
  reset(shippoOk())
  for (const carrier of ['usps', 'USPS', 'fedex']) {
    const r = await call(shippoLabel, { query: { action: 'label' }, body: { address_to: ADDR, parcel: PARCEL, carrier } })
    assert.equal(r.code, 400)
    assert.match(r.payload.error, /Only UPS Ground/)
  }
  assert.equal(calls.length, 0)
})

test('G3: a parcel without a usable weight is refused before any Shippo call', async () => {
  reset(shippoOk())
  for (const weight of [null, 0, 'abc', undefined]) {
    const r = await call(shippoLabel, { query: { action: 'label' }, body: { address_to: ADDR, parcel: { ...PARCEL, weight } } })
    assert.equal(r.code, 400)
  }
  assert.equal(calls.length, 0)
})

test('G3: no US-account ups_ground rate -> 422, nothing bought', async () => {
  reset(shippoOk([rate('ups_ground_saver', 12), rate('ups_ground', 15, CA_UPS_ACCOUNT), rate('usps_ground_advantage', 10.95, 'usps_acct')]))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: { address_to: ADDR, parcel: PARCEL } })
  assert.equal(r.code, 422)
  assert.equal(r.payload.error, 'No UPS Ground rate returned')
  assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
})

test('G3: label buys the chosen rate and logs a ups_ground cost row at the declared weight', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'label' }, body: { address_to: ADDR, parcel: PARCEL, order_id: 'gid://shopify/Order/1', order_name: '#8263', box_index: 1, box_count: 4 } })
  assert.equal(r.code, 200)
  const txn = calls.find(c => c.url.endsWith('/transactions/'))
  assert.equal(txn.body.rate, 'rate_ups_ground_21db')
  assert.equal(txn.body.label_file_type, 'PDF_4x6')
  const row = calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body
  assert.equal(row.service, 'ups_ground')
  assert.equal(row.is_cubic, false)
  assert.equal(row.weight_lb, 22)
  assert.equal(row.cost, '16.43')
  assert.equal(row.dest_zip, '93117')
  assert.equal(r.payload.cost_logged, true)
  assert.equal(r.payload.test, false)
})

test('G3: failed purchase -> 502 and no cost row', async () => {
  reset((url) => url.endsWith('/transactions/') ? { json: { status: 'ERROR', messages: [{ text: 'bad' }] } } : shippoOk()(url))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: { address_to: ADDR, parcel: PARCEL } })
  assert.equal(r.code, 502)
  assert.equal(calls.filter(c => c.url.includes('/rest/v1/')).length, 0)
})

// ── G3 server: shopify-fulfill ──────────────────────────────────────────────────────────
const shopifyOk = () => (url, body) => {
  if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok' } }
  if (url.includes('/graphql.json') && /fulfillmentOrders/.test(body.query)) return { json: { data: { order: { id: 'gid://shopify/Order/1', name: '#8263', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/9', status: 'OPEN' } }] } } } } }
  if (url.includes('/graphql.json')) return { json: { data: { fulfillmentCreate: { fulfillment: { id: 'f1', status: 'SUCCESS', trackingInfo: body.variables.fulfillment.trackingInfo }, userErrors: [] } } } }
  if (url.includes('/rpc/mark_ship_labels_fulfilled')) return { text: '4' }
  throw new Error('unexpected ' + url)
}
const TRACKING = [{ number: '1Z29G1830300998096', url: 'https://ups/t' }]

test('G3: fulfill writes company UPS when none is sent', async () => {
  reset(shopifyOk())
  const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: TRACKING, notifyCustomer: true } })
  assert.equal(r.code, 200)
  const m = calls.find(c => c.body && c.body.variables && c.body.variables.fulfillment)
  assert.equal(m.body.variables.fulfillment.trackingInfo.company, 'UPS')
  assert.equal(m.body.variables.fulfillment.notifyCustomer, true)
})

test('G3: fulfill refuses any company but UPS, before any Shopify call', async () => {
  reset(shopifyOk())
  for (const company of ['USPS', 'ups', 'FedEx']) {
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: TRACKING, company } })
    assert.equal(r.code, 400)
  }
  assert.equal(calls.length, 0)
})
