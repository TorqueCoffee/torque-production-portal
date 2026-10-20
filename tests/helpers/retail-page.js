// A sandbox page for the B3b Retail tests (Pack, Fulfill, Done, banners, Void): the page's own
// retail functions loaded out of index.html, with a fake server and a fake DB. Nothing is bought,
// fulfilled or written: apiFetch and sb.rpc are stubs, and every call is logged.
const vm = require('vm')
const { inlineScripts, declarationSource } = require('./index-html')

const NAMES = ['escHtml', 'safeUrl', 'SHIP_CARRIER', 'SHIP_WEIGHT_BASIS', 'RETAIL_MAX_BATCH', 'RETAIL_BUY_ENABLED', 'RETAIL_BUY_PARALLEL', 'RETAIL_BUSY_WAIT_MS', 'RETAIL_AGE_CHIP_DAYS',
  'RETAIL_CARTONS', 'RETAIL_CARTON_DESC', 'RETAIL_HOLD_TEXT', 'RETAIL_HOLD_DETAIL_TEXT', 'RETAIL_EXCLUDED_TEXT', 'RETAIL_ROW_TEXT', 'RETAIL_ROW_CHIP',
  'retailOrders', 'retailExcluded', 'retailLoadedAt', 'retailLoadSeq', 'retailLoading', 'retailError', 'retailSel', 'retailMsg', 'retailShowHold',
  'retailPending', 'retailPendingError', 'retailBatch', 'retailBuyInFlight', 'retailReprinting', 'retailPack',
  'RETAIL_UNRECORDED_KEY', 'RETAIL_UNRECORDED_DAYS', 'retailReadUnrecorded', 'retailSaveUnrecorded', 'retailUnrecorded', 'retailMergeUnrecorded', 'retailRemember', 'retailForget', 'retailClearUnrecorded', 'retailApplyShipTo',
  'retailCartonLabel', 'retailSizeLabel', 'retailAgeDays', 'retailGroups', 'retailReadyOrders', 'retailSelectAllIds', 'retailBilledLb', 'retailApplySubscriptions',
  'loadRetailOrders', 'loadRetailPending', 'retailApplyPending', 'retailToggle', 'retailToggleAll', 'retailChip', 'retailChips', 'retailShipTo', 'retailLines', 'retailShopifyLink', 'retailRow',
  'RETAIL_ROW_BAD', 'retailMoney', 'retailShippoAddress', 'retailPacificDate', 'retailSlip', 'retailBoughtRow', 'retailGoneRow', 'retailBuyAndPrint', 'retailAfterBuy', 'retailPdfTab',
  'retailRun', 'retailPost', 'retailRequest', 'retailTooMany', 'retailQuote', 'retailBuyOne', 'retailRowAction', 'retailPdfRows', 'retailOpenPdf', 'retailPdfFresh',
  'retailPdfButton', 'retailReprintBought', 'retailCloseBatch', 'retailBackToQueue', 'retailPackAndFulfill',
  'retailPackLocked', 'retailBatchOpen', 'retailPackCards', 'retailPackCounts', 'retailOpenPack', 'retailBackFromPack', 'retailSetHeld',
  'retailPackCard', 'renderRetailPack', 'retailResumeBanner', 'renderRetailBatch', 'renderRetail',
  'retailFulfillFailed', 'retailFulfillPost', 'retailFulfillOutcome', 'retailFulfillAsk', 'retailFulfillBack', 'retailFulfillGo', 'retailFulfillRun', 'retailReprintBatch', 'renderRetailDone', 'renderRetailConfirm',
  'retailBannerBusy', 'retailBannerMsg', 'retailGoneIds', 'retailBannerLocked', 'retailRetryFulfill', 'retailClearGone', 'retailRedBanner']

