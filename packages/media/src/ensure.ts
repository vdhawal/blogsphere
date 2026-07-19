import { access } from "node:fs/promises";
import { join, extname, dirname, basename, posix } from "node:path";
import type { AssetEntry, AssetManifest, ImageAsset, VideoAsset } from "@blogspace/schemas";
import { processImage, DEFAULT_IMAGE_WIDTHS } from "./images.js";
import { processVideo, CDN_ASSET_MAX_BYTES } from "./videos.js";
import { isFfmpegAvailable, probeVideoFile, type MediaProbe } from "./probe.js";

export interface EnsureAssetVariantsResult {
  entries: AssetEntry[];
  repaired: string[];
  warnings: string[];
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

function variantSubdirForRef(sourceRelative: string): string {
  const parts = sourceRelative.replace(/\\/g, "/").split("/");
  if (parts[0] === "assets" && parts.length >= 2) {
    const chapter =
      parts[1] === ".variants" || parts[1] === ".crops" || !parts[1] ? "_" : parts[1];
    if (parts[1] === ".crops") {
      return posix.join("assets", ".variants", ".crops", parts[2] ?? "_");
    }
    return posix.join("assets", ".variants", chapter);
  }
  return posix.join("assets", ".variants", "_");
}

function needsResponsiveImageVariants(sourceRelative: string): boolean {
  const ext = extname(sourceRelative).toLowerCase();
  return ext === ".heic" || ext === ".heif" || ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".avif";
}

export function isImageAssetComplete(entry: ImageAsset): boolean {
  if (!needsResponsiveImageVariants(entry.sourcePath)) return entry.variants.length > 0;
  const formats = new Set(entry.variants.map((v) => v.format));
  if (!formats.has("avif") || !formats.has("webp") || !formats.has("jpeg")) return false;
  // Verify every expected width step (up to the source width) is present in at
  // least one format. A missing step (e.g. 800px added to the ladder after the
  // image was first processed) makes the asset incomplete → triggers re-process.
  const existingWidths = new Set(entry.variants.map((v) => v.width));
  const expectedWidths = DEFAULT_IMAGE_WIDTHS.filter((w) => w <= entry.width);
  return expectedWidths.every((w) => existingWidths.has(w));
}

function webVideoVariant(entry: VideoAsset) {
  return entry.variants.find(
    (v) => v.role === "web" || (v.codec === "h264" && v.mime === "video/mp4" && v.path !== entry.sourcePath),
  );
}

function hasWebVideoFallback(entry: VideoAsset): boolean {
  const web = webVideoVariant(entry);
  return !!web && web.bytes > 0 && web.bytes <= CDN_ASSET_MAX_BYTES;
}

export function videoNeedsWebFallback(probe: MediaProbe | null, sourceRelative: string): boolean {
  const ext = extname(sourceRelative).toLowerCase();
  if (ext === ".mov") return true;
  if (probe?.codec === "hevc" || probe?.codec === "h265") return true;
  if (probe?.hdr) return true;
  return false;
}

export async function isVideoAssetComplete(
  entry: VideoAsset,
  spaceRoot: string,
  probe: MediaProbe | null,
  hasFfmpeg: boolean,
): Promise<boolean> {
  if (entry.variants.length === 0) return false;
  const srcAbs = join(spaceRoot, entry.sourcePath);
  if (!(await fileExists(srcAbs))) return false;
  if (hasFfmpeg) {
    if (!entry.posterPath) return false;
    if (!(await fileExists(join(spaceRoot, entry.posterPath)))) return false;
  }
  if (videoNeedsWebFallback(probe, entry.sourcePath)) {
    if (!hasWebVideoFallback(entry)) return false;
    const web = webVideoVariant(entry);
    if (web && (await fileExists(join(spaceRoot, web.path)))) {
      // Manifest bytes can drift — verify on disk too.
      const { stat } = await import("node:fs/promises");
      const sz = (await stat(join(spaceRoot, web.path))).size;
      if (sz > CDN_ASSET_MAX_BYTES) return false;
    }
  }
  for (const v of entry.variants) {
    if (!(await fileExists(join(spaceRoot, v.path)))) return false;
  }
  return true;
}

export async function ensureAssetVariants(args: {
  spaceRoot: string;
  imageRefs: Iterable<string>;
  videoRefs: Iterable<string>;
  manifest: AssetManifest;
  /** When true, re-run processing for any incomplete asset. */
  repair?: boolean;
}): Promise<EnsureAssetVariantsResult> {
  const { spaceRoot, repair = true } = args;
  const warnings: string[] = [];
  const repaired: string[] = [];
  const byPath = new Map(args.manifest.assets.map((a) => [a.sourcePath, a]));
  const touched = new Set<string>();
  const hasFfmpeg = await isFfmpegAvailable();

  const ensureOne = async (sourceRelative: string, kind: "image" | "video") => {
    if (touched.has(sourceRelative)) return;
    touched.add(sourceRelative);
    const sourceAbs = join(spaceRoot, sourceRelative);
    if (!(await fileExists(sourceAbs))) {
      warnings.push(`missing source: ${sourceRelative}`);
      return;
    }
    const existing = byPath.get(sourceRelative);
    const variantSubdir = variantSubdirForRef(sourceRelative);

    if (kind === "image") {
      const entry = existing?.kind === "image" ? existing : undefined;
      if (entry && isImageAssetComplete(entry) && entry.processingStatus === "ready") {
        if (!repair) return;
        const allExist = await Promise.all(
          entry.variants.map((v) => fileExists(join(spaceRoot, v.path))),
        );
        if (allExist.every(Boolean)) return;
      }
      try {
        const next = await processImage({
          sourceAbs,
          spaceRoot,
          sourceRelative,
          options: { variantSubdir },
        });
        byPath.set(sourceRelative, { ...next, processingStatus: "ready", processingError: undefined });
        repaired.push(sourceRelative);
      } catch (err) {
        warnings.push(`image ${sourceRelative}: ${(err as Error).message}`);
        byPath.set(sourceRelative, {
          kind: "image",
          sourcePath: sourceRelative,
          width: entry?.width ?? 1,
          height: entry?.height ?? 1,
          sizeBytes: entry?.sizeBytes ?? 0,
          blurhash: entry?.blurhash ?? "L00000000000",
          alt: entry?.alt ?? "",
          uploadedAt: entry?.uploadedAt ?? new Date().toISOString(),
          variants: entry?.variants ?? [],
          processingStatus: "failed",
          processingError: (err as Error).message,
        });
      }
      return;
    }

    const entry = existing?.kind === "video" ? existing : undefined;
    const probe = await probeVideoFile(sourceAbs);
    if (entry && (await isVideoAssetComplete(entry, spaceRoot, probe, hasFfmpeg)) && entry.processingStatus === "ready") {
      return;
    }
    try {
      const result = await processVideo({
        sourceAbs,
        spaceRoot,
        sourceRelative,
        options: { variantSubdir },
      });
      if (result.warnings.length) warnings.push(...result.warnings.map((w) => `${sourceRelative}: ${w}`));
      byPath.set(sourceRelative, {
        ...result.asset,
        processingStatus: "ready",
        processingError: undefined,
      });
      repaired.push(sourceRelative);
    } catch (err) {
      warnings.push(`video ${sourceRelative}: ${(err as Error).message}`);
      byPath.set(sourceRelative, {
        kind: "video",
        sourcePath: sourceRelative,
        width: probe?.width ?? entry?.width ?? 1,
        height: probe?.height ?? entry?.height ?? 1,
        sizeBytes: probe?.bytes ?? entry?.sizeBytes ?? 0,
        durationMs: probe?.durationMs ?? entry?.durationMs,
        posterPath: entry?.posterPath,
        caption: entry?.caption ?? "",
        uploadedAt: entry?.uploadedAt ?? new Date().toISOString(),
        variants: entry?.variants ?? [],
        processingStatus: "failed",
        processingError: (err as Error).message,
      });
    }
  };

  for (const ref of args.imageRefs) await ensureOne(normalizeAssetRef(ref), "image");
  for (const ref of args.videoRefs) await ensureOne(normalizeAssetRef(ref), "video");

  return {
    entries: [...byPath.values()],
    repaired,
    warnings,
  };
}

export function normalizeAssetRef(ref: string): string {
  return ref.replace(/^\.\//, "").replace(/^\//, "");
}

export function collectRefsFromChapter(args: {
  body: string;
  cover?: string;
  ogImage?: string;
}): { imageRefs: string[]; videoRefs: string[] } {
  const imageRefs = new Set<string>();
  const videoRefs = new Set<string>();
  const enqueue = (ref?: string) => {
    if (ref && !/^https?:\/\//.test(ref)) imageRefs.add(normalizeAssetRef(ref));
  };
  enqueue(args.cover);
  enqueue(args.ogImage);
  const imgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const videoSrcRe = /::video[^\n]*src\s*=\s*([^\s}]+)/g;
  for (const m of args.body.matchAll(imgRe)) {
    const ref = m[1];
    if (ref && !/^https?:\/\//.test(ref)) imageRefs.add(normalizeAssetRef(ref));
  }
  for (const m of args.body.matchAll(videoSrcRe)) {
    const ref = m[1];
    if (ref) videoRefs.add(normalizeAssetRef(ref));
  }
  return { imageRefs: [...imageRefs], videoRefs: [...videoRefs] };
}

export { variantSubdirForRef, basename, dirname };
