import { XMLParser } from 'fast-xml-parser'
import type { NamecheapAuth } from './config.ts'
import { RailpointError } from './output.ts'
import type { HostRecord } from './plan.ts'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['Error', 'Domain', 'host'].includes(name),
})

export const apiAccessPage = (sandbox: boolean) => `https://ap.www.${sandbox ? 'sandbox.' : ''}namecheap.com/settings/tools/apiaccess/`
export const whitelistPage = (sandbox: boolean) => `${apiAccessPage(sandbox)}whitelisted-ips`

function toError(auth: NamecheapAuth, text: string): RailpointError {
  if (/\bIP\b/.test(text) && /whitelist|invalid/i.test(text)) {
    return new RailpointError('NAMECHEAP_IP_NOT_WHITELISTED', text, `whitelist ${auth.clientIp} at ${whitelistPage(auth.sandbox)}, or set NAMECHEAP_CLIENT_IP`)
  }
  if (/api ?key|user/i.test(text)) return new RailpointError('NAMECHEAP_AUTH_FAILED', text, 'check NAMECHEAP_API_USER, NAMECHEAP_API_KEY and NAMECHEAP_USERNAME, and that API access is enabled')
  return new RailpointError('NAMECHEAP_ERROR', text)
}

async function request(auth: NamecheapAuth, command: string, params: Record<string, string | number> = {}, method: 'GET' | 'POST' = 'GET') {
  const url = `https://api.${auth.sandbox ? 'sandbox.' : ''}namecheap.com/xml.response`
  const all = new URLSearchParams({ ApiUser: auth.apiUser, ApiKey: auth.apiKey, UserName: auth.username, ClientIp: auth.clientIp, Command: command })
  for (const [k, v] of Object.entries(params)) all.set(k, String(v))
  const res = method === 'GET'
    ? await fetch(`${url}?${all}`, { signal: AbortSignal.timeout(15_000) })
    : await fetch(url, { method, body: all, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new RailpointError('NAMECHEAP_ERROR', `Namecheap answered ${res.status} ${res.statusText}`.trim())
  const body = parser.parse(await res.text()).ApiResponse
  if (body?.Status !== 'OK') {
    const first = body?.Errors?.Error?.[0]
    throw toError(auth, String(first?.['#text'] ?? first ?? 'Namecheap returned an error without a message'))
  }
  return body.CommandResponse
}

// Namecheap's SLD/TLD split: the first label, then the rest (example.co.uk → example + co.uk).
const split = (zone: string) => ({ SLD: zone.slice(0, zone.indexOf('.')), TLD: zone.slice(zone.indexOf('.') + 1) })

// The cheapest read, to prove the credentials before they are saved; returns them.
export const checkAuth = async (auth: NamecheapAuth) => (await request(auth, 'namecheap.domains.getList', { PageSize: 10 }), auth)

export async function findZone(auth: NamecheapAuth, name: string): Promise<{ zone: string; host: string }> {
  const owned: string[] = []
  for (let page = 1; ; page++) {
    const r = await request(auth, 'namecheap.domains.getList', { Page: page, PageSize: 100 })
    const domains: { Name: string }[] = r.DomainGetListResult?.Domain ?? []
    owned.push(...domains.map((d) => d.Name.toLowerCase()))
    if (!domains.length || owned.length >= Number(r.Paging?.TotalItems ?? 0)) break
  }
  const want = name.toLowerCase().replace(/\.$/, '')
  const zone = owned.filter((d) => want === d || want.endsWith(`.${d}`)).sort((a, b) => b.length - a.length)[0]
  if (!zone) throw new RailpointError('ZONE_NOT_FOUND', `No domain in this Namecheap account holds ${name}`, 'check NAMECHEAP_USERNAME, or link a name under a domain you own there')
  return { zone, host: want === zone ? '@' : want.slice(0, -zone.length - 1) }
}

export async function assertOurDns(auth: NamecheapAuth, zone: string): Promise<void> {
  const r = await request(auth, 'namecheap.domains.dns.getList', split(zone))
  if (r.DomainDNSGetListResult?.IsUsingOurDNS !== 'true') {
    throw new RailpointError('NAMECHEAP_NOT_OUR_DNS', `${zone} does not use Namecheap BasicDNS, so its records cannot be written here`, 'switch the nameservers to Namecheap BasicDNS, or add the records where the zone is hosted')
  }
}

export async function getHosts(auth: NamecheapAuth, zone: string): Promise<{ hosts: HostRecord[]; emailType: string }> {
  const r = (await request(auth, 'namecheap.domains.dns.getHosts', split(zone))).DomainDNSGetHostsResult
  const raw: Record<string, string>[] = r.host ?? []
  return {
    hosts: raw.map((h) => ({ name: h.Name, type: h.Type, address: h.Address, ttl: Number(h.TTL), mxPref: Number(h.MXPref) })),
    emailType: r.EmailType ?? '',
  }
}

// setHosts deletes every record it is not sent, so `hosts` must be the whole zone (ADR 0001).
export async function setHosts(auth: NamecheapAuth, zone: string, hosts: HostRecord[], emailType: string): Promise<void> {
  // An empty EmailType is left out rather than sent, so the mail settings stay as they are.
  const params: Record<string, string | number> = { ...split(zone), ...(emailType && { EmailType: emailType }) }
  hosts.forEach((h, i) => {
    Object.assign(params, { [`HostName${i + 1}`]: h.name, [`RecordType${i + 1}`]: h.type, [`Address${i + 1}`]: h.address, [`TTL${i + 1}`]: h.ttl, [`MXPref${i + 1}`]: h.mxPref })
  })
  const r = await request(auth, 'namecheap.domains.dns.setHosts', params, 'POST')
  if (r.DomainDNSSetHostsResult?.IsSuccess !== 'true') throw new RailpointError('NAMECHEAP_ERROR', `Namecheap did not confirm the write to ${zone}`)
}
