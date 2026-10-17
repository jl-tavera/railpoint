#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { confirm, spinner } from '@clack/prompts'
import { loadCredentials, requireNamecheap, requireRailway } from './config.ts'
import { describeConflict, link, type LinkDeps, type LinkResult } from './link.ts'
import { fail, isJson, ok } from './output.ts'

const USAGE = 'usage: railpoint link <domain> --project <name|id> --service <name|id> [--environment <name|id>] [--force] [--timeout <s>] [--no-wait] [--json]'

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

function render(r: LinkResult): string {
  const { project, environment, service } = r.target
  return [
    `${r.created ? 'Added' : 'Already on'} ${project} / ${environment} / ${service}: ${r.domain}`,
    '',
    `${r.written ? 'Wrote' : 'Nothing to write in'} Namecheap zone ${r.zone}:`,
    '',
    table([['', 'HOST', 'TYPE', 'VALUE'], ...r.changes.map((c) => [c.action, c.record.name, c.record.type, c.record.address])]),
  ].join('\n')
}

export async function main(argv: string[], deps: LinkDeps = {}): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        project: { type: 'string' },
        service: { type: 'string' },
        environment: { type: 'string', default: 'production' },
        force: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: true },
        timeout: { type: 'string', default: '300' },
        json: { type: 'boolean', default: false },
      },
    })
  } catch {
    parsed = undefined
  }
  const [command, domain, ...extra] = parsed?.positionals ?? []
  const { project, service, environment, force = false, wait = true, json } = parsed?.values ?? {}
  const timeout = Number(parsed?.values.timeout)
  if (command !== 'link' || !domain || extra.length || !project || !service || !environment || !(timeout >= 0)) {
    process.stderr.write(USAGE + '\n')
    return 1
  }

  const asJson = isJson({ json })
  const spin = asJson ? undefined : spinner({ output: process.stderr })
  try {
    const creds = loadCredentials()
    const token = requireRailway(creds)
    const namecheap = await requireNamecheap(creds)
    spin?.start(`Linking ${domain}`)
    const result = await link({ domain, project, environment, service, token, namecheap, force, wait, timeout }, {
      ...deps,
      progress: spin && ((message) => spin.message(message)),
      confirm: spin && (async (conflicts) => {
        spin.stop('A routing record already points elsewhere')
        const yes = await confirm({ message: `Replace it?\n${conflicts.map(describeConflict).join('\n')}`, initialValue: false })
        spin.start(`Linking ${domain}`)
        return yes === true
      }),
    })
    spin?.stop('Linked')
    ok(result, asJson, () => render(result))
    return 0
  } catch (err) {
    spin?.clear()
    fail(err, asJson)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
