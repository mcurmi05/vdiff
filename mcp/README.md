# vdiff-mcp

MCP server for [vdiff-API](https://github.com/mcurmi05/vdiff-API) — structured breaking-change diffs for npm packages, so coding agents stop writing code against removed or renamed APIs.

Given a package and two versions (or "the version I know" → latest), it returns a machine-readable diff of what actually broke: removed exports, changed signatures, removed class/interface members — each with before/after signatures, a migration note, and an honest confidence score.

## Setup

Requires Node 20+. No API key needed.

**Claude Code**

```bash
claude mcp add vdiff -- npx -y vdiff-mcp
```

**Cursor / generic MCP config**

```json
{
  "mcpServers": {
    "vdiff": {
      "command": "npx",
      "args": ["-y", "vdiff-mcp"]
    }
  }
}
```

**Suggested rule for your agent config** (drop into `CLAUDE.md`, Cursor rules, etc.):

> Before writing code against an npm dependency whose installed version may be newer than you know, call the vdiff `get_breaking_changes` tool with the version you know as `from`.

## Tools

### `resolve_package`

Resolve an npm package to its latest version and dist-tags.

| Param     | Required | Notes                                  |
| --------- | -------- | -------------------------------------- |
| `package` | yes      | npm package name, e.g. `zod`, `@scope/pkg` |

### `get_breaking_changes`

Structured breaking-change diff between two versions, computed from the package's TypeScript type declarations (bundled `.d.ts`, falling back to DefinitelyTyped `@types/*`).

| Param     | Required | Notes                                                        |
| --------- | -------- | ------------------------------------------------------------ |
| `package` | yes      | npm package name                                             |
| `from`    | yes      | exact semver you have / know, e.g. `3.24.0` (no ranges)      |
| `to`      | no       | exact semver to compare against; defaults to latest          |

The first request for a version pair computes the diff on demand (up to a minute or two for large packages) — the server polls until it's ready. Results are cached permanently, so repeat requests are instant.

Response `confidence`: `0.9` when both versions ship bundled types, `0.8` when `@types/*` declarations were used (community-maintained, can drift).

## Configuration

| Env var         | Default                          | Meaning                                  |
| --------------- | -------------------------------- | ---------------------------------------- |
| `VDIFF_API_URL` | `https://vdiff-api.onrender.com` | Base URL of the vdiff-API instance to use (point at your own self-hosted instance if you run one) |

## Notes

- npm ecosystem only in v1; main entry point only (subpath exports not diffed).
- Diffs are type-level: runtime behavior changes without a type change are invisible.
