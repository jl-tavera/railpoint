import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, stubFetch, xml } from './stub.ts'
import { main } from '../src/cli.ts'


const projects = {
  data: { me: { workspaces: [{ projects: { edges: [{ node: { id: 'p1', name: 'my-app', environments: { edges: [{ node: { id: 'e1', name: 'production' } }] }, services: { edges: [{ node: { id: 's1', name: 'api' } }] } } }] } }] } },
}
const existing = { data: { domains: { customDomains: [{ ...fixture('customDomain').data.customDomain, domain: 'App.Example.com' }] } } }
const none = { data: { domains: { customDomains: [] } } }
const args = ['link', 'app.example.com', '--project', 'my-app', '--service', 'api', '--json', '--no-wait']
const waiting = args.filter((a) => a !== '--no-wait')
const raw = fixture('customDomain').data.customDomain
const status = (record: string, cert: string, verified = true) =>
  ({ data: { customDomain: { status: { ...raw.status, dnsRecords: [{ ...raw.status.dnsRecords[0], currentValue: record === 'PROPAGATED' ? raw.status.dnsRecords[0].requiredValue : 'old.example.net', status: `DNS_RECORD_STATUS_${record}` }], verified, certificateStatus: `CERTIFICATE_STATUS_TYPE_${cert}` } } } })
const pending = status('REQUIRES_UPDATE', 'VALIDATING_OWNERSHIP', false)
const ready = status('PROPAGATED', 'VALID')
// A fake clock: sleeping only moves `now` forward.
const clock = () => {
  const c = { t: 0, sleeps: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms } }
  return c
}
// The Namecheap reads before a write: two pages of domains, the nameserver check, the hosts.
const zoneReads = (hosts = xml('getHosts')) => [xml('getList-page1'), xml('getList-page2'), xml('dns-getList-true'), hosts]
const withHosts = (...lines: string[]) => xml('getHosts').replace('</DomainDNSGetHostsResult>', lines.join('') + '</DomainDNSGetHostsResult>')
const host = (name: string, type: string, address: string) => `<host Name="${name}" Type="${type}" Address="${address}" MXPref="10" TTL="1800" />`

// Runs the CLI, capturing stdout only while it runs (the test runner reports over stdout too).
async function run(argv: string[], deps = {}) {
  const out: string[] = []
  const write = mock.method(process.stdout, 'write', (chunk: string) => (out.push(chunk), true))
  const code = await main(argv, deps).finally(() => write.mock.restore())
  return { code, ...JSON.parse(out.join('')) }
}

beforeEach(() => {
  mock.restoreAll()
  process.env.RAILWAY_TOKEN = 'tok'
  Object.assign(process.env, { NAMECHEAP_API_USER: 'user', NAMECHEAP_API_KEY: 'key', NAMECHEAP_CLIENT_IP: '203.0.113.7' })
  process.env.RAILPOINT_CONFIG_DIR = join(tmpdir(), 'railpoint-test-no-config')
})

test('a domain already on the service is reused, with no create call', async () => {
  const calls = stubFetch(projects, existing, ...zoneReads(), xml('setHosts'))
  const { code, ok, data } = await run(args)
  assert.equal(code, 0)
  assert.ok(!calls.some((c) => c.query.includes('customDomainCreate')))
  assert.equal(ok, true)
  assert.equal(data.railwayDomainId, 'domain-id')
  assert.equal(data.created, false)
})

test('success prints one {ok, data} envelope with the target and records', async () => {
  const calls = stubFetch(projects, none, fixture('customDomainCreate'), ...zoneReads(), xml('setHosts'))
  const { code, ...envelope } = await run(args)
  assert.equal(code, 0)
  assert.ok(calls[2].query.includes('customDomainCreate'))
  assert.equal(calls[7].params.get('Command'), 'namecheap.domains.dns.setHosts')
  assert.equal(calls[7].params.get('HostName6'), 'verification-host.app')
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
      zone: 'example.com',
      changes: [
        { action: 'create', record: { name: 'app', type: 'CNAME', address: 'routing-value.up.railway.app', ttl: 300, mxPref: 10 } },
        { action: 'create', record: { name: 'verification-host.app', type: 'TXT', address: 'verification-token', ttl: 300, mxPref: 10 } },
      ],
      written: true,
      status: 'written',
    },
  })
  assert.equal(calls.length, 8, '--no-wait makes no status call')
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

