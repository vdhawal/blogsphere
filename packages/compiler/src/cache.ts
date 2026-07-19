import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { LoadedBlogSpace, LoadedChapter } from "./types.js";

/**
 * Incremental-build cache. Lives at `<space>/.blogspace/build-cache.yaml`.
 *
 * The compiler consults this file before rendering to decide which
 * chapters can be skipped. A chapter is skippable iff its *render-deps
 * hash* matches the cached value — i.e. nothing that affects this
 * chapter's rendered HTML has changed since last compile. Concretely
 * the deps for chapter N are:
 *
 *   - N's own source (frontmatter + body)
 *   - series.yaml (header chrome, chapter order)
 *   - N's prev/next chapter sources (for the chapter nav footer)
 *   - sources of chapters that link TO N via wikilink/chapter-link
 *     (for the "Referenced from" backlinks block)
 *   - sources of chapters that N's chapter-link directives point at
 *     (for the card preview content: target title/summary/cover)
 *
 * The render-deps hash is a PURE CACHE KEY: it decides whether a chapter
 * can be skipped on re-compile. It is NOT part of the filename — chapter
 * HTML lives at the stable `chapters/<slug>.html`, and cache-busting is
 * handled at the HTTP layer (the emitted `_headers` file marks HTML
 * `no-cache` so it revalidates, and immutable assets cache forever) plus
 * Cloudflare's per-deploy edge invalidation. See AGENTS.md.
 *
 * Built-cache compatibility:
 *   - `version` lets us reject old-shape caches and rebuild from scratch.
 *   - `compilerVersion` is bumped when our rendering logic changes in a
 *     way that affects HTML output; old caches are then invalidated.
 */
export const BUILD_CACHE_VERSION = 2;
export const COMPILER_VERSION = "0.0.2";

const chapterCacheSchema = z.object({
  sourceHash: z.string(),
  renderDepsHash: z.string(),
  outputFilename: z.string(),
});

/**
 * Cached image entry for the runtime-fallback path (images NOT in the
 * author's asset manifest). The manifest-served path doesn't need this
 * — the manifest YAML itself is the cache. This struct only covers
 * fixture-seeded or pre-manifest assets that the compiler regenerates
 * variants for on the fly.
 *
 * If `sourceHash` matches the current file AND every variant's
 * `outputPath` exists in the dist tree, the cache entry is reused
 * verbatim and sharp is skipped entirely — by far the most expensive
 * operation in a typical compile.
 */
const cachedImageVariantSchema = z.object({
  format: z.enum(["avif", "webp", "jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  outputPath: z.string(),
  bytes: z.number().int().nonnegative(),
});

const cachedImageSchema = z.object({
  sourceRef: z.string(),
  sourceHash: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  blurhash: z.string(),
  alt: z.string().default(""),
  variants: z.array(cachedImageVariantSchema),
});

const buildCacheSchema = z.object({
  version: z.literal(BUILD_CACHE_VERSION),
  compilerVersion: z.string(),
  lastBuildAt: z.string(),
  seriesSourceHash: z.string(),
  chapters: z.record(z.string(), chapterCacheSchema),
  /** Images processed by the runtime fallback, keyed by sourceRef. */
  assets: z.record(z.string(), cachedImageSchema).default({}),
});

export type ChapterCacheEntry = z.infer<typeof chapterCacheSchema>;
export type CachedImageEntry = z.infer<typeof cachedImageSchema>;
export type BuildCache = z.infer<typeof buildCacheSchema>;

const HASH_LEN = 10; // 10 hex chars = 40 bits — collision-safe for any plausible blog

/** Hash a value to a hex string of HASH_LEN characters. */
export function shortHash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, HASH_LEN);
}

/** Hash a file's contents. Reads the whole file into memory — fine for
 *  images up to a few MB; we'd switch to streaming if originals grew huge. */
export async function hashFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return shortHash(buf);
}

/**
 * Stable, order-independent hash of a chapter's source: frontmatter
 * serialized to canonical YAML + body. Frontmatter is normalized through
 * js-yaml dump so that key ordering doesn't perturb the hash.
 */
export function hashChapterSource(chapter: LoadedChapter): string {
  const frontmatterCanon = yaml.dump(chapter.frontmatter, {
    sortKeys: true,
    lineWidth: -1,
    noRefs: true,
  });
  return shortHash(`${frontmatterCanon}\n---\n${chapter.body}`);
}

/** Hash the series YAML — sorted keys for stability against re-order. */
export function hashSeriesSource(space: LoadedBlogSpace): string {
  const seriesCanon = yaml.dump(space.series, {
    sortKeys: true,
    lineWidth: -1,
    noRefs: true,
  });
  return shortHash(seriesCanon);
}

/**
 * Per-chapter render-deps hash. Inputs are the source hashes of every
 * chapter that contributes to the rendered HTML — the function is pure
 * over those inputs, so equal inputs always give the same filename.
 */
