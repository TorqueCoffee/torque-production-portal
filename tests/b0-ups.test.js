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
// The API runs with the sign-in enforced (ADR 0023): every call() carries USER_TOKEN, and the
// Supabase Auth check (/auth/v1/user) is answered here and kept out of `calls`.
// JWT-shaped (the label endpoint reads exp); valid for an hour.
const USER_TOKEN = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.')
let calls = [], respond = () => { throw new Error('unexpected fetch') }
async function stubFetch(url, opts = {}) {
  const headers = opts.headers || {}
  if (String(url).endsWith('/auth/v1/user')) {
    const ok = headers.Authorization === `Bearer ${USER_TOKEN}`
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { id: 'u1', email: 'andy@example.com', app_metadata: { portal_staff: true } } : { msg: 'bad jwt' }) }
  }
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url: String(url), body, headers })
  const out = respond(String(url), body)
  const status = out.status || 200
  return { ok: status < 400, status, json: async () => out.json, text: async () => out.text ?? JSON.stringify(out.json) }
}
globalThis.fetch = stubFetch
function reset(fn) { calls = []; respond = fn }

Object.assign(process.env, {
  SHIPPO_TOKEN: 'shippo_test_stub', SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE_HANDLE: 'store',
  PORTAL_AUTH_ENFORCE: '1'
})
const shippoLabel = require('../api/shippo-label.js')
const shopifyFulfill = require('../api/shopify-fulfill.js')
const { resolveWeightLb, isShippableB2BLine } = require('../lib/ship-rules.js')
const fs = require('fs')
const path = require('path')

async function call(handler, { method = 'POST', query = {}, body, headers = { authorization: `Bearer ${USER_TOKEN}` } } = {}) {
  const res = { code: null, payload: null, setHeader() {}, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this }, end() { return this } }
  await handler({ method, query, body, headers, url: '/api/test' }, res)
  return res
}
// The page side of the same thing: apiFetch() reads the session from supabase-js.
const SB_AUTH = { getSession: async () => ({ data: { session: { access_token: USER_TOKEN } }, error: null }) }

const ADDR = { name: 'Pete Smith', company: 'Best Coffee', street1: '1 Main St', street2: '', city: 'Goleta', state: 'CA', zip: '93117', country: 'US', phone: '' }
const PARCEL = { length: 14, width: 10, height: 10, weight: 22 }
const OK_BODY = { address_to: ADDR, parcel: PARCEL, carrier: 'ups', weight_basis: 'packed' }
const PACK_SIG_1 = '14x10x10@22,14x10x10@22,14x10x10@22,14x10x10@22'   // ORDER_1 below, as the page packs it
const LABEL_BODY = { ...OK_BODY, expected_amount: '16.43', order_id: 'gid://shopify/Order/1', order_name: '#8263', box_index: 1, box_count: 4, pack_sig: PACK_SIG_1 }
const rate = (token, amount, account = UPS_ACCOUNT) =>
  ({ object_id: `rate_${token}_${account.slice(0, 4)}`, amount: String(amount), currency: 'USD', zone: null, estimated_days: 1, carrier_account: account, servicelevel: { token, name: token } })