test('a routing record pointing elsewhere is DNS_CONFLICT in JSON mode, hinted --force, with no write', async () => {
  const calls = stubFetch(projects, existing, ...zoneReads(withHosts(host('app', 'CNAME', 'old.example.net'))))
  const { code, error } = await run(args)
  assert.equal(code, 1)
  assert.equal(error.code, 'DNS_CONFLICT')
  assert.match(error.message, /old\.example\.net/)
  assert.match(error.hint, /--force/)
  assert.ok(!calls.some((c) => c.params.get('Command') === 'namecheap.domains.dns.setHosts'))
})

test('--force replaces the conflicting routing record', async () => {
  const calls = stubFetch(projects, existing, ...zoneReads(withHosts(host('app', 'CNAME', 'old.example.net'))), xml('setHosts'))
  const { code, data } = await run([...args, '--force'])
  assert.equal(code, 0)
  assert.deepEqual(data.changes.map((c: any) => c.action), ['replace', 'create'])
  const form = calls.at(-1)!.params
  assert.ok(![...form.values()].includes('old.example.net'))
  assert.equal(form.get('HostName5'), 'app')
})

test('when every record is already there, nothing is written', async () => {
  const calls = stubFetch(projects, existing, ...zoneReads(withHosts(host('app', 'CNAME', 'Routing-Value.up.railway.app.'), host('verification-host.app', 'TXT', 'verification-token'))))
  const { code, data } = await run(args)
  assert.equal(code, 0)
  assert.equal(data.written, false)
  assert.deepEqual(data.changes.map((c: any) => c.action), ['skip', 'skip'])
  assert.ok(!calls.some((c) => c.params.get('Command') === 'namecheap.domains.dns.setHosts'))
})

test('a zone on other nameservers is NAMECHEAP_NOT_OUR_DNS before the hosts are read', async () => {
  const calls = stubFetch(projects, existing, xml('getList-page1'), xml('getList-page2'), xml('dns-getList-false'))
  const { code, error } = await run(args)
  assert.equal(code, 1)
  assert.equal(error.code, 'NAMECHEAP_NOT_OUR_DNS')
  assert.equal(calls.length, 5)
})

test('missing Namecheap credentials fail before anything is created on Railway', async () => {
  delete process.env.NAMECHEAP_API_KEY
  const calls = stubFetch()
  const { code, error } = await run(args)
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.equal(error.code, 'MISSING_CREDENTIALS')
  assert.match(error.message, /NAMECHEAP_API_KEY/)
})

test('a Railway label that disagrees with the Namecheap zone is refused before the hosts are read', async () => {
  const elsewhere = { data: { domains: { customDomains: [{ ...fixture('customDomain').data.customDomain, domain: 'app.shop.example.com', status: { ...fixture('customDomain').data.customDomain.status, dnsRecords: [{ ...fixture('customDomain').data.customDomain.status.dnsRecords[0], hostlabel: 'app.shop' }] } }] } } }
  const calls = stubFetch(projects, elsewhere, xml('getList-page1'), xml('getList-page2'))
  const { code, error } = await run(['link', 'app.shop.example.com', ...args.slice(2)])
  assert.equal(code, 1)
  assert.equal(error.code, 'UNSUPPORTED_RECORD')
  assert.equal(calls.length, 4)
})

test('link polls every 5 s until every record is valid and the certificate issued', async () => {
  const c = clock()
  const calls = stubFetch(projects, existing, ...zoneReads(), xml('setHosts'), pending, pending, ready)
  const { code, data } = await run(waiting, c)
  assert.equal(code, 0)
  assert.equal(data.status, 'ready')
  assert.deepEqual(c.sleeps, [5000, 5000])
  assert.deepEqual(calls.slice(-3).map((x) => x.variables), Array(3).fill({ id: 'domain-id', projectId: 'p1' }))
})

test('still pending at the timeout is TIMEOUT naming the pending record and the certificate status', async () => {
  const c = clock()
  stubFetch(projects, existing, ...zoneReads(), xml('setHosts'), pending, pending, pending)
  const { code, error } = await run([...waiting, '--timeout', '10'], c)
  assert.equal(code, 1)
  assert.equal(error.code, 'TIMEOUT')
  assert.match(error.message, /app: old\.example\.net \(needs routing-value\.up\.railway\.app\)/)
  assert.match(error.message, /verification-host\.app: not verified yet/)
  assert.match(error.message, /CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP/)
  assert.match(error.hint, /re-run/)
  assert.deepEqual(c.sleeps, [5000, 5000])
})

test('a failing status check goes to stderr and the loop carries on', async (t) => {
  const c = clock()
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  stubFetch(projects, existing, ...zoneReads(), xml('setHosts'), new Response('', { status: 502 }), ready)
  const { code, data } = await run(waiting, c)
  assert.equal(code, 0)
  assert.equal(data.status, 'ready')
  assert.match(String(stderr.mock.calls[0].arguments[0]), /502/)
})
