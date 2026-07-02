#!/usr/bin/env node
/**
 * vdiff-mcp — MCP server wrapping the hosted vdiff REST service (spec §8).
 * Thin protocol layer: no diff logic lives here, it only calls the API.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.VDIFF_API_URL ?? "https://vdiff-api.onrender.com").replace(/\/+$/, "");
// First diff for a version pair is computed on demand (can take ~1 min on big
// packages); the server answers 202/503 with retry-after while it works.
const POLL_BUDGET_MS = 120_000;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(
  path: string,
  params: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(API_URL + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { "user-agent": "vdiff-mcp" } });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body (e.g. proxy error page); status alone is enough to report
  }
  return { status: res.status, body };
}

function apiErrorMessage(status: number, body: Record<string, unknown>): string {
  const detail = body.error ?? body.message ?? JSON.stringify(body);
  return `vdiff API error (HTTP ${status}): ${detail}`;
}

const server = new McpServer({ name: "vdiff", version: "0.1.1" });

server.registerTool(
  "resolve_package",
  {
    title: "Resolve npm package version",
    description:
      "Resolve an npm package to its latest published version and dist-tags. " +
      "Use this when you only know the package name and need the current version, " +
      "typically before calling get_breaking_changes.",
    inputSchema: {
      package: z
        .string()
        .describe('npm package name, e.g. "zod" or "@scope/pkg"'),
    },
  },
  async ({ package: pkg }) => {
    try {
      const { status, body } = await apiGet("/v1/resolve", {
        ecosystem: "npm",
        package: pkg,
      });
      if (status === 200) return ok(body);
      return fail(apiErrorMessage(status, body));
    } catch (err) {
      return fail(`could not reach the vdiff API at ${API_URL}: ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  "get_breaking_changes",
  {
    title: "Get breaking changes between package versions",
    description:
      "Structured breaking-change diff between two versions of an npm package, computed from its " +
      "TypeScript type declarations: removed exports, changed signatures, removed/changed class or " +
      "interface members, plus new exports. Each entry has before/after signatures and a short " +
      "migration note. The response includes a confidence score: 0.9 when both versions ship bundled " +
      "types, 0.8 when DefinitelyTyped @types/* declarations were used. Use this before writing or " +
      "upgrading code that targets a dependency version you are not certain about — e.g. when the " +
      "installed version is newer than the API surface you know. The first request for a version pair " +
      "may take up to a couple of minutes while the diff is computed; results are cached after that.",
    inputSchema: {
      package: z
        .string()
        .describe('npm package name, e.g. "zod" or "@scope/pkg"'),
      from: z
        .string()
        .describe(
          'exact semver of the version you know or currently have installed, e.g. "3.24.0" (from a lockfile); ranges like "^3.0.0" are not accepted'
        ),
      to: z
        .string()
        .optional()
        .describe(
          "exact semver of the version to compare against; omit to use the latest published version"
        ),
    },
  },
  async ({ package: pkg, from, to }) => {
    const params: Record<string, string> = { ecosystem: "npm", package: pkg, from };
    if (to !== undefined) params.to = to;

    const deadline = Date.now() + POLL_BUDGET_MS;
    try {
      while (true) {
        const { status, body } = await apiGet("/v1/diff", params);
        if (status === 200) return ok(body);
        // 202 = this diff is being computed; 503 = server busy with other diffs.
        // Both carry retry_after_seconds; poll until the budget runs out.
        if (status === 202 || status === 503) {
          const waitMs = (Number(body.retry_after_seconds) || 3) * 1000;
          if (Date.now() + waitMs > deadline) {
            return fail(
              "diff is still being computed — retry this tool call in a minute; the result will be cached"
            );
          }
          await sleep(waitMs);
          continue;
        }
        return fail(apiErrorMessage(status, body));
      }
    } catch (err) {
      return fail(`could not reach the vdiff API at ${API_URL}: ${(err as Error).message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
