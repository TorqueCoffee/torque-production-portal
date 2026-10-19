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
  // Packs order line items into the fewest 14x10x10 boxes, each <= weight cap.
  // weight_lb = per-UNIT nominal net weight (resolveWeightLb: title, then grams).
  // The 20 lb cap began as the USPS cubic ceiling and stays as the 14x10x10 box limit
  // under UPS (ADR 0020). It is applied to NET weight; the weight declared to Shippo
  // adds measured bag weight + box tare (declaredWeightLb).
  // Fit/volume is NOT modeled by design — the human eyeball-confirm step verifies
  // physical fit before any label is bought.
  const PACK_BOX = Object.freeze({ label: '14x10x10', maxWeightLb: 20 })

  // Hardcoded per-SKU physical unit overrides.
  // Some products are priced/sold as one unit but physically ship as multiple boxes
  // (e.g. TCCDS-40 prices as one 40lb line item but ships as 2x 20lb boxes). Key = SKU
  // exactly as it appears in Shopify. Extend this map if more such SKUs appear; do not
  // build a general config system for a single known case — see ADR on this decision.
  const SHIP_UNIT_OVERRIDES = Object.freeze({
    'TCCDS-40': Object.freeze({ units: 2, weight_lb: 20 }) // Cocoa Drops xBloom Bulk 40lb Box -> 2x 20lb boxes
  })

  // Applies SHIP_UNIT_OVERRIDES to a line-item list before it reaches packBoxes(), so
  // packBoxes keeps working purely on already-correct per-unit weights like every other SKU.
  function expandShipItems(items) {
    return (items || []).map(item => {
      const override = SHIP_UNIT_OVERRIDES[item.sku]
      if (!override) return item
      return { ...item, qty: (item.qty || 0) * override.units, weight_lb: override.weight_lb }
    })
  }

  function packBoxes(items, opts = {}) {
    const cap = opts.maxWeightLb ?? PACK_BOX.maxWeightLb
    const boxLabel = opts.boxLabel ?? PACK_BOX.label
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
      if (w > cap + EPS) {
        unpackable.push({ product_name: it.product_name, variant_title: it.variant_title, qty, weight_lb: w, reason: 'unit_exceeds_box_cap' })
        continue
      }
      for (let i = 0; i < qty; i++) units.push({ product_name: it.product_name, variant_title: it.variant_title, weight_lb: w })
    }

    // First-Fit Decreasing: heaviest first, into the first box that still fits.
    units.sort((a, b) => b.weight_lb - a.weight_lb)
    const bins = []
    for (const u of units) {
      let placed = false
      for (const bin of bins) {
        if (bin.weight_lb + u.weight_lb <= cap + EPS) { bin.units.push(u); bin.weight_lb += u.weight_lb; placed = true; break }
      }
      if (!placed) bins.push({ weight_lb: u.weight_lb, units: [u] })
    }

    const box_count = bins.length
    const boxes = bins.map((bin, idx) => ({
      box_index: idx + 1, box_count, box_label: boxLabel,
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
  const CARTON_TARE_LB = Object.freeze({ '14x10x10': 0.83 })
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

  return Object.freeze({
    resolveWeightLb, weightFromTitle, isShippableB2BLine, b2bShipItems,
    PACK_BOX, SHIP_UNIT_OVERRIDES, expandShipItems, packBoxes, packAggregate, packB2BItems,
    MEASURED_NET_LB, CARTON_TARE_LB, PACK_ALLOWANCE_LB, declaredWeightLb, boxParcel, packSignature
  })
})
