// Login slice gates L2-L3 (docs/TESTS.md, ADR 0023): the /api functions refuse callers who are
// not signed in, the page signs in with Supabase Auth and sends the token on every /api call,
// and customer text is escaped. No network: fetch is stubbed.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const { INDEX, inlineScripts, loadFromIndex } = require('./helpers/index-html')

const jwt = exp => ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.')
const GOOD = jwt(Math.floor(Date.now() / 1000) + 3600)
let goodTokens = new Set([GOOD])
// What Supabase Auth answers for /auth/v1/user: 'ok' | 'reject' | 'down' | 'throw' | 'hang' |
// 'badkey' | 'anonymous' | 'stranger' (a valid user without the portal_staff marker)
let authMode = 'ok'
// What PostgREST answers for the one-label lookup: 'ok' | 'refused' | 'throw'
let lookupMode = 'ok'
let calls = [], authCalls = []
async function stubFetch(url, opts = {}) {
  url = String(url)
  const headers = opts.headers || {}
  if (url.endsWith('/auth/v1/user')) {
    authCalls.push({ url, headers })
    if (authMode === 'throw') throw new Error('ECONNREFUSED')
    if (authMode === 'hang') {
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    if (authMode === 'down') return { ok: false, status: 502, json: async () => ({}), text: async () => '' }
    if (authMode === 'badkey') return { ok: false, status: 401, json: async () => ({}), text: async () => '{"message":"Invalid API key","hint":"Double check your Supabase `anon` or `service_role` API key."}' }
    const ok = authMode !== 'reject' && goodTokens.has(String(headers.Authorization).replace(/^Bearer /, ''))
    const user = { id: 'u1', email: 'floor@torque.coffee', is_anonymous: authMode === 'anonymous',
      app_metadata: authMode === 'stranger' ? { provider: 'email' } : { provider: 'email', portal_staff: true } }
    return { ok, status: ok ? 200 : 403, json: async () => (ok ? user : { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }), text: async () => (ok ? JSON.stringify(user) : '{"code":403,"error_code":"bad_jwt","msg":"invalid JWT: unable to parse or verify signature"}') }
  }
  const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body
  calls.push({ url, body, headers })
  // Enough of Shippo, Shopify and PostgREST for each handler to get past its first outside call.
  if (url.includes('/rpc/ship_labels_for_order')) {
    if (lookupMode === 'refused') return { ok: false, status: 401, json: async () => ({ message: 'permission denied for function ship_labels_for_order' }) }
    if (lookupMode === 'throw') throw new Error('ECONNRESET')
    return { ok: true, status: 200, json: async () => [] }
  }
  if (url.includes('/rpc/claim_label_box') || url.includes('/rpc/release_label_box')) return { ok: true, status: 200, json: async () => true }
  if (url.endsWith('/shipments/')) return { ok: true, status: 200, json: async () => ({ rates: [{ object_id: 'r1', amount: '16.43', currency: 'USD', carrier_account: '21db4cf80df74a2cb27fc20948862003', servicelevel: { token: 'ups_ground', name: 'Ground' } }], messages: [] }) }
  if (url.endsWith('/transactions/')) return { ok: true, status: 200, json: async () => ({ status: 'SUCCESS', tracking_number: '1Z29G1830300998096', tracking_url_provider: 'https://ups/t', label_url: 'https://shippo-delivery.s3.amazonaws.com/x.pdf', object_id: 'txn_1' }) }
  if (url.includes('/rest/v1/shipping_labels')) return { ok: true, status: 201, text: async () => '', json: async () => ({}) }
  if (url.includes('/rpc/mark_ship_labels_fulfilled')) return { ok: true, status: 200, text: async () => '1', json: async () => 1 }
  if (url.includes('/oauth/access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 'shpat' }) }
  // The order behind LABEL_BODY, which the label check repacks (B2a): 4 x 5 lb = one box, 22 lb declared.
  if (url.includes('/orders/1.json')) return { ok: true, status: 200, json: async () => ({ order: { id: 1, name: '#8263', cancelled_at: null, line_items: [{ vendor: 'Torque Coffees', title: 'Cocoa Drop', variant_title: '5lb', quantity: 4, grams: 2270, sku: 'CD5', fulfillment_status: null }] } }) }
  return { ok: true, status: 200, json: async () => ({ data: {} }), text: async () => '{}' }
}
globalThis.fetch = stubFetch

Object.assign(process.env, {
  SHIPPO_TOKEN: 'shippo_test_stub', SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon-key',
  SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_STORE_HANDLE: 'store'
})
const auth = require('../api/_auth.js')
const shippoLabel = require('../api/shippo-label.js')
const shopifyFulfill = require('../api/shopify-fulfill.js')
const shopifyToken = require('../api/shopify-token.js')
const shipDoc = require('../api/ship-doc.js')

const LABEL_BODY = {
  address_to: { name: 'Pete Smith', company: 'Best Coffee', street1: '1 Main St', city: 'Goleta', state: 'CA', zip: '93117', country: 'US' },
  parcel: { length: 14, width: 10, height: 10, weight: 22 }, carrier: 'ups', weight_basis: 'packed',
  expected_amount: '16.43', order_id: 'gid://shopify/Order/1', order_name: '#8263', box_index: 1, box_count: 1,
  pack_sig: '14x10x10@22'
}
const HANDLERS = [
  ['shippo-label', shippoLabel, { method: 'POST', query: { action: 'label' }, body: LABEL_BODY }],
  ['shopify-fulfill', shopifyFulfill, { method: 'POST', query: {}, body: { order_id: 'gid://shopify/Order/1', tracking: [{ number: '1Z29G1830300998096' }] } }],
  ['shopify-token', shopifyToken, { method: 'GET', query: { type: 'b2b-ship' } }],
  ['ship-doc', shipDoc, { method: 'POST', query: {}, body: { boxes: [{ box_index: 1 }], include_slips: true } }]
]

const warnings = []
console.warn = (...a) => warnings.push(a.join(' '))

async function call(handler, { method = 'POST', query = {}, body, authorization } = {}) {
  const headers = authorization === undefined ? {} : { authorization }
  const res = { code: null, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(c) { this.code = c; return this }, json(p) { this.payload = p; return this }, send(p) { this.payload = p; return this }, end() { return this } }
  await handler({ method, query, body, headers, url: '/api/x?type=y' }, res)
  return res
}
function setup({ enforce = true, mode = 'ok', lookup = 'ok' } = {}) {
  process.env.PORTAL_AUTH_ENFORCE = enforce ? '1' : ''
  authMode = mode
  lookupMode = lookup
  calls = []; authCalls = []; warnings.length = 0
}

// ── L2: the four functions, enforcing ────────────────────────────────────────────────────
test('L2: every function refuses a request with no token (401) before any outside call', async () => {
  for (const [name, handler, req] of HANDLERS) {
    setup()
    const r = await call(handler, req)
    assert.equal(r.code, 401, name)
    assert.equal(calls.length, 0, `${name} made an outside call`)
    assert.equal(authCalls.length, 0, `${name} asked Supabase without a token`)
    assert.match(warnings.join('\n'), /auth:missing .* enforce=1/)
  }
})

test('L2: a bad or malformed token is refused (401), and is never echoed back', async () => {
  for (const authorization of ['Bearer not.the.token', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(9000)}`, 'Bearer <script>']) {
    for (const [name, handler, req] of HANDLERS) {
      setup()
      const r = await call(handler, { ...req, authorization })
      assert.equal(r.code, 401, `${name} with ${authorization.slice(0, 20)}`)
      assert.equal(calls.length, 0)
      assert.ok(!JSON.stringify(r.payload).includes('not.the.token'))
    }
  }
})

test('L2: Supabase Auth down, unreachable or slow -> 503, nothing else called (fails closed)', async () => {
  auth.settings.checkTimeoutMs = 20
  for (const mode of ['down', 'throw', 'hang']) {
    for (const [name, handler, req] of HANDLERS) {
      setup({ mode })
      const r = await call(handler, { ...req, authorization: `Bearer ${GOOD}` })
      assert.equal(r.code, 503, `${name} when auth is ${mode}`)
      assert.equal(calls.length, 0)
    }
  }
  auth.settings.checkTimeoutMs = 3000
})

test('L2: SUPABASE_URL or SUPABASE_ANON_KEY unset -> 503 while enforcing', async () => {
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    const saved = process.env[key]
    delete process.env[key]
    setup()
    const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
    assert.equal(r.code, 503, key)
    assert.equal(calls.length, 0)
    process.env[key] = saved
  }
})

test('L2: a valid token passes; the check sends the token and the anon key to /auth/v1/user', async () => {
  setup()
  const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.equal(r.code, 200)
  assert.equal(authCalls.length, 1)
  assert.equal(authCalls[0].url, 'https://sb.example/auth/v1/user')
  assert.equal(authCalls[0].headers.Authorization, `Bearer ${GOOD}`)
  assert.equal(authCalls[0].headers.apikey, 'anon-key')
  // "bearer" is case-insensitive (RFC 6750)
  setup()
  const lower = await call(shopifyFulfill, { ...HANDLERS[1][2], authorization: `bearer ${GOOD}` })
  assert.ok(![401, 503].includes(lower.code), String(lower.code))   // past the sign-in check (the Shopify stub has no order)
})

test('L2: server-side Supabase calls run as the signed-in user, not the anon key', async () => {
  setup()
  await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  const lookup = calls.find(c => c.url.includes('/rpc/ship_labels_for_order'))
  const costRow = calls.find(c => c.url.includes('/rest/v1/shipping_labels'))
  assert.equal(lookup.headers.Authorization, `Bearer ${GOOD}`)
  assert.equal(costRow.headers.Authorization, `Bearer ${GOOD}`)
  assert.equal(costRow.headers.apikey, 'anon-key')
  assert.equal(costRow.headers.Prefer, 'return=minimal')
  setup()
  await call(shopifyFulfill, { ...HANDLERS[1][2], authorization: `Bearer ${GOOD}` })
  // shopify-fulfill's GraphQL stub returns no order, so drive the flip helper's header directly
  assert.equal(auth.supabaseHeaders(GOOD).Authorization, `Bearer ${GOOD}`)
  assert.equal(auth.supabaseHeaders(null).Authorization, 'Bearer anon-key')
})

test('L2: the functions send no CORS headers (same-origin only) and keep their method checks', async () => {
  setup()
  const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.deepEqual(Object.keys(r.headers).filter(k => /^access-control/i.test(k)), [])
  for (const [name, handler, req] of HANDLERS) {
    setup()
    const wrong = req.method === 'GET' ? 'POST' : 'GET'
    assert.equal((await call(handler, { ...req, method: wrong, authorization: `Bearer ${GOOD}` })).code, 405, name)
    assert.equal((await call(handler, { ...req, method: 'OPTIONS' })).code, 405, `${name} OPTIONS`)
  }
  for (const f of ['shippo-label', 'shopify-fulfill', 'shopify-token', 'ship-doc']) {
    assert.ok(!/Access-Control-Allow-Origin/.test(fs.readFileSync(`${__dirname}/../api/${f}.js`, 'utf8')), f)
  }
})

// ── L2: observe mode (PORTAL_AUTH_ENFORCE unset) ─────────────────────────────────────────
const RATE_REQ = { method: 'POST', query: { action: 'rate' }, body: LABEL_BODY }
test('L2: not enforcing, a missing or bad token is logged and let through where allowed; a bad token is forwarded, not swapped for the anon key', async () => {
  for (const authorization of [undefined, 'Bearer not.the.token']) {
    setup({ enforce: false })
    const r = await call(shippoLabel, { ...RATE_REQ, authorization })
    assert.equal(r.code, 200)
    assert.match(warnings.join('\n'), authorization ? /auth:invalid .* enforce=0/ : /auth:missing .* enforce=0/)
    assert.ok(!warnings.join('\n').includes('not.the.token'), 'the token is never logged')
  }
  // The forwarding itself, at the helper.
  assert.equal(auth.supabaseHeaders('not.the.token').Authorization, 'Bearer not.the.token')
  setup({ enforce: false, mode: 'throw' })
  assert.equal((await call(shippoLabel, { ...RATE_REQ, authorization: `Bearer ${GOOD}` })).code, 200)
  assert.match(warnings.join('\n'), /auth:unreachable/)
  setup({ enforce: false })
  await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.equal(warnings.filter(w => w.startsWith('auth:')).length, 0)
  assert.equal(calls.find(c => c.url.includes('/rest/v1/shipping_labels')).headers.Authorization, `Bearer ${GOOD}`)
})

test('L2: buying a label, fulfilling, the B2B lists and label PDFs need a staff sign-in even when not enforcing', async () => {
  const sensitive = [
    [shippoLabel, { method: 'POST', query: { action: 'label' }, body: LABEL_BODY }],
    [shopifyFulfill, HANDLERS[1][2]],
    [shopifyToken, { method: 'GET', query: { type: 'b2b' } }],
    [shopifyToken, { method: 'GET', query: { type: 'b2b-ship' } }],
    [shipDoc, HANDLERS[3][2]]
  ]
  for (const [handler, req] of sensitive) {
    setup({ enforce: false })
    assert.equal((await call(handler, req)).code, 401, JSON.stringify(req.query))
    assert.equal(calls.length, 0)
  }
  // Products and the order list stay open until PORTAL_AUTH_ENFORCE=1.
  setup({ enforce: false })
  assert.notEqual((await call(shopifyToken, { method: 'GET', query: { type: 'products' } })).code, 401)
})

test('L2: a valid Supabase user without the portal_staff marker is refused (403), even when not enforcing on sensitive calls', async () => {
  setup({ mode: 'stranger' })
  const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.equal(r.code, 403)
  assert.match(r.payload.error, /isn't set up for the portal/)
  assert.equal(calls.length, 0)
  setup({ enforce: false, mode: 'stranger' })
  assert.equal((await call(shopifyFulfill, { ...HANDLERS[1][2], authorization: `Bearer ${GOOD}` })).code, 403)
  assert.match(warnings.join('\n'), /auth:not_staff/)
})

test('L2: only PORTAL_AUTH_ENFORCE=1 enforces', async () => {
  for (const v of ['true', 'yes', '0', ' 1']) {
    setup()
    process.env.PORTAL_AUTH_ENFORCE = v
    assert.equal((await call(shopifyToken, { method: 'GET', query: { type: 'products' } })).code !== 401, true, v)
  }
})

// ── L3: the page ─────────────────────────────────────────────────────────────────────────
const html = fs.readFileSync(INDEX, 'utf8')
const page = inlineScripts().join('\n')

test('L3: the TT gate is gone; the page starts locked behind a real sign-in form', () => {
  assert.ok(!/['"]TT['"]/.test(page), 'TT password still in the page')
  assert.ok(!/tqUnlock|tq_access=granted/.test(html))
  assert.match(html, /<html lang="en" class="tq-locked">/)
  assert.match(html, /<input id="signInEmail"[^>]*type="email"[^>]*autocomplete="username"/)
  assert.match(html, /<input id="signInPassword"[^>]*type="password"[^>]*autocomplete="current-password"/)
  assert.match(html, /id="signOutBtn"/)
  assert.ok(!/signUp\(|resetPasswordForEmail/.test(page), 'no sign-up or reset from the page')
})

test('L3: supabase-js is pinned to an exact version with an integrity hash', () => {
  const tag = html.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"[^>]*><\/script>/)
  assert.ok(tag, 'supabase-js script tag')
  assert.match(tag[0], /supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js"/)
  assert.match(tag[0], / integrity="sha384-[A-Za-z0-9+/]{64}"/)
  assert.match(tag[0], / crossorigin="anonymous"/)
})

test('L3: every /api call goes through apiFetch', () => {
  assert.equal((page.match(/apiFetch\('\/api\//g) || []).length, 11)   // 11th: the Retail queue (B1 UI)
  assert.equal((page.match(/(?<![\w.])fetch\(\s*['"`]\/api/g) || []).length, 0)
  // The bare fetches left are apiFetch's own and sbFetch's (the wrapper supabase-js uses).
  assert.equal((page.match(/(?<![\w.])fetch\(/g) || []).length, 3)
  assert.match(page, /global: \{ fetch: sbFetch \}/)
})

test('L3: apiFetch sends the session token, sends none without a session, and a 401 shows sign-in', async () => {
  const sent = []
  let shown = null, status = 200
  const mk = session => loadFromIndex(['apiFetch'], {
    sb: { auth: { getSession: async () => ({ data: { session }, error: null }) } },
    fetch: async (url, opts) => { sent.push({ url, opts }); return { status } },
    showSignIn: m => { shown = m }
  })
  await mk({ access_token: GOOD }).apiFetch('/api/shopify-fulfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(sent[0].opts.headers.Authorization, `Bearer ${GOOD}`)
  assert.equal(sent[0].opts.headers['Content-Type'], 'application/json')
  assert.equal(sent[0].opts.method, 'POST')
  await mk(null).apiFetch('/api/shopify-token?type=products')
  assert.equal('Authorization' in sent[1].opts.headers, false)
  assert.equal(shown, null)
  status = 401
  await mk({ access_token: GOOD }).apiFetch('/api/shopify-token')
  assert.match(shown, /Sign in again/)
})

test('L3: on a 401, apiFetch refreshes the session once and retries before asking for a sign-in', async () => {
  const sent = []
  let shown = null
  const F = loadFromIndex(['apiFetch'], {
    sb: { auth: {
      getSession: async () => ({ data: { session: { access_token: 'old' } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'new' } } })
    } },
    fetch: async (url, opts) => { sent.push(opts.headers.Authorization); return { status: opts.headers.Authorization === 'Bearer new' ? 200 : 401 } },
    showSignIn: m => { shown = m }
  })
  const res = await F.apiFetch('/api/shopify-token?type=products')
  assert.equal(res.status, 200)
  assert.deepEqual(sent, ['Bearer old', 'Bearer new'])
  assert.equal(shown, null)
})

test('L3: the page never sends a REST call on the publishable key alone, and counts its writes', async () => {
  let shown = null
  const seen = []
  const F = loadFromIndex(['sbFetch'], {
    SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'pk',
    restWritesInFlight: 0, localWriteGen: 0, lastLocalWriteAt: 0, Headers,
    showSignIn: m => { shown = m },
    fetch: async (url, init) => { seen.push([url, F.__ctx.restWritesInFlight]); return { status: 200 } }
  })
  await assert.rejects(F.sbFetch('https://sb.example/rest/v1/daily_plan?id=eq.1', { method: 'PATCH', headers: { Authorization: 'Bearer pk' } }), /Not signed in/)
  assert.match(shown, /Sign in again/)
  assert.equal(seen.length, 0)
  await F.sbFetch('https://sb.example/rest/v1/daily_plan?id=eq.1', { method: 'PATCH', headers: new Headers({ Authorization: 'Bearer user.jwt' }) })
  assert.deepEqual(seen.at(-1), ['https://sb.example/rest/v1/daily_plan?id=eq.1', 1])   // counted while in flight
  assert.equal(F.__ctx.restWritesInFlight, 0)
  assert.equal(F.__ctx.localWriteGen, 1)
  assert.ok(F.__ctx.lastLocalWriteAt > 0)
  await F.sbFetch('https://sb.example/rest/v1/daily_plan', { headers: { Authorization: 'Bearer user.jwt' } })   // a read
  assert.equal(F.__ctx.localWriteGen, 1)
  await F.sbFetch('https://sb.example/auth/v1/token?grant_type=password', { method: 'POST', headers: { Authorization: 'Bearer pk' } })   // sign-in itself passes
  assert.equal(seen.length, 3)
})

// A small stand-in for the DOM that the sign-in functions touch.
function fakeDom() {
  const classes = new Set(['tq-locked'])
  const els = {}
  const el = id => (els[id] ||= { id, textContent: '', value: '', disabled: false, style: {}, focused: false, focus() { this.focused = true } })
  return {
    classes,
    el,
    document: {
      documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
      getElementById: el
    }
  }
}
function authSandbox(extra = {}) {
  const dom = fakeDom()
  const counts = { init: 0, subscribe: 0, reload: 0 }
  const P = loadFromIndex(['showSignIn', 'startApp', 'onAuthChange'], {
    document: dom.document,
    appStarted: false, shipBuyInFlight: false,
    init: () => { counts.init++ }, subscribeRealtime: () => { counts.subscribe++ },
    location: { reload: () => { counts.reload++ } },
    ...extra
  })
  // `let appStarted` lives at page level; the sandbox global stands in for it.
  return { P, dom, counts }
}

test('L3: no session -> the sign-in screen, and nothing loads', () => {
  const { P, dom, counts } = authSandbox()
  P.onAuthChange('INITIAL_SESSION', null)
  assert.ok(dom.classes.has('tq-locked'))
  assert.equal(counts.init, 0); assert.equal(counts.subscribe, 0)
  assert.equal(dom.el('signInEmail').focused, true)
  assert.equal(dom.el('signInErr').style.display, 'none')
})

test('L3: a session unlocks the page and starts data + realtime exactly once', () => {
  const { P, dom, counts } = authSandbox()
  const session = { access_token: GOOD, user: { email: 'floor@torque.coffee' } }
  P.onAuthChange('INITIAL_SESSION', session)
  P.onAuthChange('TOKEN_REFRESHED', session)
  P.onAuthChange('SIGNED_IN', session)
  assert.ok(!dom.classes.has('tq-locked'))
  assert.equal(counts.init, 1); assert.equal(counts.subscribe, 1)
  assert.equal(dom.el('signedInAs').textContent, 'floor@torque.coffee')
})

test('L3: signing in again after the screen locked reloads the data; a silent token refresh does not', () => {
  const { P, dom, counts } = authSandbox()
  const session = { access_token: GOOD, user: { email: 'floor@torque.coffee' } }
  P.onAuthChange('INITIAL_SESSION', session)
  P.__ctx.appStarted = true
  P.onAuthChange('TOKEN_REFRESHED', session)
  assert.equal(counts.init, 1)
  P.showSignIn('Your session ended. Sign in again.')   // e.g. a 401 mid-use
  P.onAuthChange('SIGNED_IN', session)
  assert.equal(counts.init, 2)
  assert.equal(counts.subscribe, 1)
  assert.ok(!dom.classes.has('tq-locked'))
})

test('L3: signing out after the app ran reloads (no data left in memory), except mid-buy', () => {
  const a = authSandbox()
  a.P.onAuthChange('INITIAL_SESSION', { user: {} })
  a.P.__ctx.appStarted = true
  a.P.onAuthChange('SIGNED_OUT', null)
  assert.equal(a.counts.reload, 1)
  const b = authSandbox({ appStarted: true, shipBuyInFlight: true })
  b.P.onAuthChange('SIGNED_OUT', null)
  assert.equal(b.counts.reload, 0)
  assert.ok(b.dom.classes.has('tq-locked'))
  assert.match(b.dom.el('signInErr').textContent, /Sign in again/)
})

test('L3: realtime subscribes only from startApp; init() is not called at load', () => {
  assert.ok(!/^init\(\)/m.test(page), 'init() still runs at load')
  assert.ok(!/^sb\.channel\(/m.test(page), 'a realtime channel still subscribes at load')
  assert.match(page, /^sb\.auth\.onAuthStateChange\(/m)
})

// ── L3: realtime reloads ──────────────────────────────────────────────────────────────────
function rtSandbox(extra = {}) {
  const timers = []
  const R = loadFromIndex(['RT_QUIET_MS', 'RT_MAX_HOLD_MS', 'isEditingField', 'scheduleRealtime', 'runRealtime'], {
    rtJobs: new Set(), rtTimer: null, rtRunning: false, rtAgain: false, pointerIsDown: false, rtHeldSince: 0,
    document: { activeElement: null }, Date,
    restWritesInFlight: 0, localWriteGen: 0, lastLocalWriteAt: 0,
    setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    console: { warn() {} },
    ...extra
  })
  const flush = async () => { while (timers.length) await timers.shift()() }
  return { R, flush, timers }
}

test('L3: many realtime events become one reload', async () => {
  let runs = 0
  const job = async () => { runs++; return true }
  const { R, flush } = rtSandbox()
  for (let i = 0; i < 60; i++) R.scheduleRealtime(job)   // a Pull Orders on another device
  await flush()
  assert.equal(runs, 1)
})

test('L3: a reload waits while this device is writing or a finger is down', async () => {
  let runs = 0
  const { R, flush, timers } = rtSandbox({ restWritesInFlight: 1 })
  R.scheduleRealtime(async () => { runs++; return true })
  await timers.shift()()
  assert.equal(runs, 0); assert.equal(timers.length, 1)   // rescheduled
  R.__ctx.restWritesInFlight = 0; R.__ctx.pointerIsDown = true
  await timers.shift()()
  assert.equal(runs, 0)
  R.__ctx.pointerIsDown = false
  await flush()
  assert.equal(runs, 1)
})

test('L3: a reload waits while a field is being edited, but not past the hold limit', async () => {
  let runs = 0
  const realNow = Date.now
  const { R, timers } = rtSandbox()
  R.__ctx.document.activeElement = { tagName: 'SELECT' }   // e.g. the Add Order coffee picker
  R.scheduleRealtime(async () => { runs++; return true })
  await timers.shift()()
  assert.equal(runs, 0)
  R.__ctx.document.activeElement = { tagName: 'INPUT', type: 'checkbox' }   // a checkbox is not "editing"
  await timers.shift()()
  assert.equal(runs, 1)
  // Held too long: runs anyway.
  R.__ctx.document.activeElement = { tagName: 'INPUT', type: 'number' }
  R.scheduleRealtime(async () => { runs++; return true })
  await timers.shift()()
  assert.equal(runs, 1)
  R.__ctx.Date = { now: () => realNow() + 61000 }
  await timers.shift()()
  assert.equal(runs, 2)
})

test('L3: a failed plan_state read keeps the last known state (no false "open" plan)', async () => {
  const q = (data, error) => ({ select() { return this }, eq() { return this }, maybeSingle() { return Promise.resolve({ data, error }) } })
  const F = loadFromIndex(['loadPlanState'], { TEAM_ID: 't', todayStr: 'd', planState: { finalized_at: '2026-10-18T14:00:00Z' }, sb: { from: () => q(null, { message: 'fetch failed' }) } })
  await F.loadPlanState()
  assert.equal(F.__ctx.planState.finalized_at, '2026-10-18T14:00:00Z')
})

test('L3: a label 409 that is not "Price changed" or "Already bought" shows as a failed box, not a price change', () => {
  assert.match(page, /res\.status === 409 && data\.error === 'Price changed'/)
})

test('L3: a reload that read rows while a local write went out is dropped and re-run', async () => {
  const applied = []
  let tapDuringRead = true
  const { R, flush } = rtSandbox()
  const job = async (stillFresh) => {
    if (tapDuringRead) { R.__ctx.localWriteGen++; tapDuringRead = false }   // a "+" tap lands mid-read
    if (!stillFresh()) return false
    applied.push('fresh'); return true
  }
  R.scheduleRealtime(job)
  await flush()
  assert.deepEqual(applied, ['fresh'])   // the stale read was never applied; the re-run was
})

test('L3: loadPlan applies nothing when its reads went stale, and keeps the list on a failed read', async () => {
  const q = (data, error = null) => ({ select() { return this }, eq() { return this }, order() { return this }, then(r) { r({ data, error }) } })
  const mk = (planResult) => loadFromIndex(['loadPlan'], {
    TEAM_ID: 't', todayStr: '2026-10-18', planData: ['old'], roastingProgress: {}, roastLocks: {},
    sb: { from: t => (t === 'daily_plan' ? planResult : q([])) },
    loadPlanState: async () => {}, loadActivity: async () => {},
    renderBagging() {}, renderRoasting() {}, renderLbsNeeded() {}, populateCoffeeDropdown() {}
  })
  const A = mk(q([{ id: 1 }]))
  assert.equal(await A.loadPlan(() => false), false)
  assert.deepEqual(structuredClone(A.__ctx.planData), ['old'])
  const B = mk(q(null, { message: 'JWT expired' }))
  assert.equal(await B.loadPlan(), true)
  assert.deepEqual(structuredClone(B.__ctx.planData), ['old'])
  // A failed roasting read keeps the batch counts.
  const D = loadFromIndex(['loadPlan'], {
    TEAM_ID: 't', todayStr: '2026-10-18', planData: [], roastingProgress: { Kenya: { batches_done: 3 } }, roastLocks: {},
    sb: { from: t => (t === 'daily_plan' ? q([]) : q(null, { message: 'JWT expired' })) },
    loadPlanState: async () => {}, loadActivity: async () => {},
    renderBagging() {}, renderRoasting() {}, renderLbsNeeded() {}, populateCoffeeDropdown() {}
  })
  await D.loadPlan()
  assert.equal(D.__ctx.roastingProgress.Kenya.batches_done, 3)
  const C = mk(q([{ id: 1 }]))
  await C.loadPlan()
  assert.deepEqual(structuredClone(C.__ctx.planData), [{ id: 1 }])
})

test('L3: a live channel that drops shows on the sync pill; one that never connected only logs', () => {
  const sync = []
  const C = loadFromIndex(['onChannelStatus'], {
    rtLive: {}, setSync: (...a) => sync.push(a), scheduleRealtime() {}, loadPlan() {}, console: { warn() {} }
  })
  C.onChannelStatus('plan_changes', 'CHANNEL_ERROR')   // e.g. publication not applied yet
  assert.equal(sync.length, 0)
  C.onChannelStatus('plan_changes', 'SUBSCRIBED')
  C.onChannelStatus('plan_changes', 'TIMED_OUT')
  assert.equal(sync.at(-1)[0], 'error')
  C.onChannelStatus('plan_changes', 'SUBSCRIBED')
  assert.equal(sync.at(-1)[0], 'live')
})

test('L3: the sign-in form cannot post credentials natively, and a failed library load says so', () => {
  assert.match(html, /<form class="tq-gate-card" id="signInForm" onsubmit="return false"/)
  assert.ok(!/<form[^>]*id="signInForm"[^>]*(method=|action=)/.test(html))
  assert.match(page, /if \(typeof supabase === 'undefined'\) \{[\s\S]{0,400}Can't load the sign-in page/)
})

// ── L3: escaping ─────────────────────────────────────────────────────────────────────────
const X = '<img src=x onerror=alert(1)>'
const { escHtml, jsArg, safeUrl, trackingLink } = loadFromIndex(['escHtml', 'jsArg', 'safeUrl', 'trackingLink'], { URL })

test('L3: jsArg makes a string that survives an inline handler unchanged and inert', () => {
  const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const v of ["Bob's Blend", 'He said "hi"', X, '\\\'); alert(1); //', '</script>', 'a\nb', '']) {
    const out = jsArg(v)
    assert.ok(!/["'<>]/.test(out), `raw quote or bracket in ${out}`)
    assert.equal(JSON.parse(decode(out)), v)
  }
})

test('L3: safeUrl allows only http(s); trackingLink escapes the number and the link', () => {
  assert.equal(safeUrl('https://www.ups.com/track?n=1Z'), 'https://www.ups.com/track?n=1Z')
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', 'vbscript:x', '', null, '/relative']) {
    assert.equal(safeUrl(bad), '', String(bad))
  }
  assert.equal(trackingLink({ tracking_number: X, tracking_url: 'javascript:alert(1)' }), escHtml(X))
  const a = trackingLink({ tracking_number: '1Z1', tracking_url: 'https://x.test/"onmouseover="alert(1)' })
  assert.ok(!a.includes('"onmouseover'))
  assert.match(a, /^<a href="https:\/\/x\.test\/%22onmouseover=%22alert\(1\)" target="_blank" rel="noopener">1Z1<\/a>$/)
})

test('L3: the ship box escapes product names, box label and tracking from Shopify/Shippo/the DB', () => {
  const F = loadFromIndex(['escHtml', 'safeUrl', 'trackingLink', 'renderShipBox', 'declaredWeightLb', 'MEASURED_NET_LB', 'CARTON_TARE_LB', 'PACK_ALLOWANCE_LB'], { URL })
  const out = F.renderShipBox({
    box: { box_index: 1, box_count: 1, weight_lb: 5, box_label: X, contents: [{ qty: 1, product_name: X, variant_title: X, weight_lb: 5 }] },
    label: { tracking_number: X, tracking_url: 'javascript:alert(1)', cost_logged: false, cost_log_error: '"><script>' },
    rate: null, status: 'bought'
  }, 0)
  assert.ok(!out.includes('<img'), out)
  assert.ok(!out.includes('<script'))
  assert.ok(!out.includes('javascript:'))
})

test('L3: the B2B list escapes company, contact, email and line items', async () => {
  const dom = fakeDom()
  const evil = { company_name: X, contact_name: X, email: 'a"onmouseover="x@y.z', order_count: 1, items: [{ qty: 2, product_name: X, variant_title: X }] }
  const F = loadFromIndex(['escHtml', 'loadB2B'], {
    document: dom.document,
    apiFetch: async () => ({ json: async () => ({ companies: [evil] }) })
  })
  await F.loadB2B()
  const out = dom.el('b2bBody').innerHTML
  assert.ok(out.length > 0)
  assert.ok(!out.includes('<img'), out)
  assert.ok(!/"onmouseover/.test(out))
})

test('L3: no inline handler takes a name or text from data as a quoted JS string', () => {
  // DB-generated ids and dates only; names go through jsArg() or data-* attributes.
  const ALLOWED = new Set(['row.id', 'comp.id', 'gs.id', 'ev.id', 'r.id', 'row.week_start', "id.split('-').slice(1).join('-')", 'id',
    "m.machine==='probat'?'probat_batch_lbs':'batch_size_lbs'", "m.machine==='probat'?'probat_shrink_pct':'shrinkage_pct'"])
  const rx = /\son[a-z]+="[^"]*?'\$\{([^}]+)\}'/g
  const bad = []
  let m
  while ((m = rx.exec(page))) if (!ALLOWED.has(m[1].trim())) bad.push(m[1])
  assert.deepEqual(bad, [])
})

// ── Round 1 review fixes ─────────────────────────────────────────────────────────────────
test('L2: a refused or rotated server key is a 503 (server problem), not a 401 that asks everyone to sign in', async () => {
  setup({ mode: 'badkey' })
  const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.equal(r.code, 503)
  assert.match(warnings.join('\n'), /auth:unconfigured/)
})

test('L2: an anonymous Supabase user (if anonymous sign-ins were ever switched on) is refused', async () => {
  setup({ mode: 'anonymous' })
  assert.equal((await call(shopifyToken, { ...HANDLERS[2][2], authorization: `Bearer ${GOOD}` })).code, 401)
  assert.equal(calls.length, 0)
})

test('L2: the log line names the device (user agent), never the token', async () => {
  setup()
  await shippoLabel({ method: 'POST', query: {}, body: {}, url: '/api/shippo-label?action=label', headers: { authorization: 'Bearer not.the.token', 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0)\u0007"' } },
    { status() { return this }, json() { return this }, setHeader() {} })
  assert.match(warnings.join('\n'), /auth:invalid POST \/api\/shippo-label enforce=1 ua="Mozilla\/5\.0 \(iPad; CPU OS 18_0\)"/)
  assert.ok(!warnings.join('\n').includes('not.the.token'))
})

test('L2: double-charge guard under the new auth: a refused or failed one-label lookup buys nothing', async () => {
  for (const [enforce, authorization, lookup] of [
    [true, `Bearer ${GOOD}`, 'refused'],   // e.g. a token PostgREST rejects though Auth accepted it
    [true, `Bearer ${GOOD}`, 'throw'],     // Supabase unreachable
    [false, undefined, 'refused'],         // migration in, enforcement off, a page with no token
    [false, 'Bearer not.the.token', 'refused']
  ]) {
    setup({ enforce, lookup })
    const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization })
    // 503 at the lookup, or 401 before it (a label buy always needs a staff sign-in)
    assert.equal(r.code, authorization === `Bearer ${GOOD}` ? 503 : 401, `${enforce} ${authorization} ${lookup}`)
    assert.equal(calls.filter(c => c.url.endsWith('/shipments/') || c.url.endsWith('/transactions/')).length, 0)
    assert.equal(calls.filter(c => c.url.includes('/rest/v1/shipping_labels')).length, 0)
  }
  // The one-label lookup runs as the caller, with a timeout.
  setup()
  await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${GOOD}` })
  assert.equal(calls.find(c => c.url.includes('/rpc/ship_labels_for_order')).headers.Authorization, `Bearer ${GOOD}`)
})

test('L2: ship-doc fetches labels from Shippo\'s own domain only', async () => {
  for (const [label_url, code] of [
    ['https://deliver.goshippo.com/abc.pdf', 200],
    ['https://shippo-delivery-east.s3.amazonaws.com/abc.pdf', 400],
    ['https://evil-shippo.s3.amazonaws.com/x.pdf', 400],
    ['https://goshippo.com.evil.test/x.pdf', 400],
    ['https://evilgoshippo.com/x.pdf', 400]
  ]) {
    setup()
    const r = await call(shipDoc, { method: 'POST', body: { boxes: [{ box_index: 1, label_url }], include_labels: true }, authorization: `Bearer ${GOOD}` })
    if (code === 400) assert.equal(r.code, 400, label_url)
    else assert.notEqual(r.code, 400, label_url)
  }
})

test('L3: sign out is refused mid-buy and mid-fulfill, and signs out this device only', async () => {
  for (const [shipBuyInFlight, shipState, refused] of [[true, null, true], [false, { phase: 'fulfilling' }, true], [false, { phase: 'bought' }, false], [false, null, false]]) {
    let alerted = false, scope = null
    const F = loadFromIndex(['signOut'], {
      shipBuyInFlight, shipState, alert: () => { alerted = true }, confirm: () => true,
      sb: { auth: { signOut: async (o) => { scope = o.scope } } }
    })
    await F.signOut()
    assert.equal(alerted, refused)
    assert.equal(scope, refused ? null : 'local')
  }
})

test('L2: a label purchase with under two minutes left on the token is refused (401) before anything is bought', async () => {
  const SOON = jwt(Math.floor(Date.now() / 1000) + 60)
  goodTokens.add(SOON)
  setup()
  const r = await call(shippoLabel, { ...HANDLERS[0][2], authorization: `Bearer ${SOON}` })
  assert.equal(r.code, 401)
  assert.match(r.payload.error, /about to expire/)
  assert.equal(calls.length, 0)
  // Rating doesn't need it.
  setup()
  assert.equal((await call(shippoLabel, { method: 'POST', query: { action: 'rate' }, body: LABEL_BODY, authorization: `Bearer ${SOON}` })).code, 200)
})
