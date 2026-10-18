// Test helpers for index.html, which has no module system: pull the inline <script>
// blocks out, and load named top-level declarations into a sandbox so pure functions can
// be unit-tested without a browser.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const INDEX = path.join(__dirname, '..', '..', 'index.html')

function inlineScripts(html = fs.readFileSync(INDEX, 'utf8')) {
  const out = []
  const rx = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g
  let m
  while ((m = rx.exec(html))) {
    if (/\ssrc=/.test(m[1] || '')) continue
    out.push(m[2])
  }
  return out
}

// Source text of one top-level `function NAME(` or `const NAME =` declaration. Bracket
// depth is tracked across (), [] and {}: a function ends when its body brace closes, a
// const at the first newline outside any bracket. Good enough for the plain declarations
// tested here (no unbalanced brackets inside strings).
function declarationSource(src, name) {
  const rx = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(|^const\\s+${name}\\s*=`, 'm')
  const m = rx.exec(src)
  if (!m) throw new Error(`declaration not found in index.html: ${name}`)
  const isFn = !m[0].startsWith('const')
  let depth = 0, inBody = false
  for (let i = m.index; i < src.length; i++) {
    const c = src[i]
    if ('([{'.includes(c)) {
      if (isFn && depth === 0 && c === '{') inBody = true
      depth++
    } else if (')]}'.includes(c)) {
      depth--
      if (isFn && inBody && depth === 0) return src.slice(m.index, i + 1)
    } else if (!isFn && c === '\n' && depth === 0) {
      return src.slice(m.index, i)
    }
  }
  throw new Error(`unterminated declaration: ${name}`)
}

// Load the named declarations (in order) into a fresh sandbox and return them. `globals`
// stands in for page state and browser APIs the code touches (shipState, fetch, confirm…).
// Values come back from another realm: compare them with structuredClone(), not directly.
function loadFromIndex(names, globals = {}) {
  const src = inlineScripts().join('\n')
  const code = names.map(n => declarationSource(src, n)).join('\n') +
    `\n;({ ${names.join(', ')} })`
  return vm.runInNewContext(code, { ...globals })
}

module.exports = { INDEX, inlineScripts, declarationSource, loadFromIndex }
