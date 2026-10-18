// Global gate (docs/TESTS.md): a paste error breaks the whole app, so every inline script in
// index.html must parse and every serverless function must pass node --check.
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { inlineScripts } = require('./helpers/index-html')

const API = path.join(__dirname, '..', 'api')

test('every inline <script> in index.html parses', () => {
  const scripts = inlineScripts()
  assert.ok(scripts.length >= 1)
  scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `index.html#script${i}` })))
})

test('every api/*.js passes node --check', () => {
  const files = fs.readdirSync(API).filter(f => f.endsWith('.js'))
  assert.ok(files.length >= 4)
  for (const f of files) execFileSync(process.execPath, ['--check', path.join(API, f)])
})
