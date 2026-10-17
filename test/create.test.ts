import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, stubFetch, xml } from './stub.ts'
import { create } from '../src/link.ts'
import { main } from '../src/cli.ts'

const project = (id: string, name: string, services: [string, string][]) => ({
  node: { id, name, environments: { edges: [{ node: { id: `${id}-prod`, name: 'production' } }] }, services: { edges: services.map(([id, name]) => ({ node: { id, name } })) } },
})
const listing = (...edges: unknown[]) => ({ data: { me: { workspaces: [{ projects: { edges } }] } } })
const before = listing(project('p1', 'my-app', [['s1', 'api']]))
const after = listing(project('p1', 'my-app', [['s1', 'api']]), project('p2', 'shop', [['s2', 'shop']]))
const none = { data: { domains: { customDomains: [] } } }
const zoneReads = [xml('getList-page1'), xml('getList-page2'), xml('dns-getList-true'), xml('getHosts')]
const opts = {
  domain: 'app.example.com',
  repo: 'acme/shop',
  token: 'tok',
  namecheap: { apiUser: 'user', apiKey: 'key', username: 'user', clientIp: '203.0.113.7', sandbox: false },
  force: false,
  wait: false,
  timeout: 300,
}

beforeEach(() => mock.restoreAll())

test('create makes the project and the service from the repo, then links the domain', async () => {
  const calls = stubFetch(
    before,
    { data: { me: { workspaces: [{ id: 'w1', name: 'acme' }] } } },
    { data: { projectCreate: { id: 'p2' } } },
    { data: { serviceCreate: { id: 's2' } } },
    after, none, fixture('customDomainCreate'), ...zoneReads, xml('setHosts'),
  )
  const result = await create({ ...opts, branch: 'main' })
  assert.deepEqual(calls[2].variables, { input: { name: 'shop', defaultEnvironmentName: 'production', workspaceId: 'w1' } })
  assert.deepEqual(calls[3].variables, { input: { projectId: 'p2', name: 'shop', source: { repo: 'acme/shop' }, branch: 'main' } })
  assert.equal(result.projectCreated, true)
  assert.equal(result.serviceCreated, true)
  assert.deepEqual(result.target, { projectId: 'p2', project: 'shop', environmentId: 'p2-prod', environment: 'production', serviceId: 's2', service: 'shop' })
  assert.equal(result.written, true)
})

test('an existing project and service are reused, with no mutation sent to Railway before the domain', async () => {
  const calls = stubFetch(before, before, none, fixture('customDomainCreate'), ...zoneReads, xml('setHosts'))
  const result = await create({ ...opts, project: 'my-app', service: 'api' })
  assert.deepEqual(calls.filter((c) => c.query.startsWith('mutation')).map((c) => c.query.match(/\{ (\w+)\(/)?.[1]), ['customDomainCreate'])
  assert.equal(result.projectCreated, false)
  assert.equal(result.serviceCreated, false)
  assert.equal(result.target.serviceId, 's1')
})

test('an existing project gets a new service when none has that name', async () => {
  const calls = stubFetch(before, { data: { serviceCreate: { id: 's3' } } }, listing(project('p1', 'my-app', [['s1', 'api'], ['s3', 'shop']])), none, fixture('customDomainCreate'), ...zoneReads, xml('setHosts'))
  const result = await create({ ...opts, project: 'p1' })
  assert.equal(calls[1].variables.input.projectId, 'p1')
  assert.equal(result.projectCreated, false)
  assert.equal(result.serviceCreated, true)
})

test('a workspace token creates the project without a workspaceId', async () => {
  const calls = stubFetch(fixture('notAuthorized'), fixture('projects'), fixture('notAuthorized'), { data: { projectCreate: { id: 'p2' } } }, { errors: [{ message: 'stop here' }] })
  await assert.rejects(create(opts))
  assert.deepEqual(calls[3].variables, { input: { name: 'shop', defaultEnvironmentName: 'production' } })
})

test('an account token with several workspaces is TARGET_AMBIGUOUS before anything is created', async () => {
  const calls = stubFetch(before, { data: { me: { workspaces: [{ id: 'w1', name: 'acme' }, { id: 'w2', name: 'side' }] } } })
  await assert.rejects(create(opts), { code: 'TARGET_AMBIGUOUS', message: /acme \(w1\), side \(w2\)/ })
  assert.equal(calls.length, 2)
})

test('a repo Railway cannot reach fails with RAILWAY_ERROR and Railway\'s message, before any Namecheap call', async () => {
  const message = 'GitHub repo acme/shop not found or not accessible'
  const calls = stubFetch(before, { data: { me: { workspaces: [{ id: 'w1', name: 'acme' }] } } }, { data: { projectCreate: { id: 'p2' } } }, { errors: [{ message }], data: null })
  await assert.rejects(create(opts), { code: 'RAILWAY_ERROR', message })
  assert.equal(calls.length, 4)
  assert.ok(calls.every((c) => c.url.includes('railway')))
})

test('create without --repo, with a repo that is not owner/name, or with a flag of the other command, prints usage and exits 1', async (t) => {
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  const calls = stubFetch()
  const usage = [
    ['create', 'app.example.com'],
    ['create', 'app.example.com', '--repo', 'shop'],
    ['create', 'app.example.com', '--repo', 'acme/shop', '--environment', 'staging'],
    ['link', 'app.example.com', '--project', 'my-app', '--service', 'api', '--repo', 'acme/shop'],
  ]
  for (const argv of usage) assert.equal(await main([...argv, '--json']), 1)
  assert.equal(calls.length, 0)
  assert.match(String(stderr.mock.calls[0].arguments[0]), /railpoint create <domain> --repo <owner\/name>/)
})