const MIXED_RATES = [
  rate('ups_ground_saver', 12.00),
  rate('usps_ground_advantage', 10.95, 'usps_acct'),
  rate('ups_ground', 15.00, CA_UPS_ACCOUNT),
  rate('ups_ground', 16.43)
]
// The order behind LABEL_BODY as Shopify returns it; the label check repacks it (B2a):
// 16 x 5 lb = 4 boxes of 20 lb net, 22 lb declared.
const ORDER_1 = { id: 1, name: '#8263', cancelled_at: null, line_items: [{ vendor: 'Torque Coffees', title: 'Cocoa Drop', variant_title: '5lb', quantity: 16, grams: 2270, sku: 'CD5', fulfillment_status: null }] }
const shopifyOrder = (url, order = ORDER_1) => {
  if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok' } }
  if (url.includes('/orders/1.json')) return { json: { order } }
  return null
}
const shippoOk = (rates = MIXED_RATES, prior = [], order = ORDER_1) => (url) => {
  const shop = shopifyOrder(url, order)
  if (shop) return shop
  if (url.includes('/rpc/ship_labels_for_order')) return { json: prior }
  if (url.includes('/rpc/claim_label_box') || url.includes('/rpc/release_label_box')) return { json: true }
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

test('G2: a size that can\'t be read as one bag is held, never guessed', () => {
  const w = (variant_title, title = 'X', grams = 340) => resolveWeightLb({ title, variant_title, grams })
  assert.equal(w('Default Title', 'Bombon Colombia xBloom xPods Bulk 45lb Box', 0), 45)   // an explicit lb beats the xPods rule
  assert.equal(w('Whole Bean / 900g'), 1.984)                                             // grams in the title (R10), not Shopify's 340
  assert.equal(w('1kg'), 2.205)
  assert.equal(w('.5lb'), 0.5)
  for (const t of ['2 x 12oz', '12oz x 2', '12oz × 2', 'Case of 6 x 12oz', '12oz (2 pack)', '2-pack', '1/2 lb', '2lb Bag (2x 1lb bags)']) {
    assert.equal(w(t), null, t)
  }
  assert.equal(w('Default Title', 'The Roasters Tour - Coffee Club - 1x 2lb bags', 908), null)
  assert.equal(w('Black / 2XL', 'Torque Skeleton Shirt', 141.7), 0.25)                  // no size: grams
})

test('G2: every shippable catalog variant resolves as A1 says, or by a named exception', () => {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'docs', 'retail_catalog.csv'), 'utf8').trim().split('\n')
  const parse = line => { const out = []; let cur = '', q = false; for (const c of line) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = '' } else cur += c } out.push(cur); return out }
  const head = parse(csv[0])
  const rows = csv.slice(1).map(parse).map(r => Object.fromEntries(head.map((k, i) => [k, r[i]]))).filter(r => r.ship_status === 'SHIP')
  const SIZE = /(\d+(?:\.\d+)?|\.\d+)\s*(lbs?|pounds?|oz|ounces?|kg|g|grams?)\b/i
  const MULTI = /\d+\s*[x×]\s*\d|(?:^|[^a-z])[x×]\s*\d|\bpack\b|\bcase\s+of\b|\d+\s*\/\s*\d+/i
  const snap = g => Math.round(g / 453.59237 * 4) / 4
  // Where the resolver deliberately differs from A1's eff_g_proposed, and why.
  const EXCEPTIONS = [
    { why: 'multipack or fraction in a title: held', match: r => MULTI.test(r.variant_title) || MULTI.test(r.product_title), expect: () => null },
    { why: 'R3: xPods and the 250 g box count as 12 oz', match: r => /x\s*pods?|250\s*g/i.test(r.variant_title), expect: () => 0.75 },
    { why: 'R10: the 8oz in the title beats Shopify grams (340)', match: r => r.product_title.startsWith('Cascara Perla Tea') && r.variant_title === '8oz Bag', expect: () => 0.5 },
    { why: 'no size in either title: grams, snapped to the quarter pound', match: r => !SIZE.test(r.variant_title) && !SIZE.test(r.product_title), expect: r => snap(Number(r.grams)) }
  ]
  const unexplained = []
  let excepted = 0
  for (const r of rows) {
    const got = resolveWeightLb({ title: r.product_title, variant_title: r.variant_title, grams: Number(r.grams) })
    const a1 = Number(r.eff_g_proposed) / 453.59237
    if (got != null && Math.abs(got - a1) <= 0.06) continue
    const ex = EXCEPTIONS.find(e => e.match(r))
    if (ex && got === ex.expect(r)) { excepted++; continue }
    unexplained.push(`${r.product_title} | ${r.variant_title} | grams ${r.grams} | A1 ${a1.toFixed(3)} | got ${got}`)
  }
  assert.ok(rows.length >= 470, `catalog rows: ${rows.length}`)
  assert.deepEqual(unexplained, [])
  assert.ok(excepted > 0 && excepted < 60, `excepted ${excepted}`)
})

