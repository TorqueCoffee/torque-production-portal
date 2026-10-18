// B0 gates G2-G3 (docs/TESTS.md): every order ships UPS Ground at the packed weight, and
// the endpoints refuse anything else. No network: fetch is stubbed. G1 is syntax.test.js.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { inlineScripts, loadFromIndex } = require('./helpers/index-html')

const UPS_ACCOUNT = '21db4cf80df74a2cb27fc20948862003'
const CA_UPS_ACCOUNT = '588f0f77b8c54b1da58732df6e91575c'
// Values built inside the vm sandbox carry that realm's prototypes; compare host copies.
const host = v => structuredClone(v)

// ── fetch stub, installed before the API modules load (they capture fetch at require) ──
let calls = [], respond = () => { throw new Error('unexpected fetch') }
async function stubFetch(url, opts = {}) {
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url: String(url), body })
  const out = respond(String(url), body)
  const status = out.status || 200
  return { ok: status < 400, status, json: async () => out.json, text: async () => out.text ?? JSON.stringify(out.json) }
}
globalThis.fetch = stubFetch
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
const OK_BODY = { address_to: ADDR, parcel: PARCEL, carrier: 'ups', weight_basis: 'packed' }
const LABEL_BODY = { ...OK_BODY, expected_amount: '16.43', order_id: 'gid://shopify/Order/1', order_name: '#8263', box_index: 1, box_count: 4 }
const rate = (token, amount, account = UPS_ACCOUNT) =>
  ({ object_id: `rate_${token}_${account.slice(0, 4)}`, amount: String(amount), currency: 'USD', zone: null, estimated_days: 1, carrier_account: account, servicelevel: { token, name: token } })
const MIXED_RATES = [
  rate('ups_ground_saver', 12.00),
  rate('usps_ground_advantage', 10.95, 'usps_acct'),
  rate('ups_ground', 15.00, CA_UPS_ACCOUNT),
  rate('ups_ground', 16.43)
]
const shippoOk = (rates = MIXED_RATES) => (url) => {
  if (url.endsWith('/shipments/')) return { json: { rates, messages: [] } }
  if (url.endsWith('/transactions/')) return { json: { status: 'SUCCESS', tracking_number: '1Z29G1830300998096', tracking_url_provider: 'https://ups/t', label_url: 'https://shippo-delivery.s3.amazonaws.com/x.pdf', object_id: 'txn_1', test: false } }
  if (url.includes('/rest/v1/shipping_labels')) return { status: 201, text: '' }
  throw new Error('unexpected ' + url)
}

// ── G2 weight resolution (R10 title first, R3 xPods/250 g as 12 oz) ──────────────────────
test('G2: weight comes from the title first, then grams', () => {
  assert.equal(resolveWeightLb({ title: 'La Mora - Francisca Cubillo, Costa Rica', variant_title: '5lb', grams: 340 }), 5)   // grams wrong in Shopify
  assert.equal(resolveWeightLb({ title: 'X', variant_title: '2lb', grams: 908 }), 2)
  assert.equal(resolveWeightLb({ title: 'X', variant_title: '12oz Coffee Bag', grams: 0 }), 0.75)
  assert.equal(resolveWeightLb({ title: 'X', variant_title: '12 oz bag / In Stock', grams: 340 }), 0.75)
  assert.equal(resolveWeightLb({ title: 'Cocoa Drops xBloom Bulk 40lb Box', variant_title: 'Default Title', grams: 18144 }), 40)
  assert.equal(resolveWeightLb({ title: 'Gum Drop xPods', variant_title: '8 xPods', grams: 120 }), 0.75)
  assert.equal(resolveWeightLb({ title: 'Some Coffee', variant_title: '250g', grams: 250 }), 0.75)
  assert.equal(resolveWeightLb({ title: 'No size here', variant_title: 'Default Title', grams: 2270 }), 5)  // grams fallback, snapped
  assert.equal(resolveWeightLb({ title: 'Gift Card', variant_title: '$25', grams: 0 }), null)
})

// ── G2 client: UPS only, declared weight ────────────────────────────────────────────────
const C = loadFromIndex(['PACK_BOX', 'SHIP_UNIT_OVERRIDES', 'expandShipItems', 'packBoxes', 'packAggregate',
  'SHIP_CARRIER', 'SHIP_WEIGHT_BASIS', 'MEASURED_NET_LB', 'CARTON_TARE_LB', 'PACK_ALLOWANCE_LB',
  'declaredWeightLb', 'toShippoAddress', 'boxParcel'])
