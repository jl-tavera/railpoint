import type { NamecheapAuth } from './config.ts'
import { assertOurDns, findZone, getHosts, setHosts } from './namecheap.ts'
import { RailpointError } from './output.ts'
import { apply, plan, sameValue, type Change, type Conflict } from './plan.ts'
import { customDomainCreate, findCustomDomain, resolveTarget, type DnsRecord, type Target } from './railway.ts'

export type LinkOptions = { domain: string; project: string; environment: string; service: string; token: string; namecheap: NamecheapAuth; force: boolean }

// `confirm` is only passed in a TTY; without it a conflict fails the run.
export type LinkDeps = { confirm?: (conflicts: Conflict[]) => Promise<boolean> }

export type LinkResult = {
  domain: string
  target: Target
  railwayDomainId: string
  created: boolean
  records: DnsRecord[]
  zone: string
  changes: Change[]
  written: boolean
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

  return { domain: railwayDomain.domain, target, railwayDomainId: railwayDomain.id, created: !existing, records: railwayDomain.records, zone, changes, written }
}
