// api/_retail-slip.js — the retail 4x6 packing slip (B4, docs/retail_slip_spec.md, approved
// 2026-10-17; visual target docs/retail_slip_sample.pdf). Not an endpoint (leading "_").
// Used by api/ship-doc.js for the Retail tab's batch PDF: label, then this slip, per order.
//
// Slip input (built by the page from the queue's order, checked by cleanSlip below):
//   { order_name, date: 'YYYY-MM-DD', subscription: null | 'RECURRING' | 'FIRST',
//     replacement: null | reason, name, city_line, lines: [{ qty, size, name }],
//     note, carton: '8x6x3' | '12x8x6' | '14x10x10', billed_lb }

const { rgb } = require('pdf-lib')

const PT = 72
const PAGE_W = 4 * PT, PAGE_H = 6 * PT
const L = 0.25 * PT                     // left margin
const BOX_W = 3.5 * PT                  // note and pack-in boxes
const NAME_X = L + 1.03 * PT, NAME_W = 2.45 * PT
const NAME_SIZES = [10, 9, 8.5, 8]
const ROW_TOP = 1.75, ROW_STEP = 0.30   // inches from the top
const NOTE_TOP = 4.85, NOTE_BOTTOM = 5.30
const PACK_TOP = 5.41, PACK_BOTTOM = 5.75
const BLACK = rgb(0, 0, 0)
const CARTON_NOTE = { '14x10x10': '20 lb box' }
const MAX_LINES = 30, MAX_TEXT = 300

const y = inches => PAGE_H - inches * PT

// Standard fonts are WinAnsi only: a character outside it (an emoji in a note, "ễ" in a name)
// makes pdf-lib throw and would sink the whole batch PDF. Accents are dropped to the base
// letter first; anything still unprintable becomes "?".
function printable(font, s) {
  const out = []
  for (const ch of Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '))) {
    if (canDraw(font, ch)) { out.push(ch); continue }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    out.push(base && Array.from(base).every(c => canDraw(font, c)) ? base : '?')
  }
  return out.join('')
}
function canDraw(font, ch) {
  try { font.encodeText(ch); return true } catch { return false }
}

// The name column (spec "Line item format"): step the size down 10, 9, 8.5, 8; then drop the
// text after the last comma (the country); then cut with "..." but never inside the coffee
// name (the text before " - "), unless the coffee name alone can't fit.
function fitName(font, name) {
  for (const size of NAME_SIZES) if (font.widthOfTextAtSize(name, size) <= NAME_W) return { text: name, size: size }
  const size = 8
  let n = name
  const coffee = name.includes(' - ') ? name.slice(0, name.indexOf(' - ')) : ''
  // The country is the text after the last comma of the producer part, never a comma inside the
  // coffee name (or one at the very start).
  const comma = n.lastIndexOf(',')
  if (comma > 0 && comma > coffee.length) {
    n = n.slice(0, comma).trimEnd()
    if (font.widthOfTextAtSize(n, size) <= NAME_W) return { text: n, size }
  }
  const fits = t => font.widthOfTextAtSize(t + '...', size) <= NAME_W
  while (n.length > 1 && !fits(n) && n.length > coffee.length) n = n.slice(0, -1)
  if (!fits(n)) while (n.length > 1 && !fits(n)) n = n.slice(0, -1)   // the coffee name alone is too long
  return { text: n.trimEnd() + '...', size }
}

// The first size in `sizes` at which `text` fits `width` (the last one if none does).
function fitSize(font, text, width, sizes) {
  return sizes.find(sz => font.widthOfTextAtSize(text, sz) <= width) || sizes[sizes.length - 1]
}
// Cut text to a width with "..." (headers, the replacement reason, the note).
function cut(font, size, text, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let t = text
  while (t.length && font.widthOfTextAtSize(t + '...', size) > width) t = t.slice(0, -1)
  return t.trimEnd() + '...'
}
// Up to `max` lines of `width`, word-wrapped; whatever is left goes on the last line, cut with "...".
function wrap(font, size, text, width, max) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (let i = 0; i < words.length; i++) {
    const next = cur ? cur + ' ' + words[i] : words[i]
    if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue }
    if (lines.length === max - 1) return [...lines, cut(font, size, words.slice(i).reduce((a, w) => a + ' ' + w, cur).trim(), width)]
    if (cur) lines.push(cur)
    cur = words[i]
    if (font.widthOfTextAtSize(cur, size) > width && lines.length === max - 1) return [...lines, cut(font, size, words.slice(i).join(' '), width)]
    if (font.widthOfTextAtSize(cur, size) > width) { lines.push(cut(font, size, cur, width)); cur = '' }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, max)
}

// -> { slip } or { error }. Everything is a string or number of bounded size; the page builds it.
function cleanSlip(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'slip required' }
  const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '')
  const lines = Array.isArray(s.lines) ? s.lines : []
  if (!lines.length || lines.length > MAX_LINES) return { error: 'slip lines: 1 to 30' }
  const out = {
    order_name: str(s.order_name, 40),
    date: /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : '',
    subscription: s.subscription === 'FIRST' || s.subscription === 'RECURRING' ? s.subscription : null,
    replacement: s.replacement == null ? null : str(s.replacement, 120),
    name: str(s.name, 120),
    city_line: str(s.city_line, 120),
    note: str(s.note, 1000).trim(),
    carton: ['8x6x3', '12x8x6', '14x10x10'].includes(s.carton) ? s.carton : null,
    billed_lb: Number.isInteger(s.billed_lb) && s.billed_lb >= 1 && s.billed_lb <= 150 ? s.billed_lb : null,
    lines: []
  }
  if (!out.order_name) return { error: 'slip order_name required' }
  if (!out.carton || !out.billed_lb) return { error: 'slip carton and billed_lb required' }
  for (const l of lines) {
    if (!l || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 999) return { error: 'slip line qty must be a whole number' }
    out.lines.push({ qty: l.qty, size: str(l.size, 20), name: str(l.name, 200) })
  }
  return { slip: out }
}