const box = (lines, label = '14x10x10') => ({ box_label: label, contents: lines.map(([unit, qty]) => ({ unit_weight_lb: unit, qty })) })

test('G2: the client sends UPS for every order and has no per-account routing left', () => {
  assert.equal(C.SHIP_CARRIER, 'ups')
  assert.equal(C.SHIP_WEIGHT_BASIS, 'packed')
  const src = inlineScripts().join('\n')
  assert.doesNotMatch(src, /carrierForOrder|UPS_COMPANIES|CARRIER_LABEL/)
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

test('G2: declared weight is null (no rate) for an unknown carton or bad contents', () => {
  assert.equal(C.declaredWeightLb(box([[5, 1]], '12x12x12')), null)
  assert.equal(C.declaredWeightLb(box([])), null)
  assert.equal(C.declaredWeightLb(box([[null, 2]])), null)
  assert.equal(C.declaredWeightLb(box([[5, 0]])), null)
  assert.equal(C.declaredWeightLb(null), null)
})

test('G2: real order shape -> packer -> declared weight (#6486, 21 x 5 lb)', () => {
  const items = [{ product_name: 'Cocoa Drop', variant_title: '5lb', qty: 21, sku: 'X', weight_lb: resolveWeightLb({ title: 'Cocoa Drop', variant_title: '5lb', grams: 2270 }) }]
  const pack = C.packBoxes(C.expandShipItems(items))
  assert.deepEqual(host(pack.boxes.map(b => b.weight_lb)), [20, 20, 20, 20, 20, 5])
  assert.deepEqual(host(pack.boxes.map(C.declaredWeightLb)), [22, 22, 22, 22, 22, 6])
  assert.deepEqual(host(C.boxParcel(pack.boxes[0])), { length: 14, width: 10, height: 10, weight: 22 })
})

test('G2: La Mora 5lb (340 g in Shopify) packs and declares as 5 lb bags', () => {
  const items = [{ product_name: 'La Mora', variant_title: '5lb', qty: 4, sku: null, weight_lb: resolveWeightLb({ title: 'La Mora - Francisca Cubillo, Costa Rica', variant_title: '5lb', grams: 340 }) }]
  const pack = C.packBoxes(C.expandShipItems(items))
  assert.deepEqual(host(pack.boxes.map(C.declaredWeightLb)), [22])
})

test('G2: TCCDS-40 ships as two 20 lb boxes declared at 21 lb', () => {
  const pack = C.packBoxes(C.expandShipItems([{ product_name: 'Cocoa Drops xBloom Bulk 40lb Box', variant_title: 'Default Title', qty: 1, sku: 'TCCDS-40', weight_lb: 40 }]))
  assert.deepEqual(host(pack.boxes.map(C.declaredWeightLb)), [21, 21])
})

test('G2: client address carries no email', () => {
  const a = C.toShippoAddress({ name: 'A', company: 'B', address1: '1 St', city: 'X', province_code: 'CA', zip: '92104', country_code: 'US', phone: '', email: 'a@b.c' })
  assert.equal('email' in a, false)
})

// ── G2 client flow: the payloads getRates / buyLabels / fulfillOrder actually send ─────
function shipFlow() {
  const pack = C.packBoxes(C.expandShipItems([{ product_name: 'Cocoa Drop', variant_title: '5lb', qty: 5, sku: 'X', weight_lb: 5 }]))
  const shipState = {
    order: { order_id: 'gid://shopify/Order/1', order_name: '#9001', shipping_address: { name: 'Pete', company: 'Best Coffee', address1: '1 Main St', city: 'Goleta', province_code: 'CA', zip: '93117', country_code: 'US', phone: '' } },
    pack, phase: 'packed',
    boxes: pack.boxes.map(box => ({ box, rate: null, rateError: null, rateAlt: null, label: null, labelError: null, status: 'packed' }))
  }
  const F = loadFromIndex(['PACK_BOX', 'SHIP_CARRIER', 'SHIP_WEIGHT_BASIS', 'MEASURED_NET_LB', 'CARTON_TARE_LB', 'PACK_ALLOWANCE_LB',
    'escHtml', 'declaredWeightLb', 'toShippoAddress', 'boxParcel', 'getRates', 'buyLabels', 'fulfillOrder'],
  { shipState, shipPending: {}, renderShip() {}, confirm: () => true, alert() {}, fetch: stubFetch })
  return { F, shipState }
}
const apiCalls = (path) => calls.filter(c => c.url.startsWith(path))

test('G2: rate and label requests carry UPS, packed basis, the same declared weight, and the confirmed price', async () => {
  const { F, shipState } = shipFlow()
  reset((url) => url.startsWith('/api/shippo-label?action=rate')
    ? { json: { ok: true, amount: '16.43', currency: 'USD', zone: null } }
    : { json: { ok: true, tracking_number: '1Z29G1830300998096', cost: '16.43', currency: 'USD' } })
  await F.getRates()
  await F.buyLabels()
  const rates = apiCalls('/api/shippo-label?action=rate'), labels = apiCalls('/api/shippo-label?action=label')
  assert.equal(rates.length, 2); assert.equal(labels.length, 2)               // boxes [20, 5]
  assert.deepEqual(rates.map(c => c.body.parcel.weight), [22, 6])
  assert.deepEqual(labels.map(c => c.body.parcel.weight), [22, 6])
  for (const c of [...rates, ...labels]) { assert.equal(c.body.carrier, 'ups'); assert.equal(c.body.weight_basis, 'packed') }
  assert.deepEqual(labels.map(c => c.body.expected_amount), ['16.43', '16.43'])
  assert.equal(shipState.phase, 'bought')
})

test('G2: a price change buys nothing and sends the box back to the rate step', async () => {
  const { F, shipState } = shipFlow()
  reset((url) => url.startsWith('/api/shippo-label?action=rate')
    ? { json: { ok: true, amount: '16.43', currency: 'USD' } }
    : { status: 409, json: { error: 'Price changed', quoted: '16.43', amount: '18.10' } })
  await F.getRates()
  await F.buyLabels()
  const b = shipState.boxes[0]
  assert.equal(b.label, null)
  assert.equal(b.rate, null)
  assert.match(b.rateError, /Price changed: confirmed \$16\.43, UPS now charges \$18\.10/)
})

test('G2: re-rating skips boxes that already have a label', async () => {
  const { F, shipState } = shipFlow()
  shipState.boxes[0].label = { tracking_number: '1Z29G1830300998096', recovered: true }
  reset(() => ({ json: { ok: true, amount: '9.00', currency: 'USD' } }))
  await F.getRates()
  assert.equal(apiCalls('/api/shippo-label?action=rate').length, 1)
})

test('G2: no-rate error shows Shippo\'s reason, escaped', async () => {
  const { F, shipState } = shipFlow()
  reset(() => ({ status: 422, json: { error: 'No UPS Ground rate returned', rates: [], messages: [{ text: 'Invalid ZIP <b>93117</b>' }] } }))
  await F.getRates()
  assert.equal(shipState.boxes[0].rateError, 'No UPS Ground rate returned — Invalid ZIP &lt;b&gt;93117&lt;/b&gt;')
})

test('G2: fulfill sends tracking only; the server decides the company', async () => {
  const { F, shipState } = shipFlow()
  shipState.boxes.forEach(b => { b.label = { tracking_number: '1Z29G1830300998096', tracking_url: 'https://ups/t' } })
  reset(() => ({ json: { ok: true, notified: true } }))
  await F.fulfillOrder()
  const body = apiCalls('/api/shopify-fulfill')[0].body
  assert.equal('company' in body, false)
  assert.equal(body.tracking.length, 2)
})

// ── G3 server: shippo-label ─────────────────────────────────────────────────────────────
test('G3: rate pins the US UPS account, real origin phone, phone fallback, no email, declared weight', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, address_to: { ...ADDR, email: 'pete@best.coffee', metadata: 'x', __proto__: { y: 1 } } } })
  assert.equal(r.code, 200)
  assert.equal(calls.length, 1)
  const sent = calls[0].body
  assert.deepEqual(sent.carrier_accounts, [UPS_ACCOUNT])
  assert.equal(sent.address_from.phone, '6192305400')
  assert.equal(sent.address_from.zip, '92104')
  assert.deepEqual(Object.keys(sent.address_to).sort(), ['city', 'company', 'country', 'name', 'phone', 'state', 'street1', 'street2', 'zip'])
  assert.equal(sent.address_to.phone, '6192305400')
  assert.equal(sent.parcels[0].weight, '22')
  assert.equal(r.payload.service, 'ups_ground')
  assert.equal(r.payload.amount, '16.43')        // the US-account ups_ground, not Saver/USPS/CA
})

