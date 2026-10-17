# Railway fixtures

**Not captured yet.** These two files follow the shape in Railway's published schema
(`railwayapp/cli`, `src/gql/schema.json` and `CustomDomainCreate.graphql`). The values are placeholders.

Before ticket A1 closes, replace them with one real `customDomainCreate` response and one real
`customDomain` response. Swap in placeholders for the ids, the token and the domain, but keep
`hostlabel`, `recordType` and `verificationDnsHost` as Railway sent them. `customDomain.json` is also the shape of each item in `domains(...).customDomains`, which is what
`link` queries to find a domain that is already on the target. `src/railway.ts` reads the
records from those fields and holds no constant for them.

`me.json`, `notAuthorized.json` and `projects.json` are the three answers `listProjects` handles: an account token's
`me`, a workspace token's `me`, and that token's top-level `projects`. Their shapes follow a live check; the ids and
names are placeholders.
