import { RailpointError } from './output.ts'

const API = 'https://backboard.railway.com/graphql/v2'

export type Target = {
  projectId: string
  project: string
  environmentId: string
  environment: string
  serviceId: string
  service: string
}

export type DnsRecord = { host: string; type: 'A' | 'CNAME' | 'TXT'; value: string }

export type RailwayDomain = { id: string; domain: string; records: DnsRecord[] }

type Named = { id: string; name: string }
type Edges<T> = { edges: { node: T }[] }

type RawDomain = {
  id: string
  domain: string
  status: {
    dnsRecords: { hostlabel: string; recordType: string; requiredValue: string }[]
    verificationDnsHost: string | null
    verificationToken: string | null
  }
}

const DOMAIN_FIELDS = `id domain status { dnsRecords { hostlabel recordType requiredValue } verificationDnsHost verificationToken }`

// Railway's DNSRecordType enum → the record type Namecheap is sent. Anything else is never guessed.
const RECORD_TYPES: Record<string, DnsRecord['type']> = {
  DNS_RECORD_TYPE_A: 'A',
  DNS_RECORD_TYPE_CNAME: 'CNAME',
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => null) as { data?: T; errors?: { message: string }[] } | null
  const message = body?.errors?.[0]?.message
  if (!res.ok || message || !body?.data) throw new RailpointError('RAILWAY_ERROR', message ?? `Railway answered ${res.status} ${res.statusText}`.trim())
  return body.data
}

function pick<T extends Named>(kind: string, items: T[], want: string): T {
  const hits = items.filter((i) => i.id === want || i.name === want)
  if (hits.length === 1) return hits[0]
  const list = (hits.length ? hits : items).map((i) => `${i.name} (${i.id})`).join(', ') || 'none'
  const message = hits.length ? `${hits.length} ${kind}s match "${want}": ${list}` : `No ${kind} matches "${want}". Candidates: ${list}`
  throw new RailpointError('TARGET_AMBIGUOUS', message, `pass the ${kind} id`)
}

const ids = (t: Target) => ({ projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId })

const nodes = <T>(e: Edges<T>) => e.edges.map((x) => x.node)

export async function resolveTarget(token: string, want: { project: string; environment: string; service: string }): Promise<Target> {
  // lazy: only the token owner's workspaces (first 500 projects each); add externalWorkspaces when a shared project is needed
  const data = await gql<{ me: { workspaces: { projects: Edges<Named & { environments: Edges<Named>; services: Edges<Named> }> }[] } }>(
    token,
    `query { me { workspaces { projects(first: 500) { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } } } }`,
  )
  const project = pick('project', data.me.workspaces.flatMap((w) => nodes(w.projects)), want.project)
  const environment = pick('environment', nodes(project.environments), want.environment)
  const service = pick('service', nodes(project.services), want.service)
  return {
    projectId: project.id,
    project: project.name,
    environmentId: environment.id,
    environment: environment.name,
    serviceId: service.id,
    service: service.name,
  }
}

function toDomain(d: RawDomain): RailwayDomain {
  const records = d.status.dnsRecords.map((r): DnsRecord => {
    const type = RECORD_TYPES[r.recordType]
    if (!type) throw new RailpointError('UNSUPPORTED_RECORD', `Railway asks for a ${r.recordType} record at "${r.hostlabel}", which railpoint does not know how to write`)
    return { host: r.hostlabel, type, value: r.requiredValue }
  })
  const { verificationDnsHost: host, verificationToken: token } = d.status
  if (token) {
    if (!host) throw new RailpointError('UNSUPPORTED_RECORD', 'Railway sent a verification token without the host to put it at')
    records.push({ host, type: 'TXT', value: token })
  }
  return { id: d.id, domain: d.domain, records }
}

export async function findCustomDomain(token: string, target: Target, domain: string): Promise<RailwayDomain | undefined> {
  const data = await gql<{ domains: { customDomains: RawDomain[] } }>(
    token,
    `query ($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { customDomains { ${DOMAIN_FIELDS} } } }`,
    ids(target),
  )
  const found = data.domains.customDomains.find((d) => d.domain.toLowerCase() === domain.toLowerCase())
  return found && toDomain(found)
}

export async function customDomainCreate(token: string, target: Target, domain: string): Promise<RailwayDomain> {
  const data = await gql<{ customDomainCreate: RawDomain }>(
    token,
    `mutation ($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { ${DOMAIN_FIELDS} } }`,
    { input: { ...ids(target), domain } },
  )
  return toDomain(data.customDomainCreate)
}