test('G2: shipping-weight filler lines are not packed', () => {
  const line = (title, extra = {}) => ({ vendor: 'Torque Coffees', fulfillment_status: null, title, ...extra })
  assert.equal(isShippableB2BLine(line('5 lb weight for shipping')), false)
  assert.equal(isShippableB2BLine(line('2lb weight for shipping')), false)
  assert.equal(isShippableB2BLine(line('Cocoa Drop - Compositions')), true)
  assert.equal(isShippableB2BLine(line('Cocoa Drop - Compositions', { fulfillment_status: 'fulfilled' })), false)
  assert.equal(isShippableB2BLine(line('Grinder', { vendor: 'Baratza' })), false)
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

test('G2: exactly one escHtml, and it escapes all five characters', () => {
  const src = inlineScripts().join('\n')
  assert.equal((src.match(/^function escHtml\(/gm) || []).length, 1)
  const { escHtml } = loadFromIndex(['escHtml'])
  assert.equal(escHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
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
function shipFlow(qty = 5) {
  const pack = C.packBoxes(C.expandShipItems([{ product_name: 'Cocoa Drop', variant_title: '5lb', qty, sku: 'X', weight_lb: 5 }]))
  const shipState = {
    order: { order_id: 'gid://shopify/Order/1', order_name: '#9001', shipping_address: { name: 'Pete', company: 'Best Coffee', address1: '1 Main St', city: 'Goleta', province_code: 'CA', zip: '93117', country_code: 'US', phone: '' } },
    pack, phase: 'packed',
    boxes: pack.boxes.map(box => ({ box, rate: null, rateError: null, rateAlt: null, label: null, labelError: null, status: 'packed' }))
  }
  const F = loadFromIndex(['PACK_BOX', 'SHIP_CARRIER', 'SHIP_WEIGHT_BASIS', 'MEASURED_NET_LB', 'CARTON_TARE_LB', 'PACK_ALLOWANCE_LB',
    'escHtml', 'declaredWeightLb', 'toShippoAddress', 'boxParcel', 'packSignature', 'getRates', 'reRate', 'buyLabels', 'fulfillOrder',
    'renderShipActions', 'pluralBox', 'shipAllPrinted', 'apiFetch'],
  { shipState, shipPending: {}, shipBuyInFlight: false, renderShip() {}, confirm: () => true, alert() {}, fetch: stubFetch,
    sb: { auth: SB_AUTH }, showSignIn() {} })
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

test('G2: a price change buys nothing, stops the order, and asks for a re-rate', async () => {
  const { F, shipState } = shipFlow(11)                                       // boxes [20, 20, 15]
  reset((url) => url.startsWith('/api/shippo-label?action=rate')
    ? { json: { ok: true, amount: '16.43', currency: 'USD' } }
    : { status: 409, json: { error: 'Price changed', quoted: '16.43', amount: '18.10' } })
  await F.getRates()
  await F.buyLabels()
  assert.equal(apiCalls('/api/shippo-label?action=label').length, 1)          // stopped after box 1
  const [b1, b2, b3] = shipState.boxes
  assert.equal(b1.label, null); assert.equal(b1.rate, null)
  assert.deepEqual(host(b1.priceChange), { quoted: '16.43', amount: '18.10' })
  assert.equal(b1.rateError, null)                                            // not shown as "No rate"
  for (const b of [b2, b3]) { assert.equal(b.label, null); assert.equal(b.status, 'packed'); assert.equal(b.rate, null) }  // whole address re-rates
  const bar = F.renderShipActions()
  assert.match(bar, /UPS changed the price after you confirmed/)
  assert.match(bar, /Nothing was bought for 3 boxes/)
  assert.match(bar, /reRate\(\)/)
  assert.doesNotMatch(bar, /buyLabels\(\)/)
  // Re-rate: all three get the new price, the warning clears, Buy offers the new total
  reset(() => ({ json: { ok: true, amount: '18.10', currency: 'USD' } }))
  F.reRate(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0))
  assert.equal(b1.priceChange, null)
  assert.match(F.renderShipActions(), /Buy 3 labels — \$54\.30/)
})

test('G2: a nested Get rates mid-buy cannot put a Buy button on screen', async () => {
  const { F, shipState } = shipFlow(11)
  let after = null
  reset((url) => {
    if (url.startsWith('/api/shippo-label?action=rate')) return { json: { ok: true, amount: '16.43', currency: 'USD' } }
    if (apiCalls('/api/shippo-label?action=label').length === 1) { F.getRates(); F.reRate(); after = F.renderShipActions() }
    return { json: { ok: true, tracking_number: '1Z29G1830300998096', cost: '16.43', currency: 'USD' } }
  })
  await F.getRates()
  await F.buyLabels()
  assert.match(after, /Buying labels/)
  assert.doesNotMatch(after, /onclick/)
  assert.equal(apiCalls('/api/shippo-label?action=rate').length, 3)
  assert.equal(F.__ctx.shipBuyInFlight, false)                                // released when done
  assert.equal(shipState.phase, 'bought')
})

test('G2: leaving or reopening an order mid-buy is refused (the second-loop double charge)', async () => {
  const { F, shipState } = shipFlow(11)
  const G = loadFromIndex(['backToShipList', 'openShipOrder', 'loadShipOrders'], {
    shipBuyInFlight: false, shipState, b2bShipOrders: [shipState.order],
    alert(m) { G.__alerts = (G.__alerts || 0) + 1 }, confirm: () => true, renderShip() {}, packBoxes() { throw new Error('reopened') }
  })
  reset((url) => {
    if (url.startsWith('/api/shippo-label?action=rate')) return { json: { ok: true, amount: '16.43', currency: 'USD' } }
    if (apiCalls('/api/shippo-label?action=label').length === 1) {
      G.__ctx.shipBuyInFlight = F.__ctx.shipBuyInFlight                        // same page, same flag
      assert.equal(G.__ctx.shipBuyInFlight, true)
      G.backToShipList(); G.openShipOrder(0); G.loadShipOrders()
    }
    return { json: { ok: true, tracking_number: '1Z29G1830300998096', cost: '16.43', currency: 'USD' } }
  })
  await F.getRates()
  await F.buyLabels()
  assert.equal(G.__alerts, 3)
  assert.equal(G.__ctx.shipState, shipState)                                  // never reset mid-buy
  assert.deepEqual(apiCalls('/api/shippo-label?action=label').map(c => c.body.box_index), [1, 2, 3])
})

test('G2: "Already bought" from the server becomes a recovered label, not a failure', async () => {
  const { F, shipState } = shipFlow()
  reset((url) => url.startsWith('/api/shippo-label?action=rate')
    ? { json: { ok: true, amount: '16.43', currency: 'USD' } }
    : { status: 409, json: { error: 'Already bought', tracking_number: '1Z29G1830300998096', label_url: 'https://shippo/x.pdf' } })
  await F.getRates()
  await F.buyLabels()
  for (const b of shipState.boxes) { assert.equal(b.status, 'bought'); assert.equal(b.label.recovered, true); assert.equal(b.labelError, null) }
  assert.equal(shipState.phase, 'bought')
})

test('G2: Clear closes out a hand-fulfilled order only when Shopify says it is fulfilled', async () => {
  for (const [reply, cleared] of [[{ ok: true, alreadyFulfilled: true }, true], [{ error: 'not fulfilled' }, false]]) {
    const shipPending = { 'gid://shopify/Order/7': { order_name: '#7000' } }
    const sb = { auth: SB_AUTH, rpc: async () => ({ data: [{ box_index: 1, tracking_number: '9400111899223197428490' }], error: null }) }
    const H = loadFromIndex(['clearHandFulfilled', 'apiFetch'], { sb, shipPending, fetch: stubFetch, renderShip() {}, alert() {}, showSignIn() {} })
    reset(() => ({ status: reply.ok ? 200 : 409, json: reply }))
    await H.clearHandFulfilled('gid://shopify/Order/7')
    const body = apiCalls('/api/shopify-fulfill')[0].body
    assert.equal(body.notifyCustomer, false)
    assert.equal(body.only_if_fulfilled, true)
    assert.equal('gid://shopify/Order/7' in shipPending, !cleared)
  }
})

test('G2: while labels are being bought nothing can start a second buy (no double charge)', async () => {
  const { F, shipState } = shipFlow(11)
  let duringBuy = null
  reset((url) => {
    if (url.startsWith('/api/shippo-label?action=rate')) return { json: { ok: true, amount: '16.43', currency: 'USD' } }
    const n = apiCalls('/api/shippo-label?action=label').length
    if (n === 1) {
      duringBuy = F.renderShipActions()
      F.buyLabels(); F.reRate(); F.getRates()                                 // operator taps around mid-buy
      return { status: 409, json: { error: 'Price changed', quoted: '16.43', amount: '18.10' } }
    }
    return { json: { ok: true, tracking_number: '1Z29G18303009980' + n + '6', cost: '16.43', currency: 'USD' } }
  })
  await F.getRates()
  await F.buyLabels()
  assert.match(duringBuy, /Buying labels/)
  assert.doesNotMatch(duringBuy, /onclick/)
  assert.deepEqual(apiCalls('/api/shippo-label?action=label').map(c => c.body.box_index), [1])
  assert.equal(apiCalls('/api/shippo-label?action=rate').length, 3)           // the first Get rates only
  shipState.phase = 'buying'
  assert.match(F.renderShipActions(), /Buying labels/)
  shipState.boxes[1].rateError = 'x'                                           // even with a rate error showing
  assert.doesNotMatch(F.renderShipActions(), /onclick/)
})

test('G2: the buy button counts only boxes still to buy', async () => {
  const { F, shipState } = shipFlow(11)
  shipState.boxes[0].label = { tracking_number: '1Z29G1830300998096', recovered: true }
  reset(() => ({ json: { ok: true, amount: '16.43', currency: 'USD' } }))
  await F.getRates()
  const bar = F.renderShipActions()
  assert.match(bar, /Buy 2 labels — \$32\.86/)
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

test('G2: fulfill sends company UPS (ignored by this server; protects a rollback to the old one)', async () => {
  const { F, shipState } = shipFlow()
  shipState.boxes.forEach(b => { b.label = { tracking_number: '1Z29G1830300998096', tracking_url: 'https://ups/t' } })
  reset(() => ({ json: { ok: true, notified: true } }))
  await F.fulfillOrder()
  const body = apiCalls('/api/shopify-fulfill')[0].body
  assert.equal(body.company, 'UPS')
  assert.equal(body.tracking.length, 2)
})

test('G2: fulfill errors are escaped before they reach the page', async () => {
  const { F, shipState } = shipFlow()
  shipState.boxes.forEach(b => { b.label = { tracking_number: '1Z29G1830300998096' } })
  reset(() => ({ status: 502, json: { error: 'fulfillmentCreate failed', detail: '<img src=x>' } }))
  await F.fulfillOrder()
  assert.doesNotMatch(shipState.fulfillError, /<img/)
  assert.match(shipState.fulfillError, /&lt;img/)
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

test('G3: address fields are strings, cleaned; name and company are cut to the UPS line length', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, address_to: { ...ADDR, name: 'Pete\r\nSmith\u0000\u00AD', street1: ['PO', 'Box 9'], street2: '123½ Main St', city: { x: 1 }, company: '😀'.repeat(40) } } })
  assert.equal(r.code, 200)
  const a = calls[0].body.address_to
  assert.equal(a.name, 'Pete Smith')
  assert.equal(a.street1, '')                      // not a string: dropped, not joined into "PO,Box 9"
  assert.equal(a.city, '')
  assert.equal(a.street2, '123½ Main St')           // NFC, not NFKC: ½ is not rewritten to 1⁄2
  assert.equal(Array.from(a.company).length, 35)    // cut by code point, no half emoji
})

test('G3: an address line, line 2 or city longer than UPS allows is refused, not cut', async () => {
  reset(shippoOk())
  for (const k of ['street1', 'street2', 'city']) {
    const r = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, address_to: { ...ADDR, [k]: '4501 Mission Bay Dr Building 2 Ste 3C' } } })
    assert.equal(r.code, 400, k)
    assert.match(r.payload.error, /longer than UPS allows/)
  }
  const huge = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, address_to: { ...ADDR, name: '\uFDFA'.repeat(300) } } })
  assert.equal(huge.code, 400)                     // refused before it is normalized
  assert.equal(calls.length, 0)
})

