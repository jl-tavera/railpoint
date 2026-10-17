import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, plan, sameValue } from '../src/plan.ts'

const host = (name: string, type: string, address: string, ttl = 1800) => ({ name, type, address, ttl, mxPref: 10 })

const cname = { host: 'app', type: 'CNAME' as const, value: 'routing.up.railway.app' }
const txt = { host: '_railway-verify.app', type: 'TXT' as const, value: 'token' }

test('a verification record is created beside an existing TXT at the same host', () => {
  const existing = [host('_railway-verify.app', 'TXT', 'other')]
  const { changes, conflicts } = plan(existing, [txt], { force: false })
  assert.deepEqual(changes, [{ action: 'create', record: host('_railway-verify.app', 'TXT', 'token', 300) }])
  assert.deepEqual(conflicts, [])
  assert.deepEqual(apply(existing, changes), [...existing, host('_railway-verify.app', 'TXT', 'token', 300)])
})

test('a verification record with an equal value already there is skipped', () => {
  const { changes } = plan([host('_railway-verify.app', 'TXT', 'token')], [txt], { force: false })
  assert.deepEqual(changes.map((c) => c.action), ['skip'])
})

test('a routing record pointing elsewhere is a conflict, and nothing is changed', () => {
  const existing = [host('app', 'CNAME', 'old.example.net')]
  const { changes, conflicts } = plan(existing, [cname], { force: false })
  assert.deepEqual(conflicts, [{ existing: existing[0], record: host('app', 'CNAME', 'routing.up.railway.app', 300) }])
  assert.deepEqual(changes, [])
})

test('force replaces the conflicting routing record and nothing else', () => {
  const existing = [host('app', 'CNAME', 'old.example.net'), host('@', 'A', '1.2.3.4'), host('app', 'TXT', 'keep'), host('@', 'MX', 'mail.example.com')]
  const { changes, conflicts } = plan(existing, [cname], { force: true })
  assert.deepEqual(conflicts, [])
  assert.deepEqual(changes.map((c) => c.action), ['replace'])
  assert.deepEqual(apply(existing, changes), [existing[1], existing[2], existing[3], host('app', 'CNAME', 'routing.up.railway.app', 300)])
})

test('a routing record at the apex is written as ALIAS', () => {
  const { changes } = plan([], [{ host: '@', type: 'CNAME', value: 'routing.up.railway.app' }], { force: false })
  assert.deepEqual(changes, [{ action: 'create', record: host('@', 'ALIAS', 'routing.up.railway.app', 300) }])
})

test('values compare without case or a trailing dot, so an equal routing record is skipped', () => {
  assert.ok(sameValue('Routing.UP.railway.app.', 'routing.up.railway.app'))
  assert.ok(!sameValue('routing.up.railway.app', 'other.up.railway.app'))
  const { changes, conflicts } = plan([host('APP', 'CNAME', 'Routing.Up.Railway.App.')], [cname], { force: false })
  assert.deepEqual(changes.map((c) => c.action), ['skip'])
  assert.deepEqual(conflicts, [])
})

test('apply keeps every host it did not touch, with its own TTL', () => {
  const existing = [host('@', 'A', '1.2.3.4', 60), host('www', 'CNAME', 'example.com', 3600), host('@', 'MX', 'mail.example.com')]
  const { changes } = plan(existing, [cname, txt], { force: false })
  assert.deepEqual(apply(existing, changes), [...existing, host('app', 'CNAME', 'routing.up.railway.app', 300), host('_railway-verify.app', 'TXT', 'token', 300)])
})
