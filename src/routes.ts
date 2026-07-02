import type { FastifyInstance } from "fastify";
import semver from "semver";
import { query } from "./db/index.js";
import { computeDiff } from "./diff/engine.js";
import { NoTypesError } from "./diff/symbols.js";
import { fetchPackument, NotFoundError, type Packument } from "./registry/npm.js";

interface ResolveQuery {
  ecosystem?: string;
  package?: string;
}

interface DiffQuery extends ResolveQuery {
  from?: string;
  to?: string;
}

export async function routes(app: FastifyInstance) {
  app.get<{ Querystring: ResolveQuery }>("/v1/resolve", async (req, reply) => {
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
      return sendUpstreamError(reply, err);
    }
  });

  app.get<{ Querystring: DiffQuery }>("/v1/diff", async (req, reply) => {
    const bad = validateBase(req.query);
    if (bad) return reply.code(400).send({ error: bad });
    const { package: pkg, from } = req.query;
    if (!from) return reply.code(400).send({ error: "missing required param: from" });

    let packument: Packument;
    try {
      packument = await fetchPackument(pkg!);
    } catch (err) {
      return sendUpstreamError(reply, err);
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
      error: string | null;
      confidence_score: number;
      source_tier: string;
      created_at: string;
    }>(
      `SELECT id, status, breaking_changes, error, confidence_score, source_tier, created_at
       FROM diffs WHERE package_id = $1 AND version_from = $2 AND version_to = $3`,
      [packageId, from, to],
    );

    const hit = cached.rows[0];
    await query(
      `INSERT INTO diff_requests_log (package_id, version_from, version_to, cache_hit)
       VALUES ($1, $2, $3, $4)`,
      [packageId, from, to, hit?.status === "complete"],
    );

    if (hit?.status === "complete") {
      return diffResponse(pkg!, from, to, hit);
    }
    if (hit?.status === "pending") {
      // another request is computing this diff right now
      const ageMs = Date.now() - new Date(hit.created_at).getTime();
      if (ageMs < 120_000) {
        return reply.code(202).send({ status: "pending", retry_after_seconds: 3 });
      }
      await query(`DELETE FROM diffs WHERE id = $1`, [hit.id]); // stale, recompute
    } else if (hit?.status === "failed") {
      await query(`DELETE FROM diffs WHERE id = $1`, [hit.id]); // allow retry
    }

    const claimed = await query<{ id: number }>(
      `INSERT INTO diffs (package_id, version_from, version_to, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (package_id, version_from, version_to) DO NOTHING
       RETURNING id`,
      [packageId, from, to],
    );
    if (claimed.rows.length === 0) {
      return reply.code(202).send({ status: "pending", retry_after_seconds: 3 });
    }
    const diffId = claimed.rows[0].id;

    try {
      const result = await computeDiff(packument, from, to);
      const stored = await query<{
        status: string;
        breaking_changes: unknown;
        confidence_score: number;
        source_tier: string;
      }>(
        `UPDATE diffs SET status = 'complete', breaking_changes = $2,
           confidence_score = $3, source_tier = $4, computed_at = now()
         WHERE id = $1
         RETURNING status, breaking_changes, confidence_score, source_tier`,
        [diffId, JSON.stringify(result.breaking_changes), result.confidence_score, result.source_tier],
      );
      return diffResponse(pkg!, from, to, stored.rows[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await query(`UPDATE diffs SET status = 'failed', error = $2 WHERE id = $1`, [
        diffId,
        message,
      ]);
      if (err instanceof NoTypesError) {
        return reply.code(422).send({ status: "failed", error: message });
      }
      req.log.error(err);
      return reply.code(500).send({ status: "failed", error: message });
    }
  });
}

function validateBase(q: ResolveQuery): string | null {
  if (!q.ecosystem) return "missing required param: ecosystem";
  if (q.ecosystem !== "npm") return `unsupported ecosystem: ${q.ecosystem} (v1 supports 'npm')`;
  if (!q.package) return "missing required param: package";
  return null;
}

function diffResponse(
  pkg: string,
  from: string,
  to: string,
  row: { breaking_changes: unknown; confidence_score: number; source_tier: string },
) {
  return {
    ecosystem: "npm",
    package: pkg,
    from,
    to,
    status: "complete",
    confidence: row.confidence_score,
    source_tier: row.source_tier,
    breaking_changes: row.breaking_changes,
  };
}

function sendUpstreamError(reply: import("fastify").FastifyReply, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  return reply.code(502).send({
    error: `upstream registry error: ${err instanceof Error ? err.message : err}`,
  });
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
