# vdiff-API

A breaking-change diff API for npm packages. Given a package and two versions, it returns a structured, machine-readable list of what actually broke: removed exports, changed function signatures, and removed or changed class and interface members. Each entry includes the before and after signatures plus a short migration note.

Live at `https://vdiff-api.onrender.com`. Most easily consumed through the MCP server, [vdiff-mcp](mcp/README.md):

```bash
claude mcp add vdiff -- npx -y vdiff-mcp
```

Or call the REST API directly:

```bash
curl "https://vdiff-api.onrender.com/v1/diff?ecosystem=npm&package=zod&from=3.24.0&to=4.0.0"
```

## Why this exists

LLMs learn a package's API surface during training, then the package moves on. When a coding agent writes code against `zod` or `express`, it writes for the version it remembers, which is often not the version in your lockfile. The result is confident code that calls functions that were renamed or removed two majors ago.

Existing tools only solve part of this. Version lookup tools tell the agent what the current version is. Documentation tools tell it what the docs say today. Neither answers the question the agent actually has mid-edit: "what changed between the version I know and the version installed here?"

vdiff-API answers exactly that. Diffs are computed from the package's own type declarations rather than changelogs, so the output reflects the real exported surface, and every response carries a confidence score so the consumer knows how much to trust it.

Full product spec: [docs/breaking-change-api-spec.md](docs/breaking-change-api-spec.md). Endpoint reference: [docs/api.md](docs/api.md).

## How it works

1. **Resolve.** Fetch package metadata, versions and dist-tags from the npm registry.
2. **Extract.** For each of the two versions, download the tarball, keep only the `.d.ts` files, and build a table of public exports (functions, classes, members, normalized call signatures) using the TypeScript compiler API. Bundled declarations are preferred; packages that ship none fall back to the matching DefinitelyTyped `@types/*` package, version-matched by `major.minor`.
3. **Compare.** Diff the two export tables into typed change entries (`export_removed`, `signature_changed`, `member_removed` and so on), each with before/after signatures and a migration note.
4. **Cache and meter.** Results are stored in Postgres keyed on (package, from, to), so each version pair is computed once, ever. Every request is logged with cache-hit status and user agent.
5. **Guard.** Per-IP rate limits, a cap on simultaneous diff computations, size limits on tarballs and extracted declarations, and fetch timeouts keep the service safe to expose publicly.

Diffs are type-level: a runtime behavior change that leaves the types untouched is invisible. Responses using bundled types carry confidence `0.9`; responses using community-maintained `@types/*` declarations carry `0.8`.

## API overview

| Endpoint          | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `GET /v1/diff`    | Breaking-change diff between two versions (`from` required, `to` defaults to latest) |
| `GET /v1/resolve` | Latest version and dist-tags for a package                           |
| `GET /healthz`    | Liveness check                                                       |

See [docs/api.md](docs/api.md) for parameters, response shapes, change types, error codes and rate limits.

## Stack

| Layer    | Choice                                | Why                                                                 |
| -------- | ------------------------------------- | ------------------------------------------------------------------- |
| Runtime  | Node 20+, TypeScript                  | npm-only `.d.ts` diffing needs the TS compiler API, so one language |
| API      | Fastify 5                             | Fast, minimal, good TypeScript support                              |
| Diffing  | `typescript` compiler API             | Structured symbol tables from `.d.ts` files, the core of the product |
| Database | Postgres 18 (Docker local, Neon prod) | JSONB for variable-shape diff payloads, SQL for billing and analytics |
| Registry | npm registry HTTP API + `tar`         | Packuments and tarball extraction, declarations only                |
| Tests    | Vitest                                | Unit tests for compare logic and `@types` version matching          |

The code is cloud-agnostic: a plain container plus a `DATABASE_URL`. It currently runs on Render with Neon Postgres.

## Running it yourself

```bash
docker compose up -d      # Postgres 18 on :5432
npm install
npm run db:migrate        # apply src/db/schema.sql
npm run dev               # API on :3000
```

Or containerized, the way a PaaS runs it (applies the schema on boot, then serves):

```bash
docker build -t vdiff-api .
docker run -p 3000:3000 -e DATABASE_URL="postgres://user:pass@host:5432/db" vdiff-api
```

### Configuration

All configuration is via environment variables:

| Env var                  | Default                  | Purpose                                        |
| ------------------------ | ------------------------ | ----------------------------------------------- |
| `PORT`                   | `3000`                   | Listen port                                     |
| `DATABASE_URL`           | local Docker Postgres    | Postgres connection string                      |
| `RATE_LIMIT_DIFF_MAX`    | `30`                     | Per-IP `/v1/diff` requests per minute           |
| `RATE_LIMIT_RESOLVE_MAX` | `120`                    | Per-IP `/v1/resolve` requests per minute        |
| `COMPUTE_CONCURRENCY`    | `2`                      | Max simultaneous diff computations              |
| `TRUST_PROXY`            | unset                    | Set `true` behind a PaaS proxy so the rate limiter sees real client IPs |

### Hardening notes

- **Rate limiting**: per-IP, in-memory (fine while single-instance). `/healthz` is exempt for platform health checks.
- **Compute cap**: at most `COMPUTE_CONCURRENCY` uncached diffs compile at once; excess requests get a `503` with `retry-after`. Cached diffs are always served.
- **Size guards**: tarball downloads are capped at 50 MB (checked via content-length and counted bytes), extracted declarations at 15 MB per version. Oversized packages fail with a clear `422`.
- **Fetch budgets**: 10 s for packuments, 30 s for tarballs. Tarballs are only fetched from `registry.npmjs.org` over HTTPS.

## Project layout

```
src/
  index.ts          Fastify bootstrap, /healthz
  routes.ts         /v1/resolve, /v1/diff: validation, cache, dedup, metering
  registry/npm.ts   packument fetch, tarball download, .d.ts extraction
  diff/
    symbols.ts      .d.ts to symbol table (TS compiler API)
    compare.ts      symbol table diff to breaking changes
    engine.ts       orchestration, @types/* fallback, confidence
  db/
    schema.sql      packages, versions, diffs, diff_requests_log
    migrate.ts      applies schema
mcp/                vdiff-mcp, the MCP server wrapping this API (published to npm)
docs/
  breaking-change-api-spec.md   full product spec
  api.md                        endpoint reference, kept current with the code
```

## Tests

```bash
npm test          # unit tests (Vitest)
npx tsc --noEmit  # typecheck
```

## Roadmap

- **Phase 1 (current)**: npm ecosystem, structural `.d.ts` diffing, Postgres cache, REST `/diff` and `/resolve`, rate limiting and compute guards. Deployed, with the MCP server published to npm and the MCP registry.
- **Phase 2**: PyPI and Python AST diffing, API-key auth and paid tiers, pre-computed diffs for top packages, a `/history` endpoint.
- **Phase 3**: LLM-extracted changelog notes as a lower-confidence supplementary source, CI integration to flag dependency-bump PRs with known breaks, private-package support.

## License

The API and diff engine are licensed under the [Functional Source License, v1.1, MIT Future License](LICENSE.md) (FSL-1.1-MIT): free to use, read and modify for anything except offering a competing service, and each release automatically becomes MIT two years after publication.

The MCP server wrapper in [`mcp/`](mcp/) is [MIT licensed](mcp/LICENSE).
