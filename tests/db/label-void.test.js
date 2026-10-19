// B6 gate V5 (docs/TESTS.md): db/2026-10-19-label-void.sql and its rollback, on PGlite, over
// today's live state (the fixture plus the three login-slice migrations).
//   npm run test:db
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const LIVE = read('tests/db/live-schema-2026-10-18.sql')
const PREP = read('db/2026-10-18-login-prep.sql')
const CLAIMS_SQL = read('db/2026-10-18-label-claims.sql')
const RLS = read('db/2026-10-18-login-rls.sql')
const VOID = read('db/2026-10-19-label-void.sql')
const VOID_ROLLBACK = read('db/2026-10-19-label-void-rollback.sql')

const CLAIMS = {
  authenticated: { role: 'authenticated', app_metadata: { provider: 'email', portal_staff: true } },
  stranger: { role: 'authenticated', app_metadata: { provider: 'email' } }
}
const O = 'gid://shopify/Order/1'
const TXN = 'a'.repeat(32)

async function prodDb({ claims = true, migrate = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  await db.exec(LIVE)
  await db.exec(`insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('floor@torque.coffee', now(), '{"provider":"email","portal_staff":true}')`)
  await db.exec(PREP)
  if (claims) await db.exec(CLAIMS_SQL)
  await db.exec(RLS)
  await db.exec(`insert into public.shipping_labels (order_id, box_index, box_count, cost, tracking_number, shippo_object_id, status) values
    ('${O}', 1, 2, 9.5, '1Z1', '${TXN}', 'purchased'),
    ('${O}', 2, 2, 9.5, '1Z2', '${'b'.repeat(32)}', 'purchased'),
    ('gid://shopify/Order/2', 1, 1, 7, '1Z3', '${'c'.repeat(32)}', 'fulfilled')`)
  if (migrate) await db.exec(VOID)
  return db
}
// One statement as `who`, committed; the first column of the first row, or 'denied'.
async function as(db, who, sql) {
  const claims = CLAIMS[who] ? JSON.stringify(CLAIMS[who]) : ''
  try {
    await db.exec(`begin; set local request.jwt.claims = '${claims}'; set local role ${who === 'stranger' ? 'authenticated' : who};`)
    const r = (await db.query(sql)).rows[0]
    await db.exec('commit')
    return Object.values(r || {})[0]
  } catch (e) {
    await db.exec('rollback')
    if (/permission denied/.test(e.message)) return 'denied'
    throw e
  }
}
const rows = async db => (await db.query(`select order_id, box_index, status, voided_at is not null as v from public.shipping_labels order by order_id, box_index`)).rows
const voidSql = (box = 1, txn = TXN, order = O) => `select public.mark_ship_label_voided('${order}', ${box}, '${txn}')`

test('V5: staff void one purchased row by its Shippo id; the claim is freed; a second void changes nothing', async () => {
  const db = await prodDb()
  assert.equal(await as(db, 'authenticated', `select public.claim_label_box('${O}', 1)`), true)
  assert.equal(await as(db, 'authenticated', voidSql()), 1)
  assert.deepEqual((await rows(db))[0], { order_id: O, box_index: 1, status: 'voided', v: true })
  assert.equal((await rows(db))[1].status, 'purchased')                       // the other box is untouched
  assert.equal(await as(db, 'authenticated', `select public.claim_label_box('${O}', 1)`), true)   // rebuy at once
  assert.equal(await as(db, 'authenticated', voidSql()), 0)
  // The label lookup still lists it, as voided (the endpoint skips it).
  assert.equal(await as(db, 'authenticated', `select status from public.ship_labels_for_order('${O}') where box_index = 1`), 'voided')
})

test('V5: a wrong Shippo id, another box or a fulfilled row is never voided', async () => {
  const db = await prodDb()
  assert.equal(await as(db, 'authenticated', voidSql(1, 'f'.repeat(32))), 0)
  assert.equal(await as(db, 'authenticated', voidSql(2, TXN)), 0)
  assert.equal(await as(db, 'authenticated', voidSql(1, 'c'.repeat(32), 'gid://shopify/Order/2')), 0)
  assert.ok((await rows(db)).every(r => r.status !== 'voided'))
})

test('V5: only portal staff: anon and the green planner are denied, a stranger changes nothing', async () => {
  const db = await prodDb()
  assert.equal(await as(db, 'anon', voidSql()), 'denied')
  assert.equal(await as(db, 'green_planner_app', voidSql()), 'denied')
  assert.equal(await as(db, 'stranger', voidSql()), 0)
  assert.ok((await rows(db)).every(r => r.status !== 'voided'))
  // Still no direct SELECT or UPDATE for signed-in users (ADR 0004).
  assert.equal(await as(db, 'authenticated', 'select count(*)::int from public.shipping_labels'), 0)
})

test('V5: fulfilling an order leaves its voided label voided', async () => {
  const db = await prodDb()
  await as(db, 'authenticated', voidSql())
  assert.equal(await as(db, 'authenticated', `select public.mark_ship_labels_fulfilled('${O}')`), 1)   // box 2 only
  assert.deepEqual((await rows(db)).filter(r => r.order_id === O).map(r => r.status), ['voided', 'fulfilled'])
  assert.equal(await as(db, 'stranger', `select public.mark_ship_labels_fulfilled('gid://shopify/Order/2')`), 0)
})

test('V5: refused without label_claims; the rollback removes the function and the column and keeps the rows', async () => {
  const bare = await prodDb({ claims: false, migrate: false })
  await assert.rejects(bare.exec(VOID), /label_claims is missing/)
  await bare.exec('rollback').catch(() => {})

  const db = await prodDb()
  await as(db, 'authenticated', voidSql())
  await db.exec(VOID_ROLLBACK)
  assert.equal((await db.query(`select to_regprocedure('public.mark_ship_label_voided(text, integer, text)') as f`)).rows[0].f, null)
  assert.equal((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'shipping_labels' and column_name = 'voided_at'`)).rows[0].n, 0)
  assert.equal((await db.query(`select status from public.shipping_labels where box_index = 1 and order_id = '${O}'`)).rows[0].status, 'voided')
  assert.equal(await as(db, 'authenticated', `select public.mark_ship_labels_fulfilled('${O}')`), 2)  // the old function, as before
  assert.equal(await as(db, 'anon', `select public.mark_ship_labels_fulfilled('${O}')`), 'denied')
})