test('G3: recipient phone on the order is kept; missing carrier defaults to UPS', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, carrier: undefined, address_to: { ...ADDR, phone: '8055550100' } } })
  assert.equal(r.code, 200)
  assert.equal(calls[0].body.address_to.phone, '8055550100')
})

test('G3: refused before any Shippo call: wrong carrier, stale page, bad action, bad parcel, bad address, P.O. box', async () => {
  reset(shippoOk())
  const cases = [
    [{ action: 'label' }, { ...LABEL_BODY, carrier: 'usps' }],
    [{ action: 'label' }, { ...LABEL_BODY, carrier: 'USPS' }],
    [{ action: 'label' }, { ...LABEL_BODY, carrier: 'fedex' }],
    [{ action: 'label' }, { ...LABEL_BODY, weight_basis: undefined }],           // page from before ADR 0020
    [{ action: 'label' }, { ...LABEL_BODY, parcel: { ...PARCEL, weight: 20.5 } }],
    [{ action: 'label' }, { ...LABEL_BODY, parcel: { ...PARCEL, weight: '22' } }],
    [{ action: 'label' }, { ...LABEL_BODY, parcel: { ...PARCEL, weight: true } }],
    [{ action: 'label' }, { ...LABEL_BODY, parcel: { ...PARCEL, weight: 0 } }],
    [{ action: 'label' }, { ...LABEL_BODY, parcel: { ...PARCEL, length: '14' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: 'a string' }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'P.O. Box 123' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street2: 'PO BOX 9' } }],
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: undefined }],
    [{ action: 'Rates' }, OK_BODY],
    [{ action: ['rate', 'rate'] }, OK_BODY],
    [{ action: 'void' }, OK_BODY]
  ]
  for (const [query, body] of cases) {
    const r = await call(shippoLabel, { query, body })
    assert.equal(r.code, 400, JSON.stringify({ query, body }))
    assert.doesNotMatch(r.payload.error, /usps|fedex|a string/i)   // no echo of caller input
  }
  assert.equal(calls.length, 0)
})