test('G3: a street named Pobox still ships', async () => {
  reset(shippoOk())
  const r = await call(shippoLabel, { query: { action: 'rate' }, body: { ...OK_BODY, address_to: { ...ADDR, street1: '1 Pobox Way' } } })
  assert.equal(r.code, 200)
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
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: '1e308' }],             // would switch the price guard off
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: [16.43] }],
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: true }],
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: '16.431' }],
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: '0' }],
    [{ action: 'label' }, { ...LABEL_BODY, expected_amount: '-1' }],
    [{ action: 'rate' }, { ...OK_BODY, weight_basis: undefined }],                  // stale page, rate step too
    [{ action: 'rate' }, { ...OK_BODY, carrier: 'usps' }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'PO\u200BBox 12' } }],   // zero-width inside
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'POB 12' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'P.O.B. 12' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'P0 Box 1' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'PO-Box 7' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'P/O Box 5' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'Po Bx 4' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'Postal Box 9' } }],
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'PO\u00ADBox 12' } }],          // soft hyphen
    [{ action: 'label' }, { ...LABEL_BODY, address_to: { ...ADDR, street1: 'P\u200EO Box 12' } }],         // bidi mark
    [{ action: 'label' }, { ...LABEL_BODY, order_id: undefined }],
    [{ action: 'label' }, { ...LABEL_BODY, box_index: undefined }],
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
  assert.deepEqual(r.payload.rates.map(x => x.account), ['torque-us', 'other', 'other'])   // no account ids leak
  assert.equal(JSON.stringify(r.payload).includes(CA_UPS_ACCOUNT), false)
  assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
})

