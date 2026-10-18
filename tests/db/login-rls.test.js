// Login slice gate L4 (docs/TESTS.md, ADR 0023): the three login-slice migrations and their
// rollbacks, run against a local Postgres (PGlite) holding a copy of the live access state.
//   npm install        (once: PGlite is a dev dependency; .npmrc keeps a lockfile out)
//   npm run test:db
// Kept out of `npm test` so that suite still needs no install (ADR 0021).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const LIVE = read('tests/db/live-schema-2026-10-18.sql')
const PREP = read('db/2026-10-18-login-prep.sql')
const PREP_ROLLBACK = read('db/2026-10-18-login-prep-rollback.sql')
const CLAIMS_SQL = read('db/2026-10-18-label-claims.sql')
const CLAIMS_ROLLBACK = read('db/2026-10-18-label-claims-rollback.sql')
const REALTIME = read('db/2026-10-18-realtime-publication.sql')
const REALTIME_ROLLBACK = read('db/2026-10-18-realtime-publication-rollback.sql')
const MIGRATION = read('db/2026-10-18-login-rls.sql')
const ROLLBACK = read('db/2026-10-18-login-rls-rollback.sql')

const TABLES = {
  activity_log:          { ins: "(team_id, kind, text) values ('x', 'k', 't')",                       upd: 'undone = undone' },
  archived_plan:         { ins: "(team_id) values ('x')",                                             upd: 'sku = sku' },
  b2b_progress:          { ins: "(team_id, company_name, product_name, variant_title) values ('x', 'c', 'p', 'v')", upd: 'qty_bagged = qty_bagged' },
  blend_matrix:          { ins: "(product_name, component_name, ratio) values ('b', 'c', 1)",          upd: 'ratio = ratio' },
  daily_plan:            { ins: "(team_id, sku, product_name, variant_title) values ('x', 's', 'p', 'v')", upd: 'note = note' },
  green_coffee_settings: { ins: "(component_name) values ('c')",                                      upd: 'batches_done = batches_done' },
  plan_state:            { ins: "(team_id) values ('x')",                                             upd: 'finalized_at = finalized_at' },
  roasting_progress:     { ins: "(team_id, green_name) values ('x', 'g')",                             upd: 'batches_done = batches_done' },
  shipping_labels:       { ins: "(order_id, box_index, box_count, cost) values ('o', 1, 1, 9.5)",       upd: 'status = status' },
  subscription_schedule: { ins: "(week_start) values ('2026-10-18')",                                  upd: 'modernist = modernist' }
}
const FUNCS = {
  ship_labels_for_order: "select * from public.ship_labels_for_order('gid://shopify/Order/1')",
  ship_labels_pending: 'select * from public.ship_labels_pending()',
  mark_ship_labels_fulfilled: "select public.mark_ship_labels_fulfilled('gid://shopify/Order/1')"
}
// 'stranger' = a signed-in Supabase user without app_metadata.portal_staff (role authenticated).
const ROLES = ['anon', 'authenticated', 'stranger', 'green_planner_app']
const CLAIMS = {
  authenticated: { role: 'authenticated', app_metadata: { provider: 'email', portal_staff: true } },
  stranger: { role: 'authenticated', app_metadata: { provider: 'email' } }
}
const dbRole = r => (r === 'stranger' ? 'authenticated' : r)

// signedIn: one account that has signed in. prep: login-prep applied (the state the access
// migration expects).
async function freshDb({ signedIn = true, prep = false } = {}) {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  await db.exec(LIVE)
  // One row per table, so reads show up as a count and writes have something to hit.
  // Seed values differ from the test inserts' so the live unique keys don't collide.
  for (const [t, { ins }] of Object.entries(TABLES)) {
    await db.exec(`insert into public.${t} ${ins.replace(/'([a-z])'/g, "'seed_$1'").replace('2026-10-18', '2026-10-11')}`)
  }
  // Runs a write as the calling role (SECURITY INVOKER) and returns how many rows it touched.
  await db.exec(`
    create schema test_helpers;
    create function test_helpers.rowcount(stmt text) returns int language plpgsql as $$
      declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;
    grant usage on schema test_helpers to anon, authenticated, green_planner_app;
    grant execute on function test_helpers.rowcount(text) to anon, authenticated, green_planner_app;`)
  if (signedIn) await db.exec(`insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('floor@torque.coffee', now(), '{"provider":"email","portal_staff":true}')`)
  if (prep) await db.exec(PREP)
  return db
}

