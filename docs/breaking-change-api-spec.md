# Project Spec: vdiff — A Breaking-Change Diff API for LLMs

## 1. One-line pitch

An API/MCP server that, given a package name and two versions (or "your pinned version" → "latest"), returns a structured, machine-readable diff of what actually broke: removed/renamed functions, changed signatures, new required params, and migration notes — so coding agents stop generating code against APIs that no longer exist.

## 2. Problem this solves

- `lastversion`-style tools tell an LLM *what version is current* but nothing about the API surface.
- Context7-style tools tell an LLM *what the current docs say* but don't tell it what changed relative to the version it was trained on or the version pinned in the user's lockfile.
- The actual failure mode: an LLM confidently writes `foo.bar(x, y)` because that's what it learned during training, but the current version renamed it to `foo.bar(x, y, options)` or removed it entirely in favor of `foo.newBar()`.
- Nobody serves "diff between version A and version B, structured for machine consumption" as a first-class product.

## 3. Core scope (what it does and does not do)

**In scope (v1):**

- npm and PyPI packages only (the two highest-volume ecosystems for AI-assisted coding).
- Diff between two semver versions of the same package.
- Output: added/removed/renamed exports, changed function signatures (param count/type/order), deprecation notices, and a short natural-language migration hint per breaking item.

**Out of scope (v1, maybe later):**

- Full documentation serving (that's Context7's job — you can complement it, not replace it).
- Languages beyond JS/TS and Python.
- Private/internal packages (good v2 expansion, see §11).
- Semantic diffing of *behavior* (e.g., "this function now throws in a new edge case") — that requires runtime analysis, far harder, phase 3 at best.

## 4. Where the data comes from

Three tiers, cheapest/most reliable first:

1. **Structured metadata (free, high signal-to-effort):**

   - npm registry API (`registry.npmjs.org`) — full version history, `package.json` per version, dist-tags.
   - PyPI JSON API (`pypi.org/pypi/<pkg>/json`) — release history, per-version metadata.
   - GitHub Releases + CHANGELOG.md files for the linked repo (most packages link their repo in package metadata).
2. **Type/signature extraction (the actual hard part):**

   - For TS/JS packages that ship `.d.ts` files: diff the type declarations between two versions directly — this is the single highest-value, most tractable source of "signature changed" facts, and it's structured data, not prose.
   - For Python: use `ast` parsing of the package source (downloaded via `pip download` into a sandbox) to extract public function/class signatures per version, then diff.
   - This tier is where you build actual IP — a signature-diffing engine, not just an aggregator.
3. **Prose changelogs (supplementary, lower trust):**

   - CHANGELOG.md, GitHub release notes, migration guides.
   - Run these through an LLM extraction pass to pull out structured "breaking change" bullets, but treat this as a *supplement* to the structural diff, not the primary source — prose is noisy and inconsistent across projects.

**Key design decision:** structural diffing (tier 2) is ground truth and cheap to trust. LLM-extracted changelog summaries (tier 3) are useful but should be flagged with a lower confidence score in the response. Don't let the LLM extraction silently become "the data" — that reintroduces the hallucination problem you're trying to solve.

## 5. Architecture

```
                    ┌─────────────────┐
                    │   MCP Server      │  ← what coding agents call
                    │  (thin wrapper)   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   REST API layer  │  (FastAPI or similar)
                    │  /diff  /resolve  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
      ┌───────▼──────┐┌──────▼──────┐┌──────▼───────┐
      │  Postgres DB  ││ Diff Engine ││ Ingestion Jobs │
      │ (cached diffs)││ (on-demand  ││ (background     │
      │               ││  compute)   ││  workers)       │
      └───────────────┘└─────────────┘└────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ npm / PyPI / GitHub │
                                    │   (external APIs)   │
                                    └─────────────────────┘
```

- **Ingestion workers**: scheduled jobs (not real-time) that watch for new releases of popular packages and pre-compute diffs against the previous version, so common queries are cache hits.
- **On-demand diff engine**: for arbitrary/unpopular version pairs not yet cached, compute on request, store the result, return it. First request is slow (a few seconds), subsequent identical requests are instant.
- **API layer**: stateless, just reads from cache or triggers the diff engine.
- **MCP server**: thin protocol wrapper around the same REST API — this is the distribution layer, not where logic lives.

## 6. Does it need a database? Yes.