test('G3: price above the confirmed one, even by a cent -> 409 with the new price, nothing bought', async () => {
  for (const amount of ['18.10', '16.44']) {
    reset(shippoOk([rate('ups_ground', amount)]))
    const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
    assert.equal(r.code, 409)
    assert.deepEqual(r.payload, { error: 'Price changed', quoted: '16.43', amount, currency: 'USD' })
    assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
  }
})

test('G3: a price that can\'t be read, or not in USD, is refused at rate and at label (fails closed)', async () => {
  for (const action of ['rate', 'label']) {
    for (const r0 of [{ amount: '' }, { amount: 'N/A' }, { amount: null }, { amount: '0' }, { currency: 'CAD' }]) {
      reset(shippoOk([{ ...rate('ups_ground', '16.43'), ...r0 }]))
      const r = await call(shippoLabel, { query: { action }, body: LABEL_BODY })
      assert.equal(r.code, 422, action + JSON.stringify(r0))
      assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
    }
  }
})

test('G3: a box that already has a label gets that label back, nothing is bought', async () => {
  const TXN = 'a'.repeat(32)
  const prior = [{ box_index: 1, tracking_number: '1Z29G1830300998096', tracking_url: 'https://evil/t', label_url: 'https://evil/x.pdf', shippo_object_id: TXN, status: 'purchased' }]
  const shippoTxn = (t) => (url) => url.endsWith(`/transactions/${TXN}`) ? { json: t } : shippoOk(MIXED_RATES, prior)(url)
  const real = { object_id: TXN, status: 'SUCCESS', tracking_number: '1Z29G1830300998096', tracking_url_provider: 'https://ups/t', label_url: 'https://deliver.goshippo.com/x.pdf' }
  reset(shippoTxn(real))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 409)
  assert.equal(r.payload.error, 'Already bought')
  assert.equal(r.payload.tracking_number, '1Z29G1830300998096')
  // Shippo's own label and tracking link, never the row's (ADR 0023)
  assert.equal(r.payload.label_url, 'https://deliver.goshippo.com/x.pdf')
  assert.equal(r.payload.tracking_url, 'https://ups/t')
  assert.equal(calls.filter(c => c.url.endsWith('/shipments/') || c.url.endsWith('/transactions/')).length, 0)
  // A row Shippo doesn't confirm (planted, or another tracking number) is refused, not bought over.
  for (const t of [{ ...real, tracking_number: '1Z999' }, { ...real, status: 'ERROR' }]) {
    reset(shippoTxn(t))
    const x = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
    assert.equal(x.code, 409)
    assert.match(x.payload.error, /doesn't confirm/)
    assert.equal(x.payload.label_url, undefined)
    assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
  }
  reset(shippoOk(MIXED_RATES, [{ ...prior[0], shippo_object_id: 'txn_0' }]))   // not a Shippo id
  assert.match((await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })).payload.error, /doesn't confirm/)
  // a label for a different box, or a voided one, does not block
  for (const p of [[{ ...prior[0], box_index: 2 }], [{ ...prior[0], status: 'voided' }]]) {
    reset(shippoOk(MIXED_RATES, p))
    assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })).code, 200)
  }
})

test('G3: if the already-bought lookup fails or is refused, nothing is bought (ADR 0023, was R8: buy anyway)', async () => {
  for (const fail of [{ status: 500, text: 'down' }, { status: 401, json: { message: 'permission denied for function ship_labels_for_order' } }, { status: 404, json: {} }]) {
    reset((url) => url.includes('/rpc/ship_labels_for_order') ? fail : shippoOk()(url))
    const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
    assert.equal(r.code, 503, String(fail.status))
    assert.match(r.payload.error, /nothing was bought/)
    assert.equal(calls.filter(c => c.url.endsWith('/shipments/') || c.url.endsWith('/transactions/')).length, 0)
  }
  // The lookup is skipped at rate time: rating never needs it.
  reset((url) => url.includes('/rpc/ship_labels_for_order') ? { status: 500, text: 'down' } : shippoOk()(url))
  assert.equal((await call(shippoLabel, { query: { action: 'rate' }, body: OK_BODY })).code, 200)
})

test('G3: the confirmed price as a number also works', async () => {
  reset(shippoOk([rate('ups_ground', '16.43')]))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, expected_amount: 16.43 } })
  assert.equal(r.code, 200)
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
  assert.equal('metadata' in txn.body, false)   // only a retail label is marked with its order
  const row = calls.find(c => c.url.includes('/rest/v1/shipping_labels')).body
  assert.equal(row.service, 'ups_ground')
  assert.equal(row.is_cubic, false)
  assert.equal(row.weight_lb, 22)
  assert.equal('channel' in row, false)   // B2B takes the column default (ADR 0028), so it works before the migration too
  assert.equal(row.cost, '16.43')
  assert.equal(row.dest_zip, '93117')
  assert.equal(r.payload.cost_logged, true)
  assert.equal(r.payload.test, false)
})

test('G3: failed purchase -> 502 and no cost row', async () => {
  reset((url) => url.endsWith('/transactions/') ? { json: { status: 'ERROR', messages: [{ text: 'bad' }] } } : shippoOk()(url))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 502)
  assert.equal(calls.filter(c => c.url.includes('/rest/v1/shipping_labels')).length, 0)
})

