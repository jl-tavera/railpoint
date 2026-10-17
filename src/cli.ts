#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spinner } from '@clack/prompts'
import { loadCredentials, requireRailway } from './config.ts'
import { link, type LinkResult } from './link.ts'
import { fail, isJson, ok } from './output.ts'

const USAGE = 'usage: railpoint link <domain> --project <name|id> --service <name|id> [--environment <name|id>] [--json]'

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

function render(r: LinkResult): string {
  const { project, environment, service } = r.target
  return [
    `${r.created ? 'Added' : 'Already on'} ${project} / ${environment} / ${service}: ${r.domain}`,
    '',
    'Add these records at Namecheap:',
    '',
    table([['HOST', 'TYPE', 'VALUE'], ...r.records.map((x) => [x.host, x.type, x.value])]),
  ].join('\n')
}

export async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        service: { type: 'string' },
        environment: { type: 'string', default: 'production' },
        json: { type: 'boolean', default: false },
      },
    })
  } catch {
    parsed = undefined
  }
  const [command, domain, ...extra] = parsed?.positionals ?? []
  const { project, service, environment, json } = parsed?.values ?? {}
  if (command !== 'link' || !domain || extra.length || !project || !service || !environment) {
    process.stderr.write(USAGE + '\n')
    return 1
  }

  const asJson = isJson({ json })
  const spin = asJson ? undefined : spinner({ output: process.stderr })
  try {
    const token = requireRailway(loadCredentials())
    spin?.start(`Adding ${domain} on Railway`)
    const result = await link({ domain, project, environment, service, token })
    spin?.stop('Railway has the domain')
    ok(result, asJson, () => render(result))
    return 0
  } catch (err) {
    spin?.clear()
    fail(err, asJson)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
