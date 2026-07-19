import { z } from "zod";
import { isoDateSchema, relativePathSchema } from "./common.js";

/**
 * Asset manifest — lives at <space>/.blogspace/assets.yaml. The source of
 * truth for what variants exist on disk for every uploaded image and video.
 *
 * The compiler reads this to wire <picture>/<video> elements without
 * re-processing anything — uploads do the heavy lifting once.
 *
 * Authors NEVER hand-edit this file. The editor manages it through the
 * upload API (full add/remove operations) — there are no edit-deltas for
 * the manifest because variant metadata is derived, not authored.
 */

export const imageVariantSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.enum(["avif", "webp", "jpeg"]),
  /** Path relative to the space root, e.g. "assets/.variants/arrival/rooftop-640.avif". */
  path: relativePathSchema,
  bytes: z.number().int().nonnegative(),
});

/** Cross-browser H.264 MP4 fallback vs original upload fidelity. */
export const videoVariantRoleSchema = z.enum(["source", "web"]);

export const assetProcessingStatusSchema = z.enum(["pending", "ready", "failed"]);

export const videoVariantSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Codec name as ffmpeg reports it (e.g. "h264", "hevc", "source"). */
  codec: z.string().min(1),
  /** Container MIME — what we put in `<source type="…">`. */
  mime: z.string().min(1),
  /** `web` = SDR H.264 for Chrome/Firefox; `source` = original upload. */
  role: videoVariantRoleSchema.optional(),
  bitrate: z.number().int().positive().optional(),
  path: relativePathSchema,
  bytes: z.number().int().nonnegative(),
});

export const imageAssetSchema = z.object({
  kind: z.literal("image"),
  /** Path of the ORIGINAL upload, relative to space root. */
  sourcePath: relativePathSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Original file size. The compiler may still prefer a smaller variant. */
  sizeBytes: z.number().int().nonnegative(),
  /** BlurHash placeholder string — short, cheap to inline. */
  blurhash: z.string().min(1),
  /** Best-known alt text. Empty until the author or AI fills it. */
  alt: z.string().default(""),
  uploadedAt: isoDateSchema,
  processingStatus: assetProcessingStatusSchema.default("ready"),
  processingError: z.string().optional(),
  /** All pre-generated variants. Empty array means "use sourcePath as-is". */
  variants: z.array(imageVariantSchema).default([]),
});

export const videoAssetSchema = z.object({
  kind: z.literal("video"),
  sourcePath: relativePathSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Auto-generated poster frame (jpeg). Compiler uses this as <video poster>. */
  posterPath: relativePathSchema.optional(),
  /** Optional caption — author writes this in the picker. */
  caption: z.string().default(""),
  uploadedAt: isoDateSchema,
  processingStatus: assetProcessingStatusSchema.default("ready"),
  processingError: z.string().optional(),
  variants: z.array(videoVariantSchema).default([]),
});

export const assetEntrySchema = z.discriminatedUnion("kind", [
  imageAssetSchema,
  videoAssetSchema,
]);

export const assetManifestSchema = z.object({
  version: z.literal(1),
  updatedAt: isoDateSchema,
  assets: z.array(assetEntrySchema).default([]),
});

export type VideoVariantRole = z.infer<typeof videoVariantRoleSchema>;
export type AssetProcessingStatus = z.infer<typeof assetProcessingStatusSchema>;
export type ImageVariant = z.infer<typeof imageVariantSchema>;
export type VideoVariant = z.infer<typeof videoVariantSchema>;
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export type VideoAsset = z.infer<typeof videoAssetSchema>;
export type AssetEntry = z.infer<typeof assetEntrySchema>;
export type AssetManifest = z.infer<typeof assetManifestSchema>;

/** Empty manifest used when a space has no assets.yaml yet. */
export function emptyAssetManifest(now = new Date().toISOString()): AssetManifest {
  return { version: 1, updatedAt: now, assets: [] };
}
