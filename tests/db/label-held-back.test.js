// B3b gate H1 (docs/TESTS.md): db/2026-10-20-label-held-back.sql and its rollback, on PGlite, over
// today's live state (the fixture plus the login, claims, void and channel migrations).
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
const HELD = read('db/2026-10-20-label-held-back.sql')
const HELD_ROLLBACK = read('db/2026-10-20-label-held-back-rollback.sql')

const CLAIMS = {
  authenticated: { role: 'authenticated', app_metadata: { provider: 'email', portal_staff: true } },
  stranger: { role: 'authenticated', app_metadata: { provider: 'email' } }
}
const B2B = 'gid://shopify/Order/1', RET = 'gid://shopify/Order/5', DONE = 'gid://shopify/Order/6', GONE = 'gid://shopify/Order/7'
const row = (order, name, box, channel, status, weight, hex) => `('${order}', '${name}', ${box}, 1, 6.43, '1Z${name.slice(1)}', '${hex.repeat(32)}', '${status}', '${channel}', ${weight})`

async function prodDb({ migrate = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  await db.exec(LIVE)
  await db.exec(`insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('floor@torque.coffee', now(), '{"provider":"email","portal_staff":true}')`)
  await db.exec(PREP)
  await db.exec(CLAIMS_SQL)
  await db.exec(RLS)
  await db.exec(VOID)
  await db.exec(CHANNEL)
  await db.exec(`insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, tracking_number, shippo_object_id, status, channel, weight_lb) values
    ${row(B2B, '#1', 1, 'b2b', 'purchased', 22, 'a')},
    ${row(RET, '#5', 1, 'retail', 'purchased', 2, 'b')},
    ${row(DONE, '#6', 1, 'retail', 'fulfilled', 2, 'c')},
    ${row(GONE, '#7', 1, 'retail', 'voided', 2, 'd')}`)
  if (migrate) await db.exec(HELD)
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
const insertRow = (order, box, status, hex = 'f') => `insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, shippo_object_id, status, channel) values ('${order}', '#x', ${box}, 1, 5, '${hex.repeat(32)}', '${status}', 'retail')`
const hold = (order, held) => `select public.set_ship_label_held_back('${order}', ${held}) as n`
const heldAt = async db => (await db.query(`select order_id, held_back_at is not null as held from public.shipping_labels order by order_id`)).rows

test('H1: staff hold back and include a retail purchased row; the row count says so', async () => {
  const db = await prodDb()
  assert.deepEqual(await as(db, 'authenticated', hold(RET, true)), [{ n: 1 }])
  assert.equal((await heldAt(db)).find(r => r.order_id === RET).held, true)
  const pend = await as(db, 'authenticated', 'select order_id, held_back_at is not null as held from public.ship_labels_pending() order by order_id')
  assert.deepEqual(pend, [{ order_id: B2B, held: false }, { order_id: RET, held: true }])
  assert.deepEqual(await as(db, 'authenticated', hold(RET, false)), [{ n: 1 }])
  assert.equal((await heldAt(db)).find(r => r.order_id === RET).held, false)
  // Holding twice is not an error; it is still one row.
  await as(db, 'authenticated', hold(RET, true))
  assert.deepEqual(await as(db, 'authenticated', hold(RET, true)), [{ n: 1 }])
})

test('H1: a B2B, fulfilled, voided or unknown order returns 0 and is left alone', async () => {
  const db = await prodDb()
  for (const o of [B2B, DONE, GONE, 'gid://shopify/Order/999']) assert.deepEqual(await as(db, 'authenticated', hold(o, true)), [{ n: 0 }], o)
  assert.deepEqual((await heldAt(db)).filter(r => r.held), [])
})

test('H1: a stranger gets 0 and nothing changes; anon and the green planner are denied', async () => {
  const db = await prodDb()
  assert.deepEqual(await as(db, 'stranger', hold(RET, true)), [{ n: 0 }])
  assert.deepEqual((await heldAt(db)).filter(r => r.held), [])
  assert.equal(await as(db, 'anon', hold(RET, true)), 'denied')
  assert.equal(await as(db, 'green_planner_app', hold(RET, true)), 'denied')
  assert.deepEqual((await heldAt(db)).filter(r => r.held), [])
})

test('H1: both lookups return held_back_at; the order lookup also returns weight_lb and dest_zip; staff only', async () => {
  const db = await prodDb()
  await db.exec(`update public.shipping_labels set dest_zip = '92104' where order_id = '${RET}'`)
  await as(db, 'authenticated', hold(RET, true))
  const one = await as(db, 'authenticated', `select box_index, channel, weight_lb::int as weight_lb, dest_zip, held_back_at is not null as held from public.ship_labels_for_order('${RET}')`)
  assert.deepEqual(one, [{ box_index: 1, channel: 'retail', weight_lb: 2, dest_zip: '92104', held: true }])
  assert.deepEqual(await as(db, 'authenticated', `select held_back_at from public.ship_labels_for_order('${B2B}')`), [{ held_back_at: null }])
  for (const sql of ['select * from public.ship_labels_pending()', `select * from public.ship_labels_for_order('${RET}')`]) {
    assert.equal(await as(db, 'anon', sql), 'denied')
    assert.deepEqual(await as(db, 'stranger', sql), [])
  }
})

test('H1: pending still groups by order and channel (B2B and retail rows of one order id stay apart)', async () => {
  const db = await prodDb()
  await db.exec(`insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, tracking_number, shippo_object_id, status, channel, weight_lb) values
    ${row(B2B, '#1', 2, 'b2b', 'purchased', 22, 'e')}, ${row(B2B, '#1', 3, 'retail', 'purchased', 2, 'f')}`)
  const pend = await as(db, 'authenticated', 'select order_id, channel, labels_bought::int as n from public.ship_labels_pending() order by order_id, channel')
  assert.deepEqual(pend, [{ order_id: B2B, channel: 'b2b', n: 2 }, { order_id: B2B, channel: 'retail', n: 1 }, { order_id: RET, channel: 'retail', n: 1 }])
})

const claim = o => `select public.claim_order_fulfill('${o}') as tok`
const release = (o, tok) => `select public.release_order_fulfill('${o}', ${tok ? `'${tok}'` : 'null'}) as ok`
const take = async (db, o) => (await as(db, 'authenticated', claim(o)))[0].tok

test('H1: one fulfiller or voider per order: a second claim fails until released or 2 minutes old; release needs the token', async () => {
  const db = await prodDb()
  const t1 = await take(db, RET)
  assert.match(t1, /^[0-9a-f-]{36}$/)
  assert.equal(await take(db, RET), null)                                              // a second claim fails
  assert.match(await take(db, B2B), /^[0-9a-f-]{36}$/)                                 // another order is free
  assert.deepEqual(await as(db, 'authenticated', release(RET, '00000000-0000-0000-0000-000000000000')), [{ ok: false }])   // wrong token frees nothing
  assert.equal(await take(db, RET), null)
  assert.deepEqual(await as(db, 'authenticated', release(RET, t1)), [{ ok: true }])
  const t2 = await take(db, RET)
  assert.ok(t2 && t2 !== t1)
  await db.exec(`update public.fulfill_claims set claimed_at = now() - interval '3 minutes' where order_id = '${RET}'`)
  const t3 = await take(db, RET)                                                       // a stale claim is taken over, with a new token
  assert.ok(t3 && t3 !== t2)
  // The slow first holder finishing late can't free the new holder's claim.
  assert.deepEqual(await as(db, 'authenticated', release(RET, t2)), [{ ok: false }])
  assert.equal(await take(db, RET), null)
  await db.exec(`update public.fulfill_claims set claimed_at = now() - interval '90 seconds' where order_id = '${RET}'`)
  assert.equal(await take(db, RET), null)                                              // 90 s is still held
})

test('H1: the claim functions are staff only; anon is denied; the table has no direct access', async () => {
  const db = await prodDb()
  assert.equal((await as(db, 'stranger', claim(RET)))[0].tok, null)
  assert.deepEqual(await as(db, 'stranger', release(RET, null)), [{ ok: false }])
  assert.equal(await as(db, 'anon', claim(RET)), 'denied')
  assert.equal(await as(db, 'anon', release(RET, null)), 'denied')
  assert.equal(await as(db, 'green_planner_app', claim(RET)), 'denied')
  assert.equal(await as(db, 'authenticated', 'select * from public.fulfill_claims'), 'denied')
  assert.equal(await as(db, 'authenticated', `insert into public.fulfill_claims (order_id) values ('x')`), 'denied')
  const t = await take(db, RET)
  assert.ok(t)
  assert.deepEqual(await as(db, 'stranger', release(RET, t)), [{ ok: false }])         // a stranger can't free it
  assert.equal(await take(db, RET), null)
})

test('H1: Hold back and Include change nothing while the order is being fulfilled or voided', async () => {
  const db = await prodDb()
  const tok = await take(db, RET)
  assert.deepEqual(await as(db, 'authenticated', hold(RET, true)), [{ n: 0 }])
  assert.equal((await heldAt(db)).find(r => r.order_id === RET).held, false)
  assert.equal((await db.query(`select count(*)::int as n from public.fulfill_claims where order_id = '${RET}'`)).rows[0].n, 1)   // still the fulfiller's claim
  await as(db, 'authenticated', release(RET, tok))
  assert.deepEqual(await as(db, 'authenticated', hold(RET, true)), [{ n: 1 }])
  assert.equal((await db.query(`select count(*)::int as n from public.fulfill_claims`)).rows[0].n, 0)                          // Hold back leaves no claim behind
  await db.exec(`insert into public.fulfill_claims (order_id, claimed_at) values ('${RET}', now() - interval '5 minutes') on conflict (order_id) do update set claimed_at = excluded.claimed_at`)
  assert.deepEqual(await as(db, 'authenticated', hold(RET, false)), [{ n: 1 }])       // a stale claim does not block
})

test('H1: one live label per box: a second purchased row is refused, a voided or fulfilled one is not; an existing duplicate stops the migration with a message', async () => {
  const db = await prodDb()
  await assert.rejects(as(db, 'authenticated', insertRow(RET, 1, 'purchased')), /duplicate key|unique/)
  await as(db, 'authenticated', insertRow(RET, 1, 'voided', 'x'))                       // voided rows may repeat
  await as(db, 'authenticated', insertRow(RET, 1, 'fulfilled', 'y'))
  await as(db, 'authenticated', insertRow(RET, 2, 'purchased', 'z'))                    // another box is fine
  // After a void the box can be bought again.
  await db.exec(`update public.shipping_labels set status = 'voided' where order_id = '${RET}' and box_index = 1 and status = 'purchased'`)
  await as(db, 'authenticated', insertRow(RET, 1, 'purchased', 'w'))
  // A database that already has two live labels for a box is refused with a message, nothing changed.
  const dup = await prodDb({ migrate: false })
  await dup.exec(`insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, shippo_object_id, status, channel) values ('${RET}', '#5', 1, 1, 5, '${'9'.repeat(32)}', 'purchased', 'retail')`)
  await assert.rejects(dup.exec(HELD), /two live \(purchased\) labels exist for one box/)
  await dup.exec('rollback').catch(() => {})
  assert.equal((await dup.query(`select count(*)::int as n from information_schema.columns where table_name = 'shipping_labels' and column_name = 'held_back_at'`)).rows[0].n, 0)
})

test('H1: the claim only takes real Shopify order ids; Hold back with another id changes nothing and leaves no claim', async () => {
  const db = await prodDb()
  for (const bad of ['', 'x', '8333', 'gid://shopify/Product/1', "gid://shopify/Order/1'; drop", 'gid://shopify/Order/']) {
    assert.equal((await as(db, 'authenticated', `select public.claim_order_fulfill('${bad.replace(/'/g, "''")}') as tok`))[0].tok, null, bad)
    assert.deepEqual(await as(db, 'authenticated', hold(bad.replace(/'/g, "''"), true)), [{ n: 0 }], bad)
  }
  assert.equal((await db.query(`select count(*)::int as n from public.fulfill_claims`)).rows[0].n, 0)
})

test('H1: signed-in users can no longer UPDATE a label row (tracking number, hold-back); the functions still can; INSERT still works', async () => {
  const db = await prodDb()
  assert.equal(await as(db, 'authenticated', `update public.shipping_labels set tracking_number = '1ZFORGED'`), 'denied')
  assert.equal(await as(db, 'authenticated', `update public.shipping_labels set held_back_at = null`), 'denied')
  assert.equal(await as(db, 'stranger', `update public.shipping_labels set tracking_number = '1ZFORGED'`), 'denied')
  assert.equal((await db.query(`select count(*)::int as n from public.shipping_labels where tracking_number = '1ZFORGED'`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int as n from pg_policies where tablename = 'shipping_labels' and cmd = 'UPDATE'`)).rows[0].n, 0)
  assert.deepEqual(await as(db, 'authenticated', hold(RET, true)), [{ n: 1 }])
  assert.deepEqual(await as(db, 'authenticated', `select public.mark_ship_labels_fulfilled('${RET}') as n`), [{ n: 1 }])
  await as(db, 'authenticated', `insert into public.shipping_labels (order_id, order_name, box_index, box_count, cost, shippo_object_id, channel) values ('gid://shopify/Order/8', '#8', 1, 1, 5, '${'f'.repeat(32)}', 'retail')`)
  assert.equal((await db.query(`select count(*)::int as n from public.shipping_labels where order_id = 'gid://shopify/Order/8'`)).rows[0].n, 1)
})

test('H1: refused a second time, and before the channel or void migrations; nothing changes', async () => {
  const once = await prodDb()
  await assert.rejects(once.exec(HELD), /this migration has run/)
  await once.exec('rollback').catch(() => {})

  const { PGlite } = await import('@electric-sql/pglite')
  for (const [why, skip, msg] of [['channel', CHANNEL, /channel is missing/], ['void', VOID, /voided_at is missing/]]) {
    const db = new PGlite()
    await db.exec(LIVE)
    await db.exec(`insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('floor@torque.coffee', now(), '{"provider":"email","portal_staff":true}')`)
    await db.exec(PREP); await db.exec(CLAIMS_SQL); await db.exec(RLS)
    if (skip !== VOID) await db.exec(VOID)
    if (skip !== CHANNEL) await db.exec(CHANNEL)
    await assert.rejects(db.exec(HELD), msg, why)
    await db.exec('rollback').catch(() => {})
    assert.equal((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'shipping_labels' and column_name = 'held_back_at'`)).rows[0].n, 0, why)
  }
})

test('H1: the rollback restores the channel-era signatures and drops the column and the function', async () => {
  const db = await prodDb()
  await as(db, 'authenticated', hold(RET, true))
  await db.exec(HELD_ROLLBACK)
  assert.equal((await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'shipping_labels' and column_name = 'held_back_at'`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int as n from public.shipping_labels`)).rows[0].n, 4)
  const result = async f => (await db.query(`select pg_get_function_result('${f}'::regprocedure) as r`)).rows[0].r
  assert.match(await result('public.ship_labels_pending()'), /bought_at timestamp with time zone, channel text\)?$/)
  assert.doesNotMatch(await result('public.ship_labels_pending()'), /held_back_at/)
  assert.match(await result('public.ship_labels_for_order(text)'), /created_at timestamp with time zone, channel text\)?$/)
  assert.doesNotMatch(await result('public.ship_labels_for_order(text)'), /weight_lb|held_back_at|dest_zip/)
  assert.equal((await db.query(`select count(*)::int as n from pg_proc where proname in ('set_ship_label_held_back', 'claim_order_fulfill', 'release_order_fulfill')`)).rows[0].n, 0)
  assert.equal((await db.query(`select count(*)::int as n from pg_tables where tablename = 'fulfill_claims'`)).rows[0].n, 0)
  // The UPDATE door is back, as login-rls left it.
  assert.equal((await db.query(`select count(*)::int as n from pg_policies where tablename = 'shipping_labels' and cmd = 'UPDATE'`)).rows[0].n, 1)
  assert.deepEqual(await as(db, 'authenticated', `update public.shipping_labels set order_name = order_name where order_id = '${RET}' returning 1 as x`), [])
  assert.equal(await as(db, 'anon', 'select * from public.ship_labels_pending()'), 'denied')
  assert.deepEqual((await as(db, 'authenticated', 'select order_id from public.ship_labels_pending() order by order_id')).map(r => r.order_id), [B2B, RET])
  // The migration can run again afterwards.
  await db.exec(HELD)
})
