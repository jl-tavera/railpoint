import { styleText } from 'node:util'
import * as clack from '@clack/prompts'
import { configPath, loadCredentials, publicIp, requireNamecheap, requireRailway, saveCredentials } from './config.ts'
import type { LinkOptions } from './link.ts'
import { apiAccessPage, whitelistPage } from './namecheap.ts'
import { RailpointError } from './output.ts'
import { listProjects } from './railway.ts'

export type Prompts = Pick<typeof clack, 'intro' | 'cancel' | 'log' | 'password' | 'text' | 'select'>

const RAILWAY_TOKENS = 'https://railway.com/account/tokens'

const purple = (s: string) => styleText('magenta', s)
// A purple label with, under it, where to get what it asks for.
const label = (message: string, where?: string) => purple(message) + (where ? `\n${styleText('dim', where)}` : '')

// The error's hint, said in the wizard's terms rather than env vars and flags.
function hint(e: RailpointError): string | undefined {
  // Read only for Namecheap errors: they come after the config was read fine, so this cannot throw while reporting.
  const nc = () => loadCredentials().namecheap
  switch (e.code) {
    case 'RAILWAY_ERROR': return e.message === 'Not Authorized' ? `Railway rejected the API token — check it at ${RAILWAY_TOKENS}` : e.hint
    case 'NAMECHEAP_AUTH_FAILED': return `Namecheap rejected the API user or key — check them, and that API access is on, at ${apiAccessPage(nc().sandbox)}`
    case 'NAMECHEAP_IP_NOT_WHITELISTED': return `whitelist ${nc().clientIp} at ${whitelistPage(nc().sandbox)}`
    case 'ZONE_NOT_FOUND': return 'link a name under a domain in this Namecheap account'
    case 'DNS_CONFLICT': return 'nothing was changed; run railpoint again and replace the record to link'
    case 'TIMEOUT': return 'run railpoint again later; it picks up where it left off'
    default: return e.hint
  }
}

// How the wizard shows a failure: clack's error line and the hint, instead of the CLI's `error CODE:` line.
export function showError(err: unknown, p: Prompts = clack): void {
  const h = err instanceof RailpointError ? hint(err) : undefined
  p.log.error((err instanceof Error ? err.message : String(err)) + (h ? `\n${purple(h)}` : ''))
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

// Thrown when the user cancels a prompt; the CLI exits 0 with "cancelled".
export class Cancelled extends Error {}

export const answer = <T>(value: T): Exclude<T, symbol> => {
  if (clack.isCancel(value)) throw new Cancelled()
  return value as Exclude<T, symbol>
}

const required = (v?: string) => (v?.trim() ? undefined : 'Required')

// A prompt layer over `link`: asks for what is missing, saves it, and returns the options with ids, or
// undefined when the user cancels. The ids come from Railway's lists, so the target cannot be ambiguous.
export async function runWizard(p: Prompts = clack): Promise<LinkOptions | undefined> {
  const choose = async <T extends { id: string; name: string }>(kind: string, items: T[]): Promise<T> => {
    if (!items.length) throw new RailpointError('TARGET_AMBIGUOUS', `The Railway token sees no ${kind}s here`, 'check the token belongs to the workspace with the service, or create it in Railway first')
    const id = answer(await p.select({ message: label(`Pick the ${kind}`), options: items.map((i) => ({ value: i.id, label: i.name })) }))
    return items.find((i) => i.id === id)!
  }
  try {
    p.intro(styleText(['bgMagenta', 'white'], ' railpoint '))
    p.log.message(`Points a custom domain on Namecheap at a Railway service. Your tokens are saved to ${configPath()}.`)
    const { railwayToken, namecheap } = loadCredentials()
    const secret = async (have: string | undefined, message: string) => (have ? undefined : answer(await p.password({ message, validate: required })).trim())
    const typed = {
      railwayToken: await secret(railwayToken, label('Railway API token', `${RAILWAY_TOKENS} (account or workspace token)`)),
      namecheap: {
        apiUser: await secret(namecheap.apiUser, label('Namecheap API user', apiAccessPage(namecheap.sandbox))),
        apiKey: await secret(namecheap.apiKey, label('Namecheap API key', apiAccessPage(namecheap.sandbox))),
        clientIp: namecheap.clientIp ? undefined : answer(await p.text({ message: label('IP whitelisted for the Namecheap API', whitelistPage(namecheap.sandbox)), initialValue: await publicIp(), validate: required })).trim(),
      },
    }
    // Saved before anything else runs, so a failed link does not lose what was typed.
    if (typed.railwayToken || Object.values(typed.namecheap).some(Boolean)) saveCredentials(typed)

    const creds = loadCredentials()
    const token = requireRailway(creds)
    const auth = await requireNamecheap(creds)
    const project = await choose('project', await listProjects(token))
    const environments = project.environments.toSorted((a, b) => Number(b.name === 'production') - Number(a.name === 'production'))
    const environment = await choose('environment', environments)
    const service = await choose('service', project.services)
    const domain = answer(await p.text({
      message: label('Domain to link'),
      placeholder: 'app.example.com',
      validate: (v) => (HOSTNAME.test(v?.trim() ?? '') ? undefined : 'Enter a hostname, like app.example.com'),
    })).trim()
    return { domain, project: project.id, environment: environment.id, service: service.id, token, namecheap: auth, force: false, wait: true, timeout: 300 }
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err
    p.cancel('cancelled')
    return undefined
  }
}