// Rows that fit on a page: down to the pack-in box, or to the note box when there is a note.
function rowsPerPage(hasNote) {
  const floor = (hasNote ? NOTE_TOP : PACK_TOP) - 0.1
  return Math.floor((floor - ROW_TOP) / ROW_STEP) + 1
}

// Draw one slip (one page, or two or more when the lines don't fit). `slip` is cleanSlip's.
function drawRetailSlip(out, slip, fonts) {
  const { bold, regular } = fonts
  const P = (font, s) => printable(font, s)
  const note = P(regular, slip.note)
  const lines = slip.lines.map(l => ({ qty: `${l.qty}x`, size: P(bold, l.size), name: P(regular, l.name) }))
  const perPage = rowsPerPage(!!note)
  const pages = Math.max(1, Math.ceil(lines.length / perPage))

  for (let p = 0; p < pages; p++) {
    const page = out.addPage([PAGE_W, PAGE_H])
    const text = (t, x, inches, size, font) => page.drawText(t, { x, y: y(inches), size, font, color: BLACK })

    // Header: order number (left), subscription box (right).
    text(cut(bold, 18, P(bold, slip.order_name), 2.0 * PT), L, 0.55, 18, bold)
    if (slip.subscription) {
      const label = slip.subscription === 'FIRST' ? 'SUBSCRIPTION - FIRST' : 'SUBSCRIPTION'
      page.drawRectangle({ x: 2.35 * PT, y: y(0.65), width: 1.4 * PT, height: 0.35 * PT, borderColor: BLACK, borderWidth: 1 })
      const size = fitSize(bold, label, 1.4 * PT - 8, [9, 8, 7.5, 7])
      text(label, 3.05 * PT - bold.widthOfTextAtSize(label, size) / 2, 0.52, size, bold)
    }
    if (pages > 1) {
      const t = `page ${p + 1} of ${pages}`
      text(t, PAGE_W - L - regular.widthOfTextAtSize(t, 8), 0.85, 8, regular)
    }
    // Date, customer, city/state/ZIP; the replacement box beside them.
    const leftW = slip.replacement != null ? 2.0 * PT : BOX_W
    if (slip.date) text(slip.date, L, 0.85, 10, regular)
    text(cut(bold, 11, P(bold, slip.name), leftW), L, 1.12, 11, bold)
    text(cut(regular, 10, P(regular, slip.city_line), leftW), L, 1.30, 10, regular)
    if (slip.replacement != null) {
      const bx = 2.35 * PT, bw = 1.4 * PT
      page.drawRectangle({ x: bx, y: y(1.38), width: bw, height: 0.48 * PT, borderColor: BLACK, borderWidth: 1.5 })
      const w = bold.widthOfTextAtSize('REPLACEMENT', 9)
      text('REPLACEMENT', bx + (bw - w) / 2, 1.07, 9, bold)
      const why = cut(regular, 7, P(regular, slip.replacement || 'reason not recorded'), bw - 8)
      text(why, bx + (bw - regular.widthOfTextAtSize(why, 7)) / 2, 1.26, 7, regular)
    }

    // Line items: Nx | size | name
    lines.slice(p * perPage, (p + 1) * perPage).forEach((l, i) => {
      const at = ROW_TOP + i * ROW_STEP
      text(l.qty, L, at, fitSize(bold, l.qty, 0.25 * PT, [11, 10, 9, 8, 7]), bold)
      text('|', L + 0.27 * PT, at, 11, regular)
      text(cut(bold, 10, l.size, 0.58 * PT), L + 0.35 * PT, at, 10, bold)
      text('|', L + 0.95 * PT, at, 11, regular)
      const n = fitName(regular, l.name)
      text(n.text, NAME_X, at, n.size, regular)
    })

    // Note, above the pack-in box.
    if (note) {
      page.drawRectangle({ x: L, y: y(NOTE_BOTTOM), width: BOX_W, height: (NOTE_BOTTOM - NOTE_TOP) * PT, borderColor: BLACK, borderWidth: 1 })
      text('NOTE', L + 4, NOTE_TOP + 0.15, 7, bold)
      wrap(regular, 8.5, note, BOX_W - 8 - 26, 2).forEach((t, i) => text(t, L + 4 + 26, NOTE_TOP + 0.15 + i * 0.15, 8.5, regular))
    }

    // Pack-in box at the bottom.
    const bh = (PACK_BOTTOM - PACK_TOP) * PT, by = y(PACK_BOTTOM)
    page.drawRectangle({ x: L, y: by, width: BOX_W, height: bh, borderColor: BLACK, borderWidth: 1.2 })
    page.drawText('PACK IN', { x: L + 6, y: by + bh - 11, size: 7, font: regular, color: BLACK })
    page.drawText(slip.carton, { x: L + 40, y: by + 9, size: 13, font: bold, color: BLACK })
    if (CARTON_NOTE[slip.carton]) {
      page.drawText(CARTON_NOTE[slip.carton], { x: L + 46 + bold.widthOfTextAtSize(slip.carton, 13), y: by + 9, size: 8, font: regular, color: BLACK })
    }
    const bill = `bill ${slip.billed_lb} lb`
    page.drawText(bill, { x: L + BOX_W - 6 - regular.widthOfTextAtSize(bill, 8), y: by + 9, size: 8, font: regular, color: BLACK })
  }
  return pages
}

module.exports = { cleanSlip, drawRetailSlip, fitName, printable, rowsPerPage, NAME_W }
