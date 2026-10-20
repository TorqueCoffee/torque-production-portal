// lib/ship-rules.js — the shipping rules the page and the server must agree on (B2a,
// docs/Retail-USPS-UPS.md). One copy, loaded two ways:
//   browser: <script src="/lib/ship-rules.js"> defines the global `ShipRules`
//   Node:    require('../lib/ship-rules.js')
// Pure functions and constants only: no DOM, no fetch, no Node APIs. The server re-packs
// every order with this file before buying a label (api/shippo-label.js), so a page that
// sends a different weight is refused rather than trusted.
// Everything in lib/ is served to every visitor (ADR 0022): browser-safe code only. Server-only
// helpers (Shopify, Shippo, secrets) go in api/_*.js. tests/syntax.test.js enforces this.
// Tested: tests/b0-ups.test.js (B2a block).
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ShipRules = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // ── Weight per unit (R10 in docs/RETAIL_SHIPPING_RULES.md) ─────────────────────────────
  // The size in the variant title, then in the product title, then Shopify's per-line
  // `grams`. Grams first was wrong for 98 of 576 variants (La Mora 5lb stores 340 g, so 4
  // bags read as 3 lb). xPods and the 250 g box count as a 12 oz bag (R3). Returns POUNDS, or
  // null if unknown or ambiguous: the packer flags null-weight items as unpackable rather
  // than guessing.
  const GRAMS_PER_LB = 453.59237
  const KG_PER_LB = 0.45359237
  // Coffee bags come in clean 0.25-lb increments (12oz, 1/2/5 lb). Shopify stores grams
  // rounded (a "5 lb" bag = 2270 g = 5.004 lb), which would push 4×5lb to 20.016 > the 20 lb
  // cap and waste a box. Snap to the nearest quarter-pound to recover the nominal weight and
  // honor the "4×5lb = 20 flat" decision.
  function snapQuarterLb(lb) { return Math.round(lb * 4) / 4 }
  function resolveWeightLb(item) {
    for (const title of [item && item.variant_title, item && item.title]) {
      const w = weightFromTitle(title)
      if (w === HOLD) return null      // the title names a size we must not guess at
      if (w != null) return w
    }
    const g = Number(item && item.grams)
    if (Number.isFinite(g) && g > 0) return snapQuarterLb(g / GRAMS_PER_LB)
    return null
  }
  // The bag size printed in a title, in pounds. null when the title names no size. HOLD when
  // it names one that can't be read as a single bag: a multipack ("2 x 12oz", "6 pack",
  // "case of 6") or a fraction ("1/2 lb"). The first number+unit wins, so "xPods Bulk 45lb
  // Box" is 45 lb; xPods and 250 g count as 12 oz (R3) only when no other size is given.
  const HOLD = Symbol('hold')
  const MULTI_OR_FRACTION_RX = /\d+\s*[x×]\s*\d|(?:^|[^a-z])[x×]\s*\d|\bpack\b|\bcase\s+of\b|\d+\s*\/\s*\d+/i
  const SIZE_RX = /(\d+(?:\.\d+)?|\.\d+)\s*(lbs?|pounds?|oz|ounces?|kg|kilograms?|g|grams?)\b/i
  function weightFromTitle(title) {
    if (!title) return null
    const t = String(title).slice(0, 255)   // Shopify titles are at most 255; bounds the regex work
    if (MULTI_OR_FRACTION_RX.test(t)) return HOLD
    const m = t.match(SIZE_RX)
    if (m) {
      const n = parseFloat(m[1]), u = m[2].toLowerCase()
      if (u[0] === 'o') return Math.round((n / 16) * 1000) / 1000           // ounces
      if (u[0] === 'k') return Math.round((n / KG_PER_LB) * 1000) / 1000    // kilograms
      if (u[0] === 'g') return n === 250 ? 0.75 : Math.round((n / GRAMS_PER_LB) * 1000) / 1000   // grams; R3: 250 g box = 12 oz
      return n                                                               // pounds
    }
    if (/\bx\s*pods?\b/i.test(t)) return 0.75   // R3: an xPods box counts as 12 oz
    return null
  }

  // ── Which B2B lines ship ──────────────────────────────────────────────────────────────
  // Shipping-weight filler products ("5 lb weight for shipping") pad the weight Shopify
  // Shipping used to quote. They are not packed; under UPS a filler line would add a real
  // box and label (ADR 0016 warns about the same name).
  const SHIPPING_FILLER_RX = /weight for shipping/i
  function isShippableB2BLine(it) {
    return it.vendor === 'Torque Coffees' && it.fulfillment_status !== 'fulfilled' && !SHIPPING_FILLER_RX.test(it.title || '')
  }
  // Shopify REST line items -> the packer's items. The order list (?type=b2b-ship) and the
  // label check both go through here, so they can't disagree about what is in the box.
  // Quantity is what is still to ship: `fulfillable_quantity` drops with order edits, refunds
  // and partial fulfillments, while `quantity` keeps the original count. Lines with nothing
  // left are dropped.
  function shipQty(it) {
    return Number.isInteger(it.fulfillable_quantity) ? it.fulfillable_quantity : it.quantity
  }
  function b2bShipItems(lineItems) {
    return (lineItems || []).filter(it => isShippableB2BLine(it) && shipQty(it) > 0).map(it => ({
      sku: it.sku || null,
      product_name: it.title,
      variant_title: it.variant_title || 'Default',
      qty: shipQty(it),
      grams: it.grams != null ? it.grams : null,
      weight_lb: resolveWeightLb(it)
    }))
  }

  // ── B2B box packer (pure) ─────────────────────────────────────────────────────────────
  // Packs order line items into the fewest boxes, each <= 40 lb net, then puts each box that
  // holds 20 lb or less in the smaller carton (ADR 0030, ADR 0031):
  //   14x10x10 up to 20 lb (the USPS cubic ceiling, kept under UPS, ADR 0020)
  //   20x15x10 (Uline S-11378) over 20 lb, up to 40 lb: 8 x 5 lb, declared 43 lb, under
  //   UPS's 50 lb additional-handling line
  // So 6 x 5 lb is one 20x15x10, 8 x 5 lb is one 20x15x10, 10 x 5 lb is a 20x15x10 and a 14x10x10.
  // weight_lb = per-UNIT nominal net weight (resolveWeightLb: title, then grams). The caps
  // are NET weight; the weight declared to Shippo adds measured bag weight + box tare
  // (declaredWeightLb).
  // Fit/volume is NOT modeled by design — the human eyeball-confirm step verifies
  // physical fit before any label is bought.
  const PACK_BOX = Object.freeze({ label: '14x10x10', maxWeightLb: 20 })
  const PACK_BOX_LARGE = Object.freeze({ label: '20x15x10', maxWeightLb: 40 })

  // Hardcoded per-SKU physical unit overrides.
  // Some products are priced/sold as one unit but physically ship as multiple boxes
  // (e.g. TCCDS-40 prices as one 40lb line item but ships as 2x 20lb boxes). Key = SKU
  // exactly as it appears in Shopify. Extend this map if more such SKUs appear; do not
  // build a general config system for a single known case — see ADR on this decision.
  // `solo`: each unit ships alone in the 14x10x10; nothing else is packed with it. TCCDS-40
  // stays 2 x 20 lb for now (Andy, 2026-10-20); it may move to the large box later.
  const SHIP_UNIT_OVERRIDES = Object.freeze({
    'TCCDS-40': Object.freeze({ units: 2, weight_lb: 20, solo: true }) // Cocoa Drops xBloom Bulk 40lb Box -> 2x 20lb boxes
  })

  // Applies SHIP_UNIT_OVERRIDES to a line-item list before it reaches packBoxes(), so
  // packBoxes keeps working purely on already-correct per-unit weights like every other SKU.
  function expandShipItems(items) {
    return (items || []).map(item => {
      const override = SHIP_UNIT_OVERRIDES[item.sku]
      if (!override) return item
      return { ...item, qty: (item.qty || 0) * override.units, weight_lb: override.weight_lb, solo: !!override.solo }
    })
  }

  function packBoxes(items) {
    const cap = PACK_BOX_LARGE.maxWeightLb
    const EPS = 1e-9
    const units = [], unpackable = []

    for (const it of (items || [])) {
      const qty = Math.max(0, Math.floor(Number(it.qty) || 0))
      const w = Number(it.weight_lb)
      if (qty === 0) continue
      if (!Number.isFinite(w) || w <= 0) {
        unpackable.push({ product_name: it.product_name, variant_title: it.variant_title, qty, weight_lb: it.weight_lb, reason: 'unknown_or_invalid_weight' })
        continue
      }
      if (w > (it.solo ? PACK_BOX.maxWeightLb : cap) + EPS) {
        unpackable.push({ product_name: it.product_name, variant_title: it.variant_title, qty, weight_lb: w, reason: 'unit_exceeds_box_cap' })
        continue
      }
      for (let i = 0; i < qty; i++) units.push({ product_name: it.product_name, variant_title: it.variant_title, weight_lb: w, solo: !!it.solo })
    }

    // First-Fit Decreasing: heaviest first, into the first box that still fits. A solo unit
    // gets a box of its own and nothing joins it.
    units.sort((a, b) => b.weight_lb - a.weight_lb)
    const bins = []
    for (const u of units) {
      const bin = u.solo ? null : bins.find(b => !b.solo && b.weight_lb + u.weight_lb <= cap + EPS)
      if (bin) { bin.units.push(u); bin.weight_lb += u.weight_lb }
      else bins.push({ weight_lb: u.weight_lb, units: [u], solo: u.solo })
    }

    const box_count = bins.length
    const boxes = bins.map((bin, idx) => ({
      box_index: idx + 1, box_count,
      box_label: bin.solo || bin.weight_lb <= PACK_BOX.maxWeightLb + EPS ? PACK_BOX.label : PACK_BOX_LARGE.label,
      weight_lb: Math.round(bin.weight_lb * 100) / 100,
      contents: packAggregate(bin.units)
    }))
    return { boxes, unpackable, box_count, total_weight_lb: Math.round(bins.reduce((s, b) => s + b.weight_lb, 0) * 100) / 100 }
  }

  // The one way to pack a B2B order's items (from b2bShipItems): SKU overrides, then the
  // packer. The page and the label check both call this, never the pieces.
  function packB2BItems(items) {
    return packBoxes(expandShipItems(items))
  }

  // Collapse units back into {product, variant, qty} lines for the contents block.
  function packAggregate(units) {
    const map = new Map()
    for (const u of units) {
      const key = `${u.product_name} ${u.variant_title}`
      if (!map.has(key)) map.set(key, { product_name: u.product_name, variant_title: u.variant_title, qty: 0, unit_weight_lb: u.weight_lb })
      map.get(key).qty += 1
    }
    return [...map.values()]
  }

  // ── Declared parcel weight (ADR 0020) ─────────────────────────────────────────────────
  // UPS bills actual weight rounded up to the next whole pound (1 lb minimum), so Shippo
  // gets the packed weight, not the coffee weight: ceil(measured net + carton tare + 0.05 lb
  // packing allowance). Measured bag nets and the tare are from docs/carton_weights.csv (A3).
  // A size with no measured net (e.g. the 20 lb TCCDS-40 half-box) counts at its nominal
  // weight. Unknown carton -> null (no rate).
  const MEASURED_NET_LB = Object.freeze({ 0.75: 0.75, 2: 2.03, 5: 5.07 })
  // Tare per carton (A3 docs/carton_weights.csv). The retail cartons are B2's; B2B uses the 14x10x10 and the 20x15x10.
  // 20x15x10: Uline S-11378, 32 lb per bundle of 20 = 1.6 lb a box (Uline's figure, not weighed yet).
  const CARTON_TARE_LB = Object.freeze({ '8x6x3': 0.156, '12x8x6': 0.42, '14x10x10': 0.83, '20x15x10': 1.6 })
  const PACK_ALLOWANCE_LB = 0.05
  function declaredWeightLb(box) {
    if (!box) return null
    const tare = CARTON_TARE_LB[box.box_label || PACK_BOX.label]
    if (tare == null) return null
    let net = 0
    for (const line of (box.contents || [])) {
      const unit = Number(line.unit_weight_lb), qty = Number(line.qty)
      if (!Number.isFinite(unit) || unit <= 0 || !Number.isFinite(qty) || qty <= 0) return null
      net += qty * (MEASURED_NET_LB[unit] ?? unit)
    }
    if (net <= 0) return null
    // Round to 0.001 first so float noise (20.000000004) can't push a whole pound up.
    return Math.max(1, Math.ceil(Math.round((net + tare + PACK_ALLOWANCE_LB) * 1000) / 1000))
  }

  // The parcel sent to Shippo for one packed box: carton inches from its label, declared lb.
  // A carton label that isn't LxWxH, or one with no known tare, gives null: no rate, no
  // label (never a guessed size).
  function boxParcel(box) {
    if (!box) return null
    const dims = String(box.box_label || PACK_BOX.label).split('x').map(Number)
    if (!(dims.length === 3 && dims.every(d => Number.isFinite(d) && d > 0))) return null
    const weight = declaredWeightLb(box)
    if (weight == null) return null
    const [length, width, height] = dims
    return { length, width, height, weight }
  }

  // The whole pack as one string ("14x10x10@22,14x10x10@17"): every box's carton and declared
  // weight, in box order. The label check compares it with the server's own pack, so an order
  // that changed refuses every box, not only the boxes that differ. null if any box can't be
  // shipped.
  function packSignature(boxes) {
    const parts = []
    for (const box of (boxes || [])) {
      const p = boxParcel(box)
      if (!p) return null
      parts.push(`${p.length}x${p.width}x${p.height}@${p.weight}`)
    }
    return parts.length ? parts.join(',') : null
  }

  // ── Retail packer (B2, R2/R3 and A4 oversize_rule.md) ──────────────────────────────────
  // A retail order ships as ONE carton (no split labels, Andy). The carton comes from the fit
  // table by bag counts; a 250 g box and xPods count as a 12 oz bag (R3, resolveWeightLb):
  //   1 x 12 oz                                                   -> 8x6x3
  //   2-4 x 12 oz; 12 oz + 2 lb; 2 x 12 oz + 2 lb; 1-2 x 2 lb; 1 x 5 lb -> 12x8x6
  //   anything else (a 5 lb bag with anything, any other size)       -> 14x10x10
  // The declared weight is declaredWeightLb on that box (ceil(net + tare + 0.05)). Over 30
  // bag-equivalents is held before this (classifyRetailOrder).
  const RETAIL_FITS = Object.freeze([
    { carton: '8x6x3', fits: ['1/0/0'] },
    { carton: '12x8x6', fits: ['2/0/0', '3/0/0', '4/0/0', '1/1/0', '2/1/0', '0/1/0', '0/2/0', '0/0/1'] }
  ])
  const OVERSIZE_CARTON = '14x10x10'
  function retailCarton(items) {
    const n = { 0.75: 0, 2: 0, 5: 0 }
    for (const it of items) {
      if (!(Number(it.weight_lb) in n)) return OVERSIZE_CARTON   // a size the fit table doesn't name
      n[Number(it.weight_lb)] += Number(it.qty) || 0
    }
    const key = `${n[0.75]}/${n[2]}/${n[5]}`
    const hit = RETAIL_FITS.find(f => f.fits.includes(key))
    return hit ? hit.carton : OVERSIZE_CARTON
  }
  // Retail items (retailShipItems) -> the same pack shape packBoxes returns, with one box.
  function packRetail(items) {
    const units = [], unpackable = []
    for (const it of (items || [])) {
      const qty = Math.max(0, Math.floor(Number(it.qty) || 0))
      const w = Number(it.weight_lb)
      if (qty === 0) continue
      if (!Number.isFinite(w) || w <= 0) {
        unpackable.push({ product_name: it.product_name, variant_title: it.variant_title, qty, weight_lb: it.weight_lb, reason: 'unknown_or_invalid_weight' })
        continue
      }
      for (let i = 0; i < qty; i++) units.push({ product_name: it.product_name, variant_title: it.variant_title, weight_lb: w })
    }
    if (!units.length || unpackable.length) return { boxes: [], unpackable, box_count: 0, total_weight_lb: 0 }
    units.sort((a, b) => b.weight_lb - a.weight_lb)
    const net = Math.round(units.reduce((s, u) => s + u.weight_lb, 0) * 100) / 100
    const box = { box_index: 1, box_count: 1, box_label: retailCarton(packAggregate(units).map(l => ({ weight_lb: l.unit_weight_lb, qty: l.qty }))), weight_lb: net, contents: packAggregate(units) }
    return { boxes: [box], unpackable, box_count: 1, total_weight_lb: net }
  }

  // ── Address checks UPS forces (B0 refuses them at purchase; B1 pre-checks them) ─────────
  const UPS_LINE_MAX = 35      // UPS address line limit
  // NFC text for the label. Invisible format characters (zero-width, soft hyphen, bidi marks)
  // are dropped; control characters become spaces.
  function cleanText(v) {
    return v.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  }
  // UPS does not deliver to P.O. boxes: "P.O. Box 12", "PO-Box 7", "P/O Box 5", "PO BOX 9",
  // "POB 12", "P.O.B. 12", "Po Bx 4", "P0 Box 1", "Post Office Box 5", "Postal Box 9". A box
  // word must be followed by a number, so a street named "Pobox Way" still ships. Tested on
  // the NFKC form of the cleaned line.
  const PO_BOX = /\b(?:p[\s.\-\/]*[o0][\s.\-\/]*b(?:o?x)?\.?|post(?:al)?\s+(?:office\s+)?box)\s*(?:#|no\.?)?\s*\d/i
  const isPoBox = line => PO_BOX.test(line.normalize('NFKC'))
  // The retail queue's list-time check (D5 in docs/RETAIL_UI_HANDOFF.md): a Shopify address
  // (address1, address2, city) that purchase would refuse -> { code, text } to fix in Shopify,
  // else null. Same cleaning and limits as recipientAddress in api/shippo-label.js.
  function addressProblem(a) {
    const x = a || {}
    const f = k => (typeof x[k] === 'string' ? cleanText(x[k]) : '')
    if (isPoBox(f('address1')) || isPoBox(f('address2'))) return { code: 'PO_BOX', text: 'P.O. box · UPS cannot deliver. Fix in Shopify' }
    const over = k => Array.from(f(k)).length > UPS_LINE_MAX
    if (over('address1') || over('address2')) return { code: 'LINE_TOO_LONG', text: `Street line over ${UPS_LINE_MAX} characters. Shorten in Shopify` }
    if (over('city')) return { code: 'LINE_TOO_LONG', text: `City over ${UPS_LINE_MAX} characters. Shorten in Shopify` }
    return null
  }

  // ── Retail order list (B1, R1/R1a/R11–R14 in docs/RETAIL_SHIPPING_RULES.md) ─────────────
  // classifyRetailOrder takes the plain order shape api/_retail.js builds from Shopify and
  // decides, first match wins:
  //   EXCLUDE  never listed (pickup, no shipping, B2B, cancelled, refunded, Fellow, Siip)
  //   HOLD     listed with the reason; not shipped by this flow (R1a: no partial shipments)
  //   LIST     shippable; class ELIGIBLE, or DRAFT_COMP_OR_REPLACEMENT (R14)
  // Flags: SUBSCRIPTION (R12), REPLACEMENT (R14), FREE_SHIPPING (R11).
  const TORQUE_VENDOR = 'Torque Coffees'
  const SIIP_SOURCE = '349022519297'
  const DRAFT_SOURCE = 'shopify_draft_order'
  const HOLD_PROVINCES = Object.freeze(['HI', 'AK', 'PR', 'AA', 'AE', 'AP'])
  const MAX_BAG_EQUIV = 30            // 12 oz = 1.0 (A4 oversize_rule.md)
  const BAG_12OZ_LB = 0.75
  const SUBSCRIPTION_TAGS = Object.freeze(['appstle_subscription_recurring_order', 'appstle_subscription_first_order'])
  const SUBSCRIPTION_LINE_KEY = '__appstle-selected-selling-plan'
  const OPEN_HOLD_STATUSES = Object.freeze(['PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'PENDING_FULFILLMENT'])

  // The lines a box would hold: still to ship, physical, not a gift card.
  function retailShipLines(order) {
    return (order.lines || []).filter(l => l.requires_shipping && !l.is_gift_card && l.qty > 0)
  }
  // Packer items for B2: nominal lb per unit by R10 (title, then grams).
  function retailShipItems(order) {
    return retailShipLines(order).map(l => ({
      sku: l.sku || null, product_name: l.title, variant_title: l.variant_title || 'Default', qty: l.qty,
      grams: l.grams, weight_lb: resolveWeightLb({ variant_title: l.variant_title, title: l.title, grams: l.grams })
    }))
  }
  function classifyRetailOrder(order) {
    const o = order || {}
    const tags = (o.tags || []).map(t => String(t).toLowerCase())
    const out = (decision, cls, extra) => ({ decision, class: cls, ...extra })
    if (o.cancelled) return out('EXCLUDE', 'CANCELLED')
    if (tags.includes('fellow')) return out('EXCLUDE', 'FELLOW')
    if (o.source === SIIP_SOURCE) return out('EXCLUDE', 'SIIP_FULFILLMENT')
    const methods = o.delivery_methods || []
    if (methods.includes('PICK_UP')) return out('EXCLUDE', 'PICKUP')
    if (methods.includes('LOCAL')) return out('EXCLUDE', 'LOCAL_DELIVERY')
    if (!methods.length || methods.some(m => m !== 'SHIPPING') || !(o.lines || []).some(l => l.requires_shipping)) return out('EXCLUDE', 'NO_SHIPPING')
    if (o.financial_status === 'REFUNDED' || o.financial_status === 'VOIDED') return out('EXCLUDE', 'REFUNDED')
    const company = String((o.address && o.address.company) || '').trim()
    if (/fellow\s*drops/i.test(company)) return out('EXCLUDE', 'FELLOW_DROPS_COMPANY')
    if (company) return out('EXCLUDE', 'COMPANY_B2B')
    if (o.fulfillment_status !== 'UNFULFILLED') {
      return OPEN_HOLD_STATUSES.includes(o.fulfillment_status) ? out('HOLD', 'NOT_UNFULFILLED', { detail: o.fulfillment_status }) : out('EXCLUDE', 'NOT_OPEN')
    }
    const lines = retailShipLines(o)
    if (!lines.length) return out('EXCLUDE', 'NO_SHIPPING')
    if (o.lines_truncated) return out('HOLD', 'TOO_MANY_LINES')
    const draft = o.source === DRAFT_SOURCE
    if (draft && lines.some(l => !l.has_variant)) return out('HOLD', 'DRAFT_CUSTOM_LINE')
    const a = o.address || {}
    if (!a.zip || a.country !== 'US') return out('HOLD', 'NO_US_ADDRESS')
    if (HOLD_PROVINCES.includes(a.province)) return out('HOLD', 'HI_AK_PR_APO')
    if (lines.some(l => !l.has_variant)) return out('HOLD', 'CUSTOM_LINE_NO_VARIANT')
    if (lines.some(l => l.product_vendor !== TORQUE_VENDOR)) return out('HOLD', 'NON_TORQUE_VENDOR')
    const items = retailShipItems(o)
    if (items.some(i => i.weight_lb == null)) return out('HOLD', 'NO_WEIGHT')
    const bags = items.reduce((n, i) => n + i.qty * i.weight_lb / BAG_12OZ_LB, 0)
    if (bags > MAX_BAG_EQUIV + 1e-9) return out('HOLD', 'OVER_30_BAGS')
    const flags = []
    if (tags.some(t => SUBSCRIPTION_TAGS.includes(t)) || lines.some(l => (l.attribute_keys || []).includes(SUBSCRIPTION_LINE_KEY))) flags.push('SUBSCRIPTION')
    const replacement = draft && !(o.shipping_lines || []).length
    if (replacement) flags.push('REPLACEMENT')
    if ((o.shipping_lines || []).length && shippingCharged(o) === 0) flags.push('FREE_SHIPPING')
    return out('LIST', replacement ? 'DRAFT_COMP_OR_REPLACEMENT' : 'ELIGIBLE', { flags })
  }
  // R11: what the customer paid for shipping, after discounts and shipping refunds. Display only.
  function shippingCharged(order) {
    const cents = (order.shipping_lines || []).reduce((c, l) => c + Math.round(Number(l.amount || 0) * 100), 0) -
      Math.round(Number(order.refunded_shipping || 0) * 100)
    return Math.max(0, cents) / 100
  }

  return Object.freeze({
    resolveWeightLb, weightFromTitle, isShippableB2BLine, b2bShipItems,
    PACK_BOX, PACK_BOX_LARGE, SHIP_UNIT_OVERRIDES, expandShipItems, packBoxes, packAggregate, packB2BItems,
    MEASURED_NET_LB, CARTON_TARE_LB, PACK_ALLOWANCE_LB, declaredWeightLb, boxParcel, packSignature,
    classifyRetailOrder, retailShipItems, shippingCharged, packRetail,
    UPS_LINE_MAX, cleanText, isPoBox, addressProblem
  })
})
