#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { cancel, confirm, spinner } from '@clack/prompts'
import { loadCredentials, requireNamecheap, requireRailway } from './config.ts'
import { create, describeConflict, link, type CreateOptions, type CreateResult, type LinkDeps, type LinkOptions, type LinkResult } from './link.ts'
import { fail, isJson, ok } from './output.ts'
import { answer, Cancelled, runWizard, type Prompts } from './wizard.ts'

const USAGE = 'usage: railpoint                (interactive, in a terminal)\n       railpoint link <domain> --project <name|id> --service <name|id> [--environment <name|id>] [--force] [--timeout <s>] [--no-wait] [--json]\n       railpoint create <domain> --repo <owner/name> [--project <name|id>] [--service <name>] [--branch <b>] [--force] [--timeout <s>] [--no-wait] [--json]'

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

function render(r: LinkResult | CreateResult): string {
  const { project, environment, service } = r.target
  const made = 'projectCreated' in r ? [r.projectCreated && `project ${project}`, r.serviceCreated && `service ${service}`].filter(Boolean) : []
  return [
    ...(made.length ? [`Created ${made.join(' and ')}`] : []),
    `${r.created ? 'Added' : 'Already on'} ${project} / ${environment} / ${service}: ${r.domain}`,
    '',
    `${r.written ? 'Wrote' : 'Nothing to write in'} Namecheap zone ${r.zone}:`,
    '',
    table([['', 'HOST', 'TYPE', 'VALUE'], ...r.changes.map((c) => [c.action, c.record.name, c.record.type, c.record.address])]),
  ].join('\n')
}

// The one link path, for the command and the wizard alike: `options` resolves inside the error handling.
async function run(options: () => Promise<LinkOptions | CreateOptions | undefined>, asJson: boolean, deps: LinkDeps): Promise<number> {
  const spin = asJson ? undefined : spinner({ output: process.stderr })
  try {
    const opts = await options()
    if (!opts) return 0
    const { domain } = opts
    spin?.start(`Linking ${domain}`)
    const linkDeps: LinkDeps = {
      ...deps,
      progress: spin && ((message) => spin.message(message)),
      confirm: spin && (async (conflicts) => {
        spin.stop('A routing record already points elsewhere')
        const yes = answer(await confirm({ message: `Replace it?\n${conflicts.map(describeConflict).join('\n')}`, initialValue: false }))
        spin.start(`Linking ${domain}`)
        return yes
      }),
    }
    const result = 'repo' in opts ? await create(opts, linkDeps) : await link(opts, linkDeps)
    spin?.stop('Linked')
    ok(result, asJson, () => render(result))
    return 0
  } catch (err) {
    spin?.clear()
    if (err instanceof Cancelled) {
      cancel('cancelled')
      return 0
    }
    fail(err, asJson)
    return 1
  }
}

// No arguments in a terminal runs the wizard; it never runs headless, so anything else needs a command.
export async function main(argv: string[], deps: LinkDeps & { prompts?: Prompts } = {}): Promise<number> {
  const { prompts, ...linkDeps } = deps
  if (!argv.length && process.stdin.isTTY && process.stdout.isTTY) return run(() => runWizard(prompts), false, linkDeps)
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        project: { type: 'string' },
        service: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        environment: { type: 'string' },
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
  const { project, service, environment, repo, branch, force = false, wait = true, json } = parsed?.values ?? {}
  const timeout = Number(parsed?.values.timeout)
  // Each command refuses the other's flags rather than ignore them.
  const targeted = command === 'link' ? project && service && !repo && !branch : command === 'create' && !environment && /^[^/\s]+\/[^/\s]+$/.test(repo ?? '')
  if (!targeted || !domain || extra.length || !(timeout >= 0)) {
    process.stderr.write(USAGE + '\n')
    return 1
  }

  return run(async () => {
    const creds = loadCredentials()
    const common = { domain, token: requireRailway(creds), namecheap: await requireNamecheap(creds), force, wait, timeout }
    return command === 'create' ? { ...common, repo: repo!, project, service, branch } : { ...common, project: project!, environment: environment ?? 'production', service: service! }
  }, isJson({ json }), linkDeps)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
