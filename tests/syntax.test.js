// Global gate (docs/TESTS.md): a paste error breaks the whole app, so every inline script in
// index.html must parse, every serverless function and lib/ file must pass node --check, and
// every same-origin script the page loads must be deployed (ADR 0022).
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { INDEX, inlineScripts } = require('./helpers/index-html')

const ROOT = path.join(__dirname, '..')
const API = path.join(ROOT, 'api')
const LIB = path.join(ROOT, 'lib')

test('every inline <script> in index.html parses', () => {
  const scripts = inlineScripts()
  assert.ok(scripts.length >= 1)
  scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `index.html#script${i}` })))
})

test('every api/*.js and lib/*.js passes node --check', () => {
  const files = [
    ...fs.readdirSync(API).filter(f => f.endsWith('.js')).map(f => path.join(API, f)),
    ...fs.readdirSync(LIB).filter(f => f.endsWith('.js')).map(f => path.join(LIB, f))
  ]
  assert.ok(files.length >= 5)
  for (const f of files) execFileSync(process.execPath, ['--check', f])
})

// .vercelignore is an allowlist (`/*` then `!name` per top-level entry). A same-origin script
// it leaves out 404s in production and stops the page before sign-in.
test('every same-origin <script src> exists and is deployed', () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  const allowed = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l.startsWith('!')).map(l => l.slice(1).replace(/\/$/, ''))
  const srcs = [...html.matchAll(/<script\s[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(s => s.startsWith('/') && !s.startsWith('//'))
  assert.ok(srcs.includes('/lib/ship-rules.js'))
  for (const src of srcs) {
    const rel = src.replace(/^\//, '').split('?')[0]
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${src} is not in the repo`)
    assert.ok(allowed.includes(rel.split('/')[0]), `${src} is not in the .vercelignore allowlist`)
  }
})

// lib/ is public (ADR 0022) and runs in the browser: no secrets, no server-only code.
test('lib/ holds browser-safe code only', () => {
  for (const f of fs.readdirSync(LIB).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')   // code, not comments
    assert.ok(!/process\.env|\brequire\s*\(|SHIPPO|SHOPIFY_|SUPABASE_/.test(src), `lib/${f} references server-only code or secrets`)
  }
})

