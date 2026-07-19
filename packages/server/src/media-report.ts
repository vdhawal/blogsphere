import { join } from "node:path";
import sharp from "sharp";
import type { AssetEntry, ImageAsset, VideoAsset } from "@blogspace/schemas";
import {
  collectRefsFromChapter,
  imageContainerForPath,
  isImageAssetComplete,
  isVideoAssetComplete,
  probeVideoFile,
  videoNeedsWebFallback,
  isFfmpegAvailable,
  type MediaProbe,
} from "@blogspace/media";
import type { Workspace } from "./fs-ops.js";
import type { AssetStore } from "./asset-store.js";
import type { AssetProcessingQueue } from "./asset-queue.js";

export interface MediaVariantDetail {
  path: string;
  role?: "source" | "web";
  width: number;
  height: number;
  bytes: number;
  format?: string;
  codec?: string;
  mime?: string;
  container?: string;
  pixFmt?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdr?: boolean;
}

export interface MediaAssetDetail {
  sourcePath: string;
  kind: "image" | "video";
  label: string;
  processingStatus: "pending" | "ready" | "failed";
  processingError?: string;
  complete: boolean;
  needsWebFallback: boolean;
  source: MediaVariantDetail;
  variants: MediaVariantDetail[];
  posterPath?: string;
}

export interface MediaReport {
  spaceId: string;
  slug?: string;
  queue: { pending: number; active: string | null };
  assets: MediaAssetDetail[];
  summary: { total: number; complete: number; pending: number; failed: number; incomplete: number };
}

export async function buildMediaReport(args: {
  workspace: Workspace;
  assets: AssetStore;
  queue: AssetProcessingQueue;
  spaceId: string;
  slug?: string;
}): Promise<MediaReport> {
  const { workspace, assets, queue, spaceId, slug } = args;
  const spaceRoot = workspace.spaceDir(spaceId);
  const manifest = await assets.load(spaceId);
  const byPath = new Map(manifest.assets.map((a) => [a.sourcePath, a]));

  let imageRefs: string[] = [];
  let videoRefs: string[] = [];
  if (slug) {
    const ch = await workspace.readChapter(spaceId, slug);
    const refs = collectRefsFromChapter({
      body: ch.body,
      cover: ch.frontmatter.cover,
      ogImage: ch.frontmatter.seo?.ogImage,
    });
    imageRefs = refs.imageRefs;
    videoRefs = refs.videoRefs;
  } else {
    const space = await workspace.readSpace(spaceId);
    for (const item of space.chapters) {
      const ch = await workspace.readChapter(spaceId, item.slug);
      const refs = collectRefsFromChapter({
        body: ch.body,
        cover: ch.frontmatter.cover,
        ogImage: ch.frontmatter.seo?.ogImage,
      });
      imageRefs.push(...refs.imageRefs);
      videoRefs.push(...refs.videoRefs);
    }
    imageRefs = [...new Set(imageRefs)];
    videoRefs = [...new Set(videoRefs)];
  }

  const imageRefsSet = new Set(imageRefs);
  const videoRefsSet = new Set(videoRefs);
  const hasFfmpeg = await isFfmpegAvailable();
  const details: MediaAssetDetail[] = [];

  for (const ref of imageRefsSet) {
    const entry = byPath.get(ref);
    if (!entry || entry.kind !== "image") {
      details.push(await missingAssetDetail(ref, "image", spaceRoot));
      continue;
    }
    details.push(await imageDetail(entry, spaceRoot));
  }
  for (const ref of videoRefsSet) {
    const entry = byPath.get(ref);
    if (!entry || entry.kind !== "video") {
      details.push(await missingAssetDetail(ref, "video", spaceRoot));
      continue;
    }
    details.push(await videoDetail(entry, spaceRoot, hasFfmpeg));
  }

  const summary = {
    total: details.length,
    complete: details.filter((d) => d.complete && d.processingStatus === "ready").length,
    pending: details.filter((d) => d.processingStatus === "pending").length,
    failed: details.filter((d) => d.processingStatus === "failed").length,
    incomplete: details.filter((d) => !d.complete && d.processingStatus !== "pending").length,
  };

  return {
    spaceId,
    slug,
    queue: queue.status(spaceId),
    assets: details,
    summary,
  };
}

