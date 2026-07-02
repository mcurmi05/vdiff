# Graph Report - docs  (2026-07-02)

## Corpus Check
- Corpus is ~3,230 words - fits in a single context window. You may not need a graph.

## Summary
- 35 nodes · 39 edges · 6 communities
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.91)
- Token cost: 47,448 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Diff Pipeline & Data Sources|Diff Pipeline & Data Sources]]
- [[_COMMUNITY_Distribution & Monetisation|Distribution & Monetisation]]
- [[_COMMUNITY_Package Resolution & Product Core|Package Resolution & Product Core]]
- [[_COMMUNITY_Signature Diffing Engines|Signature Diffing Engines]]
- [[_COMMUNITY_Diff API Endpoints|Diff API Endpoints]]
- [[_COMMUNITY_Hosting & Deployment|Hosting & Deployment]]

## God Nodes (most connected - your core abstractions)
1. `/v1/diff Endpoint` - 6 edges
2. `MCP Server Layer` - 4 edges
3. `REST API Layer` - 4 edges
4. `Diff Engine` - 4 edges
5. `Postgres Cache Database` - 4 edges
6. `Ingestion Workers` - 4 edges
7. `vdiff-API (Breaking-Change Diff API for LLMs)` - 3 edges
8. `Structural Diffing (Tier 2)` - 3 edges
9. `/v1/resolve Endpoint` - 3 edges
10. `Context7` - 3 edges

## Surprising Connections (you probably didn't know these)
- `/v1/diff Endpoint` --shares_data_with--> `Postgres Cache Database`  [INFERRED]
  breaking-change-api-spec.md → breaking-change-api-spec.md  _Bridges community 0 → community 4_
- `CI/PR Integration` --references--> `/v1/diff Endpoint`  [INFERRED]
  breaking-change-api-spec.md → breaking-change-api-spec.md  _Bridges community 4 → community 1_
- `vdiff-API (Breaking-Change Diff API for LLMs)` --references--> `Context7`  [EXTRACTED]
  breaking-change-api-spec.md → breaking-change-api-spec.md  _Bridges community 2 → community 1_
- `MCP Server Layer` --references--> `REST API Layer`  [EXTRACTED]
  breaking-change-api-spec.md → breaking-change-api-spec.md  _Bridges community 1 → community 0_
- `Diff Engine` --implements--> `Structural Diffing (Tier 2)`  [EXTRACTED]
  breaking-change-api-spec.md → breaking-change-api-spec.md  _Bridges community 0 → community 3_

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Three-Tier Data Sourcing Strategy** — docs_breaking_change_api_spec_npm_registry_api, docs_breaking_change_api_spec_pypi_json_api, docs_breaking_change_api_spec_github_releases, docs_breaking_change_api_spec_structural_diffing, docs_breaking_change_api_spec_changelog_llm_extraction [EXTRACTED 1.00]
- **vdiff-API Core Architecture** — docs_breaking_change_api_spec_mcp_server, docs_breaking_change_api_spec_rest_api_layer, docs_breaking_change_api_spec_diff_engine, docs_breaking_change_api_spec_postgres_cache, docs_breaking_change_api_spec_ingestion_workers [EXTRACTED 1.00]
- **REST API Endpoint Surface** — docs_breaking_change_api_spec_diff_endpoint, docs_breaking_change_api_spec_resolve_endpoint, docs_breaking_change_api_spec_summary_endpoint, docs_breaking_change_api_spec_history_endpoint [EXTRACTED 1.00]

## Communities (6 total, 0 thin omitted)

### Community 0 - "Diff Pipeline & Data Sources"
Cohesion: 0.24
Nodes (10): Changelog LLM Extraction (Tier 3), Confidence Scoring, Conservative Breaking-Change Detection, Diff Engine, FastAPI, GitHub Releases / CHANGELOG.md, Ingestion Workers, Postgres Cache Database (+2 more)

### Community 1 - "Distribution & Monetisation"
Cohesion: 0.33
Nodes (7): CI/PR Integration, Coding Agents as Primary Consumer, Context7, Freemium Pricing Model, MCP SDK (@modelcontextprotocol/sdk or Python), MCP Server Layer, No-Signup Free Tier

### Community 2 - "Package Resolution & Product Core"
Cohesion: 0.33
Nodes (6): lastversion, npm Registry API, Phased Build Plan, /v1/resolve Endpoint, resolve_package MCP Tool, vdiff-API (Breaking-Change Diff API for LLMs)

### Community 3 - "Signature Diffing Engines"
Cohesion: 0.40
Nodes (5): .d.ts Type Declaration Diffing, Python AST Signature Diffing, Python stdlib ast Module, Structural Diffing (Tier 2), TypeScript Compiler API / api-extractor

### Community 4 - "Diff API Endpoints"
Cohesion: 0.50
Nodes (4): /v1/diff Endpoint, get_breaking_changes MCP Tool, /history Endpoint, /v1/summary Endpoint

### Community 5 - "Hosting & Deployment"
Cohesion: 0.67
Nodes (3): AWS-Native Architecture Alternative, PaaS Hosting Plan (Fly/Render/Railway + Neon), Private/Internal Package Support

## Knowledge Gaps
- **12 isolated node(s):** `/v1/summary Endpoint`, `/history Endpoint`, `resolve_package MCP Tool`, `get_breaking_changes MCP Tool`, `PyPI JSON API` (+7 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Postgres Cache Database` connect `Diff Pipeline & Data Sources` to `Diff API Endpoints`?**
  _High betweenness centrality (0.299) - this node is a cross-community bridge._
- **Why does `Diff Engine` connect `Diff Pipeline & Data Sources` to `Signature Diffing Engines`?**
  _High betweenness centrality (0.266) - this node is a cross-community bridge._
- **Why does `/v1/diff Endpoint` connect `Diff API Endpoints` to `Diff Pipeline & Data Sources`, `Distribution & Monetisation`?**
  _High betweenness centrality (0.238) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `/v1/diff Endpoint` (e.g. with `CI/PR Integration` and `Postgres Cache Database`) actually correct?**
  _`/v1/diff Endpoint` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `/v1/summary Endpoint`, `/history Endpoint`, `resolve_package MCP Tool` to the rest of the system?**
  _12 weakly-connected nodes found - possible documentation gaps or missing edges._