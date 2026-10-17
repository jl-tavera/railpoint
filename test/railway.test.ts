import { test, beforeEach, mock } from 'node:test'
import { fixture, stubFetch } from './stub.ts'
import assert from 'node:assert/strict'
import { customDomainCreate, listProjects, resolveTarget } from '../src/railway.ts'


const projects = {
  data: {
    me: {
      workspaces: [{
        projects: {
          edges: [
            { node: { id: 'p1', name: 'my-app', environments: { edges: [{ node: { id: 'e1', name: 'production' } }, { node: { id: 'e2', name: 'staging' } }] }, services: { edges: [{ node: { id: 's1', name: 'api' } }, { node: { id: 's2', name: 'api' } }, { node: { id: 's3', name: 'web' } }] } } },
            { node: { id: 'p2', name: 'other', environments: { edges: [] }, services: { edges: [] } } },
          ],
        },
      }],
    },
  },
}

beforeEach(() => mock.restoreAll())

test('resolveTarget finds project, environment and service by name', async () => {
  const calls = stubFetch(projects)
  const target = await resolveTarget('tok', { project: 'my-app', environment: 'production', service: 'web' })
  assert.deepEqual(target, { projectId: 'p1', project: 'my-app', environmentId: 'e1', environment: 'production', serviceId: 's3', service: 'web' })
  assert.equal(calls[0].auth, 'Bearer tok')
})

test('resolveTarget accepts an id at each level', async () => {
  stubFetch(projects)
  const target = await resolveTarget('tok', { project: 'p1', environment: 'e2', service: 's2' })
  assert.equal(target.serviceId, 's2')
  assert.equal(target.environment, 'staging')
})

test('resolveTarget with two services of the same name is TARGET_AMBIGUOUS listing both', async () => {
  stubFetch(projects)
  await assert.rejects(resolveTarget('tok', { project: 'my-app', environment: 'production', service: 'api' }), (e: any) => {
    assert.equal(e.code, 'TARGET_AMBIGUOUS')
    assert.match(e.message, /s1/)
    assert.match(e.message, /s2/)
    assert.match(e.hint, /id/)
    return true
  })
})

test('resolveTarget with no match is TARGET_AMBIGUOUS listing the candidates', async () => {
  stubFetch(projects)
  await assert.rejects(resolveTarget('tok', { project: 'nope', environment: 'production', service: 'api' }), (e: any) => {
    assert.equal(e.code, 'TARGET_AMBIGUOUS')
    assert.match(e.message, /my-app/)
    assert.match(e.message, /other/)
    return true
  })
})

test('errors[] in a 200 is RAILWAY_ERROR with the first message', async () => {
  stubFetch({ data: null, errors: [{ message: 'Project not found' }, { message: 'second' }] })
  await assert.rejects(resolveTarget('tok', { project: 'p', environment: 'e', service: 's' }), { code: 'RAILWAY_ERROR', message: 'Project not found' })
})

test('a non-2xx response is RAILWAY_ERROR', async () => {
  stubFetch(new Response('bad gateway', { status: 502 }))
  await assert.rejects(resolveTarget('tok', { project: 'p', environment: 'e', service: 's' }), { code: 'RAILWAY_ERROR' })
})

test('listProjects with an account token asks me once', async () => {
  const calls = stubFetch(fixture('me'))
  assert.deepEqual(await listProjects('tok'), [{ id: 'project-id-1', name: 'my-app', environments: [{ id: 'environment-id-1', name: 'production' }], services: [{ id: 'service-id-1', name: 'api' }] }])
  assert.equal(calls.length, 1)
})

test('listProjects with a workspace token falls back to projects on Not Authorized', async () => {
  const calls = stubFetch(fixture('notAuthorized'), fixture('projects'))
  assert.deepEqual(await listProjects('tok'), [{ id: 'project-id-2', name: 'team-app', environments: [{ id: 'environment-id-2', name: 'production' }], services: [{ id: 'service-id-2', name: 'web' }] }])
  assert.equal(calls.length, 2)
  assert.match(calls[1].query, /^query \{ projects\(first: 500\)/)
})

test('listProjects does not fall back on any other Railway error', async () => {
  const calls = stubFetch({ data: null, errors: [{ message: 'Problem processing request' }] })
  await assert.rejects(listProjects('tok'), { code: 'RAILWAY_ERROR', message: 'Problem processing request' })
  assert.equal(calls.length, 1)
})

const target = { projectId: 'p1', project: 'my-app', environmentId: 'e1', environment: 'production', serviceId: 's3', service: 'web' }

test('customDomainCreate maps the captured response to the routing and verification records', async () => {
  const raw = fixture('customDomainCreate').data.customDomainCreate
  const calls = stubFetch(fixture('customDomainCreate'))
  const domain = await customDomainCreate('tok', target, 'app.example.com')
  assert.deepEqual(calls[0].variables.input, { projectId: 'p1', environmentId: 'e1', serviceId: 's3', domain: 'app.example.com' })
  assert.equal(domain.id, raw.id)
  assert.deepEqual(domain.records, [
    { host: raw.status.dnsRecords[0].hostlabel, type: 'CNAME', value: raw.status.dnsRecords[0].requiredValue },
    { host: raw.status.verificationDnsHost, type: 'TXT', value: raw.status.verificationToken },
  ])
})

test('a record type the code does not know is UNSUPPORTED_RECORD', async () => {
  const body = fixture('customDomainCreate')
  body.data.customDomainCreate.status.dnsRecords[0].recordType = 'DNS_RECORD_TYPE_NS'
  stubFetch(body)
  await assert.rejects(customDomainCreate('tok', target, 'app.example.com'), { code: 'UNSUPPORTED_RECORD' })
})
