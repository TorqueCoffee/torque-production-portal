// B2 gates (docs/TESTS.md): packRetail puts every listed acceptance order in Phase A's carton at
// Phase A's billed pounds (R2, R3, A4 oversize_rule.md). Pure: no network.
//   node --test "tests/*.test.js"
const test = require('node:test')
const assert = require('node:assert/strict')
const { packRetail, boxParcel, retailShipItems, classifyRetailOrder } = require('../lib/ship-rules.js')
const { normalizeRetailOrder } = require('../api/_retail.js')

const ACCEPT = require('../docs/acceptance_fixtures.json').fixtures
const RAW = require('./fixtures/retail-orders.json').orders
const order = name => normalizeRetailOrder({ ...RAW.find(n => n.name === name), displayFulfillmentStatus: 'UNFULFILLED' })
const parcelOf = items => boxParcel(packRetail(items).boxes[0])
const carton = p => `${p.length}x${p.width}x${p.height}`

test('B2: every listed acceptance order gets Phase A\'s carton and billed pounds', () => {
  const listed = ACCEPT.filter(f => f.decision === 'LIST')
  assert.equal(listed.length, 16)
  for (const f of listed) {
    const o = order(f.order)
    assert.equal(classifyRetailOrder(o).decision, 'LIST', f.order)
    const p = parcelOf(retailShipItems(o))
    assert.equal(carton(p), f.carton, `${f.order} carton (${f.contents})`)
    assert.equal(p.weight, f.billed_lb, `${f.order} billed lb (${f.contents})`)
  }
})

const bags = (...spec) => spec.map(([qty, weight_lb], i) => ({ product_name: `C${i}`, variant_title: String(weight_lb), qty, weight_lb }))

test('B2: the fit table (R2) and the A4 oversize combinations', () => {
  const cases = [
    [[[1, 0.75]], '8x6x3', 1],
    [[[2, 0.75]], '12x8x6', 2], [[[3, 0.75]], '12x8x6', 3], [[[4, 0.75]], '12x8x6', 4],
    [[[1, 0.75], [1, 2]], '12x8x6', 4], [[[2, 0.75], [1, 2]], '12x8x6', 4],
    [[[1, 2]], '12x8x6', 3], [[[2, 2]], '12x8x6', 5], [[[1, 5]], '12x8x6', 6],
    // A4 oversize_rule.md table: all one 14x10x10 label
    [[[5, 0.75]], '14x10x10', 5], [[[1, 0.75], [2, 2]], '14x10x10', 6], [[[7, 0.75]], '14x10x10', 7],
    [[[3, 2]], '14x10x10', 7], [[[1, 2], [1, 5]], '14x10x10', 8], [[[3, 2], [1, 5]], '14x10x10', 13],
    [[[1, 5], [1, 0.75]], '14x10x10', 7],                                   // a 5 lb bag never ships with a 12 oz in the 12x8x6
    [[[2, 5]], '14x10x10', 12]
  ]
  for (const [spec, want, lb] of cases) {
    const p = parcelOf(bags(...spec))
    assert.equal(carton(p), want, JSON.stringify(spec))
    assert.equal(p.weight, lb, JSON.stringify(spec))
  }
  // Two lines of the same size count together; a size outside the table goes to the 14x10x10.
  assert.equal(carton(parcelOf(bags([1, 0.75], [1, 0.75]))), '12x8x6')
  assert.equal(carton(parcelOf(bags([1, 1]))), '14x10x10')
})

test('B2: one carton per order, never split; unweighable or empty orders pack to nothing', () => {
  const big = packRetail(bags([30, 0.75]))
  assert.equal(big.box_count, 1)
  assert.equal(big.boxes[0].box_label, '14x10x10')
  assert.equal(boxParcel(big.boxes[0]).weight, 24)                          // 22.5 + 0.83 + 0.05 -> 24
  assert.deepEqual(packRetail([]).boxes, [])
  const bad = packRetail([...bags([1, 0.75]), { product_name: 'X', variant_title: 'Pack', qty: 1, weight_lb: null }])
  assert.deepEqual(bad.boxes, [])
  assert.equal(bad.unpackable.length, 1)
})