// ── G3 server: shopify-fulfill ──────────────────────────────────────────────────────────
const shopifyOk = () => (url, body) => {
  if (url.includes('/oauth/access_token')) return { json: { access_token: 'tok' } }
  if (url.includes('/graphql.json') && /fulfillmentOrders/.test(body.query)) return { json: { data: { order: { id: 'gid://shopify/Order/1', name: '#8263', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'gid://shopify/FulfillmentOrder/9', status: 'OPEN' } }] } } } } }
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

test('G3: fulfill refuses a non-UPS tracking number on an open order; nothing is created', async () => {
  for (const number of ['9400111899223197428490', '1Z29G18303', '1Z29G1830300998096X']) {
    reset(shopifyOk())
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: [...TRACKING, { number, url: null }] } })
    assert.equal(r.code, 400)
    assert.match(r.payload.error, /by hand in Shopify/)
    assert.equal(calls.filter(c => c.body && c.body.variables && c.body.variables.fulfillment).length, 0)
  }
})

test('G3: an order already fulfilled (e.g. by hand in Shopify) clears its pending labels, even with USPS numbers', async () => {
  reset((url, body) => {
    if (url.includes('/graphql.json') && /fulfillmentOrders/.test(body.query)) return { json: { data: { order: { id: 'gid://shopify/Order/1', name: '#8100', cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'fo', status: 'CLOSED' } }] } } } } }
    return shopifyOk()(url, body)
  })
  const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: [{ number: '9400111899223197428490' }], only_if_fulfilled: true } })
  assert.equal(r.code, 200)
  assert.equal(r.payload.alreadyFulfilled, true)
  assert.equal(r.payload.notified, false)
  assert.equal(r.payload.cost_rows_updated, 4)
  const flips = calls.filter(c => c.url.includes('/rpc/mark_ship_labels_fulfilled'))
  assert.equal(flips.length, 1)
  assert.equal(flips[0].headers.Authorization, `Bearer ${USER_TOKEN}`)   // as the signed-in user (ADR 0023)
  assert.equal(calls.filter(c => c.body && c.body.variables && c.body.variables.fulfillment).length, 0)
})

test('G3: fulfill refuses a box with no tracking number instead of dropping it, before any Shopify call', async () => {
  reset(shopifyOk())
  for (const tracking of [[...TRACKING, { number: '' }], [...TRACKING, {}], [...TRACKING, null], [{ number: ['1Z29G1830300998096'] }], []]) {
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking } })
    assert.equal(r.code, 400, JSON.stringify(tracking))
  }
  assert.equal(calls.length, 0)
})

test('G3: held, scheduled, incomplete, cancelled or invisible orders are NOT treated as fulfilled; rows stay pending', async () => {
  const cases = [
    [{ status: 'ON_HOLD' }, null, 'UNFULFILLED', /Release the hold/],
    [{ status: 'SCHEDULED' }, null, 'SCHEDULED', /SCHEDULED/],
    [{ status: 'INCOMPLETE' }, null, 'UNFULFILLED', /INCOMPLETE/],
    [null, null, 'UNFULFILLED', /none visible/],
    [{ status: 'CLOSED' }, '2026-10-17T00:00:00Z', 'UNFULFILLED', /cancelled/]
  ]
  for (const [fo, cancelledAt, dfs, rx] of cases) {
    reset((url, body) => {
      if (url.includes('/graphql.json') && /fulfillmentOrders/.test(body.query)) return { json: { data: { order: { id: 'gid://shopify/Order/1', name: '#8100', cancelledAt, displayFulfillmentStatus: dfs, fulfillmentOrders: { edges: fo ? [{ node: { id: 'fo', ...fo } }] : [] } } } } }
      return shopifyOk()(url, body)
    })
    const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: TRACKING } })
    assert.equal(r.code, 409, JSON.stringify(fo))
    assert.match(r.payload.error, rx)
    assert.equal(calls.filter(c => c.url.includes('/rpc/mark_ship_labels_fulfilled')).length, 0)
  }
})

test('G3: fulfill sends no tracking URL (Shopify builds the UPS link; a page-sent URL could be anything)', async () => {
  reset(shopifyOk())
  await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: [{ number: '1Z29G1830300998096', url: 'https://evil.example/login' }] } })
  const m = calls.find(c => c.body && c.body.variables && c.body.variables.fulfillment)
  assert.equal('urls' in m.body.variables.fulfillment.trackingInfo, false)
})

test('G3: Clear (only_if_fulfilled) on an order Shopify still has open items for creates nothing', async () => {
  reset(shopifyOk())
  const r = await call(shopifyFulfill, { body: { order_id: 'gid://shopify/Order/1', tracking: TRACKING, notifyCustomer: false, only_if_fulfilled: true } })
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /nothing was changed/)
  assert.equal(calls.filter(c => c.body && c.body.variables && c.body.variables.fulfillment).length, 0)
  assert.equal(calls.filter(c => c.url.includes('/rpc/mark_ship_labels_fulfilled')).length, 0)
})

