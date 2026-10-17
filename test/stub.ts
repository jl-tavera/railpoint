import { mock } from 'node:test'
import { readFileSync } from 'node:fs'

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/railway/${name}.json`, import.meta.url), 'utf8'))

export const xml = (name: string) => readFileSync(new URL(`fixtures/namecheap/${name}.xml`, import.meta.url), 'utf8')

// Answers each fetch with the next body (a string is sent as-is, anything else as JSON), recording the
// GraphQL query, variables and auth header, or the Namecheap params from the query string or the form.
export function stubFetch(...bodies: unknown[]) {
  const calls: { url: string; query: string; variables: any; auth: string | null; params: URLSearchParams }[] = []
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const gql = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    const params = init.body instanceof URLSearchParams ? init.body : new URL(url).searchParams
    calls.push({ url, query: gql.query ?? '', variables: gql.variables, auth: new Headers(init.headers).get('authorization'), params })
    const body = bodies.shift()
    return body instanceof Response ? body : typeof body === 'string' ? new Response(body) : Response.json(body)
  })
  return calls
}
