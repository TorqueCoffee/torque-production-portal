// B3a gate C1 (docs/TESTS.md): db/2026-10-19-label-channel.sql and its rollback, on PGlite, over
// today's live state (the fixture plus the login-slice migrations), with and without the void
// migration before it.
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
const CHANNEL = read('db/2026-10-19-label-channel.sql')
const CHANNEL_ROLLBACK = read('db/2026-10-19-label-channel-rollback.sql')

const CLAIMS = {
  authenticated: { role: 'authenticated', app_metadata: { provider: 'email', portal_staff: true } },
  stranger: { role: 'authenticated', app_metadata: { provider: 'email' } }
}
const B2B = 'gid://shopify/Order/1', RET = 'gid://shopify/Order/5'

async function prodDb({ rls = true, voids = false, migrate = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  await db.exec(LIVE)
  await db.exec(`insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('floor@torque.coffee', now(), '{"provider":"email","portal_staff":true}')`)
  await db.exec(PREP)
  await db.exec(CLAIMS_SQL)
  if (rls) await db.exec(RLS)
  if (voids) await db.exec(VOID)
  await db.exec(`insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, tracking_number, shippo_object_id, status) values
    ('${B2B}', '#1', 1, 2, 9.5, '1Z1', '${'a'.repeat(32)}', 'purchased'),
    ('${B2B}', '#1', 2, 2, 9.5, '1Z2', '${'b'.repeat(32)}', 'purchased'),
    ('gid://shopify/Order/2', '#2', 1, 1, 7, '1Z3', '${'c'.repeat(32)}', 'fulfilled')`)
  if (migrate) await db.exec(CHANNEL)
  return db
}
// One statement as `who`, committed; all rows, or 'denied'.
async function as(db, who, sql) {
  const claims = CLAIMS[who] ? JSON.stringify(CLAIMS[who]) : ''
  try {
    await db.exec(`begin; set local request.jwt.claims = '${claims}'; set local role ${who === 'stranger' ? 'authenticated' : who};`)
    const r = (await db.query(sql)).rows
    await db.exec('commit')
    return r
  } catch (e) {
    await db.exec('rollback')
    if (/permission denied/.test(e.message)) return 'denied'
    throw e
  }
}
const insertRetail = (channel = 'retail', box = 1) => `insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, tracking_number, shippo_object_id, status, channel)
  values ('${RET}', '#5', ${box}, 1, 6.43, '1Z5', '${'d'.repeat(31)}${box}', 'purchased', '${channel}')`

test('C1: existing rows read b2b; staff insert a retail row; another channel is refused', async () => {
  const db = await prodDb()
  assert.deepEqual((await db.query(`select distinct channel from public.shipping_labels`)).rows, [{ channel: 'b2b' }])
  await as(db, 'authenticated', insertRetail())
  // A row inserted without channel (every B2B purchase) takes the default.
  await as(db, 'authenticated', `insert into public.shipping_labels (order_id, box_index, box_count, cost, shippo_object_id) values ('gid://shopify/Order/9', 1, 1, 5, '${'e'.repeat(32)}')`)
  assert.deepEqual((await db.query(`select order_id, channel from public.shipping_labels where order_id in ('${RET}', 'gid://shopify/Order/9') order by order_id`)).rows,
    [{ order_id: RET, channel: 'retail' }, { order_id: 'gid://shopify/Order/9', channel: 'b2b' }])
  await assert.rejects(as(db, 'authenticated', insertRetail('wholesale', 2)), /check constraint/)
  await assert.rejects(as(db, 'authenticated', insertRetail('null', 2).replace(`'null'`, 'null')), /not-null|null value/)
})

test('C1: pending and for_order return channel; each order lands on its own tab', async () => {
  const db = await prodDb()
  await as(db, 'authenticated', insertRetail())
  const pend = await as(db, 'authenticated', 'select order_id, labels_bought::int as n, channel from public.ship_labels_pending() order by order_id')
  assert.deepEqual(pend, [{ order_id: B2B, n: 2, channel: 'b2b' }, { order_id: RET, n: 1, channel: 'retail' }])   // fulfilled #2 is not pending
  const one = await as(db, 'authenticated', `select box_index, channel, tracking_number from public.ship_labels_for_order('${RET}')`)
  assert.deepEqual(one, [{ box_index: 1, channel: 'retail', tracking_number: '1Z5' }])
})

test('C1: still staff only: anon and the green planner denied, a stranger sees nothing, no direct SELECT', async () => {
  const db = await prodDb()
  for (const sql of ['select * from public.ship_labels_pending()', `select * from public.ship_labels_for_order('${B2B}')`]) {
    assert.equal(await as(db, 'anon', sql), 'denied')
    assert.equal(await as(db, 'green_planner_app', sql), 'denied')
    assert.deepEqual(await as(db, 'stranger', sql), [])
  }
  assert.deepEqual(await as(db, 'authenticated', 'select count(*)::int as n from public.shipping_labels'), [{ n: 0 }])
})

test('C1: works after the void migration; void and fulfil still work on a retail row', async () => {
  const db = await prodDb({ voids: true })
  await as(db, 'authenticated', insertRetail())
  assert.deepEqual(await as(db, 'authenticated', `select public.mark_ship_label_voided('${RET}', 1, '${'d'.repeat(31)}1') as n`), [{ n: 1 }])
  assert.deepEqual(await as(db, 'authenticated', `select status, channel from public.ship_labels_for_order('${RET}')`), [{ status: 'voided', channel: 'retail' }])
  assert.deepEqual(await as(db, 'authenticated', `select public.mark_ship_labels_fulfilled('${B2B}') as n`), [{ n: 2 }])
})

test('C1: refused twice and before the login RLS; the rollback restores the old functions and keeps the rows', async () => {
  const once = await prodDb()
  await assert.rejects(once.exec(CHANNEL), /already exists/)
  await once.exec('rollback').catch(() => {})

  const early = await prodDb({ rls: false, migrate: false })
  await assert.rejects(early.exec(CHANNEL), /login-rls/)
  await early.exec('rollback').catch(() => {})

  const db = await prodDb()
  await as(db, 'authenticated', insertRetail())
  await db.exec(CHANNEL_ROLLBACK)
  assert.equal((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'shipping_labels' and column_name = 'channel'`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int as n from public.shipping_labels`)).rows[0].n, 4)
  const pend = await as(db, 'authenticated', 'select * from public.ship_labels_pending() order by order_id')
  assert.deepEqual(pend.map(r => Object.keys(r).length), [5, 5])   // the old shape, no channel
  assert.equal(await as(db, 'anon', 'select * from public.ship_labels_pending()'), 'denied')
  // The login-rls rollback can run afterwards (it recreates the old return type).
  await db.exec(read('db/2026-10-18-login-rls-rollback.sql'))
})
