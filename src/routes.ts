import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import semver from "semver";
import { query } from "./db/index.js";
import { computeDiff } from "./diff/engine.js";
import { NoTypesError } from "./diff/symbols.js";
import {
  fetchPackument,
  NotFoundError,
  packageNameProblem,
  PackageTooLargeError,
  type Packument,
} from "./registry/npm.js";

interface ResolveQuery {
  ecosystem?: string;
  package?: string;
}

interface DiffQuery extends ResolveQuery {
  from?: string;
  to?: string;
}

// per-IP rate limits (in-memory, per instance). /v1/diff triggers real
// compute + npm downloads, so it gets a tighter budget than /v1/resolve.
const RATE_LIMIT_DIFF_MAX = Number(process.env.RATE_LIMIT_DIFF_MAX ?? 30);
const RATE_LIMIT_RESOLVE_MAX = Number(process.env.RATE_LIMIT_RESOLVE_MAX ?? 120);

// cap simultaneous diff computations: TS compilation is CPU-bound and the
// rate limiter can't stop N distinct IPs from piling up N uncached diffs.
const COMPUTE_CONCURRENCY = Number(process.env.COMPUTE_CONCURRENCY ?? 2);
let computing = 0;

export async function routes(app: FastifyInstance) {
  app.get<{ Querystring: ResolveQuery }>(
    "/v1/resolve",
    { config: { rateLimit: { max: RATE_LIMIT_RESOLVE_MAX, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const bad = validateBase(req.query);
      if (bad) return reply.code(400).send({ error: bad });

      try {
        const packument = await fetchPackument(req.query.package!);
        return {
          ecosystem: "npm",
          package: packument.name,
          latest: packument["dist-tags"].latest,
          dist_tags: packument["dist-tags"],
          versions_count: Object.keys(packument.versions).length,
        };
      } catch (err) {
        return sendUpstreamError(req, reply, err);
      }
    },
  );

  app.get<{ Querystring: DiffQuery }>(
    "/v1/diff",
    { config: { rateLimit: { max: RATE_LIMIT_DIFF_MAX, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const bad = validateBase(req.query);
      if (bad) return reply.code(400).send({ error: bad });
      const { package: pkg, from } = req.query;
      if (!from) return reply.code(400).send({ error: "missing required param: from" });

      let packument: Packument;
      try {
        packument = await fetchPackument(pkg!);
      } catch (err) {
        return sendUpstreamError(req, reply, err);
      }

      const to = req.query.to ?? packument["dist-tags"].latest;
      for (const [label, v] of [["from", from], ["to", to]] as const) {
        if (!semver.valid(v)) {
          return reply.code(400).send({ error: `invalid semver in '${label}': ${v}` });
        }
        if (!packument.versions[v]) {
          return reply.code(404).send({ error: `version not found: ${pkg}@${v}` });
        }
      }

      const packageId = await upsertPackage(packument);

      const cached = await query<{
        id: number;
        status: string;
        breaking_changes: unknown;
        types_source: unknown;
        error: string | null;
        confidence_score: number;
        source_tier: string;
        created_at: string;
      }>(
        `SELECT id, status, breaking_changes, types_source, error, confidence_score, source_tier, created_at
         FROM diffs WHERE package_id = $1 AND version_from = $2 AND version_to = $3`,
        [packageId, from, to],
      );

      const hit = cached.rows[0];
      await query(
        `INSERT INTO diff_requests_log (package_id, version_from, version_to, cache_hit, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [packageId, from, to, hit?.status === "complete", userAgent(req)],
      );

      if (hit?.status === "complete") {
        return diffResponse(pkg!, from, to, hit);
      }
      if (hit?.status === "pending") {
        // another request is computing this diff right now
        const ageMs = Date.now() - new Date(hit.created_at).getTime();
        if (ageMs < 120_000) {
          return sendPending(reply);
        }
        await query(`DELETE FROM diffs WHERE id = $1`, [hit.id]); // stale, recompute
      } else if (hit?.status === "failed") {
        await query(`DELETE FROM diffs WHERE id = $1`, [hit.id]); // allow retry
      }

      // check + increment with no await in between — an await here would let
      // simultaneous requests all pass the check before any of them counts
      if (computing >= COMPUTE_CONCURRENCY) {
        return reply
          .code(503)
          .header("retry-after", "5")
          .send({ status: "busy", error: "server busy computing other diffs", retry_after_seconds: 5 });
      }
      computing++;
      let diffId: number | undefined;
      try {
        const claimed = await query<{ id: number }>(
          `INSERT INTO diffs (package_id, version_from, version_to, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (package_id, version_from, version_to) DO NOTHING
           RETURNING id`,
          [packageId, from, to],
        );
        if (claimed.rows.length === 0) {
          return sendPending(reply);
        }
        diffId = claimed.rows[0].id;

        const result = await computeDiff(packument, from, to);
        const stored = await query<{
          status: string;
          breaking_changes: unknown;
          types_source: unknown;
          confidence_score: number;
          source_tier: string;
        }>(
          `UPDATE diffs SET status = 'complete', breaking_changes = $2,
             confidence_score = $3, source_tier = $4, types_source = $5, computed_at = now()
           WHERE id = $1
           RETURNING status, breaking_changes, types_source, confidence_score, source_tier`,
          [
            diffId,
            JSON.stringify(result.breaking_changes),
            result.confidence_score,
            result.source_tier,
            JSON.stringify(result.types_source),
          ],
        );
        return diffResponse(pkg!, from, to, stored.rows[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (diffId !== undefined) {
          await query(`UPDATE diffs SET status = 'failed', error = $2 WHERE id = $1`, [
            diffId,
            message,
          ]);
        }
        if (err instanceof NoTypesError || err instanceof PackageTooLargeError) {
          return reply.code(422).send({ status: "failed", error: message });
        }
        req.log.error(err);
        return reply.code(500).send({ status: "failed", error: "internal error computing diff" });
      } finally {
        computing--;
      }
    },
  );
}

function validateBase(q: ResolveQuery): string | null {
  if (!q.ecosystem) return "missing required param: ecosystem";
  if (q.ecosystem !== "npm") return `unsupported ecosystem: ${q.ecosystem} (v1 supports 'npm')`;
  if (!q.package) return "missing required param: package";
  return packageNameProblem(q.package);
}

function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 255) : null;
}

function sendPending(reply: FastifyReply) {
  return reply
    .code(202)
    .header("retry-after", "3")
    .send({ status: "pending", retry_after_seconds: 3 });
}

function diffResponse(
  pkg: string,
  from: string,
  to: string,
  row: {
    breaking_changes: unknown;
    types_source: unknown;
    confidence_score: number;
    source_tier: string;
  },
) {
  return {
    ecosystem: "npm",
    package: pkg,
    from,
    to,
    status: "complete",
    confidence: row.confidence_score,
    source_tier: row.source_tier,
    types_source: row.types_source,
    breaking_changes: row.breaking_changes,
  };
}

function sendUpstreamError(req: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  req.log.error(err);
  return reply.code(502).send({ error: "upstream registry error" });
}

async function upsertPackage(packument: Packument): Promise<number> {
  const repo = packument.versions[packument["dist-tags"].latest]?.repository?.url ?? null;
  const res = await query<{ id: number }>(
    `INSERT INTO packages (ecosystem, name, repo_url, last_indexed_at)
     VALUES ('npm', $1, $2, now())
     ON CONFLICT (ecosystem, name)
     DO UPDATE SET repo_url = EXCLUDED.repo_url, last_indexed_at = now()
     RETURNING id`,
    [packument.name, repo],
  );
  return res.rows[0].id;
}
