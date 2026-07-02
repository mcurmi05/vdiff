-- vdiff-API schema (spec §6)

CREATE TABLE IF NOT EXISTS packages (
  id BIGSERIAL PRIMARY KEY,
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm', 'pypi')),
  name TEXT NOT NULL,
  repo_url TEXT,
  last_indexed_at TIMESTAMPTZ,
  UNIQUE (ecosystem, name)
);

CREATE TABLE IF NOT EXISTS versions (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES packages(id),
  version_string TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  dist_tag_json JSONB,
  UNIQUE (package_id, version_string)
);

CREATE TABLE IF NOT EXISTS diffs (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES packages(id),
  version_from TEXT NOT NULL,
  version_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  breaking_changes JSONB,
  error TEXT,
  confidence_score REAL,
  source_tier TEXT CHECK (source_tier IN ('structural', 'changelog', 'mixed')),
  computed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_id, version_from, version_to)
);

-- usage metering / future billing (spec §6, §10)
CREATE TABLE IF NOT EXISTS diff_requests_log (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT REFERENCES packages(id),
  version_from TEXT,
  version_to TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cache_hit BOOLEAN NOT NULL
);
