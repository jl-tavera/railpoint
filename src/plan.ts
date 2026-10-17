import type { DnsRecord } from './railway.ts'

export type HostRecord = { name: string; type: string; address: string; ttl: number; mxPref: number }

export type Change = { action: 'create' | 'skip' | 'replace'; record: HostRecord }

export type Conflict = { existing: HostRecord; record: HostRecord }

const ROUTING = new Set(['A', 'AAAA', 'CNAME', 'ALIAS', 'URL', 'URL301', 'FRAME'])

// Case and a trailing dot never make two values differ (doomain's silent no-op came from comparing raw strings).
export const sameValue = (a: string, b: string) => a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '')

const isRoutingAt = (h: HostRecord, name: string) => ROUTING.has(h.type) && sameValue(h.name, name)

export function plan(existing: HostRecord[], desired: DnsRecord[], { force }: { force: boolean }): { changes: Change[]; conflicts: Conflict[] } {
  const changes: Change[] = []
  const conflicts: Conflict[] = []
  for (const d of desired) {
    const name = d.host || '@'
    const type = name === '@' && d.type === 'CNAME' ? 'ALIAS' : d.type
    const record: HostRecord = { name, type, address: d.value, ttl: 300, mxPref: 10 }
    if (type === 'TXT') {
      const equal = existing.some((h) => h.type === 'TXT' && sameValue(h.name, name) && sameValue(h.address, d.value))
      changes.push({ action: equal ? 'skip' : 'create', record })
      continue
    }
    const routing = existing.filter((h) => isRoutingAt(h, name))
    if (routing.some((h) => h.type === type && sameValue(h.address, d.value))) changes.push({ action: 'skip', record })
    else if (!routing.length) changes.push({ action: 'create', record })
    else if (force) changes.push({ action: 'replace', record })
    else conflicts.push(...routing.map((h) => ({ existing: h, record })))
  }
  return { changes, conflicts }
}

// The full list for setHosts: every untouched host as read, minus what a replace displaces, plus what is written.
export function apply(existing: HostRecord[], changes: Change[]): HostRecord[] {
  const replaced = changes.filter((c) => c.action === 'replace').map((c) => c.record.name)
  const kept = existing.filter((h) => !replaced.some((name) => isRoutingAt(h, name)))
  return [...kept, ...changes.filter((c) => c.action !== 'skip').map((c) => c.record)]
}
