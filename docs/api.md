# vdiff-API — API Reference

Reference for the vdiff-API REST endpoints as currently implemented. Updated alongside the code — if this file and the code disagree, the code wins and this file has a bug.

Base URL (local dev): `http://localhost:3000`

## Quick start (local testing)

```bash
docker compose up -d      # Postgres 16 on :5432
npm install
npm run db:migrate        # apply src/db/schema.sql
npm run dev               # API on :3000

# smoke test
curl "localhost:3000/healthz"
curl "localhost:3000/v1/resolve?ecosystem=npm&package=zod"
curl "localhost:3000/v1/diff?ecosystem=npm&package=zod&from=3.24.0&to=4.0.0"
```

---

## GET /healthz

Liveness check. No parameters.

**200**
```json
{ "ok": true }
```

---

## GET /v1/resolve

Resolve a package to its latest version and dist-tags. The `lastversion`-equivalent convenience endpoint (spec §7).

### Query parameters

| Param | Required | Notes |
|-------|----------|-------|
| `ecosystem` | yes | Only `npm` in v1. |
| `package` | yes | npm package name, e.g. `zod`, `@scope/pkg`. |

### Example

```bash
curl "localhost:3000/v1/resolve?ecosystem=npm&package=zod"
```

**200**
```json
{
  "ecosystem": "npm",
  "package": "zod",
  "latest": "4.4.3",
  "dist_tags": { "latest": "4.4.3", "canary": "4.5.0-canary.20260504T180558" },
  "versions_count": 875
}
```

### Errors

| Status | Body | When |
|--------|------|------|
| 400 | `{ "error": "missing required param: ecosystem" }` | Missing/unsupported params. |
| 404 | `{ "error": "package not found: <name>" }` | Package doesn't exist on npm. |
| 502 | `{ "error": "upstream registry error: ..." }` | npm registry unreachable/errored. |

---

## GET /v1/diff

Structured breaking-change diff between two versions of a package. Computed from the two versions' bundled `.d.ts` type declarations (TypeScript compiler API), cached in Postgres. First request for a pair takes ~1–3 s; cached requests are near-instant.

### Query parameters

| Param | Required | Notes |
|-------|----------|-------|
| `ecosystem` | yes | Only `npm` in v1. |
| `package` | yes | npm package name. |
| `from` | yes | Exact semver of the version you have (e.g. from your lockfile). |
| `to` | no | Exact semver to compare against. Defaults to the `latest` dist-tag. |

### Example

```bash
curl "localhost:3000/v1/diff?ecosystem=npm&package=zod&from=3.24.0&to=4.0.0"
```

**200**
```json
{
  "ecosystem": "npm",
  "package": "zod",
  "from": "3.24.0",
  "to": "4.0.0",
  "status": "complete",
  "confidence": 0.9,
  "source_tier": "structural",
  "breaking_changes": [
    {
      "type": "export_removed",
      "symbol": "addIssueToContext",
      "before": ["(ctx: ParseContext, issueData: IssueData) => void"],
      "note": "Export 'addIssueToContext' (function) no longer exists in the target version."
    },
    {
      "type": "signature_changed",
      "symbol": "setErrorMap",
      "before": ["(map: ZodErrorMap) => void"],
      "after": ["(map: core.$ZodErrorMap) => void"],
      "note": "'setErrorMap' signature changed. Compare before/after and update call sites."
    }
  ]
}
```

### Response fields

- `confidence` — float 0–1. Structural `.d.ts` diffs are `0.9`: high trust, but type-level only — runtime behavior changes without a type change are invisible (spec §13).
- `source_tier` — `structural` (only tier implemented). `changelog` and `mixed` reserved for Phase 3.
- `breaking_changes[]` — ordered: breaking items first, then informational `export_added` entries.

### Breaking change types

| `type` | Meaning | Breaking? |
|--------|---------|-----------|
| `export_removed` | Export no longer exists. | yes |
| `export_kind_changed` | e.g. class became function. | yes |
| `signature_changed` | Call signature(s) differ (params, types, return). | yes |
| `member_removed` | Public class/interface member gone. `symbol` is `Class.member`. | yes |
| `member_changed` | Member type/signature differs. | yes |
| `export_added` | New export in target version. | no — informational |

Each entry carries `symbol`, optional `before`/`after` (signature strings or kind), and a short `note` migration hint.

### In-progress responses

Identical concurrent requests don't duplicate work. If another request is already computing this diff:

**202**
```json
{ "status": "pending", "retry_after_seconds": 3 }
```

Retry after a few seconds; the completed diff will be served from cache. Pending rows older than 2 minutes are treated as stale and recomputed.

### Errors

| Status | Body | When |
|--------|------|------|
| 400 | `{ "error": "missing required param: from" }` | Missing params. |
| 400 | `{ "error": "invalid semver in 'from': ..." }` | Not exact semver (ranges like `^3.0.0` rejected). |
| 404 | `{ "error": "version not found: zod@9.9.9" }` | Package or version doesn't exist. |
| 422 | `{ "status": "failed", "error": "package ships no usable bundled type declarations (@types fallback not yet supported)" }` | Package has no bundled `.d.ts` (e.g. `lodash` — types live in `@types/lodash`). Also hits versions published without built files (real case: `zod@3.25.0` ships zero `.d.ts`). |
| 502 | `{ "error": "upstream registry error: ..." }` | npm registry failure. |
| 500 | `{ "status": "failed", "error": "..." }` | Unexpected compute failure. Failed diffs are not cached — retrying recomputes. |

---

## Behavior notes

- **Caching**: completed diffs stored permanently in the `diffs` table keyed on (package, from, to). Failed diffs deleted on next request (retryable).
- **Metering**: every `/v1/diff` request logged to `diff_requests_log` with `cache_hit` — future billing/analytics reads this.
- **Known limits (v1)**: npm only; main entry point only (subpath exports like `pkg/subpath` not diffed); no `@types/*` fallback; type-level changes only.