test('G3: one buyer per box: a box claimed by another device buys nothing; a failed purchase releases the claim', async () => {
  reset((url) => url.includes('/rpc/claim_label_box') ? { json: false } : shippoOk()(url))
  let r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 409)
  assert.match(r.payload.error, /another device/)
  assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
  for (const fail of [{ status: 500, text: 'down' }, { status: 404, json: {} }]) {   // e.g. the claims migration not applied
    reset((url) => url.includes('/rpc/claim_label_box') ? fail : shippoOk()(url))
    r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
    assert.equal(r.code, 503)
    assert.equal(calls.filter(c => c.url.endsWith('/transactions/')).length, 0)
  }
  reset((url) => url.endsWith('/transactions/') ? { json: { status: 'ERROR', messages: [{ text: 'no' }] } } : shippoOk()(url))
  r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 502)
  const release = calls.filter(c => c.url.includes('/rpc/release_label_box'))
  assert.equal(release.length, 1)
  assert.deepEqual(release[0].body, { p_order_id: 'gid://shopify/Order/1', p_box_index: 1 })
  // A successful purchase claims first and keeps the claim.
  reset(shippoOk())
  r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
  assert.equal(r.code, 200)
  const order = calls.map(c => c.url.includes('claim_label_box') ? 'claim' : c.url.endsWith('/transactions/') ? 'buy' : null).filter(Boolean)
  assert.deepEqual(order, ['claim', 'buy'])
  assert.equal(calls.filter(c => c.url.includes('/rpc/release_label_box')).length, 0)
})

// ── B2a: one copy of the ship rules; the server repacks before buying ────────────────────
const ShipRules = require('../lib/ship-rules.js')
const bought = () => calls.filter(c => c.url.endsWith('/shipments/') || c.url.endsWith('/transactions/')).length
const shopifyCalls = () => calls.filter(c => c.url.includes('myshopify.com')).length

test('B2a: the page takes every shipping rule from lib/ship-rules.js and declares none itself', () => {
  const src = inlineScripts().join('\n')
  const m = /const \{([^}]+)\} = SHIP_RULES_LOADED \? ShipRules : \{\}/.exec(src)
  assert.ok(m, 'index.html destructures ShipRules')
  for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) assert.ok(name in ShipRules, `${name} is exported by lib/ship-rules.js`)
  // No lib export is declared again anywhere in the page, at any indent, with any keyword.
  for (const name of Object.keys(ShipRules)) {
    assert.ok(!new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).test(src), `${name} is not redeclared in index.html`)
  }
  for (const f of ['shopify-token.js', 'shippo-label.js']) {
    const api = fs.readFileSync(path.join(__dirname, '..', 'api', f), 'utf8')
    assert.ok(!/function (resolveWeightLb|weightFromTitle|packBoxes|declaredWeightLb|isShippableB2BLine)\b/.test(api), `${f} keeps no copy of a rule`)
  }
})

test('B2a: in a browser the file defines a frozen ShipRules global', () => {
  const vm = require('vm')
  const ctx = {}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ship-rules.js'), 'utf8'), ctx)
  assert.equal(typeof ctx.ShipRules.packBoxes, 'function')
  assert.ok(Object.isFrozen(ctx.ShipRules) && Object.isFrozen(ctx.ShipRules.MEASURED_NET_LB) && Object.isFrozen(ctx.ShipRules.SHIP_UNIT_OVERRIDES))
})

test('B2a: the order list and the label check build the same items from Shopify lines', () => {
  const items = ShipRules.b2bShipItems([
    ...ORDER_1.line_items,
    { vendor: 'Torque Coffees', title: '5 lb weight for shipping', variant_title: '', quantity: 1, grams: 2268 },
    { vendor: 'Baratza', title: 'Grinder', quantity: 1, grams: 3000 },
    { vendor: 'Torque Coffees', title: 'Gum Drop', variant_title: '12oz', quantity: 2, grams: 340, fulfillment_status: 'fulfilled' }
  ])
  assert.deepEqual(items, [{ sku: 'CD5', product_name: 'Cocoa Drop', variant_title: '5lb', qty: 16, grams: 2270, weight_lb: 5 }])
})

test('B2a: a label is bought only for the parcel the server packs (weight, carton, box count)', async () => {
  for (const [why, body] of [
    ['weight', { ...LABEL_BODY, parcel: { ...PARCEL, weight: 21 } }],
    ['heavier', { ...LABEL_BODY, parcel: { ...PARCEL, weight: 23 } }],
    ['carton', { ...LABEL_BODY, parcel: { ...PARCEL, height: 8 } }],
    ['box count', { ...LABEL_BODY, box_count: 3 }],
    ['box count', { ...LABEL_BODY, box_index: 5, box_count: 5 }]
  ]) {
    reset(shippoOk())
    const r = await call(shippoLabel, { query: { action: 'label' }, body })
    assert.equal(r.code, 409, why)
    assert.match(r.payload.error, /Nothing was bought/)
    assert.equal(bought(), 0, why)
    assert.equal(calls.filter(c => c.url.includes('claim_label_box')).length, 0, why)
  }
  // box_index past box_count is a malformed request
  reset(shippoOk())
  assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, box_index: 5 } })).code, 400)
  assert.equal(bought(), 0)
})

