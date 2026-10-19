// B1 UI gates (docs/TESTS.md): the Retail tab's queue. Pure helpers and the render are loaded
// out of index.html (tests/helpers/index-html.js); no browser, no network.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const fs = require('fs')
const { inlineScripts, declarationSource, SHIP_RULES } = require('./helpers/index-html')
const ShipRules = (() => { const c = {}; vm.runInNewContext(fs.readFileSync(SHIP_RULES, 'utf8'), c); return c.ShipRules })()

// The shared address check (also used by the label endpoint, so the queue and purchase agree).
test('B1 UI: addressProblem catches what purchase refuses, and only that', () => {
  const A = ShipRules.addressProblem
  for (const line of ['PO Box 123', 'P.O. Box 12', 'p/o box 5', 'Post Office Box 5', 'POB 12', 'P0 Box 1', 'ＰＯ ＢＯＸ 9']) {
    assert.equal(A({ address1: line, city: 'X' }).code, 'PO_BOX', line)
  }
  assert.equal(A({ address1: '1 Main St', address2: 'PO Box 7' }).code, 'PO_BOX')        // line 2 counts
  assert.equal(A({ address1: '12 Pobox Way' }), null)                                    // a street named Pobox
  assert.equal(A({ address1: 'x'.repeat(35) }), null)                                    // 35 is allowed
  assert.equal(A({ address1: 'x'.repeat(36) }).code, 'LINE_TOO_LONG')
  assert.equal(A({ address1: '1 Main', address2: 'y'.repeat(36) }).code, 'LINE_TOO_LONG')
  assert.match(A({ address1: '1 Main', city: 'c'.repeat(36) }).text, /^City over 35/)
  assert.equal(A({ address1: '😀'.repeat(35) }), null)                                   // counted by character, not UTF-16 unit
  assert.equal(A({ address1: '1​' + 'x'.repeat(34) }), null)                        // invisible characters are dropped first
  assert.equal(A(null), null)
  assert.equal(A({ address1: 123 }), null)                                               // not a string: nothing to check
})

// Load the queue's declarations into one sandbox, with settable state and a fake document.
function queue(extraGlobals = {}) {
  const src = inlineScripts().join('\n')
  const names = ['escHtml', 'safeUrl', 'RETAIL_MAX_BATCH', 'RETAIL_BUY_ENABLED', 'RETAIL_AGE_CHIP_DAYS', 'RETAIL_CARTONS', 'RETAIL_CARTON_DESC',
    'RETAIL_HOLD_TEXT', 'RETAIL_HOLD_DETAIL_TEXT', 'RETAIL_EXCLUDED_TEXT', 'retailOrders', 'retailExcluded', 'retailLoadedAt', 'retailLoading', 'retailError', 'retailSel',
    'retailMsg', 'retailShowHold', 'retailCartonLabel', 'retailSizeLabel', 'retailAgeDays', 'retailGroups', 'retailReadyOrders',
    'retailSelectAllIds', 'retailBilledLb', 'retailApplySubscriptions', 'retailToggle', 'retailToggleAll', 'retailToggleHold', 'retailChip',
    'retailChips', 'retailShipTo', 'retailLines', 'retailShopifyLink', 'retailRow', 'renderRetail',
    'retailPending', 'retailPendingError', 'retailBatch', 'retailBuyInFlight', 'retailReprinting', 'retailBoughtRow', 'retailGoneRow']
  const el = { innerHTML: '' }
  const all = { checked: false, indeterminate: false }
  const { elements = {}, ...globals } = extraGlobals
  const ctx = { SHIP_RULES_LOADED: true, scheduleData: [], applySubscriptionSubstitution: x => x, Date, URL, console,
    document: { getElementById: id => (id === 'retailBody' ? el : id === 'retailAll' ? all : elements[id] || null) }, ...globals }
  const code = names.map(n => declarationSource(src, n).replace(/^const RETAIL_AGE_CHIP_DAYS/, 'let RETAIL_AGE_CHIP_DAYS')).join('\n') + `
;({ set(o) { if ('orders' in o) retailOrders = o.orders; if ('excluded' in o) retailExcluded = o.excluded; if ('loadedAt' in o) retailLoadedAt = o.loadedAt;
  if ('sel' in o) retailSel = new Set(o.sel); if ('err' in o) retailError = o.err; if ('ageDays' in o) RETAIL_AGE_CHIP_DAYS = o.ageDays },
  get sel() { return [...retailSel] }, get msg() { return retailMsg }, get showHold() { return retailShowHold },
  groups: retailGroups, selectAllIds: retailSelectAllIds, sizeLabel: retailSizeLabel, ageDays: retailAgeDays, billed: retailBilledLb,
  carton: retailCartonLabel, apply: retailApplySubscriptions, toggle: retailToggle, toggleAll: retailToggleAll, toggleHold: retailToggleHold, render: renderRetail })`
  const out = vm.runInNewContext(code, ctx)
  out.html = () => el.innerHTML
  out.all = all
  return out
}