async function missingAssetDetail(
  sourcePath: string,
  kind: "image" | "video",
  spaceRoot: string,
): Promise<MediaAssetDetail> {
  const abs = join(spaceRoot, sourcePath);
  const source = kind === "video"
    ? await videoSourceDetail(abs, sourcePath)
    : await imageSourceDetail(abs, sourcePath);
  return {
    sourcePath,
    kind,
    label: basenameLabel(sourcePath),
    processingStatus: "failed",
    processingError: "not in asset manifest",
    complete: false,
    needsWebFallback: kind === "video",
    source,
    variants: [],
  };
}

async function imageDetail(entry: ImageAsset, spaceRoot: string): Promise<MediaAssetDetail> {
  const source = await imageSourceDetail(join(spaceRoot, entry.sourcePath), entry.sourcePath);
  const variants: MediaVariantDetail[] = [];
  for (const v of entry.variants) {
    variants.push({
      path: v.path,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
      format: v.format,
      container: v.format,
      mime: v.format === "jpeg" ? "image/jpeg" : `image/${v.format}`,
    });
  }
  return {
    sourcePath: entry.sourcePath,
    kind: "image",
    label: basenameLabel(entry.sourcePath),
    processingStatus: entry.processingStatus,
    processingError: entry.processingError,
    complete: isImageAssetComplete(entry),
    needsWebFallback: false,
    source,
    variants,
  };
}

async function videoDetail(entry: VideoAsset, spaceRoot: string, hasFfmpeg: boolean): Promise<MediaAssetDetail> {
  const probe = await probeVideoFile(join(spaceRoot, entry.sourcePath));
  const needsWeb = videoNeedsWebFallback(probe, entry.sourcePath);
  const complete = await isVideoAssetComplete(entry, spaceRoot, probe, hasFfmpeg);
  const source = probeToVariant(entry.sourcePath, probe, entry.sizeBytes, "source");
  const variants: MediaVariantDetail[] = [];
  for (const v of entry.variants) {
    if (v.path === entry.sourcePath) continue;
    const vp = await probeVideoFile(join(spaceRoot, v.path));
    variants.push({
      path: v.path,
      role: v.role,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
      codec: v.codec,
      mime: v.mime,
      container: v.mime.replace(/^video\//, ""),
      pixFmt: vp?.pixFmt,
      colorSpace: vp?.colorSpace,
      colorTransfer: vp?.colorTransfer,
      colorPrimaries: vp?.colorPrimaries,
      hdr: vp?.hdr,
    });
  }
  return {
    sourcePath: entry.sourcePath,
    kind: "video",
    label: basenameLabel(entry.sourcePath),
    processingStatus: entry.processingStatus,
    processingError: entry.processingError,
    complete,
    needsWebFallback: needsWeb,
    source,
    variants,
    posterPath: entry.posterPath,
  };
}

async function imageSourceDetail(abs: string, path: string): Promise<MediaVariantDetail> {
  try {
    const meta = await sharp(abs).metadata();
    return {
      path,
      role: "source",
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      bytes: meta.size ?? 0,
      format: meta.format,
      container: imageContainerForPath(path),
      mime: meta.format ? `image/${meta.format === "jpeg" ? "jpeg" : meta.format}` : undefined,
    };
  } catch {
    return { path, role: "source", width: 0, height: 0, bytes: 0, container: imageContainerForPath(path) };
  }
}

async function videoSourceDetail(abs: string, path: string): Promise<MediaVariantDetail> {
  const probe = await probeVideoFile(abs);
  return probeToVariant(path, probe, probe?.bytes ?? 0, "source");
}

function probeToVariant(
  path: string,
  probe: MediaProbe | null,
  bytes: number,
  role: "source" | "web",
): MediaVariantDetail {
  if (!probe) {
    return { path, role, width: 0, height: 0, bytes, container: path.split(".").pop() };
  }
  return {
    path,
    role,
    width: probe.width,
    height: probe.height,
    bytes: probe.bytes || bytes,
    codec: probe.codec,
    mime: probe.mime,
    container: probe.container,
    pixFmt: probe.pixFmt,
    colorSpace: probe.colorSpace,
    colorTransfer: probe.colorTransfer,
    colorPrimaries: probe.colorPrimaries,
    hdr: probe.hdr,
  };
}

function basenameLabel(path: string): string {
  return path.split("/").pop() ?? path;
}