test('B2a: an order edited after the list loaded buys no box at all, not only the boxes that changed', async () => {
  // A real Shopify edit or refund: `quantity` stays 16, `fulfillable_quantity` drops to 15. Box 4
  // now holds 15 lb (17 declared); boxes 1-3 are unchanged, but the whole order is refused.
  const edited = { ...ORDER_1, line_items: [{ ...ORDER_1.line_items[0], quantity: 16, fulfillable_quantity: 15 }] }
  for (const box_index of [1, 4]) {
    reset(shippoOk(MIXED_RATES, [], edited))
    const r = await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, box_index } })
    assert.equal(r.code, 409)
    assert.equal(r.payload.code, 'pack_changed')
    assert.match(r.payload.error, /14x10x10@22,14x10x10@22,14x10x10@22,14x10x10@17/)
    assert.equal(bought(), 0)
  }
  // The same order listed after the edit matches and buys.
  reset(shippoOk(MIXED_RATES, [], edited))
  const fresh = '14x10x10@22,14x10x10@22,14x10x10@22,14x10x10@17'
  assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, box_index: 4, pack_sig: fresh, parcel: { ...PARCEL, weight: 17 } } })).code, 200)
  // Everything already fulfilled: nothing left to ship, nothing bought.
  reset(shippoOk(MIXED_RATES, [], { ...ORDER_1, line_items: [{ ...ORDER_1.line_items[0], fulfillable_quantity: 0 }] }))
  assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })).code, 409)
  assert.equal(bought(), 0)
  // The TCCDS-40 override applies on the server too: one 40 lb line = 2 boxes of 20 lb.
  const bulk = { ...ORDER_1, line_items: [{ vendor: 'Torque Coffees', title: 'Cocoa Drops xBloom Bulk 40lb Box', variant_title: 'Default Title', quantity: 1, grams: 18144, sku: 'TCCDS-40' }] }
  reset(shippoOk(MIXED_RATES, [], bulk))
  assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, box_count: 2, box_index: 2, pack_sig: '14x10x10@21,14x10x10@21', parcel: { ...PARCEL, weight: 21 } } })).code, 200)
})

test('B2a: a page that sends no pack is told to reload; nothing reaches Shopify or Shippo', async () => {
  reset(shippoOk())
  const { pack_sig, ...old } = LABEL_BODY
  const r = await call(shippoLabel, { query: { action: 'label' }, body: old })
  assert.equal(r.code, 400)
  assert.match(r.payload.error, /out of date/)
  assert.equal(calls.length, 0)
})

test('B2a: a pack_changed refusal stops the page buying the rest of the order', async () => {
  const { F, shipState } = shipFlow(11)                                       // boxes [20, 20, 15]
  reset((url) => url.startsWith('/api/shippo-label?action=rate')
    ? { json: { ok: true, amount: '16.43', currency: 'USD' } }
    : { status: 409, json: { code: 'pack_changed', error: 'This order changed since the list was loaded' } })
  await F.getRates()
  await F.buyLabels()
  const labels = apiCalls('/api/shippo-label?action=label')
  assert.equal(labels.length, 1)                                              // stopped after box 1
  assert.equal(labels[0].body.pack_sig, '14x10x10@22,14x10x10@22,14x10x10@17')
  assert.match(shipState.boxes[0].labelError, /order changed/)
  assert.equal(shipState.phase, 'partial')
})

test('B2a: boxParcel never guesses a carton', () => {
  const box = { box_label: '14x10x10', contents: [{ qty: 1, unit_weight_lb: 5 }] }
  assert.deepEqual(ShipRules.boxParcel(box), { length: 14, width: 10, height: 10, weight: 6 })
  assert.equal(ShipRules.boxParcel({ ...box, box_label: 'mailer' }), null)       // not LxWxH
  assert.equal(ShipRules.boxParcel({ ...box, box_label: '12x9x4' }), null)       // a size with no tare
  assert.equal(ShipRules.packSignature([box, { ...box, box_label: 'mailer' }]), null)
})

test('B2a: cancelled, missing or unweighable orders, or Shopify down, buy nothing', async () => {
  const cases = [
    ['cancelled', (url) => shopifyOrder(url, { ...ORDER_1, cancelled_at: '2026-10-19T00:00:00Z' }), 409],
    ['missing', (url) => url.includes('/orders/1.json') ? { status: 404, json: { errors: 'Not Found' } } : shopifyOrder(url), 409],
    ['shopify down', (url) => url.includes('/orders/1.json') ? { status: 500, json: {} } : shopifyOrder(url), 503],
    ['no token', (url) => url.includes('/oauth/access_token') ? { json: { error: 'invalid_client' } } : shopifyOrder(url), 503],
    ['unweighable', (url) => shopifyOrder(url, { ...ORDER_1, line_items: [...ORDER_1.line_items, { vendor: 'Torque Coffees', title: 'Mystery', variant_title: '2 x 12oz', quantity: 1, grams: 0 }] }), 409]
  ]
  for (const [why, shop, code] of cases) {
    reset((url) => shop(url) || shippoOk()(url))
    const r = await call(shippoLabel, { query: { action: 'label' }, body: LABEL_BODY })
    assert.equal(r.code, code, why)
    assert.equal(bought(), 0, why)
  }
  // An order id that isn't a Shopify order id never reaches Shopify.
  reset(shippoOk())
  assert.equal((await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, order_id: '../../products/9' } })).code, 400)
  assert.equal(shopifyCalls(), 0)
})

test('B2a: rating and an already-bought box never wait on Shopify', async () => {
  reset(shippoOk())
  assert.equal((await call(shippoLabel, { query: { action: 'rate' }, body: OK_BODY })).code, 200)
  assert.equal(shopifyCalls(), 0)
  const TXN = 'b'.repeat(32)
  const prior = [{ box_index: 1, tracking_number: '1Z29G1830300998096', shippo_object_id: TXN, status: 'purchased' }]
  reset((url) => url.endsWith(`/transactions/${TXN}`)
    ? { json: { object_id: TXN, status: 'SUCCESS', tracking_number: '1Z29G1830300998096' } }
    : shippoOk(MIXED_RATES, prior)(url))
  const r = await call(shippoLabel, { query: { action: 'label' }, body: { ...LABEL_BODY, parcel: { ...PARCEL, weight: 99 } } })
  assert.equal(r.payload.error, 'Already bought')
  assert.equal(shopifyCalls(), 0)
})
