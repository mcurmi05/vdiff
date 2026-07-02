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

## Rate limits

Per-IP, per-instance, one-minute window:

| Route          | Default limit | Env override             |
| -------------- | ------------- | ------------------------ |
| `GET /v1/diff` | 30/min        | `RATE_LIMIT_DIFF_MAX`    |
| `GET /v1/resolve` | 120/min    | `RATE_LIMIT_RESOLVE_MAX` |
| `GET /healthz` | unlimited     | —                        |

Every rate-limited response carries `x-ratelimit-limit`, `x-ratelimit-remaining`, and `x-ratelimit-reset` headers. When exceeded:

**429**

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded, retry in 1 minute"
}
```

with a `retry-after` header (seconds).

---

## GET /healthz

Liveness check. No parameters, never rate-limited.

**200**

```json
{ "ok": true }
```

---

## GET /v1/resolve

Resolve a package to its latest version and dist-tags. The `lastversion`-equivalent convenience endpoint (spec §7).

### Query parameters

| Param       | Required | Notes                                                                  |
| ----------- | -------- | ---------------------------------------------------------------------- |
| `ecosystem` | yes      | Only `npm` in v1.                                                      |
| `package`   | yes      | npm package name, e.g. `zod`, `@scope/pkg`. Must be a valid npm name (lowercase, ≤214 chars). |

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

| Status | Body                                                 | When                              |
| ------ | ---------------------------------------------------- | --------------------------------- |
| 400    | `{ "error": "missing required param: ecosystem" }` | Missing/unsupported params.       |
| 400    | `{ "error": "invalid npm package name: ..." }`     | Name fails npm naming rules.      |
| 404    | `{ "error": "package not found: <name>" }`         | Package doesn't exist on npm.     |
| 429    | See [Rate limits](#rate-limits).                     | Limit exceeded.                   |
| 502    | `{ "error": "upstream registry error" }`           | npm registry unreachable/errored/timed out (10 s budget). |

---

## GET /v1/diff

Structured breaking-change diff between two versions of a package. Computed from the two versions' `.d.ts` type declarations (TypeScript compiler API), cached in Postgres. First request for a pair takes ~1–3 s; cached requests are near-instant.

Declaration source per version, in order:

1. **Bundled** `.d.ts` files shipped inside the package tarball (e.g. `zod`).
2. **DefinitelyTyped fallback**: if the package ships no types, the matching `@types/*` package is used (e.g. `lodash` → `@types/lodash`, `@babel/core` → `@types/babel__core`). The `@types` version is matched to the target version's `major.minor` (highest patch), falling back to the highest same-`major` version.

### Query parameters

| Param       | Required | Notes                                                                |
| ----------- | -------- | -------------------------------------------------------------------- |
| `ecosystem` | yes      | Only `npm` in v1.                                                    |
| `package`   | yes      | npm package name (valid npm name, lowercase, ≤214 chars).            |
| `from`      | yes      | Exact semver of the version you have (e.g. from your lockfile).      |
| `to`        | no       | Exact semver to compare against. Defaults to the `latest` dist-tag.  |

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
  "types_source": { "from": "bundled", "to": "bundled" },
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

- `confidence` — float 0–1. Bundled `.d.ts` diffs are `0.9`: high trust, but type-level only — runtime behavior changes without a type change are invisible (spec §13). Diffs involving `@types/*` declarations are `0.8`: community-maintained, can drift from the package's real surface.
- `source_tier` — `structural` (only tier implemented). `changelog` and `mixed` reserved for Phase 3.
- `types_source` — where each side's declarations came from: `"bundled"` or `"@types/<name>@<version>"` (e.g. `{ "from": "@types/express@4.17.25", "to": "@types/express@5.0.6" }`).
- `breaking_changes[]` — ordered: breaking items first, then informational `export_added` entries.

### Breaking change types

| `type`                | Meaning                                                            | Breaking?           |
| ----------------------- | ------------------------------------------------------------------ | ------------------- |
| `export_removed`      | Export no longer exists.                                           | yes                 |
| `export_kind_changed` | e.g. class became function.                                        | yes                 |
| `signature_changed`   | Call signature(s) differ (params, types, return).                  | yes                 |
| `member_removed`      | Public class/interface member gone. `symbol` is `Class.member`.  | yes                 |
| `member_changed`      | Member type/signature differs.                                     | yes                 |
| `export_added`        | New export in target version.                                      | no — informational |

Each entry carries `symbol`, optional `before`/`after` (signature strings or kind), and a short `note` migration hint.

### In-progress and busy responses

Identical concurrent requests don't duplicate work. If another request is already computing this diff:

**202**

```json
{ "status": "pending", "retry_after_seconds": 3 }
```

with a `retry-after: 3` header. Retry after a few seconds; the completed diff will be served from cache. Pending rows older than 2 minutes are treated as stale and recomputed.

If the instance is already computing its maximum number of *different* diffs (default 2, env `COMPUTE_CONCURRENCY`):

**503**

```json
{ "status": "busy", "error": "server busy computing other diffs", "retry_after_seconds": 5 }
```

with a `retry-after: 5` header. Cached diffs are always served regardless of compute load.

### Errors

| Status | Body                                                                                                              | When                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `{ "error": "missing required param: from" }`                                                                    | Missing params.                                                                                                                                                                          |
| 400    | `{ "error": "invalid npm package name: ..." }`                                                                   | Name fails npm naming rules.                                                                                                                                                             |
| 400    | `{ "error": "invalid semver in 'from': ..." }`                                                                   | Not exact semver (ranges like `^3.0.0` rejected).                                                                                                                                        |
| 404    | `{ "error": "version not found: zod@9.9.9" }`                                                                    | Package or version doesn't exist.                                                                                                                                                        |
| 422    | `{ "status": "failed", "error": "<pkg>@<v> ships no bundled type declarations and @types/<pkg> does not exist" }` | No bundled `.d.ts` **and** no usable `@types/*` package (missing, or no version matching the target's major). Also hits versions published without built files (real case: `zod@3.25.0` ships zero `.d.ts`). |
| 422    | `{ "status": "failed", "error": "<pkg>@<v> tarball exceeds 50 MB limit" }`                                       | Package exceeds compute guards: tarball > 50 MB or extracted type declarations > 15 MB.                                                                                                  |
| 429    | See [Rate limits](#rate-limits).                                                                                   | Limit exceeded.                                                                                                                                                                          |
| 502    | `{ "error": "upstream registry error" }`                                                                          | npm registry failure or timeout (10 s packument, 30 s tarball budgets). Details are logged server-side.                                                                                  |
| 503    | `{ "status": "busy", ... }`                                                                                       | Compute concurrency cap reached — retry shortly.                                                                                                                                         |
| 500    | `{ "status": "failed", "error": "internal error computing diff" }`                                                | Unexpected compute failure. Details are logged server-side, never returned. Failed diffs are not cached — retrying recomputes.                                                           |

---

## Behavior notes

- **Caching**: completed diffs stored permanently in the `diffs` table keyed on (package, from, to). Failed diffs deleted on next request (retryable).
- **Metering**: every `/v1/diff` request logged to `diff_requests_log` with `cache_hit` and (truncated) `user_agent` — future billing/analytics reads this.
- **Compute guards**: tarball downloads capped at 50 MB, extracted declarations at 15 MB per version; registry fetches time out (10 s packument / 30 s tarball); tarballs are only fetched from `registry.npmjs.org` over HTTPS.
- **Known limits (v1)**: npm only; main entry point only (subpath exports like `pkg/subpath` not diffed); type-level changes only; `@types/*` declarations can lag or drift from the real package surface (hence lower confidence).

## Server configuration (env)

| Env var                  | Default                                       | Meaning                                        |
| ------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `PORT`                   | `3000`                                        | Listen port.                                   |
| `DATABASE_URL`           | `postgres://vdiff:vdiff@localhost:5432/vdiff` | Postgres connection string.                    |
| `RATE_LIMIT_DIFF_MAX`    | `30`                                          | Per-IP `/v1/diff` requests per minute.         |
| `RATE_LIMIT_RESOLVE_MAX` | `120`                                         | Per-IP `/v1/resolve` requests per minute.      |
| `COMPUTE_CONCURRENCY`    | `2`                                           | Max simultaneous diff computations.            |
| `TRUST_PROXY`            | unset                                         | Set `true` behind a PaaS proxy so the rate limiter sees real client IPs from `x-forwarded-for`. |