const P = { '8x6x3': { length: 8, width: 6, height: 3, weight: 1 }, '12x8x6': { length: 12, width: 8, height: 6, weight: 2 }, '14x10x10': { length: 14, width: 10, height: 10, weight: 5 } }
let seq = 0
const order = (o = {}) => {
  const n = ++seq
  return { order_id: `gid://shopify/Order/${n}`, order_name: `#${9000 + n}`, created_at: `2026-10-${String(1 + (n % 27)).padStart(2, '0')}T20:00:00Z`, decision: 'LIST', class: 'ELIGIBLE',
    flags: [], note: '', discount_codes: [], subscription: null,
    shipping_address: { name: `Pat ${n}`, address1: `${n} Main St`, address2: '', city: 'San Diego', province: 'CA', zip: '92104', country: 'US', phone: '' },
    items: [{ product_name: 'La Mora - Rodrigo Sanchez, Colombia', variant_title: '12oz', qty: 1, weight_lb: 0.75 }], parcel: P['8x6x3'], fix: null,
    admin_url: `https://admin.shopify.com/store/s/orders/${n}`, ...o,
    pack_sig: o.pack_sig || (() => { const p = o.parcel || P['8x6x3']; return `${p.length}x${p.width}x${p.height}@${p.weight}` })() }
}
// A pending retail row as ship_labels_pending returns it.
const pendingRow = (o, over = {}) => ({ order_id: o.order_id, order_name: o.order_name, labels_bought: 1, box_count: 1, bought_at: '2026-10-20T17:00:00Z', channel: 'retail', held_back_at: null, ...over })
// The saved label row as ship_labels_for_order returns it.
const labelRow = (o, over = {}) => ({ order_id: o.order_id, order_name: o.order_name, box_index: 1, box_count: 1, tracking_number: `1Z${o.order_id.replace(/\D/g, '').padStart(16, '0')}`,
  label_url: `https://deliver.goshippo.com/${o.order_id.replace(/\D/g, '')}.pdf`, status: 'purchased', channel: 'retail', weight_lb: o.parcel ? o.parcel.weight : 1, held_back_at: null, ...over })

// The fake server and DB. `orders` is the Shopify list; `pending` the DB's pending rows (mutable,
// as the DB is); `hold(args)` can override what set_ship_label_held_back answers.
function server({ orders = [], pending = [], labelsFor, hold, listFail = false, rate, label, pdf = () => ({ status: 200 }), fulfill, voidLabel } = {}) {
  const srv = { log: [], rpcLog: [], orders, pending, inFlight: 0, maxInFlight: 0 }
  srv.labelsFor = labelsFor || (id => { const o = srv.orders.find(x => x.order_id === id); return o && srv.pending.some(p => p.order_id === id) ? [labelRow(o)] : [] })
  srv.apiFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null
    srv.log.push({ url, body, busy: srv.inFlight })
    srv.inFlight++; srv.maxInFlight = Math.max(srv.maxInFlight, srv.inFlight)
    try {
      await new Promise(r => setTimeout(r, 1))
      let out
      if (url === '/api/shopify-token?type=retail-ship') out = listFail ? { status: 502, json: { error: 'Shopify is down' } } : { json: { orders: srv.orders, excluded: {} } }
      else if (url === '/api/shippo-label?action=rate') out = rate ? rate(body) : { json: { ok: true, amount: '6.43', currency: 'USD' } }
      else if (url === '/api/shippo-label?action=label') {
        const dflt = { json: { ok: true, cost: body.expected_amount, tracking_number: `1Z${body.order_id.replace(/\D/g, '').padStart(16, '0')}`, label_url: `https://deliver.goshippo.com/${body.order_id.replace(/\D/g, '')}.pdf` } }
        out = (label && label(body)) || dflt
        if (out.json && out.json.ok) srv.pending.push(pendingRow({ order_id: body.order_id, order_name: body.order_name }))   // the cost row the server writes
      } else if (url === '/api/ship-doc') out = pdf(body)
      else if (url === '/api/shopify-fulfill') out = fulfill ? fulfill(body, srv) : { json: { ok: true, notified: true, emailed: true } }
      else if (url === '/api/shippo-label?action=void') out = voidLabel ? voidLabel(body, srv) : { json: { ok: true, row_marked: true } }
      else throw new Error('unexpected ' + url)
      if (out.throw) throw new Error(out.throw)
      const status = out.status || 200
      return { ok: status < 400, status, json: async () => out.json || {}, blob: async () => ({ size: 1, type: out.type || 'application/pdf' }) }
    } finally { srv.inFlight-- }
  }
  srv.rpc = async (fn, args) => {
    srv.rpcLog.push({ fn, args })
    if (fn === 'ship_labels_pending') return { data: srv.pending.map(r => ({ ...r })), error: null }
    if (fn === 'ship_labels_for_order') return { data: srv.labelsFor(args.p_order_id), error: null }
    if (fn === 'set_ship_label_held_back') {
      if (hold) return hold(args, srv)
      const rows = srv.pending.filter(p => p.order_id === args.p_order_id)
      rows.forEach(r => { r.held_back_at = args.p_held ? '2026-10-20T18:00:00Z' : null })
      return { data: rows.length, error: null }
    }
    return { data: null, error: new Error('unexpected rpc ' + fn) }
  }
  srv.calls = part => srv.log.filter(e => e.url.includes(part))
  srv.rpcs = fn => srv.rpcLog.filter(e => e.fn === fn)
  return srv
}

