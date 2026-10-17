import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, stubFetch } from './stub.ts'
import { main } from '../src/cli.ts'


const projects = {
  data: { me: { workspaces: [{ projects: { edges: [{ node: { id: 'p1', name: 'my-app', environments: { edges: [{ node: { id: 'e1', name: 'production' } }] }, services: { edges: [{ node: { id: 's1', name: 'api' } }] } } }] } }] } },
}
const existing = { data: { domains: { customDomains: [{ ...fixture('customDomain').data.customDomain, domain: 'App.Example.com' }] } } }
const none = { data: { domains: { customDomains: [] } } }
const args = ['link', 'app.example.com', '--project', 'my-app', '--service', 'api', '--json']

// Runs the CLI, capturing stdout only while it runs (the test runner reports over stdout too).
async function run(argv: string[]) {
  const out: string[] = []
  const write = mock.method(process.stdout, 'write', (chunk: string) => (out.push(chunk), true))
  const code = await main(argv).finally(() => write.mock.restore())
  return { code, ...JSON.parse(out.join('')) }
}

beforeEach(() => {
  mock.restoreAll()
  process.env.RAILWAY_TOKEN = 'tok'
  process.env.RAILPOINT_CONFIG_DIR = join(tmpdir(), 'railpoint-test-no-config')
})

test('a domain already on the service is reused, with no create call', async () => {
  const calls = stubFetch(projects, existing)
  const { code, ok, data } = await run(args)
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.ok(!calls.some((c) => c.query.includes('customDomainCreate')))
  assert.equal(ok, true)
  assert.equal(data.railwayDomainId, 'domain-id')
  assert.equal(data.created, false)
})

test('success prints one {ok, data} envelope with the target and records', async () => {
  const calls = stubFetch(projects, none, fixture('customDomainCreate'))
  const { code, ...envelope } = await run(args)
  assert.equal(code, 0)
  assert.ok(calls[2].query.includes('customDomainCreate'))
  assert.deepEqual(envelope, {
    ok: true,
    data: {
      domain: 'app.example.com',
      target: { projectId: 'p1', project: 'my-app', environmentId: 'e1', environment: 'production', serviceId: 's1', service: 'api' },
      railwayDomainId: 'domain-id',
      created: true,
      records: [
        { host: 'app', type: 'CNAME', value: 'routing-value.up.railway.app' },
        { host: 'verification-host.app', type: 'TXT', value: 'verification-token' },
      ],
    },
  })
})

test('failure prints one {ok: false, error: {code, message, hint}} envelope and exits 1', async () => {
  stubFetch(projects)
  const { code, ok, error } = await run([...args.slice(0, 5), 'nope', '--json'])
  assert.equal(code, 1)
  assert.equal(ok, false)
  assert.deepEqual(Object.keys(error), ['code', 'message', 'hint'])
  assert.equal(error.code, 'TARGET_AMBIGUOUS')
})

test('a missing RAILWAY_TOKEN is MISSING_CREDENTIALS naming the variable', async () => {
  delete process.env.RAILWAY_TOKEN
  const calls = stubFetch()
  const { code, error } = await run(args)
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.equal(error.code, 'MISSING_CREDENTIALS')
  assert.match(error.message, /RAILWAY_TOKEN/)
})
