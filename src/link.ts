import { setTimeout as delay } from 'node:timers/promises'
import type { NamecheapAuth } from './config.ts'
import { assertOurDns, findZone, getHosts, setHosts } from './namecheap.ts'
import { RailpointError } from './output.ts'
import { apply, plan, sameValue, type Change, type Conflict } from './plan.ts'
import { customDomainCreate, customDomainStatus, find, findCustomDomain, listProjects, projectCreate, resolveTarget, serviceCreate, type DnsRecord, type DomainStatus, type Target } from './railway.ts'

export type LinkOptions = { domain: string; project: string; environment: string; service: string; token: string; namecheap: NamecheapAuth; force: boolean; wait: boolean; timeout: number }

// `confirm` and `progress` are only passed in a TTY; without `confirm` a conflict fails the run.
export type LinkDeps = {
  confirm?: (conflicts: Conflict[]) => Promise<boolean>
  progress?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type LinkResult = {
  domain: string
  target: Target
  railwayDomainId: string
  created: boolean
  records: DnsRecord[]
  zone: string
  changes: Change[]
  written: boolean
  status: 'ready' | 'written'
}

const POLL_MS = 5_000

const describePending = (s: DomainStatus) => [
  ...s.records.filter((r) => !r.ready).map((r) => `${r.hostlabel}: ${r.currentValue || 'nothing'} (needs ${r.requiredValue})`),
  ...(s.certificateIssued ? [] : [`certificate: ${s.certificateStatus}`]),
]

// Polls Railway until it reports every record valid and the certificate issued, or the timeout passes.
async function waitForReady(token: string, id: string, projectId: string, timeout: number, deps: LinkDeps): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? delay
  const deadline = now() + timeout * 1000
  let pending = ['no status from Railway yet']
  for (;;) {
    try {
      pending = describePending(await customDomainStatus(token, id, projectId))
      if (!pending.length) return
      deps.progress?.(`Waiting for Railway: ${pending.join(', ')}`)
    } catch (err) {
      process.stderr.write(`status check failed, retrying: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    if (now() >= deadline) throw new RailpointError('TIMEOUT', `Not ready after ${timeout}s: ${pending.join('; ')}`, 're-run `railpoint link` later; it picks up where it left off')
    await sleep(POLL_MS)
  }
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

// The one domain rule, for the command and the wizard alike: the name as Railway and Namecheap should see it.
export function parseDomain(raw: string): string {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!HOSTNAME.test(domain)) throw new RailpointError('INVALID_DOMAIN', `"${raw}" is not a hostname`, 'pass a name like app.example.com')
  return domain
}

export const describeConflict = (c: Conflict) => `${c.existing.name} ${c.existing.type} ${c.existing.address} → ${c.record.type} ${c.record.address}`

// Idempotent: a domain already on the target is reused and equal records are skipped, so re-running is the status check.
export async function link(opts: LinkOptions, deps: LinkDeps = {}): Promise<LinkResult> {
  const target = await resolveTarget(opts.token, opts)
  const existing = await findCustomDomain(opts.token, target, opts.domain)
  const railwayDomain = existing ?? (await customDomainCreate(opts.token, target, opts.domain))

  // Read the whole zone before writing any of it (ADR 0001).
  const nc = opts.namecheap
  const { zone, host } = await findZone(nc, railwayDomain.domain)
  // Railway's labels must be relative to the zone Namecheap holds, or the records would land on the wrong host.
  const routing = railwayDomain.records.find((r) => r.type !== 'TXT')
  if (routing && !sameValue(routing.host || '@', host)) {
    throw new RailpointError('UNSUPPORTED_RECORD', `Railway puts the routing record at "${routing.host}", but ${railwayDomain.domain} is "${host}" in the Namecheap zone ${zone}`)
  }
  await assertOurDns(nc, zone)
  const { hosts, emailType } = await getHosts(nc, zone)
  let { changes, conflicts } = plan(hosts, railwayDomain.records, { force: opts.force })
  if (conflicts.length) {
    if (!deps.confirm || !(await deps.confirm(conflicts))) {
      throw new RailpointError('DNS_CONFLICT', `A routing record already points elsewhere: ${conflicts.map(describeConflict).join('; ')}`, 'pass --force to replace it')
    }
    ;({ changes } = plan(hosts, railwayDomain.records, { force: true }))
  }
  const written = changes.some((c) => c.action !== 'skip')
  if (written) await setHosts(nc, zone, apply(hosts, changes), emailType)
  if (opts.wait) await waitForReady(opts.token, railwayDomain.id, target.projectId, opts.timeout, deps)

  return { domain: railwayDomain.domain, target, railwayDomainId: railwayDomain.id, created: !existing, records: railwayDomain.records, zone, changes, written, status: opts.wait ? 'ready' : 'written' }
}

export type CreateOptions = Omit<LinkOptions, 'project' | 'environment' | 'service'> & { repo: string; project?: string; service?: string; branch?: string }

export type CreateResult = LinkResult & { projectCreated: boolean; serviceCreated: boolean }

// Creates the project and the service from the repo when they are missing, then links. Like `link`, re-running is safe.
export async function create(opts: CreateOptions, deps: LinkDeps = {}): Promise<CreateResult> {
  const name = opts.repo.split('/')[1]
  const projectName = opts.project ?? name
  const serviceName = opts.service ?? name
  const project = find('project', await listProjects(opts.token), projectName)
  const projectId = project?.id ?? (await projectCreate(opts.token, projectName))
  const service = project && find('service', project.services, serviceName)
  const serviceId = service?.id ?? (await serviceCreate(opts.token, projectId, serviceName, opts.repo, opts.branch))
  const result = await link({ ...opts, project: projectId, environment: 'production', service: serviceId }, deps)
  return { ...result, projectCreated: !project, serviceCreated: !service }
}