// What `role` can do, as one string per cell, inside a transaction that is always rolled back.
async function attempt(db, role, sql) {
  try {
    const claims = CLAIMS[role] ? JSON.stringify(CLAIMS[role]).replace(/'/g, "''") : ''
    await db.exec(`begin; set local request.jwt.claims = '${claims}'; set local role ${dbRole(role)};`)
    const res = await db.query(sql)
    return Object.values(res.rows[0] || {})[0]
  } catch (e) {
    if (/row-level security/.test(e.message)) return 'rls'
    if (/permission denied/.test(e.message)) return 'denied'
    throw e
  } finally {
    await db.exec('rollback')
  }
}
async function matrix(db) {
  const m = {}
  for (const role of ROLES) {
    m[role] = {}
    for (const [t, { ins, upd }] of Object.entries(TABLES)) {
      const cell = async sql => {
        const v = await attempt(db, role, sql)
        return typeof v === 'number' || typeof v === 'bigint' ? Number(v) : v
      }
      m[role][t] = {
        select: await cell(`select count(*)::int from public.${t}`),
        insert: await cell(`select test_helpers.rowcount($q$insert into public.${t} ${ins}$q$)`),
        update: await cell(`select test_helpers.rowcount($q$update public.${t} set ${upd}$q$)`),
        delete: await cell(`select test_helpers.rowcount($q$delete from public.${t}$q$)`)
      }
    }
    for (const [f, sql] of Object.entries(FUNCS)) {
      const v = await attempt(db, role, `select count(*)::int from (${sql}) x`)
      m[role][f] = v === 'denied' ? 'denied' : 'ok'
    }
  }
  return m
}
async function policies(db) {
  return (await db.query(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
                          where schemaname = 'public' order by 1, 2`)).rows
}
async function published(db) {
  return (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)).rows.map(r => r.tablename)
}

async function anonDefaultsOnNewObjects(db) {
  await db.exec(`create table public.later_t (id int); create function public.later_f() returns int language sql as 'select 1';`)
  // f: anon's own EXECUTE entry on the new function. (PUBLIC's EXECUTE, which anon inherits,
  // comes from Postgres's built-in default and is not changed: ADR 0023.)
  const r = (await db.query(`select has_table_privilege('anon', 'public.later_t', 'select') as t,
                                    coalesce(array_to_string(p.proacl, ' ') ~ '(^| )anon=', false) as f,
                                    has_table_privilege('authenticated', 'public.later_t', 'select') as at
                             from pg_proc p where p.oid = 'public.later_f()'::regprocedure`)).rows[0]
  await db.exec('drop table public.later_t; drop function public.later_f();')
  return r
}

let BEFORE
test('L4: the fixture reproduces today: anon has full access, signed-in users miss the two logs', async () => {
  const db = await freshDb()
  BEFORE = await matrix(db)
  assert.deepEqual(BEFORE.anon.daily_plan, { select: 1, insert: 1, update: 1, delete: 1 })
  assert.deepEqual(BEFORE.anon.activity_log, { select: 1, insert: 1, update: 1, delete: 0 })
  assert.deepEqual(BEFORE.anon.shipping_labels, { select: 0, insert: 1, update: 0, delete: 0 })
  assert.equal(BEFORE.anon.ship_labels_pending, 'ok')
  // activity_log and plan_state are `to anon` today: a signed-in device would see and save nothing.
  assert.deepEqual(BEFORE.authenticated.plan_state, { select: 0, insert: 'rls', update: 0, delete: 0 })
  assert.equal(BEFORE.green_planner_app.blend_matrix.select, 1)
  assert.deepEqual(await published(db), [])
  assert.deepEqual(await anonDefaultsOnNewObjects(db), { t: true, f: true, at: true })
})

// ── Step 0: login-prep ───────────────────────────────────────────────────────────────────
test('L4 prep: signed-in users get exactly anon\'s access; anon loses nothing', async () => {
  const db = await freshDb({ prep: true })
  const m = await matrix(db)
  assert.deepEqual(m.authenticated, BEFORE.anon)   // so the observation day works for signed-in devices
  assert.deepEqual(m.anon, BEFORE.anon)
  assert.deepEqual(m.green_planner_app, BEFORE.green_planner_app)
})

test('L4 prep: refused if run twice; its rollback restores today', async () => {
  const db = await freshDb()
  const before = await policies(db)
  await db.exec(PREP)
  await assert.rejects(db.exec(PREP), /not `to anon` as expected/)
  await db.exec('rollback').catch(() => {})
  await db.exec(PREP_ROLLBACK)
  assert.deepEqual(await policies(db), before)
  assert.deepEqual(await matrix(db), BEFORE)
})

// ── Step 0: label claims ─────────────────────────────────────────────────────────────────
test('L4 claims: one claim per box; a second device is refused; a release or a stale claim frees it', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(CLAIMS_SQL)
  const as = async (who, sql) => {
    const claims = CLAIMS[who] ? JSON.stringify(CLAIMS[who]) : ''
    try {
      await db.exec(`begin; set local request.jwt.claims = '${claims}'; set local role ${dbRole(who)};`)
      const r = (await db.query(sql)).rows[0]
      await db.exec('commit')
      return Object.values(r)[0]
    } catch (e) {
      await db.exec('rollback')
      return /permission denied/.test(e.message) ? 'denied' : e.message
    }
  }
  const claim = (who, box = 1) => as(who, `select public.claim_label_box('gid://shopify/Order/1', ${box})`)
  const release = (who, box = 1) => as(who, `select public.release_label_box('gid://shopify/Order/1', ${box})`)
  assert.equal(await claim('authenticated'), true)
  assert.equal(await claim('authenticated'), false)        // the second device
  assert.equal(await claim('authenticated', 2), true)      // another box is independent
  assert.equal(await release('authenticated'), true)
  assert.equal(await claim('authenticated'), true)         // free again after a failed purchase
  await db.exec("update public.label_claims set claimed_at = now() - interval '11 minutes' where box_index = 1")
  assert.equal(await claim('authenticated'), true)         // a stale claim is taken over
  assert.equal(await claim('anon'), 'denied')
  assert.equal(await claim('stranger', 3), false)          // not portal staff
  assert.equal(await claim('green_planner_app', 3), 'denied')
  for (const who of ['anon', 'authenticated', 'stranger']) {
    assert.equal(await as(who, 'select count(*) from public.label_claims'), 'denied', who)   // only through the functions
  }
  await db.exec(CLAIMS_ROLLBACK)
  assert.equal((await db.query("select to_regclass('public.label_claims') as t")).rows[0].t, null)
})

test('L4 claims: the access migration and its rollback run with the claims table in place', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(CLAIMS_SQL)
  await db.exec(MIGRATION)
  await db.exec(ROLLBACK)
})

// ── Step 1b: realtime publication ────────────────────────────────────────────────────────
test('L4 realtime: publishes the four tables; updates still work; rollback unpublishes', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(REALTIME)
  assert.deepEqual(await published(db), ['activity_log', 'daily_plan', 'plan_state', 'roasting_progress'])
  await db.exec(REALTIME)   // idempotent
  assert.equal((await published(db)).length, 4)
  const m = await matrix(db)
  assert.deepEqual(m.authenticated, BEFORE.anon)   // publishing changes no access, and UPDATE/DELETE still run
  await db.exec(REALTIME_ROLLBACK)
  assert.deepEqual(await published(db), [])
})

test('L4 realtime: refused if a table has no primary key (its updates would fail once published)', async () => {
  const db = await freshDb()
  await db.exec('alter table public.plan_state drop constraint plan_state_pkey')
  await assert.rejects(db.exec(REALTIME), /no primary key/)
  await db.exec('rollback').catch(() => {})
  assert.deepEqual(await published(db), [])
})

// ── Step 3b: access migration ────────────────────────────────────────────────────────────
test('L4: after the migration, anon reads nothing, writes nothing and runs no recovery function', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(MIGRATION)
  const after = await matrix(db)
  for (const t of Object.keys(TABLES)) {
    assert.deepEqual(after.anon[t], { select: 0, insert: 'rls', update: 0, delete: 0 }, t)
  }
  for (const f of Object.keys(FUNCS)) assert.equal(after.anon[f], 'denied', f)
})

test('L4: signed-in users keep exactly the access anon had, incl. no DELETE on the logs and no SELECT on shipping_labels', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(MIGRATION)
  const after = await matrix(db)
  assert.deepEqual(after.authenticated, BEFORE.anon)
  assert.deepEqual(after.authenticated.shipping_labels, { select: 0, insert: 1, update: 0, delete: 0 })
  for (const f of Object.keys(FUNCS)) assert.equal(after.authenticated[f], 'ok', f)
})

test('L4: a signed-in Supabase user without the portal_staff marker gets nothing: no rows, no writes, empty recovery functions', async () => {
  const db = await freshDb({ prep: true })
  await db.exec("insert into public.shipping_labels (order_id, box_index, box_count, cost, tracking_number) values ('gid://shopify/Order/1', 1, 1, 9, '1Z1')")
  await db.exec(MIGRATION)
  const m = await matrix(db)
  for (const t of Object.keys(TABLES)) {
    assert.deepEqual(m.stranger[t], { select: 0, insert: 'rls', update: 0, delete: 0 }, t)
  }
  const asRole = async (who, sql) => {
    await db.exec(`begin; set local request.jwt.claims = '${JSON.stringify(CLAIMS[who])}'; set local role authenticated;`)
    try { return (await db.query(sql)).rows } finally { await db.exec('rollback') }
  }
  assert.equal((await asRole('stranger', "select * from public.ship_labels_for_order('gid://shopify/Order/1')")).length, 0)
  assert.equal((await asRole('stranger', 'select * from public.ship_labels_pending()')).length, 0)
  assert.equal((await asRole('stranger', "select public.mark_ship_labels_fulfilled('gid://shopify/Order/1') as n"))[0].n, 0)
  // Staff see the label and can flip it.
  assert.equal((await asRole('authenticated', "select * from public.ship_labels_for_order('gid://shopify/Order/1')")).length, 1)
  assert.ok((await asRole('authenticated', 'select * from public.ship_labels_pending()')).some(r => r.order_id === 'gid://shopify/Order/1'))
  assert.equal((await asRole('authenticated', "select public.mark_ship_labels_fulfilled('gid://shopify/Order/1') as n"))[0].n, 1)
})

test('L4: the green planner reads only its two tables, writes nothing, and loses the recovery functions', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(MIGRATION)
  const g = (await matrix(db)).green_planner_app
  for (const t of Object.keys(TABLES)) {
    assert.deepEqual(g[t], BEFORE.green_planner_app[t], t)
    const own = t === 'blend_matrix' || t === 'green_coffee_settings'
    assert.equal(g[t].select, own ? 1 : 'denied', t)
    for (const op of ['insert', 'update', 'delete']) assert.equal(g[t][op], 'denied', `${t} ${op}`)
  }
  // Today it can run all three through PUBLIC, including the one that writes.
  for (const f of Object.keys(FUNCS)) {
    assert.equal(BEFORE.green_planner_app[f], 'ok', f)
    assert.equal(g[f], 'denied', f)
  }
})

test('L4: policies keep their command and expressions; only role and name change', async () => {
  const db = await freshDb({ prep: true })
  const before = await policies(db)
  await db.exec(MIGRATION)
  const after = (await policies(db)).filter(p => !p.policyname.startsWith('green planner') && p.policyname !== 'portal staff only')
  const key = p => `${p.tablename}|${p.cmd}|${p.qual}|${p.with_check}`
  assert.deepEqual(after.map(key).sort(), before.map(key).sort())
  assert.ok(after.every(p => p.roles === '{authenticated}' && p.policyname.startsWith('authenticated ')))
})

test('L4: objects postgres creates later no longer get Supabase\'s anon grants; authenticated still does', async () => {
  const db = await freshDb({ prep: true })
  await db.exec(MIGRATION)
  assert.deepEqual(await anonDefaultsOnNewObjects(db), { t: false, f: false, at: true })
})

test('L4: refused, with nothing changed, without login-prep, without accounts, with an account never signed in, or an anonymous user', async () => {
  const cases = [
    [{ prep: false }, '', /login-prep/],
    [{ prep: true, signedIn: false }, '', /No Supabase Auth accounts/],
    [{ prep: true }, `insert into auth.users (email, raw_app_meta_data) values ('newhire@torque.coffee', '{"portal_staff":true}')`, /never signed in: newhire@torque\.coffee/],
    [{ prep: true }, "insert into auth.users (email, last_sign_in_at, is_anonymous) values (null, now(), true)", /Anonymous users/],
    [{ prep: true }, "insert into auth.users (email, last_sign_in_at, raw_app_meta_data) values ('stranger@example.com', now(), '{\"provider\":\"email\"}')", /without the portal_staff marker: stranger@example\.com/]
  ]
  for (const [opts, extra, rx] of cases) {
    const db = await freshDb(opts)
    if (extra) await db.exec(extra)
    const before = await policies(db)
    await assert.rejects(db.exec(MIGRATION), rx)
    await db.exec('rollback').catch(() => {})
    assert.deepEqual(await policies(db), before)
  }
  // A deleted account that never signed in doesn't block.
  const db = await freshDb({ prep: true })
  await db.exec("insert into auth.users (email, deleted_at) values ('gone@torque.coffee', now())")
  await db.exec(MIGRATION)
})

test('L4: refused if the policies drifted, and when run a second time', async () => {
  const db = await freshDb({ prep: true })
  await db.exec('drop policy "anon delete daily_plan" on public.daily_plan')
  await assert.rejects(db.exec(MIGRATION), /Expected 36 policies/)
  await db.exec('rollback').catch(() => {})

  const db2 = await freshDb({ prep: true })
  await db2.exec(MIGRATION)
  const once = await policies(db2)
  await assert.rejects(db2.exec(MIGRATION), /Expected 36 policies in public, found 48/)
  await db2.exec('rollback').catch(() => {})
  assert.deepEqual(await policies(db2), once)
})

test('L4: the rollback returns to the login-prep state, where signed-in pages still work', async () => {
  const db = await freshDb({ prep: true })
  const prepPolicies = await policies(db)
  const prepMatrix = await matrix(db)
  await db.exec(MIGRATION)
  await db.exec(ROLLBACK)
  assert.deepEqual(await policies(db), prepPolicies)
  assert.deepEqual(await matrix(db), prepMatrix)
  assert.deepEqual((await matrix(db)).authenticated, BEFORE.anon)   // the login code can stay deployed
  assert.deepEqual(await anonDefaultsOnNewObjects(db), { t: true, f: true, at: true })
  await assert.rejects(db.exec(ROLLBACK), /not in that state/)
  await db.exec('rollback').catch(() => {})
  // And all the way back to today with the prep rollback.
  await db.exec(PREP_ROLLBACK)
  assert.deepEqual(await matrix(db), BEFORE)
})
