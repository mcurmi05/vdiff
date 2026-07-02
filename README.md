# vdiff-API

Breaking-change diff API for npm packages. Given a package and two versions, returns a structured, machine-readable diff of what actually broke: removed exports, changed signatures, kind changes — so coding agents stop generating code against APIs that no longer exist.

Spec: [docs/breaking-change-api-spec.md](docs/breaking-change-api-spec.md) · API reference: [docs/api.md](docs/api.md)

## Run locally

```bash
docker compose up -d      # Postgres 16 on :5432
npm install
npm run db:migrate        # apply src/db/schema.sql
npm run dev               # API on :3000
```

## Endpoints (v1)

```
GET /v1/resolve?ecosystem=npm&package=zod
GET /v1/diff?ecosystem=npm&package=zod&from=3.24.0&to=4.0.0   # to defaults to latest
GET /healthz
```

Diffs are computed on demand from the two versions' bundled `.d.ts` files (TypeScript compiler API), cached in Postgres, and metered in `diff_requests_log`. Packages without bundled type declarations return `422` (`@types/*` fallback is planned).

## Tests

```bash
npm test
```
