import * as clack from '@clack/prompts'
import { loadCredentials, publicIp, requireNamecheap, requireRailway, saveCredentials } from './config.ts'
import type { LinkOptions } from './link.ts'
import { RailpointError } from './output.ts'
import { listProjects } from './railway.ts'

export type Prompts = Pick<typeof clack, 'intro' | 'cancel' | 'password' | 'text' | 'select'>

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
    const id = answer(await p.select({ message: `Pick the ${kind}`, options: items.map((i) => ({ value: i.id, label: i.name })) }))
    return items.find((i) => i.id === id)!
  }
  try {
    p.intro('railpoint')
    const { railwayToken, namecheap } = loadCredentials()
    const secret = async (have: string | undefined, message: string) => (have ? undefined : answer(await p.password({ message, validate: required })).trim())
    const typed = {
      railwayToken: await secret(railwayToken, 'Railway API token'),
      namecheap: {
        apiUser: await secret(namecheap.apiUser, 'Namecheap API user'),
        apiKey: await secret(namecheap.apiKey, 'Namecheap API key'),
        clientIp: namecheap.clientIp ? undefined : answer(await p.text({ message: 'IP whitelisted for the Namecheap API', initialValue: await publicIp(), validate: required })).trim(),
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
      message: 'Domain to link',
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