Postgres is the right call. Why you need it (this isn't optional):

- Diffs are expensive to compute (downloading packages, parsing ASTs/type files) — you must cache results or your latency and compute costs balloon.
- You need to track which (package, version_a, version_b) triples have already been diffed.
- You need a queue/status table for in-progress diff jobs (so concurrent identical requests don't trigger duplicate work).

**Minimal schema:**

```sql
packages (
  id, ecosystem ('npm'|'pypi'), name, repo_url, last_indexed_at
)

versions (
  id, package_id FK, version_string, published_at, dist_tag_json
)

diffs (
  id, package_id FK, version_from, version_to,
  status ('pending'|'complete'|'failed'),
  breaking_changes JSONB,   -- structured array, see §7
  confidence_score FLOAT,
  computed_at, source_tier  -- 'structural' | 'changelog' | 'mixed'
)

diff_requests_log (
  id, package_id, version_from, version_to, requested_at, cache_hit BOOL
)  -- for usage metering / billing
```

Use Postgres `JSONB` for the breaking-changes payload rather than fully normalizing it — the shape varies enough (added export vs. changed signature vs. deprecation) that a flexible document per diff is more practical than a rigid relational model, while `diff_requests_log` gives you the relational data you actually need for billing and analytics.

## 7. API design

**`GET /v1/diff?ecosystem=npm&package=lodash&from=4.16.0&to=4.17.21`**

```json
{
  "package": "lodash",
  "ecosystem": "npm",
  "from": "4.16.0",
  "to": "4.17.21",
  "confidence": "high",
  "source": "structural",
  "breaking_changes": [
    {
      "type": "function_removed",
      "symbol": "lodash.pluck",
      "replacement": "lodash.map with iteratee shorthand",
      "note": "Removed in 4.x line, use _.map(collection, 'property') instead."
    },
    {
      "type": "signature_changed",
      "symbol": "lodash.debounce",
      "before": "debounce(func, wait, options)",
      "after": "debounce(func, wait, options)",
      "note": "No signature change detected between these versions."
    }
  ],
  "changelog_url": "https://github.com/lodash/lodash/releases/tag/4.17.21"
}
```

**`GET /v1/resolve?ecosystem=npm&package=lodash`** — returns latest stable version + dist-tags (this is your `lastversion`-equivalent convenience endpoint, cheap to build since it's tier-1 data, and it makes your API self-sufficient without a second dependency).

**`GET /v1/summary?ecosystem=npm&package=lodash&from=4.16.0`** — convenience: diff against latest automatically, so an agent doesn't need to know the target version.

Keep responses terse and machine-shaped: no marketing copy, consistent field names, explicit `confidence` field so the LLM (or the agent orchestrating it) can decide how much to trust a given entry.

## 8. MCP server layer

Wrap the REST API in an MCP server exposing 2–3 tools, mirroring Context7's minimal-surface approach (it only exposes two tools and that simplicity is part of why it's easy for agents to pick up):

- `resolve_package` → name → ecosystem + canonical id + latest version.
- `get_breaking_changes` → package + from-version (+ optional to-version, default latest) → structured diff.
- Publish to the MCP registry / awesome-mcp-servers list under a clear name so it surfaces in `search_mcp_registry`-style discovery flows, the same channel that made Context7 easy to find.

## 9. Hosting

Nothing exotic needed for v1:

- **Compute**: a single small VM or container service (Fly.io, Render, or Railway) running the FastAPI app + background worker. This is I/O-bound (network calls to npm/PyPI/GitHub, some CPU for AST parsing), not GPU-bound — cheap to run.
- **Database**: managed Postgres (Neon, Supabase, or RDS) — don't self-host this early, it's not worth the ops burden.
- **Ingestion workers**: a simple cron/queue (even a scheduled GitHub Action or a Render cron job hitting a `/internal/ingest` endpoint is enough for v1; a real queue like Redis+RQ or SQS only becomes necessary once request volume justifies it).
- **Rate limiting / auth**: API keys issued via a simple dashboard, checked at the API layer — don't need a full auth provider for v1, a `api_keys` table with a hashed key and a rate-limit counter is enough.
- Estimated v1 hosting cost: well under $50/month at low volume; scales with diff-computation load (downloading and parsing packages), not with API request volume, since most requests should be cache hits.

### 9a. AWS-native alternative

The default recommendation above (Fly/Render/Railway + Neon) optimizes for fastest time-to-working-product with the least setup surface. AWS is a legitimate alternative, but the reasons to choose it are specific, not general — don't default to it just because it's the industry-standard cloud:

**When AWS is the right call for this project:**

- A prospective customer (especially in the Phase 3 private/internal-package enterprise tier) has a hard requirement to run inside their own AWS VPC, or needs a compliance posture (SOC2, specific data-residency) that's easier to satisfy on AWS than on smaller PaaS providers.
- You already have AWS credits (startup programs, existing account) that make the cost calculus different.
- You want to lean into the workload's naturally spiky, cache-dominated shape from day one rather than migrating into it later.

**What the architecture looks like on AWS, if chosen:**

- **API layer**: API Gateway (HTTP API) + Lambda for the request handlers. This fits well because most traffic is a fast cache read, and Lambda's pay-per-invocation model means you pay near-zero for idle periods between package releases.
- **Diff computation**: a separate, longer-running Lambda (or Fargate task if diffing a large package exceeds Lambda's time/memory limits) triggered asynchronously when a cache miss occurs, so the API layer doesn't block on slow AST/type-parsing work.
- **Database**: Aurora Serverless v2 (Postgres-compatible, scales to near-zero) if you want to keep the relational schema in §6 as-is; DynamoDB is a reasonable alternative specifically because the core access pattern is a simple key lookup (package + version_from + version_to → diff), and DynamoDB's pay-per-request pricing suits the same spiky/idle traffic shape as Lambda. Trade-off: DynamoDB makes the `diff_requests_log` billing/analytics queries (§6) more awkward than Postgres would, so this is a real design decision, not a free upgrade.
- **Ingestion workers**: EventBridge scheduled rules triggering Lambda for the cron-style polling in v1; graduate to SQS + a small Fargate worker fleet in Phase 2 if polling volume grows enough to need a real queue with retries/backoff.
- **Auth/rate limiting**: API Gateway usage plans + API keys handle this natively, which removes the need to hand-roll the `api_keys` table logic described in §9's default plan.

**Cost/complexity honesty check:** this architecture is *cheaper at true-zero traffic* than a PaaS+managed-Postgres setup, because everything scales to near-zero, but it costs more in setup time (IAM roles, VPC config if using Aurora, Lambda packaging/cold-start tuning) and more in ongoing operational complexity than Fly/Render. It's the right choice when a specific requirement (customer, compliance, existing AWS investment) justifies that cost — not as a default.

## 10. Should it be a paid service?

Yes, freemium, same shape as Context7's model (free tier + API key for higher limits) — that model is proven to convert in exactly this market:

- **Free tier**: generous rate limit (e.g., 1,000 requests/day), no key required for basic use, key optional for higher limits. This matters because friction kills MCP adoption — agents/developers bail on multi-step signup.
- **Paid tier**: for teams/CI pipelines running high volume (e.g., a CI check that runs "any breaking changes since our lockfile" on every PR) — this is actually a compelling paid use case beyond just LLM-agent usage, worth building toward.
- **Consider**: a "pre-compute this package for me" priority queue as a paid feature — companies with internal reliance on fast-moving dependencies would pay to have their exact packages ingested and refreshed continuously rather than waiting for the crawler to get to them.

## 11. Phased build plan

**Phase 1 (MVP, ~2-4 weeks for one dev agent):**

- npm only.
- Structural diffing via `.d.ts` comparison only (skip Python, skip changelog-LLM-extraction).
- Postgres cache + on-demand compute, no pre-computation/background ingestion yet.
- REST API with `/diff` and `/resolve`.
- No auth, no billing — just get it working and correct.

**Phase 2:**

- Add PyPI + Python AST-based signature diffing.
- Add MCP server wrapper, publish to registries.
- Add API key auth + rate limiting.
- Add background pre-computation for top ~500 packages by download count so common queries are instant.

**Phase 3:**

- Changelog LLM-extraction as a supplementary confidence-scored source.
- CI/PR integration (GitHub Action that calls the API on dependency bumps).
- Private/internal package support (customer uploads their own repo, you index it) — this is the defensible enterprise expansion, since it requires access no public crawler has.

## 12. Suggested tech stack

- **API**: Python + FastAPI (fast to build, good async support for the many external network calls).
- **DB**: Postgres (Neon for serverless-friendly managed hosting).
- **TS/JS diffing**: `typescript` compiler API (or `@microsoft/api-extractor`) to parse `.d.ts` files into a comparable symbol table.
- **Python diffing**: stdlib `ast` module, extract function defs + signatures from downloaded source, no need for heavier tooling in v1.
- **Background jobs**: start with a simple cron endpoint; graduate to a real queue only if load demands it.
- **MCP server**: `@modelcontextprotocol/sdk` (TypeScript) or the Python MCP SDK, thin layer calling the REST API.

## 13. Open risks / questions to flag to the dev agent

- `.d.ts` diffing gives you *type-level* signature changes but won't catch pure runtime behavior changes with no type change — be upfront in the API response (`confidence` field) about this limitation rather than overclaiming coverage.
- Some packages don't ship types or have poor changelogs — the API needs a clean "insufficient data" response rather than guessing.
- Rate limits from npm/PyPI/GitHub APIs need respectful backoff — don't get IP-banned during ingestion.
- Decide early whether "breaking change" detection should be conservative (only report changes you're structurally certain about) or aggressive (report anything plausibly breaking) — conservative is almost certainly right for a tool whose entire value proposition is trustworthiness.

## 14. Who is the consumer, and why does this matter to them?

**Primary consumer: coding agents themselves, called autonomously mid-task.** This is the Context7 model — the "user" of the API is rarely a human typing a query, it's Claude Code, Cursor, or a CI agent calling the tool as a step inside a larger task, without a person watching each call. That has real implications for design: responses must be terse, structured, and immediately actionable with no back-and-forth, because there's often no human in the loop to clarify an ambiguous result.

**Secondary consumer: individual developers using AI coding tools**, who benefit indirectly — they experience it as "the AI just didn't break my code this time," not as a product they consciously chose. This is why distribution matters more than a landing page: most users will never visit your website.

**Tertiary consumer: engineering teams running CI pipelines**, who *do* actively choose and pay for the product — e.g., a GitHub Action that fails a PR if a dependency bump introduces a known breaking change the code doesn't account for. This is the segment with real budget and is worth designing the paid tier around.

**Why it's useful, concretely:**

- Saves the debugging loop of "AI writes plausible code → code fails at runtime → developer figures out the API changed → developer manually tells the AI → AI fixes it." That loop is currently invisible cost, paid in developer time, on nearly every AI-coding session involving a library update.
- Unlike documentation tools, it answers a *directional* question — "what do I need to change" — rather than a *descriptive* one — "what does this look like now." Directional answers are more immediately actionable for an agent that's already mid-edit.
- It's a trust signal: an agent that can say "confidence: high, structurally verified" versus "confidence: low, inferred from changelog prose" is more honest about its own limitations than one that just generates code and hopes.

## 15. Making it accessible to people using LLMs

The lesson from Context7 is that discoverability lives inside the agent's tool-selection flow, not on the open web. Concretely:

- **Ship the MCP server as the primary interface**, not the REST API — most agentic coding tools discover capabilities through MCP registries, not by a human searching Google for "breaking change API."
- **Publish to MCP registries and "awesome-mcp-servers" style lists** (see §8) — this is the actual acquisition channel, equivalent to SEO for this category.
- **Provide a one-line rule/prompt snippet** users can drop into their agent's config (Context7's `"Always use Context7 MCP when I need library docs..."` pattern) — lowers the activation energy from "remember to invoke this" to "set it once, forget it."
- **No-signup free tier** — since the consumer is often an autonomous agent mid-task, any auth flow that requires a human to stop and go get a key is a hard wall; let unauthenticated requests work at a real but modest rate limit, and only ask for a key when someone wants more.
- **Self-describing tool schemas** — MCP tool descriptions and parameter names should be unambiguous enough that an LLM picks the right tool and fills parameters correctly without the user having to explain the API in their prompt.

## 16. Single version-to-latest vs. full version history — why both matter

**Why "current version → latest" is the default, high-value case:**

- It maps directly onto the most common real trigger: a developer or agent is about to bump a dependency (or already has, via `npm update`/`pip install -U`), and the only question that matters is "what changes between the version I have and the version I'm about to get." Nobody cares about changes in versions they're skipping over in the abstract — they care about the cumulative effect on their pinned version.
- It's also the cheapest case to serve well: two known endpoints, one diff, easy to cache, easy to keep confidence high.

**Why someone might want the entire history instead:**

- **Auditing an unfamiliar or long-neglected dependency.** If a team hasn't touched a package in three years and is finally upgrading, they don't just want "3.x → 9.x," they may want to understand the *shape* of change — was this a gradual API evolution or a total rewrite? That informs how much manual verification the upgrade needs, not just what to mechanically fix.
- **Understanding project trajectory/stability, not just mechanics.** A maintainer or agent deciding *whether* to adopt a library at all might want to see churn rate over time — "this package has had 4 breaking changes in 6 months" is a signal about volatility that a single pairwise diff can't convey.
- **Multi-step or staged migrations.** Some ecosystems (Python 2→3 style transitions, major framework rewrites) genuinely require going version-by-version rather than jumping straight to latest, because intermediate versions carry their own codemods or compatibility shims. A single A→Z diff would collapse away information the agent actually needs to plan a staged upgrade.
- **Research/changelog-generation use cases** — e.g., "summarize what's changed in this library since I last checked six months ago" for a human digest, not a code-fix task.

**Design implication:** the pairwise `/diff` endpoint should remain the core primitive (cheap, cacheable, high-confidence), but it's worth adding a `/history` endpoint in Phase 2/3 that returns a *sequence* of pairwise diffs between consecutive versions in a range, rather than trying to build a separate "full history" diffing engine — this reuses the same underlying diff computation and caching, just exposed as a list instead of a single result. It also naturally supports "show me the volatility" queries by letting the client (or an LLM synthesizing the response) count/summarize breaking changes across the returned sequence rather than requiring you to build a separate analytics feature.