test('G3: no US-account ups_ground rate -> 422, nothing bought', async () => {
  reset(shippoOk([rate('ups_ground_saver', 12), rate('ups_ground', 15, CA_UPS_ACCOUNT), rate('usps_ground_advantage', 10.95, 'usps_acct')]))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 422)
  assert.equal(r.payload.error, 'No UPS Ground rate returned')
  assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
})

test('G3: price above the confirmed one -> 409 with the new price, nothing bought', async () => {
  reset(shippoOk([rate('ups_ground', '18.10')]))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 409)
  assert.deepEqual(r.payload, { error: 'Price changed', quoted: '16.43', amount: '18.10', currency: 'USD' })
  assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
})

test('G3: same or lower price buys', async () => {
  reset(shippoOk([rate('ups_ground', '16.10')]))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 200)
  assert.equal(r.payload.cost, '16.10')
})

test('G3: label buys the chosen rate and logs a ups_ground cost row at the declared weight', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
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
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
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

test('G3: fulfill writes company UPS whatever the page sends', async () => {
  for (const company of [undefined, 'USPS']) {
    reset(shopifyOk())
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: TRACKING, company, notifyCustomer: true } })
    assert.equal(r.code, 200)
    const m = calls.find(c => c.body && c.body.variables && c.body.variables.fulfillment)
    assert.equal(m.body.variables.fulfillment.trackingInfo.company, 'UPS')
    assert.equal(m.body.variables.fulfillment.notifyCustomer, true)
  }
})

test('G3: fulfill refuses a non-UPS tracking number (a USPS label bought before the switch)', async () => {
  reset(shopifyOk())
  for (const number of ['9400111899223197428490', '1Z29G18303', '1Z29G1830300998096X']) {
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: [...TRACKING, { number, url: null }] } })
    assert.equal(r.code, 400)
    assert.match(r.payload.error, /by hand in Shopify/)
  }
  assert.equal(calls.length, 0)
})