const P = { '8x6x3': { length: 8, width: 6, height: 3, weight: 1 }, '12x8x6': { length: 12, width: 8, height: 6, weight: 2 }, '14x10x10': { length: 14, width: 10, height: 10, weight: 4 } }
let seq = 0
const order = (o = {}) => {
  const n = ++seq
  return { order_id: `gid://shopify/Order/${n}`, order_name: `#${9000 + n}`, created_at: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T12:00:00Z`, decision: 'LIST', class: 'ELIGIBLE', flags: [], note: '', discount_codes: [],
    shipping_address: { province: 'CA', zip: '92104' }, items: [{ product_name: 'La Mora', variant_title: '12oz', qty: 1, weight_lb: 0.75 }], parcel: P['8x6x3'], fix: null, admin_url: `https://admin.shopify.com/store/s/orders/${n}`, ...o }
}

test('B1 UI: orders sort into Needs a fix, one group per carton, and Hold; nothing unsized or fixable is ever ready', () => {
  const q = queue()
  const a = order(), b = order({ parcel: P['12x8x6'] }), c = order({ parcel: P['14x10x10'] })
  const fixed = order({ fix: { code: 'PO_BOX', text: 'P.O. box · UPS cannot deliver. Fix in Shopify' } })
  const unsized = order({ parcel: null }), odd = order({ parcel: { length: 9, width: 9, height: 9, weight: 3 } })
  const held = order({ decision: 'HOLD', class: 'OVER_30_BAGS', parcel: null })
  const g = q.groups([a, b, c, fixed, unsized, odd, held])
  assert.deepEqual(structuredClone(g.ready), { '8x6x3': [a], '12x8x6': [b], '14x10x10': [c] })
  assert.equal(g.fix.length, 3)
  assert.match(g.fix.find(f => f.order === unsized).why, /No carton size/)
  assert.equal(g.fix.find(f => f.order === odd).why.startsWith('No carton size'), true)  // a carton the table doesn't name
  assert.deepEqual(structuredClone(g.hold), [held])
})

test('B1 UI: Select all takes the oldest ready orders, never more than 25, never a fix or hold row', () => {
  const q = queue()
  const many = Array.from({ length: 30 }, (_, i) => order({ created_at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))
  const fixed = order({ fix: { code: 'PO_BOX', text: 'x' }, created_at: '2026-01-01T00:00:00Z' })
  const held = order({ decision: 'HOLD', class: 'OVER_30_BAGS', created_at: '2026-01-02T00:00:00Z' })
  const ids = q.selectAllIds(q.groups([...many, fixed, held]))
  assert.equal(ids.length, 25)
  assert.deepEqual(structuredClone(ids), many.slice(0, 25).map(o => o.order_id))
  assert.ok(!ids.includes(fixed.order_id) && !ids.includes(held.order_id))
})

test('B1 UI: a fresh load has nothing ticked and Buy off; ticking, Select all and the 25 cap behave', () => {
  const q = queue()
  const rows = Array.from({ length: 27 }, (_, i) => order({ parcel: i % 2 ? P['12x8x6'] : P['8x6x3'] }))
  q.set({ orders: rows, loadedAt: Date.now(), sel: [] })
  q.render()
  let html = q.html()
  assert.equal((html.match(/type="checkbox"[^>]* checked/g) || []).length, 0)
  assert.match(html, /<b>0 selected<\/b>/)
  assert.match(html, /class="btn btn-primary rt-buy" onclick="retailBuyAndPrint\(\)" disabled>Buy and print 0 labels/)
  assert.match(html, /Pack in 8x6x3 · 14 orders/)
  assert.match(html, /Pack in 12x8x6 · 13 orders/)
  assert.doesNotMatch(html, /\$\d/)                                                       // no dollar estimate on the queue
  q.toggle(rows[0].order_id)
  assert.deepEqual(structuredClone(q.sel), [rows[0].order_id])
  assert.equal(q.all.indeterminate, true)                                                 // some ticked: Select all shows half-ticked
  q.toggle(rows[0].order_id)
  assert.equal(q.sel.length, 0)
  assert.equal(q.all.indeterminate, false)
  q.toggleAll()
  assert.equal(q.sel.length, 25)
  assert.match(q.msg, /oldest 25 of 27/)
  assert.match(q.html(), /<b>25 selected<\/b> <span class="mut">of 27 ready · \d+ billed lb/)
  assert.equal(q.all.indeterminate, false)                                                // the oldest 25 is "all": not half-ticked
  q.toggle(rows.find(r => !q.sel.includes(r.order_id)).order_id)                          // a 26th tick
  assert.equal(q.sel.length, 25)
  assert.match(q.msg, /25 orders at most/)
  q.toggleAll()                                                                           // a second Select all clears
  assert.equal(q.sel.length, 0)
  // billed lb is the sum of the server's declared pounds
  assert.equal(q.billed([rows[0], rows[1]]), 3)
  assert.equal(q.billed([order({ parcel: null })]), 0)
})

test('B1 UI: a fix row, or any id that is not a ready row, cannot be ticked', () => {
  const q = queue()
  const ok = order(), fixed = order({ fix: { code: 'PO_BOX', text: 'P.O. box · UPS cannot deliver. Fix in Shopify' } }), held = order({ decision: 'HOLD', class: 'NO_WEIGHT', parcel: null })
  q.set({ orders: [ok, fixed, held], loadedAt: Date.now(), sel: [] })
  q.toggle(fixed.order_id); q.toggle(held.order_id); q.toggle('gid://shopify/Order/nope')
  assert.equal(q.sel.length, 0)
  q.render()
  const html = q.html()
  assert.match(html, /Needs a fix · 1/)
  assert.match(html, /P\.O\. box · UPS cannot deliver/)
  assert.match(html, new RegExp(`data-id="${fixed.order_id.replace(/\//g, '\\/')}"[^>]*disabled`))
  assert.match(html, /1 need a fix/); assert.match(html, /1 on hold/); assert.match(html, /1 ready/)
})

test('B1 UI: chips show only what changes the work: replacement reason, note, age (when set), no-coffee', () => {
  const q = queue()
  const plain = order()
  const rep = order({ flags: ['REPLACEMENT'], discount_codes: ['Mis ship'] })
  const rep2 = order({ flags: ['REPLACEMENT'], discount_codes: [] })
  const noted = order({ note: 'Gift for <b>Sam</b>' })
  const sub = order({ flags: ['SUBSCRIPTION'], items: [{ product_name: 'Classicist - Coffee Subscription', variant_title: '12oz', qty: 1, weight_lb: 0.75, note: '⚠ No coffee set for this week' }] })
  const free = order({ flags: ['FREE_SHIPPING', 'SUBSCRIPTION'] })
  q.set({ orders: [plain, rep, rep2, noted, sub, free], loadedAt: Date.now(), sel: [] })
  q.render()
  const html = q.html()
  assert.match(html, /REPLACEMENT · Mis ship/)
  assert.match(html, /REPLACEMENT · reason not recorded/)
  assert.match(html, /NOTE · read before shipping/)
  assert.match(html, /Note: Gift for &lt;b&gt;Sam&lt;\/b&gt;/)                              // the note is escaped
  assert.match(html, /No coffee set this week\. Set it in Subscriptions/)
  assert.doesNotMatch(html, /SUBSCRIPTION|COLLECTIVE|FREE_SHIPPING|days old/)               // D3/D4; age chip is off until Andy sets N
  const old = order({ created_at: new Date(Date.now() - 6 * 86400000).toISOString() })
  q.set({ orders: [old], ageDays: 5 }); q.render()
  assert.match(q.html(), /6 days old/)
  q.set({ ageDays: 7 }); q.render()
  assert.doesNotMatch(q.html(), /days old/)
  assert.equal(q.ageDays({ created_at: 'nope' }, Date.now()), null)
})

test('B1 UI: the coffees show on every line with a size; hold list shows the reason and a safe Shopify link; names are escaped', () => {
  const q = queue()
  const o = order({ order_name: '#1<script>', items: [
    { product_name: 'Dark Drop xPods', variant_title: '8 xPods', qty: 1, weight_lb: 0.75 },
    { product_name: 'BomBón', variant_title: '2lb Bag', qty: 2, weight_lb: 2 },
    { product_name: 'Big', variant_title: '5lb', qty: 1, weight_lb: 5 },
    { product_name: 'Odd', variant_title: '1kg', qty: 1, weight_lb: 2.2 },
    { product_name: 'Jorge Zuniga', variant_title: '250g Coffee Box', qty: 2, weight_lb: 0.75 },
    { product_name: 'Cocoa Drops xBloom', variant_title: 'xPods Bulk 45lb Box', qty: 1, weight_lb: 45 }] })
  const h = order({ decision: 'HOLD', class: 'NOT_UNFULFILLED', detail: 'ON_HOLD', parcel: null, admin_url: 'javascript:alert(1)' })
  const h3 = order({ decision: 'HOLD', class: 'NOT_UNFULFILLED', detail: 'PARTIALLY_FULFILLED', parcel: null })
  const h4 = order({ decision: 'HOLD', class: 'NOT_UNFULFILLED', detail: 'SOMETHING_NEW', parcel: null })
  const h2 = order({ decision: 'HOLD', class: 'OVER_30_BAGS', parcel: null })
  q.set({ orders: [o, h, h2, h3, h4], excluded: { PICKUP: 2, COMPANY_B2B: 3, ZERO: 0 }, loadedAt: Date.now(), sel: [] })
  q.render()
  let html = q.html()
  assert.match(html, /<b>1×<\/b> 8 xPods · Dark Drop xPods/)                              // the count the box holds
  assert.match(html, /<b>2×<\/b> 250g · Jorge Zuniga/)                                    // weighs as 12 oz, but it is a 250 g box to pick
  assert.match(html, /<b>1×<\/b> xPods Bulk 45lb Box · Cocoa Drops xBloom/)               // not a 12 oz line: the variant text, not "xPods"
  assert.match(html, /<b>2×<\/b> 2lb · BomBón/)
  assert.match(html, /<b>1×<\/b> 5lb · Big/)
  assert.match(html, /<b>1×<\/b> 1kg · Odd/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /Not listed right now: 2 pickup, 3 B2B\./)
  assert.doesNotMatch(html, /Over 30 × 12oz/)                                              // hold list is collapsed
  q.toggleHold()
  html = q.html()
  assert.match(html, /rt-hold-why">On hold in Shopify</)                                  // Shopify's status, said once
  assert.match(html, /rt-hold-why">Partly fulfilled in Shopify</)
  assert.match(html, /rt-hold-why">Partly fulfilled or on hold in Shopify</)               // a status the page doesn't name
  assert.match(html, /Over 30 × 12oz by weight/)                                          // bag-equivalents, not bags (a 5 lb bag is 6.7)
  assert.doesNotMatch(html, /javascript:/)                                                 // an unsafe link is dropped
  assert.match(html, new RegExp(`class="btn btn-secondary btn-sm rt-tap" href="${h2.admin_url.replace(/[.\/]/g, '\\$&')}" target="_blank" rel="noopener">Open in Shopify`))
  assert.match(html, /Hide hold list/)
})

test('B1 UI: states: loading, error, empty', () => {
  let q = queue()
  q.render(); assert.match(q.html(), /Loading retail orders/)
  q = queue()
  q.set({ orders: [], loadedAt: Date.now() }); q.render()
  assert.match(q.html(), /No retail orders are waiting to ship/)
  assert.match(q.html(), /Hold \(0\)/)
  // an error replaces the list entirely (never a stale or partial queue) and says so
  q = queue()
  q.set({ orders: [order()], loadedAt: Date.now(), err: 'Shopify retail orders query failed' }); q.render()
  assert.match(q.html(), /Couldn't load retail orders: Shopify retail orders query failed/)
  assert.doesNotMatch(q.html(), /rt-row/)
})

test('B1 UI: subscription lines get this week\'s coffee through the existing function, in one call', () => {
  const calls = []
  const q = queue({ applySubscriptionSubstitution: items => { calls.push(items.length); return items.map(i => (i.product_name === 'Classicist - Coffee Subscription' ? { ...i, product_name: 'La Mora' } : i)) } })
  const a = order({ items: [{ product_name: 'Classicist - Coffee Subscription', variant_title: '12oz', qty: 1 }, { product_name: 'Gum Drop', variant_title: '12oz', qty: 2 }] })
  const b = order({ items: [{ product_name: 'Classicist - Coffee Subscription', variant_title: '12oz', qty: 1 }] })
  const out = q.apply([a, b])
  assert.deepEqual(calls, [3])
  assert.deepEqual(structuredClone(out[0].items.map(i => [i.product_name, i.qty])), [['La Mora', 1], ['Gum Drop', 2]])
  assert.equal(out[1].items[0].product_name, 'La Mora')
  assert.ok(!('_o' in out[0].items[0]) && !('_i' in out[0].items[0]))
})

test('B1 UI: the Retail tab is wired in; loading it only reads', () => {
  const html = fs.readFileSync(require('./helpers/index-html').INDEX, 'utf8')
  assert.match(html, /data-tab="retail" onclick="switchTab\('retail',this\)">Retail</)
  assert.match(html, /<div id="retail" class="view">/)
  assert.match(html, /if \(tab === 'retail'\) initRetailTab\(\)/)
  const code = declarationSource(inlineScripts().join('\n'), 'loadRetailOrders')
  assert.match(code, /apiFetch\('\/api\/shopify-token\?type=retail-ship'\)/)
  assert.doesNotMatch(code, /shippo|fulfill|POST/i)                                       // loading the list buys and writes nothing
  assert.match(html, /const RETAIL_BUY_ENABLED = false/)
})

// ── Fixes from the B1 UI adversarial review (docs/JOURNAL.md, 2026-10-19) ──────────────────
test('B1 UI: loading the queue leaves the Subscriptions tab\'s "no coffee selected" alert as Bagging set it', () => {
  // applySubscriptionSubstitution shows or hides that alert from the lines it is given; the queue's
  // lines are a subset of Bagging's, so it must not decide it.
  const alertEl = { style: { display: 'flex' }, textContent: 'No coffee selected in Schedule for: Modernist' }
  const real = items => { alertEl.style.display = 'none'; return items }   // what the real one does with no missing plan
  let q = queue({ applySubscriptionSubstitution: real, elements: { subMissingAlert: alertEl } })
  q.apply([order()])
  assert.equal(alertEl.style.display, 'flex')
  assert.equal(alertEl.textContent, 'No coffee selected in Schedule for: Modernist')
  alertEl.style.display = 'none'; alertEl.textContent = ''
  const shows = items => { alertEl.style.display = 'flex'; alertEl.textContent = 'x'; return items }
  q = queue({ applySubscriptionSubstitution: shows, elements: { subMissingAlert: alertEl } })
  q.apply([order()])
  assert.equal(alertEl.style.display, 'none')                                             // and it never turns it on either
})

test('B1 UI: ticking a box keeps keyboard focus on it, and the sticky bar sits under the header', () => {
  // A minimal DOM: elements are re-made on every render, as innerHTML does.
  const attrs = html => [...html.matchAll(/<(input|button|a)\b([^>]*)>/g)].map(m => {
    const a = {}; for (const x of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) a[x[1]] = x[2]
    return { tagName: m[1].toUpperCase(), getAttribute: k => (k in a ? a[k].replace(/&quot;/g, '"') : null), focus() { focused = this } }
  })
  let focused = null, els = []
  const style = { vars: {}, setProperty(k, v) { this.vars[k] = v } }
  const body = { style, contains: e => els.includes(e), querySelectorAll: () => els }
  let inner = ''
  Object.defineProperty(body, 'innerHTML', { get: () => inner, set: v => { inner = v; els = attrs(v) } })
  const doc = { body: {}, get activeElement() { return focused || doc.body }, querySelector: s => (s === '.header' ? { offsetHeight: 132 } : null),
    getElementById: id => (id === 'retailBody' ? body : null) }
  const src = inlineScripts().join('\n')
  const names = ['escHtml', 'safeUrl', 'RETAIL_MAX_BATCH', 'RETAIL_BUY_ENABLED', 'RETAIL_AGE_CHIP_DAYS', 'RETAIL_CARTONS', 'RETAIL_CARTON_DESC', 'RETAIL_HOLD_TEXT',
    'RETAIL_HOLD_DETAIL_TEXT', 'RETAIL_EXCLUDED_TEXT', 'retailOrders', 'retailExcluded', 'retailLoadedAt', 'retailLoading', 'retailError', 'retailSel', 'retailMsg',
    'retailShowHold', 'retailCartonLabel', 'retailSizeLabel', 'retailAgeDays', 'retailGroups', 'retailReadyOrders', 'retailSelectAllIds', 'retailBilledLb',
    'retailToggle', 'retailToggleHold', 'retailChip', 'retailChips', 'retailShipTo', 'retailLines', 'retailShopifyLink', 'retailRow', 'renderRetail',
    'retailPending', 'retailPendingError', 'retailBatch', 'retailBuyInFlight', 'retailReprinting']
  const rows = [order(), order(), order()]
  const api = vm.runInNewContext(names.map(n => declarationSource(src, n)).join('\n') +
    `\n;({ init(o) { retailOrders = o; retailLoadedAt = Date.now() }, render: renderRetail, toggle: retailToggle })`, { document: doc, Date, URL, console })
  api.init(rows); api.render()
  assert.equal(style.vars['--rt-top'], '132px')
  focused = els.find(e => e.getAttribute('data-id') === rows[1].order_id)
  api.toggle(rows[1].order_id)                                                            // re-renders: every element is new
  assert.ok(focused && els.includes(focused), 'focus is on a live element')
  assert.equal(focused.getAttribute('data-id'), rows[1].order_id)
  focused = els.find(e => e.getAttribute('onclick') === 'retailToggleHold()')
  api.render()
  assert.equal(focused.getAttribute('onclick'), 'retailToggleHold()')
  assert.ok(els.includes(focused))
})

test('B1 UI: every control is at least 44px to tap, and the table fits an iPad in portrait', () => {
  const html = fs.readFileSync(require('./helpers/index-html').INDEX, 'utf8')
  assert.match(html, /\.rt-tap\{min-height:44px;/)
  const src = inlineScripts().join('\n')
  const render = declarationSource(src, 'renderRetail') + declarationSource(src, 'retailShopifyLink')   // the link is built in its own helper
  for (const label of ['Try again', 'Refresh orders', 'Show hold list', 'Open in Shopify']) {
    const tag = render.slice(render.lastIndexOf('<', render.indexOf(label)), render.indexOf(label))
    assert.match(tag, /rt-tap/, label)
  }
  assert.match(html, /\.rt-cell-check\{[^}]*min-height:44px/)                             // the tick box's whole cell
  // Grid minimums + gaps + padding must fit the 768 view (20px page padding and the 2px box border each side).
  const row = html.match(/\.rt-row\{display:grid;grid-template-columns:([^;]+);[^}]*column-gap:(\d+)px;[^}]*padding:0 (\d+)px;/)
  const cols = row[1].replace(/minmax\((\d+)px,[^)]+\)/g, '$1px').match(/\d+px/g).map(parseFloat)
  const need = cols.reduce((a, b) => a + b, 0) + (cols.length - 1) * Number(row[2]) + 2 * Number(row[3])
  const minWidth = Number(html.match(/\.rt-table\{min-width:(\d+)px\}/)[1])
  assert.ok(need <= minWidth && minWidth <= 768 - 2 * 20 - 2 * 2, `grid needs ${need}px, table min ${minWidth}px`)
})

// B1 was read-only. B3a (ADR 0028) adds buying; this pins exactly what the block may call.
test('B3a: the Retail block calls only the list, rate/label (never void), the batch PDF and two label lookups', () => {
  const html = fs.readFileSync(require('./helpers/index-html').INDEX, 'utf8')
  const block = html.slice(html.indexOf('// RETAIL tab (B1): the queue'), html.indexOf('// MIX GUIDE'))
  assert.ok(block.length > 5000)
  assert.deepEqual([...new Set(block.match(/\/api\/[\w-]+/g))].sort(), ['/api/ship-doc', '/api/shippo-label', '/api/shopify-token'])
  assert.doesNotMatch(block, /shopify-fulfill|action=void|'void'/)                         // no Shopify write, no void (B3b, B6)
  assert.match(block, /\/api\/shippo-label\?action=\$\{action\}/)
  assert.deepEqual([...new Set(block.match(/retailPost\('(\w+)'/g))].sort(), ["retailPost('label'", "retailPost('rate'"])
  assert.doesNotMatch(block, /\)\.(insert|update|upsert|delete)\(/)                          // no table write (retailSel.delete is a Set)
  assert.deepEqual([...new Set(block.match(/sb\.rpc\('(\w+)'/g))].sort(), ["sb.rpc('ship_labels_for_order'", "sb.rpc('ship_labels_pending'"])
  assert.deepEqual(block.match(/sb\.from\('[^']+'\)\.\w+/g), ["sb.from('subscription_schedule').select"])
})

test('B1 UI: a Needs a fix row has an Open in Shopify link (https only), so the address can be corrected', () => {
  const q = queue()
  const fixed = order({ fix: { code: 'PO_BOX', text: 'P.O. box · UPS cannot deliver. Fix in Shopify' } })
  const unsafe = order({ fix: { code: 'PO_BOX', text: 'x' }, admin_url: 'javascript:alert(1)' })
  const ok = order()
  q.set({ orders: [fixed, unsafe, ok], loadedAt: Date.now(), sel: [] }); q.render()
  const html = q.html()
  assert.equal((html.match(/>Open in Shopify</g) || []).length, 1)                 // the fix row only; the ready row has none, the unsafe link is dropped
  assert.match(html, new RegExp(`href="${fixed.admin_url.replace(/[.\/]/g, '\\$&')}" target="_blank" rel="noopener">Open in Shopify`))
  assert.doesNotMatch(html, /javascript:/)
})
