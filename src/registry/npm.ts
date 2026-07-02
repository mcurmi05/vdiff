import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

const REGISTRY = "https://registry.npmjs.org";

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<
    string,
    { version: string; dist: { tarball: string }; repository?: { url?: string } }
  >;
  time?: Record<string, string>;
}

export async function fetchPackument(name: string): Promise<Packument> {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
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

  const res = await fetch(v.dist.tarball);
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed (${res.status}) for ${packument.name}@${version}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "vdiff-"));
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    tar.x({
      cwd: dir,
      strip: 1,
      filter: (path) =>
        /\.d\.(ts|mts|cts)$/.test(path) || path === "package/package.json",
    }),
  );
  return dir;
}

export class NotFoundError extends Error {}