export function computeRenderDepsHash(args: {
  ownSourceHash: string;
  seriesSourceHash: string;
  /** prev + next, in that order. `null` for boundary chapters. */
  neighborSourceHashes: (string | null)[];
  /** Sorted list of inbound chapter source hashes (chapters that link to this one). */
  inboundSourceHashes: string[];
  /** Sorted list of outbound chapter-link target source hashes. */
  outboundChapterLinkTargetHashes: string[];
  /** Compiler version — bumped when render output changes for the same source. */
  compilerVersion: string;
}): string {
  const payload = JSON.stringify({
    o: args.ownSourceHash,
    s: args.seriesSourceHash,
    n: args.neighborSourceHashes,
    i: [...args.inboundSourceHashes].sort(),
    c: [...args.outboundChapterLinkTargetHashes].sort(),
    v: args.compilerVersion,
  });
  return shortHash(payload);
}

/** The stable on-disk/URL filename for a chapter's HTML file. */
export function chapterFilenameFor(slug: string): string {
  return `${slug}.html`;
}

/** Load the build cache. Missing/invalid file → null (treat as no cache). */
export async function loadBuildCache(spaceRoot: string): Promise<BuildCache | null> {
  const path = join(spaceRoot, ".blogspace", "build-cache.yaml");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = buildCacheSchema.safeParse(yaml.load(raw));
    if (!parsed.success) return null;
    // Discard caches written by a compiler whose render logic differs —
    // they may reference filenames or URLs we no longer produce.
    if (parsed.data.compilerVersion !== COMPILER_VERSION) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function saveBuildCache(spaceRoot: string, cache: BuildCache): Promise<void> {
  const path = join(spaceRoot, ".blogspace", "build-cache.yaml");
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, yaml.dump(cache, { lineWidth: 100, noRefs: true }), "utf8");
  // Atomic replace
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/**
 * After a successful incremental compile, prune orphaned chapter HTMLs
 * left over from previous builds. With stable `<slug>.html` filenames a
 * content edit overwrites in place, so orphans now arise only when a
 * chapter is removed from the series or its slug changes — the old
 * `<slug>.html` would otherwise linger forever.
 */
export async function pruneOrphanChapterFiles(
  chaptersDir: string,
  expectedFilenames: Set<string>,
): Promise<{ removed: number }> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(chaptersDir);
  } catch {
    return { removed: 0 };
  }
  for (const name of entries) {
    if (!name.endsWith(".html")) continue;
    if (expectedFilenames.has(name)) continue;
    await rm(join(chaptersDir, name), { force: true });
    removed += 1;
  }
  return { removed };
}

/**
 * After a successful compile, walk the output's `assets/` tree and
 * delete any file that wasn't a wanted output of THIS compile.
 *
 * "Wanted" means: a static asset the compiler emits unconditionally
 * (viewer.css, viewer.js), or a path the resolved image/video manifest
 * pointed at (variants, posters, cover crops). Anything else is an
 * orphan from a previous incremental build whose source reference has
 * since been removed from chapter markdown / frontmatter.
 *
 * The walk skips the workspace's own assets dir — it only ever touches
 * paths under `<outDir>/assets/`. The keepRoots set lets callers exempt
 * subtrees (e.g. `assets/.maps/`) that are managed by a different
 * subsystem and don't carry variant-style identity.
 */
export async function pruneOrphanAssetFiles(args: {
  assetsDir: string;
  keepPaths: Set<string>;
  /**
   * Subtree prefixes (relative to assetsDir) that are managed by other
   * code and shouldn't be touched here. Default: maps, viewer.css/.js.
   */
  keepRoots?: string[];
}): Promise<{ removedFiles: number; removedBytes: number }> {
  const { assetsDir, keepPaths, keepRoots = [".maps"] } = args;
  let removedFiles = 0;
  let removedBytes = 0;

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dirAbs, e.name);
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Sticky subtrees: leave alone entirely (no recursion).
        if (keepRoots.some((root) => rel === root || rel.startsWith(root + "/"))) continue;
        await walk(abs, rel);
        // Best-effort directory cleanup once its contents are gone.
        // rmdir fails non-empty — fine, just skip.
        try {
          await rm(abs, { recursive: false });
        } catch {
          /* not empty (still has kept files), or already gone */
        }
        continue;
      }
      const assetsPrefixed = `assets/${rel}`;
      // viewer.css / viewer.js sit directly under assets/ and are always
      // kept; they're rewritten on every compile so paths match.
      if (rel === "viewer.css" || rel === "viewer.js") continue;
      if (keepPaths.has(assetsPrefixed)) continue;
      try {
        const st = await stat(abs);
        await rm(abs, { force: true });
        removedFiles += 1;
        removedBytes += st.size;
      } catch {
        /* ignore — gone or unreadable */
      }
    }
  }

  await walk(assetsDir, "");
  return { removedFiles, removedBytes };
}

/**
 * Confirm a file exists. Used to detect cache misses (chapter is
 * "clean" per hashes but the actual HTML on disk is missing — fall
 * back to re-rendering).
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
