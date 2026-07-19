import { readFile, mkdir, writeFile, stat, copyFile } from "node:fs/promises";
import { join, dirname, extname, basename } from "node:path";
import yaml from "js-yaml";
import {
  assetManifestSchema,
  emptyAssetManifest,
  type AssetManifest,
  type ImageAsset,
  type VideoAsset,
} from "@blogspace/schemas";
import { processImage as runtimeProcessImage } from "@blogspace/media";
import { normalizeRef, escapeHtml } from "./util.js";
import { hashFile, type CachedImageEntry } from "./cache.js";
import type {
  AssetManifest as CompileManifest,
  LoadedBlogSpace,
  ProcessedImage,
  ProcessedMap,
  ProcessedVideo,
} from "./types.js";

/** Collect every asset reference that appears in the space. */
export function collectAssetRefs(space: LoadedBlogSpace): {
  imageRefs: Set<string>;
  videoRefs: Set<string>;
} {
  const imageRefs = new Set<string>();
  const videoRefs = new Set<string>();

  const enqueue = (ref?: string) => {
    if (ref && !/^https?:\/\//.test(ref)) imageRefs.add(normalizeRef(ref));
  };
  enqueue(space.series.cover);
  enqueue(space.series.seo.ogImage);
  for (const ch of space.chapters) {
    enqueue(ch.frontmatter.cover);
    enqueue(ch.frontmatter.seo.ogImage);
  }

  const imgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const videoSrcRe = /::video[^\n]*src\s*=\s*([^\s}]+)/g;
  for (const ch of space.chapters) {
    for (const m of ch.body.matchAll(imgRe)) {
      const ref = m[1];
      if (ref && !/^https?:\/\//.test(ref)) imageRefs.add(normalizeRef(ref));
    }
    for (const m of ch.body.matchAll(videoSrcRe)) {
      const ref = m[1];
      if (ref) videoRefs.add(normalizeRef(ref));
    }
  }
  return { imageRefs, videoRefs };
}

/** Read <space>/.blogspace/assets.yaml — missing file is a valid empty manifest. */
export async function loadAssetManifest(spaceRoot: string): Promise<AssetManifest> {
  const path = join(spaceRoot, ".blogspace", "assets.yaml");
  try {
    const raw = await readFile(path, "utf8");
    return assetManifestSchema.parse(yaml.load(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyAssetManifest();
    throw err;
  }
}

/**
 * Resolve every image ref into a ProcessedImage.
 *
 * Two paths, both with skip-if-already-on-disk fast paths:
 *
 *  1. Manifest hit — the upload-side processor (server) already wrote
 *     variants for this image. Each variant is copied verbatim into the
 *     dist tree at the same relative path. We skip the copy when the
 *     destination already exists with the manifest's recorded byte size,
 *     so repeat compiles only touch newly-uploaded assets.
 *  2. Manifest miss — runtime fallback. The sharp pipeline produces
 *     variants on the fly. Results are cached in `build-cache.yaml`
 *     keyed by source content hash; on subsequent compiles, if the hash
 *     matches and every variant file is still on disk, we reuse the
 *     cached metadata and don't re-encode anything.
 */
export async function resolveImages(args: {
  space: LoadedBlogSpace;
  outRoot: string;
  refs: Set<string>;
  manifest: AssetManifest;
  /** Per-asset cache from the previous build (keyed by sourceRef). */
  prevAssetCache: Map<string, CachedImageEntry>;
  warnings: string[];
}): Promise<{
  resolved: Map<string, ProcessedImage>;
  /** Snapshot of runtime-fallback results to persist to build-cache for next compile. */
  newAssetCache: Map<string, CachedImageEntry>;
  /** Per-path provenance — useful for the CLI's compile summary. */
  stats: { manifestServed: number; reusedFromCache: number; regenerated: number };
}> {
  const { space, outRoot, refs, manifest, prevAssetCache, warnings } = args;
  const resolved = new Map<string, ProcessedImage>();
  const newAssetCache = new Map<string, CachedImageEntry>();
  const stats = { manifestServed: 0, reusedFromCache: 0, regenerated: 0 };
  const byRef = new Map(
    manifest.assets
      .filter((a): a is ImageAsset => a.kind === "image")
      .map((a) => [a.sourcePath, a]),
  );

  for (const ref of refs) {
    try {
      const entry = byRef.get(ref);
      if (entry && entry.variants.length > 0) {
        // Manifest path — copy variants verbatim, but skip individual files
        // already present at the right size. Cheaper than copying every
        // variant on every compile.
        for (const v of entry.variants) {
          const srcAbs = join(space.rootDir, v.path);
          const dstAbs = join(outRoot, v.path);
          const dstSize = await tryStatSize(dstAbs);
          if (dstSize === v.bytes) continue;
          await mkdir(dirname(dstAbs), { recursive: true });
          await copyFile(srcAbs, dstAbs);
        }
        resolved.set(ref, {
          sourceRef: ref,
          width: entry.width,
          height: entry.height,
          blurhash: entry.blurhash,
          alt: entry.alt,
          variants: entry.variants.map((v) => ({
            format: v.format,
            width: v.width,
            height: v.height,
            outputPath: v.path,
            bytes: v.bytes,
          })),
        });
        stats.manifestServed += 1;
        continue;
      }

      // Runtime fallback. Try the build-cache before falling through to sharp.
      const subdir = `assets/.compiled-variants/${dirname(ref).replace(/^assets\/?/, "") || "_"}`;
      const sourceAbs = join(space.rootDir, ref);
      const currentSourceHash = await hashFile(sourceAbs);
      const cached = prevAssetCache.get(ref);

      const allVariantFilesPresent = cached
        ? await checkAllExist(
            cached.variants.map((v) => join(outRoot, v.outputPath)),
            cached.variants.map((v) => v.bytes),
          )
        : false;

      if (cached && cached.sourceHash === currentSourceHash && allVariantFilesPresent) {
        // Reuse the cached metadata; no sharp run, no file writes.
        const reused: ProcessedImage = {
          sourceRef: ref,
          width: cached.width,
          height: cached.height,
          blurhash: cached.blurhash,
          alt: cached.alt,
          sourceHash: cached.sourceHash,
          variants: cached.variants.map((v) => ({
            format: v.format,
            width: v.width,
            height: v.height,
            outputPath: v.outputPath,
            bytes: v.bytes,
          })),
        };
        resolved.set(ref, reused);
        // Carry forward into the new cache so it doesn't get pruned.
        newAssetCache.set(ref, cached);
        stats.reusedFromCache += 1;
        continue;
      }

      // Cold path: actually run sharp.
      const asset = await runtimeProcessImage({
        sourceAbs,
        spaceRoot: outRoot,
        sourceRelative: ref,
        options: { variantSubdir: subdir },
      });
      const processed: ProcessedImage = {
        sourceRef: ref,
        width: asset.width,
        height: asset.height,
        blurhash: asset.blurhash,
        alt: asset.alt,
        sourceHash: currentSourceHash,
        variants: asset.variants.map((v) => ({
          format: v.format,
          width: v.width,
          height: v.height,
          outputPath: v.path,
          bytes: v.bytes,
        })),
      };
      resolved.set(ref, processed);
      newAssetCache.set(ref, {
        sourceRef: ref,
        sourceHash: currentSourceHash,
        width: asset.width,
        height: asset.height,
        blurhash: asset.blurhash,
        alt: asset.alt,
        variants: processed.variants.map((v) => ({
          format: v.format,
          width: v.width,
          height: v.height,
          outputPath: v.outputPath,
          bytes: v.bytes,
        })),
      });
      stats.regenerated += 1;
    } catch (err) {
      warnings.push(`image: ${ref} — ${(err as Error).message}`);
    }
  }
  return { resolved, newAssetCache, stats };
}

async function tryStatSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function checkAllExist(paths: string[], expectedBytes: number[]): Promise<boolean> {
  for (let i = 0; i < paths.length; i++) {
    const size = await tryStatSize(paths[i]!);
    if (size === null) return false;
    // Size mismatch likely means the file was corrupted or replaced —
    // err on the side of regenerating.
    if (size !== expectedBytes[i]) return false;
  }
  return true;
}

/**
 * Resolve every video ref into a ProcessedVideo (original + variants + poster).
 *
 * Manifest hit: copy original + variants + poster from <space> to <dist>.
 * Manifest miss: passthrough copy of the original only — emits a single
 * `<source>` element pointing at it. Authors without ffmpeg installed end
 * up here for any video they upload.
 */
export async function resolveVideos(
  space: LoadedBlogSpace,
  outRoot: string,
  refs: Set<string>,
  manifest: AssetManifest,
  warnings: string[],
): Promise<Map<string, ProcessedVideo>> {
  const out = new Map<string, ProcessedVideo>();
  const byRef = new Map(
    manifest.assets
      .filter((a): a is VideoAsset => a.kind === "video")
      .map((a) => [a.sourcePath, a]),
  );
  for (const ref of refs) {
    try {
      const entry = byRef.get(ref);
      if (entry) {
        // Copy each variant + the poster (if any). The original is recorded
        // as one of the variants in the manifest, so iterating `variants`
        // covers it without a separate step. Skip files already at the
        // right size — video copies are by far the most expensive single-
        // file operations in a compile.
        for (const v of entry.variants) {
          const srcAbs = join(space.rootDir, v.path);
          const dstAbs = join(outRoot, v.path);
          const dstSize = await tryStatSize(dstAbs);
          if (dstSize === v.bytes) continue;
          await mkdir(dirname(dstAbs), { recursive: true });
          await copyFile(srcAbs, dstAbs);
        }
        if (entry.posterPath) {
          const srcAbs = join(space.rootDir, entry.posterPath);
          const dstAbs = join(outRoot, entry.posterPath);
          const dstSize = await tryStatSize(dstAbs);
          // Poster doesn't have a recorded byte size in the manifest; the
          // best we can do is "exists, non-empty" — good enough since the
          // poster is regenerated only when ffmpeg re-runs at upload time.
          if (dstSize === null || dstSize === 0) {
            await mkdir(dirname(dstAbs), { recursive: true });
            await copyFile(srcAbs, dstAbs);
          }
        }
        out.set(ref, {
          sourceRef: ref,
          width: entry.width,
          height: entry.height,
          durationMs: entry.durationMs,
          posterOutputPath: entry.posterPath,
          variants: [...entry.variants]
            .sort((a, b) => b.width - a.width)
            .map((v) => ({
              width: v.width,
              height: v.height,
              mime: v.mime,
              outputPath: v.path,
              bytes: v.bytes,
            })),
        });
        continue;
      }
      // Fallback: passthrough copy. No transcoding, no poster. Skip when
      // dst exists with matching size — videos are often large and the
      // passthrough copy time dominates compile latency for video-heavy
      // chapters.
      const dstRel = `assets/videos/${dirname(ref).replace(/^assets\/?/, "") || "_"}/${basename(ref)}`.replace(/\\/g, "/");
      const srcAbs = join(space.rootDir, ref);
      const dstAbs = join(outRoot, dstRel);
      const sz = (await stat(srcAbs)).size;
      const dstSize = await tryStatSize(dstAbs);
      if (dstSize !== sz) {
        await mkdir(dirname(dstAbs), { recursive: true });
        await copyFile(srcAbs, dstAbs);
      }
      const ext = extname(ref).slice(1).toLowerCase();
      const mime =
        ext === "mp4" || ext === "m4v" ? "video/mp4" : ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : `video/${ext}`;
      out.set(ref, {
        sourceRef: ref,
        width: 0,
        height: 0,
        variants: [{ width: 0, height: 0, mime, outputPath: dstRel, bytes: sz }],
      });
    } catch (err) {
      warnings.push(`video: ${ref} — ${(err as Error).message}`);
    }
  }
  return out;
}

/* Static map rendering — unchanged from the prior step. */
export async function renderStaticMap(
  outRoot: string,
  id: string,
  args: {
    center: { lat: number; lng: number };
    zoom: number;
    markers: { lat: number; lng: number; label?: string }[];
    width: number;
    height: number;
    style: string;
    interactive: boolean;
  },
): Promise<ProcessedMap> {
  const outRel = `assets/maps/${id}.svg`;
  const outAbs = join(outRoot, outRel);
  await mkdir(dirname(outAbs), { recursive: true });

  const span = 0.15 / args.zoom;
  const minLng = args.center.lng - span;
  const maxLng = args.center.lng + span;
  const minLat = args.center.lat - span * (args.height / args.width);
  const maxLat = args.center.lat + span * (args.height / args.width);

  const project = (lat: number, lng: number) => {
    const x = ((lng - minLng) / (maxLng - minLng)) * args.width;
    const y = args.height - ((lat - minLat) / (maxLat - minLat)) * args.height;
    return { x, y };
  };

  const pins = args.markers
    .map((m) => {
      const { x, y } = project(m.lat, m.lng);
      const label = m.label ? escapeHtml(m.label) : "";
      return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
        <circle r="8" fill="#c1432d" stroke="#fff" stroke-width="2"/>
        ${label ? `<text x="12" y="4" font-family="system-ui,sans-serif" font-size="12" fill="#1a1a1a">${label}</text>` : ""}
      </g>`;
    })
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${args.width} ${args.height}" width="${args.width}" height="${args.height}" role="img" aria-label="Map showing ${args.markers.length} location${args.markers.length === 1 ? "" : "s"}">
  <defs>
    <pattern id="grid-${id}" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#dadada" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="#f0ede5"/>
  <rect width="100%" height="100%" fill="url(#grid-${id})"/>
  ${pins}
  <text x="12" y="${args.height - 12}" font-family="system-ui,sans-serif" font-size="10" fill="#888">map placeholder · ${args.style}</text>
</svg>`;
  await writeFile(outAbs, svg, "utf8");

  return {
    id,
    outputPath: outRel,
    width: args.width,
    height: args.height,
    interactive: args.interactive,
    center: args.center,
    zoom: args.zoom,
    markers: args.markers,
  };
}

export function emptyManifest(): CompileManifest {
  return { images: new Map(), maps: new Map(), videos: new Map() };
}
