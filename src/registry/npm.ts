import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_HOST = new URL(REGISTRY).host;

// abuse guards: bound network time and bytes so one request can't hang a
// worker or fill the disk (spec §13). Generous — largest real packages'
// tarballs are tens of MB; typical .d.ts payloads are well under 5 MB.
const PACKUMENT_TIMEOUT_MS = 10_000;
const TARBALL_TIMEOUT_MS = 30_000;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_TYPES_BYTES = 15 * 1024 * 1024;

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<
    string,
    { version: string; dist: { tarball: string }; repository?: { url?: string } }
  >;
  time?: Record<string, string>;
}

export class NotFoundError extends Error {}
export class PackageTooLargeError extends Error {}

/** npm's naming rules; also blocks path/URL injection into registry requests. */
const NPM_NAME_RE = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function packageNameProblem(name: string): string | null {
  if (name.length > 214) return "invalid package name: exceeds 214 characters";
  if (!NPM_NAME_RE.test(name)) return `invalid npm package name: ${name}`;
  return null;
}

export async function fetchPackument(name: string): Promise<Packument> {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PACKUMENT_TIMEOUT_MS),
  });
  if (res.status === 404) throw new NotFoundError(`package not found: ${name}`);
  if (!res.ok) throw new Error(`registry error ${res.status} for ${name}`);
  return (await res.json()) as Packument;
}

/**
 * Download a version's tarball and extract only type declarations and
 * package.json into a temp dir. Returns the extraction root (contents of the
 * tarball's `package/` prefix are placed directly inside it).
 */
export async function downloadTypes(
  packument: Packument,
  version: string,
): Promise<string> {
  const v = packument.versions[version];
  if (!v) throw new NotFoundError(`version not found: ${packument.name}@${version}`);

  const tarballUrl = new URL(v.dist.tarball);
  if (tarballUrl.protocol !== "https:" || tarballUrl.host !== REGISTRY_HOST) {
    throw new Error(`unexpected tarball host for ${packument.name}@${version}`);
  }

  const res = await fetch(tarballUrl, {
    signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed (${res.status}) for ${packument.name}@${version}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_TARBALL_BYTES) {
    throw new PackageTooLargeError(
      `${packument.name}@${version} tarball exceeds ${MAX_TARBALL_BYTES / 1024 / 1024} MB limit`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "vdiff-"));
  // extraction budget: tar header sizes are uncompressed, so this also caps
  // decompression bombs. On overrun we keep extracting nothing and fail after
  // the pipeline — a partial table would produce a wrong diff.
  let downloaded = 0;
  let extracted = 0;
  let overBudget = false;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          downloaded += chunk.length;
          if (downloaded > MAX_TARBALL_BYTES) {
            cb(
              new PackageTooLargeError(
                `${packument.name}@${version} tarball exceeds ${MAX_TARBALL_BYTES / 1024 / 1024} MB limit`,
              ),
            );
          } else {
            cb(null, chunk);
          }
        },
      }),
      tar.x({
        cwd: dir,
        strip: 1,
        filter: (path, entry) => {
          if (!/\.d\.(ts|mts|cts)$/.test(path) && path !== "package/package.json") {
            return false;
          }
          extracted += entry.size ?? 0;
          if (extracted > MAX_TYPES_BYTES) {
            overBudget = true;
          }
          return !overBudget;
        },
      }),
    );
    if (overBudget) {
      throw new PackageTooLargeError(
        `${packument.name}@${version} type declarations exceed ${MAX_TYPES_BYTES / 1024 / 1024} MB limit`,
      );
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}
