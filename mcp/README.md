# vdiff-mcp

An MCP server that tells coding agents what actually broke between two versions of an npm package.

It wraps [vdiff](https://github.com/mcurmi05/vdiff), a service that compares the TypeScript type declarations of two package versions and returns a structured list of breaking changes: removed exports, changed function signatures, and removed or changed class and interface members. Each entry includes the before and after signatures plus a short migration note.

## Why you might want this

LLMs learn a package's API surface during training, then the package moves on. When an agent writes code against `zod` or `express`, it writes for the version it remembers, which is often not the version in your lockfile. The result is confident code that calls functions that were renamed or removed two majors ago.

Existing tools only solve part of this. Version lookup tools tell the agent what the current version is. Documentation tools tell it what the docs say today. Neither answers the question the agent actually has mid-edit: "what changed between the version I know and the version installed here?"

vdiff answers exactly that, with machine-readable data rather than prose. Diffs are computed from the package's own `.d.ts` files, not from changelogs, so the output reflects the real exported surface. Every response carries a confidence score so the agent knows how much to trust it.

Typical uses:

- Upgrading a dependency and wanting a concrete list of what breaks before touching code
- Letting an agent check its assumptions before writing code against a package version newer than its training data
- Reviewing a dependency-bump PR and wanting to know if the major bump actually changes anything you use

## Installation

Requires Node 20 or later. No API key or signup.

**Claude Code**

```bash
claude mcp add vdiff -- npx -y vdiff-mcp
```

**Cursor, Windsurf, or any generic MCP config**

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

To make an agent use it proactively, add a rule like this to your agent config (`CLAUDE.md`, Cursor rules, or similar):

> Before writing code against an npm dependency whose installed version may be newer than you know, call the vdiff `get_breaking_changes` tool with the version you know as `from`.

## Tools

### `get_breaking_changes`

Returns a structured breaking-change diff between two versions of an npm package.

| Param     | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `package` | yes      | npm package name, e.g. `zod` or `@scope/pkg`                       |
| `from`    | yes      | exact version you have or know, e.g. `3.24.0` (ranges are rejected) |
| `to`      | no       | exact version to compare against, defaults to the latest release   |

Example response entry:

```json
{
  "type": "signature_changed",
  "symbol": "setErrorMap",
  "before": ["(map: ZodErrorMap) => void"],
  "after": ["(map: core.$ZodErrorMap) => void"],
  "note": "'setErrorMap' signature changed. Compare before/after and update call sites."
}
```

The first request for a given version pair computes the diff on demand, which can take up to a minute or two for large packages. The tool waits and polls for you. Results are cached on the server permanently, so every later request for the same pair returns immediately.

### `resolve_package`

Resolves a package name to its latest published version and dist-tags. Useful before `get_breaking_changes` when only the package name is known.

| Param     | Required | Description                                |
| --------- | -------- | ------------------------------------------ |
| `package` | yes      | npm package name, e.g. `zod` or `@scope/pkg` |

## How the diffs are made

For each version, the service downloads the package tarball from the npm registry, extracts only the type declaration files, and builds a table of public exports using the TypeScript compiler API. The two tables are then compared structurally.

If a package ships no bundled types, the matching DefinitelyTyped package (`@types/*`) is used instead, version-matched to the target release.

The `confidence` field in every response reflects the source:

- `0.9` when both versions ship bundled type declarations. High trust, but the diff is type-level only.
- `0.8` when `@types/*` declarations were used. These are community maintained and can lag behind or drift from the real package surface.

## Configuration

| Env var         | Default                          | Description                                        |
| --------------- | -------------------------------- | --------------------------------------------------- |
| `VDIFF_API_URL` | `https://vdiff-api.onrender.com` | Base URL of the vdiff API instance. Point this at your own instance if you self-host the API. |

## Limitations

- npm only for now. Python support is planned.
- Only the package's main entry point is diffed. Subpath exports like `pkg/subpath` are not yet covered.
- Diffs are computed from type declarations, so runtime behavior changes that leave the types untouched are invisible. A function that keeps its signature but changes what it returns at runtime will not show up.

## License

MIT
