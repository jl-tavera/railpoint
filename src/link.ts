import { customDomainCreate, findCustomDomain, resolveTarget, type DnsRecord, type Target } from './railway.ts'

export type LinkOptions = { domain: string; project: string; environment: string; service: string; token: string }

export type LinkResult = { domain: string; target: Target; railwayDomainId: string; created: boolean; records: DnsRecord[] }

// Idempotent: a domain already on the target is reused, so re-running is the status check.
export async function link(opts: LinkOptions): Promise<LinkResult> {
  const target = await resolveTarget(opts.token, opts)
  const existing = await findCustomDomain(opts.token, target, opts.domain)
  const railwayDomain = existing ?? (await customDomainCreate(opts.token, target, opts.domain))
  return { domain: railwayDomain.domain, target, railwayDomainId: railwayDomain.id, created: !existing, records: railwayDomain.records }
}
