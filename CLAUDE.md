# railpoint

A CLI that links a Railway service to a custom domain on Namecheap. Modelled on
[doomain](https://github.com/crafter-station/doomain), cut to one platform and one registrar.

The words are in `resources/reference/glossary.md`, the decisions in `resources/reference/adr/`. What is
built and what comes next: `resources/planning/ROADMAP.md`, the specs in `resources/planning/specs/`. A
skill that names `docs/glossary.md`, `docs/adr/` or a spec under `docs/` means these paths; never create
them under `docs/`. `resources/` holds no data file and no secret.

## Layout

`src/` is flat: `cli.ts`, `link.ts`, `railway.ts`, `namecheap.ts`, `plan.ts`, `config.ts`, `output.ts`
(and `wizard.ts` from Spec B). Tests in `test/`, fixtures captured from real responses in
`test/fixtures/` with tokens, ids and domains replaced. Node ≥ 24 runs `.ts` directly; `dist/` exists
only for the npm `bin`.

## Agent skills

Checks (from ticket A1 on): `npm test` and `npx tsc --noEmit`. Both green before a commit.

Never: write to Namecheap without reading the zone first (ADR 0001); hard-code a DNS value Railway
should have returned; add a dependency for what a few lines of stdlib do.
