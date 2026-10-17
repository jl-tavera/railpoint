import { mock } from 'node:test'
import { readFileSync } from 'node:fs'

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/railway/${name}.json`, import.meta.url), 'utf8'))

// Answers each fetch with the next body, recording the GraphQL query, variables and auth header.
export function stubFetch(...bodies: unknown[]) {
  const calls: { query: string; variables: any; auth: string | null }[] = []
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string)
    calls.push({ query, variables, auth: new Headers(init.headers).get('authorization') })
    const body = bodies.shift()
    return body instanceof Response ? body : Response.json(body)
  })
  return calls
}