function page({ srv = server(), enabled = true, popup = true, storage = {}, confirmAnswer = false, extra = [] } = {}) {
  const src = inlineScripts().join('\n')
  const el = { innerHTML: '' }
  const opened = [], longTimers = [], confirms = []
  const ctx = {
    SHIP_RULES_LOADED: true, scheduleData: [], applySubscriptionSubstitution: x => x, Date, URL: Object.assign(class extends URL {}, { createObjectURL: () => 'blob:pdf', revokeObjectURL() {} }),
    console, Promise, alerts: [],
    localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v) } },
    setTimeout: (f, ms) => { if (ms >= 60000) { longTimers.push(f); return 0 } return setTimeout(f, Math.min(ms, 5)) },
    alert(m) { ctx.alerts.push(m) }, confirm(m) { confirms.push(m); return typeof ctx.confirmAnswer === 'function' ? ctx.confirmAnswer(m) : ctx.confirmAnswer }, confirmAnswer,
    apiFetch: srv.apiFetch, ensureScheduleData: async () => {},
    sb: { rpc: srv.rpc },
    window: { open: () => { const w = { closed: false, location: { href: '' }, document: { title: '', body: { innerHTML: '' } }, close() { this.closed = true } }; opened.push({ w, before: srv.log.length }); return popup ? w : null } },
    document: { getElementById: id => (id === 'retailBody' ? el : null) }
  }
  const names = [...NAMES, ...extra]
  const code = names.map(n => declarationSource(src, n).replace(/^const (RETAIL_BUY_ENABLED|RETAIL_BUY_PARALLEL|RETAIL_BUSY_WAIT_MS)/, 'let $1')).join('\n') + `
;({ set(o) { if ('orders' in o) { retailOrders = o.orders; retailLoadedAt = Date.now() } if ('pending' in o) retailPending = o.pending; if ('sel' in o) retailSel = new Set(o.sel) },
  get batch() { return retailBatch }, get pack() { return retailPack }, get pending() { return retailPending }, get pendingError() { return retailPendingError }, get inFlight() { return retailBuyInFlight }, get failed() { return retailFulfillFailed }, get bannerMsg() { return retailBannerMsg },
  get sel() { return [...retailSel] }, get loading() { return retailLoading },
  buy: retailBuyAndPrint, toggleAll: retailToggleAll, row: retailRowAction, reprint: retailReprintBought, load: loadRetailOrders, groups: retailGroups,
  back: retailBackToQueue, packAndFulfill: retailPackAndFulfill, openPack: retailOpenPack, backFromPack: retailBackFromPack, setHeld: retailSetHeld,
  cards: retailPackCards, batchOpen: retailBatchOpen, render: renderRetail,
  ask: retailFulfillAsk, askBack: retailFulfillBack, go: retailFulfillGo, run: retailFulfillRun, reprintBatch: retailReprintBatch, retry: retailRetryFulfill, clear: retailClearGone${extra.length ? ', ' + extra.map(n => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ') : ''} })`
  const api = vm.runInNewContext(code, ctx)
  api.html = () => el.innerHTML
  api.opened = opened
  api.confirms = confirms
  api.ctx = ctx
  api.storage = storage
  api.srv = srv
  api.fireLongTimers = () => longTimers.splice(0).forEach(f => f())
  // The RETAIL_BUY_ENABLED flag is a const in the page; the tests run with buying on.
  vm.runInContext(`RETAIL_BUY_ENABLED = ${enabled}; RETAIL_BUSY_WAIT_MS = 5`, ctx)
  return api
}
const eq = (a, b, m) => require('node:assert/strict').deepEqual(JSON.parse(JSON.stringify(a)), b, m)

module.exports = { NAMES, P, order, pendingRow, labelRow, server, page, eq }
