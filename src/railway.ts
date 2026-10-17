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

const candidates = (items: Named[]) => items.map((i) => `${i.name} (${i.id})`).join(', ') || 'none'

// The one item named or numbered `want`, or undefined when there is none; more than one is never guessed.
export function find<T extends Named>(kind: string, items: T[], want: string): T | undefined {
  const hits = items.filter((i) => i.id === want || i.name === want)
  if (hits.length > 1) throw new RailpointError('TARGET_AMBIGUOUS', `${hits.length} ${kind}s match "${want}": ${candidates(hits)}`, `pass the ${kind} id`)
  return hits[0]
}

function pick<T extends Named>(kind: string, items: T[], want: string): T {
  const hit = find(kind, items, want)
  if (!hit) throw new RailpointError('TARGET_AMBIGUOUS', `No ${kind} matches "${want}". Candidates: ${candidates(items)}`, `pass the ${kind} id`)
  return hit
}

const ids = (t: Target) => ({ projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId })

const nodes = <T>(e: Edges<T>) => e.edges.map((x) => x.node)

// Railway answers `me` only for account tokens; a workspace token gets "Not Authorized".
// lazy: keyed on Railway's message text; key on the error's `path: ['me']` if Railway rewords it
const refusesMe = (e: unknown) => e instanceof RailpointError && e.message === 'Not Authorized'

export type Project = Named & { environments: Named[]; services: Named[] }

type RawProjects = Edges<Named & { environments: Edges<Named>; services: Edges<Named> }>

const PROJECTS = `projects(first: 500) { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } }`

// Every project the token can see, with its environments and services, in one query (two for a workspace token).
export async function listProjects(token: string): Promise<Project[]> {
  let raw: RawProjects[]
  try {
    // lazy: only the token owner's workspaces (first 500 projects each); add externalWorkspaces when a shared project is needed
    const data = await gql<{ me: { workspaces: { projects: RawProjects }[] } }>(token, `query { me { workspaces { ${PROJECTS} } } }`)
    raw = data.me.workspaces.map((w) => w.projects)
  } catch (e) {
    // A workspace token sees its projects at the top level.
    if (!refusesMe(e)) throw e
    raw = [(await gql<{ projects: RawProjects }>(token, `query { ${PROJECTS} }`)).projects]
  }
  return raw.flatMap(nodes).map((p) => ({ ...p, environments: nodes(p.environments), services: nodes(p.services) }))
}

// The workspace a new project goes in: the account's only one, or none for a workspace token (Railway knows it).
async function workspaceId(token: string): Promise<string | undefined> {
  let workspaces: Named[]
  try {
    workspaces = (await gql<{ me: { workspaces: Named[] } }>(token, 'query { me { workspaces { id name } } }')).me.workspaces
  } catch (e) {
    if (refusesMe(e)) return undefined
    throw e
  }
  if (workspaces.length === 1) return workspaces[0].id
  throw new RailpointError('TARGET_AMBIGUOUS', `Your account has ${workspaces.length} workspaces: ${candidates(workspaces)}`, 'use a workspace token for the one to create in, or pass --project with an existing project')
}

export async function projectCreate(token: string, name: string): Promise<string> {
  const input = { name, defaultEnvironmentName: 'production', workspaceId: await workspaceId(token) }
  return (await gql<{ projectCreate: { id: string } }>(token, 'mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }', { input })).projectCreate.id
}

// Railway starts the first deploy of a service with a repo source itself.
export async function serviceCreate(token: string, projectId: string, name: string, repo: string, branch?: string): Promise<string> {
  const input = { projectId, name, source: { repo }, branch }
  return (await gql<{ serviceCreate: { id: string } }>(token, 'mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }', { input })).serviceCreate.id
}

export async function resolveTarget(token: string, want: { project: string; environment: string; service: string }): Promise<Target> {
  const project = pick('project', await listProjects(token), want.project)
  const environment = pick('environment', project.environments, want.environment)
  const service = pick('service', project.services, want.service)
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

export type RecordStatus = { hostlabel: string; requiredValue: string; currentValue: string; ready: boolean }

export type DomainStatus = { records: RecordStatus[]; certificateStatus: string; certificateIssued: boolean }

type RawStatus = {
  dnsRecords: { hostlabel: string; requiredValue: string; currentValue: string; status: string }[]
  verificationDnsHost: string | null
  verificationToken: string | null
  verified: boolean
  certificateStatus: string
}

// Railway's own words for "valid" and "issued" (DNSRecordStatus, CertificateStatus).
export async function customDomainStatus(token: string, id: string, projectId: string): Promise<DomainStatus> {
  const data = await gql<{ customDomain: { status: RawStatus } }>(
    token,
    `query ($id: String!, $projectId: String!) { customDomain(id: $id, projectId: $projectId) { status { dnsRecords { hostlabel requiredValue currentValue status } verificationDnsHost verificationToken verified certificateStatus } } }`,
    { id, projectId },
  )
  const s = data.customDomain.status
  const records = s.dnsRecords.map(({ status, ...r }) => ({ ...r, ready: status === 'DNS_RECORD_STATUS_PROPAGATED' }))
  // The verification TXT record has no status or current value of its own; Railway reports it as `verified`.
  if (s.verificationToken) records.push({ hostlabel: s.verificationDnsHost ?? '', requiredValue: s.verificationToken, currentValue: 'not verified yet', ready: s.verified })
  return { records, certificateStatus: s.certificateStatus, certificateIssued: s.certificateStatus === 'CERTIFICATE_STATUS_TYPE_VALID' }
}
