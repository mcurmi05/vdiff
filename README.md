# vdiff-API

Breaking-change diff API for npm packages. Given a package and two versions, returns a structured, machine-readable diff of what actually broke: removed exports, changed signatures, kind changes — so coding agents stop generating code against APIs that no longer exist.

## Why

LLMs write code against the API surface they learned during training. When a dependency has moved on — a function renamed, a required parameter added, an export removed — the model still confidently emits the old call. Version-lookup tools say *what version is current*; documentation tools say *what the docs say now*. Neither answers the question an agent mid-edit actually has: **"what changed between the version I know and the version installed?"** vdiff-API answers exactly that, as structured data with an honest confidence score.

Full product spec: [docs/breaking-change-api-spec.md](docs/breaking-change-api-spec.md) · API reference: [docs/api.md](docs/api.md)

## How it works

1. **Resolve** — package metadata, versions, and dist-tags from the npm registry.
2. **Extract** — for each of the two versions, download the tarball, keep only `.d.ts` files, and build a table of public exports (functions, classes, members, normalized call signatures) with the TypeScript compiler API. Bundled declarations are preferred; packages that ship none fall back to their DefinitelyTyped `@types/*` package, version-matched by `major.minor`.
3. **Compare** — diff the two export tables into typed change entries (`export_removed`, `signature_changed`, `member_removed`, …), each with before/after signatures and a short migration note.
4. **Cache & meter** — results stored in Postgres keyed on (package, from, to); every request logged with cache-hit status for future usage-based billing. First diff ~1–3 s, cached ~instant.

Structural diffing is the ground truth by design (spec §4): signatures come from parsed type declarations, not changelog prose, so the output can't hallucinate. Confidence is `0.9` for bundled types, `0.8` when `@types/*` is involved — type-level changes only; behavior changes with no type change are invisible.

## Stack

| Layer      | Choice                              | Why                                                                             |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Runtime    | Node 20+, full TypeScript           | Phase 1 is npm-only and `.d.ts` diffing needs the TS compiler API — one language |
| API        | Fastify 5                           | Fast, minimal, good TS support                                                  |
| Diffing    | `typescript` compiler API           | Structured symbol tables from `.d.ts`, the core IP                              |
| Database   | Postgres 16 (Docker local, Neon prod) | JSONB for variable-shape diff payloads, SQL for billing/analytics             |
| Registry   | npm registry HTTP API + `tar`       | Packuments and tarball extraction, declarations only                            |
| Tests      | Vitest                              | Unit tests for compare logic and `@types` version matching                      |

Deployment plan: PaaS (Render/Fly/Railway) first — code stays cloud-agnostic (plain container + `DATABASE_URL`), AWS migration possible later if a customer or compliance need justifies it (spec §9a).

## Project layout

```
src/
  index.ts          Fastify bootstrap, /healthz
  routes.ts         /v1/resolve, /v1/diff — validation, cache, dedup, metering
  registry/npm.ts   packument fetch, tarball download, .d.ts extraction
  diff/
    symbols.ts      .d.ts → symbol table (TS compiler API)
    compare.ts      symbol table diff → breaking changes
    engine.ts       orchestration, @types/* fallback, confidence
  db/
    schema.sql      packages, versions, diffs, diff_requests_log
    migrate.ts      applies schema
docs/
  breaking-change-api-spec.md   full product spec
  api.md                        endpoint reference (kept current with code)
```

## Run locally

```bash
docker compose up -d      # Postgres 16 on :5432
npm install
npm run db:migrate        # apply src/db/schema.sql
npm run dev               # API on :3000
```

Or containerized (what PaaS will run — applies schema on boot, then serves):

```bash
docker build -t vdiff-api .
docker run -p 3000:3000 -e DATABASE_URL="postgres://user:pass@host:5432/db" vdiff-api
```

## Endpoints (v1)

```
GET /v1/resolve?ecosystem=npm&package=zod
GET /v1/diff?ecosystem=npm&package=zod&from=3.24.0&to=4.0.0   # to defaults to latest
GET /healthz
```

See [docs/api.md](docs/api.md) for parameters, response shapes, change types, and error codes.

## Tests

```bash
npm test          # unit tests (Vitest)
npx tsc --noEmit  # typecheck
```

## Roadmap

- **Phase 1 (current)**: npm, structural `.d.ts` diffing, Postgres cache, REST `/diff` + `/resolve` — no auth or billing yet.
- **Phase 2**: PyPI + Python AST diffing, MCP server wrapper (primary distribution channel), API-key auth + rate limits, pre-computed diffs for top packages, `/history` endpoint.
- **Phase 3**: LLM-extracted changelog notes as a lower-confidence supplementary source, CI/PR integration (fail dependency-bump PRs with known breaks), private-package support.

Monetisation: freemium — generous no-signup free tier (agents bail on signup walls), paid tier for teams/CI volume (spec §10).
