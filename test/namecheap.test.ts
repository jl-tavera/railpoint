import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { stubFetch, xml } from './stub.ts'
import { assertOurDns, findZone, getHosts, setHosts } from '../src/namecheap.ts'

const auth = { apiUser: 'user', apiKey: 'key', username: 'user', clientIp: '203.0.113.7', sandbox: false }

beforeEach(() => mock.restoreAll())

test('findZone pages the domain list and the longest owned suffix wins', async () => {
  const calls = stubFetch(xml('getList-page1'), xml('getList-page2'))
  assert.deepEqual(await findZone(auth, 'API.Shop.example.com'), { zone: 'shop.example.com', host: 'api' })
  assert.deepEqual(calls.map((c) => [c.params.get('Command'), c.params.get('Page'), c.params.get('PageSize')]), [
    ['namecheap.domains.getList', '1', '100'],
    ['namecheap.domains.getList', '2', '100'],
  ])
  assert.ok(calls[0].url.startsWith('https://api.namecheap.com/xml.response'))
  assert.deepEqual(['ApiUser', 'ApiKey', 'UserName', 'ClientIp'].map((k) => calls[0].params.get(k)), ['user', 'key', 'user', '203.0.113.7'])
})

test('findZone gives @ at the apex, and ZONE_NOT_FOUND for a domain the account does not own', async () => {
  stubFetch(xml('getList-page1'), xml('getList-page2'))
  assert.deepEqual(await findZone(auth, 'example.com'), { zone: 'example.com', host: '@' })
  stubFetch(xml('getList-page1'), xml('getList-page2'))
  await assert.rejects(findZone(auth, 'notexample.com'), { code: 'ZONE_NOT_FOUND' })
})

test('the sandbox flag selects the sandbox API', async () => {
  const calls = stubFetch(xml('dns-getList-true'))
  await assertOurDns({ ...auth, sandbox: true }, 'example.co.uk')
  assert.ok(calls[0].url.startsWith('https://api.sandbox.namecheap.com/xml.response'))
  assert.deepEqual([calls[0].params.get('SLD'), calls[0].params.get('TLD')], ['example', 'co.uk'])
})

test('a zone on other nameservers is NAMECHEAP_NOT_OUR_DNS', async () => {
  stubFetch(xml('dns-getList-false'))
  await assert.rejects(assertOurDns(auth, 'example.com'), { code: 'NAMECHEAP_NOT_OUR_DNS' })
})

test('getHosts reads every host record and the EmailType', async () => {
  stubFetch(xml('getHosts'))
  const { hosts, emailType } = await getHosts(auth, 'example.com')
  assert.equal(emailType, 'MX')
  assert.equal(hosts.length, 4)
  assert.deepEqual(hosts[2], { name: '@', type: 'MX', address: 'mail.example.com.', ttl: 1800, mxPref: 20 })
})

test('setHosts posts every host, indexed, with the EmailType', async () => {
  stubFetch(xml('getHosts'))
  const { hosts, emailType } = await getHosts(auth, 'example.com')
  const calls = stubFetch(xml('setHosts'))
  await setHosts(auth, 'example.com', [...hosts, { name: 'app', type: 'CNAME', address: 'routing.up.railway.app', ttl: 300, mxPref: 10 }], emailType)
  const form = calls[0].params
  assert.equal(form.get('Command'), 'namecheap.domains.dns.setHosts')
  assert.equal(form.get('EmailType'), 'MX')
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => [form.get(`HostName${i}`), form.get(`RecordType${i}`), form.get(`Address${i}`), form.get(`TTL${i}`), form.get(`MXPref${i}`)]), [
    ['@', 'A', '1.2.3.4', '1800', '10'],
    ['www', 'CNAME', 'example.com.', '3600', '10'],
    ['@', 'MX', 'mail.example.com.', '1800', '20'],
    ['@', 'TXT', 'v=spf1 include:_spf.example.com ~all', '1799', '10'],
    ['app', 'CNAME', 'routing.up.railway.app', '300', '10'],
  ])
  assert.equal(form.get('HostName6'), null)
})

test('a non-whitelisted IP is NAMECHEAP_IP_NOT_WHITELISTED, hinted with the IP and the whitelist page', async () => {
  stubFetch(xml('error-ip'))
  await assert.rejects(getHosts(auth, 'example.com'), (e: any) => {
    assert.equal(e.code, 'NAMECHEAP_IP_NOT_WHITELISTED')
    assert.match(e.hint, /203\.0\.113\.7/)
    assert.match(e.hint, /namecheap\.com\/settings\/tools\/apiaccess/)
    return true
  })
})

test('a bad API key is NAMECHEAP_AUTH_FAILED', async () => {
  stubFetch(xml('error-ip').replace('Invalid request IP: 203.0.113.7', 'API Key is invalid or API access has not been enabled'))
  await assert.rejects(getHosts(auth, 'example.com'), { code: 'NAMECHEAP_AUTH_FAILED' })
})
