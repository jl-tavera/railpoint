import { styleText } from 'node:util'
import * as clack from '@clack/prompts'
import { configPath, loadCredentials, publicIp, readConfig, requireNamecheap, saveCredentials, type Credentials } from './config.ts'
import { parseDomain, type LinkOptions } from './link.ts'
import { apiAccessPage, checkAuth, whitelistPage } from './namecheap.ts'
import { RailpointError } from './output.ts'
import { listProjects } from './railway.ts'

export type Prompts = Pick<typeof clack, 'intro' | 'cancel' | 'log' | 'password' | 'text' | 'select'>

const RAILWAY_TOKENS = 'https://railway.com/account/tokens'

const purple = (s: string) => styleText('magenta', s)
// A purple label with, under it, where to get what it asks for.
const label = (message: string, where?: string) => purple(message) + (where ? `\n${styleText('dim', where)}` : '')

const notAuthorized = (e: RailpointError) => e.code === 'RAILWAY_ERROR' && e.message === 'Not Authorized'

// The error's hint, said in the wizard's terms rather than env vars and flags.
// `nc` is the Namecheap credentials in use, which the wizard may not have saved yet.
function hint(e: RailpointError, nc: () => Credentials['namecheap']): string | undefined {
  switch (e.code) {
    case 'RAILWAY_ERROR': return notAuthorized(e) ? `Railway rejected the API token — check it at ${RAILWAY_TOKENS}` : e.hint
    case 'NAMECHEAP_AUTH_FAILED': return `Namecheap rejected the API user or key — check them, and that API access is on, at ${apiAccessPage(nc().sandbox)}`
    case 'NAMECHEAP_IP_NOT_WHITELISTED': return `whitelist ${nc().clientIp} at ${whitelistPage(nc().sandbox)}`
    case 'ZONE_NOT_FOUND': return 'link a name under a domain in this Namecheap account'
    case 'DNS_CONFLICT': return 'nothing was changed; run railpoint again and replace the record to link'
    case 'TIMEOUT': return 'run railpoint again later; it picks up where it left off'
    default: return e.hint
  }
}

// How the wizard shows a failure: clack's error line and the hint, instead of the CLI's `error CODE:` line.
// Read only for Namecheap errors: they come after the config was read fine, so this cannot throw while reporting.
export function showError(err: unknown, p: Prompts = clack, nc?: Credentials['namecheap']): void {
  const h = err instanceof RailpointError ? hint(err, () => nc ?? loadCredentials().namecheap) : undefined
  p.log.error((err instanceof Error ? err.message : String(err)) + (h ? `\n${purple(h)}` : ''))
}

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
    // The config file as read, plus what was typed: it is saved only once a call using what was typed succeeded,
    // so a typo is never stored, and a link that fails later keeps what worked. Env values never go in it.
    const file = readConfig()
    const nc = (file.namecheap ??= {})
    const creds = () => loadCredentials(file)
    let typed = false
    const ask = async (prompt: Promise<string | symbol>) => ((typed = true), answer(await prompt).trim())
    const secret = (message: string) => ask(p.password({ message, validate: required }))
    // `rejected` names the values an error refuses, each with its env var. They are forgotten and asked again,
    // unless one comes from the environment, which wins: then the error stands.
    type Rejected = [Record<string, unknown>, string, string][]
    const proven = async <T>(fill: () => Promise<void>, call: () => Promise<T>, rejected: (e: RailpointError) => Rejected): Promise<T> => {
      for (;;) {
        await fill()
        try {
          const result = await call()
          if (typed) saveCredentials(file)
          typed = false
          return result
        } catch (e) {
          const used = creds().namecheap // the hint names what was rejected, so read it before forgetting
          const values = e instanceof RailpointError ? rejected(e) : []
          if (!values.length || values.some(([, , envVar]) => process.env[envVar])) throw e
          for (const [o, key] of values) delete o[key]
          showError(e, p, used)
        }
      }
    }

    const projects = await proven(
      async () => { if (!creds().railwayToken) file.railwayToken = await secret(label('Railway API token', `${RAILWAY_TOKENS} (account or workspace token)`)) },
      () => listProjects(creds().railwayToken!),
      (e) => (notAuthorized(e) ? [[file, 'railwayToken', 'RAILWAY_TOKEN']] : []),
    )
    const { sandbox } = creds().namecheap
    const auth = await proven(
      async () => {
        const have = creds().namecheap
        if (!have.apiUser) nc.apiUser = await secret(label('Namecheap API user', apiAccessPage(sandbox)))
        if (!have.apiKey) nc.apiKey = await secret(label('Namecheap API key', apiAccessPage(sandbox)))
        if (!have.clientIp) nc.clientIp = await ask(p.text({ message: label('IP whitelisted for the Namecheap API', whitelistPage(sandbox)), initialValue: await publicIp(), validate: required }))
      },
      async () => checkAuth(await requireNamecheap(creds())),
      // The username goes with the user: unset, it follows the user typed again.
      (e) => e.code === 'NAMECHEAP_AUTH_FAILED' ? [[nc, 'apiUser', 'NAMECHEAP_API_USER'], [nc, 'apiKey', 'NAMECHEAP_API_KEY'], [nc, 'username', 'NAMECHEAP_USERNAME']]
        : e.code === 'NAMECHEAP_IP_NOT_WHITELISTED' ? [[nc, 'clientIp', 'NAMECHEAP_CLIENT_IP']] : [],
    )
    const token = creds().railwayToken!
    const project = await choose('project', projects)
    const environments = project.environments.toSorted((a, b) => Number(b.name === 'production') - Number(a.name === 'production'))
    const environment = await choose('environment', environments)
    const service = await choose('service', project.services)
    const domain = answer(await p.text({
      message: label('Domain to link'),
      placeholder: 'app.example.com',
      validate: (v) => { try { parseDomain(v ?? '') } catch { return 'Enter a hostname, like app.example.com' } },
    }))
    return { domain: parseDomain(domain), project: project.id, environment: environment.id, service: service.id, token, namecheap: auth, force: false, wait: true, timeout: 300 }
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err
    p.cancel('cancelled')
    return undefined
  }
}
