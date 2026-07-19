import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, basename, extname } from "node:path";
import sharp from "sharp";
import { encode as encodeBlurhash } from "blurhash";
import heicConvert from "heic-convert";
import type { ImageAsset, ImageVariant } from "@blogspace/schemas";

/**
 * Default ladder. Covers small phones (320w) through 4K-ish (1920w).
 * 800 fills the gap between 640 and 1024: on a 375px-wide mobile at 2× DPR
 * the browser needs ~750px and picks the next step — 800 instead of 1024,
 * saving ~40-50% file size over the 1024px AVIF for that common case.
 */
export const DEFAULT_IMAGE_WIDTHS: readonly number[] = [320, 640, 800, 1024, 1440, 1920];
export const DEFAULT_IMAGE_FORMATS = ["avif", "webp", "jpeg"] as const;
export type ImageFormat = (typeof DEFAULT_IMAGE_FORMATS)[number];

export interface ProcessImageOptions {
  /** Where to write variant files, relative to `spaceRoot`. */
  variantSubdir: string;
  /** Widths to emit; falls back to DEFAULT_IMAGE_WIDTHS. Skipped if > source. */
  widths?: readonly number[];
  formats?: readonly ImageFormat[];
}

/**
 * Process one image source into a full ImageAsset (manifest entry) by
 * generating variants on disk under `<spaceRoot>/<variantSubdir>/`.
 *
 * - `sourceAbs`: absolute path to the original upload
 * - `spaceRoot`: absolute path to the blog space root (used to compute
 *   relative paths recorded in the manifest)
 * - `sourceRelative`: the original's path relative to spaceRoot, used as
 *   the asset's sourcePath
 */
export async function processImage(args: {
  sourceAbs: string;
  spaceRoot: string;
  sourceRelative: string;
  options: ProcessImageOptions;
}): Promise<ImageAsset> {
  const { sourceAbs, spaceRoot, sourceRelative, options } = args;
  const widths = options.widths ?? DEFAULT_IMAGE_WIDTHS;
  const formats = options.formats ?? DEFAULT_IMAGE_FORMATS;

  // Sharp doesn't bundle libheif (HEVC licensing) so HEIC/HEIF inputs
  // would throw "unsupported image format". Decode them in JS first via
  // heic-convert (libheif compiled to WebAssembly) into a lossless PNG
  // buffer, then pass that buffer to the normal sharp pipeline. The
  // emitted variants are still AVIF/WebP/JPEG — HEIC never reaches the
  // browser. For non-HEIC sources we pass the path through unchanged.
  const ext = extname(sourceRelative).toLowerCase();
  const isHeic = ext === ".heic" || ext === ".heif";
  const sharpInput: string | Buffer = isHeic
    ? await decodeHeicToBuffer(sourceAbs)
    : sourceAbs;

  const src = sharp(sharpInput);
  const meta = await src.metadata();
  const naturalW = meta.width ?? 1;
  const naturalH = meta.height ?? 1;
  // `meta.size` is the buffer size when we passed a buffer; for HEIC that
  // would be the decoded PNG size, not the on-disk source. Use the actual
  // source file's stats so the manifest reflects what the author uploaded.
  const sizeBytes = isHeic
    ? (await (await import("node:fs/promises")).stat(sourceAbs)).size
    : (meta.size ?? 0);

  // Blurhash placeholder — same input as the rest of the pipeline.
  const lqip = await sharp(sharpInput)
    .resize(32, 32, { fit: "inside" })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  const blurhash = encodeBlurhash(
    new Uint8ClampedArray(lqip.data),
    lqip.info.width,
    lqip.info.height,
    4,
    4,
  );

  // Pick ladder rungs that don't exceed the source — generating a 1920w
  // variant of a 600w original would just be an upscale.
  const ladder = widths.filter((w) => w <= naturalW);
  if (ladder.length === 0) ladder.push(naturalW);

  const variantsDirAbs = join(spaceRoot, options.variantSubdir);
  await mkdir(variantsDirAbs, { recursive: true });

  const stem = basename(sourceRelative, extname(sourceRelative));

  const variants: ImageVariant[] = [];
  for (const w of ladder) {
    const h = Math.round((naturalH / naturalW) * w);
    for (const fmt of formats) {
      const ext = fmt === "jpeg" ? "jpg" : fmt;
      const filename = `${stem}-${w}.${ext}`;
      const outAbs = join(variantsDirAbs, filename);
      const pipeline = sharp(sharpInput).resize(w);
      const buf =
        fmt === "avif"
          ? await pipeline.avif({ quality: 50, effort: 6 }).toBuffer()
          : fmt === "webp"
            ? await pipeline.webp({ quality: 78 }).toBuffer()
            : await pipeline.jpeg({ quality: 82, progressive: true, mozjpeg: true }).toBuffer();
      await writeFile(outAbs, buf);
      variants.push({
        width: w,
        height: h,
        format: fmt,
        path: `${options.variantSubdir}/${filename}`.replace(/\\/g, "/"),
        bytes: buf.length,
      });
    }
  }

  return {
    kind: "image",
    sourcePath: sourceRelative,
    width: naturalW,
    height: naturalH,
    sizeBytes,
    blurhash,
    alt: "",
    uploadedAt: new Date().toISOString(),
    variants,
    processingStatus: "ready",
  };
}

/**
 * Crop a source image to the given source-pixel rect and write the result
 * as a high-quality jpeg. HEIC sources are decoded in the same way as
 * `processImage`. The destination directory is created if missing.
 *
 * The returned path is the destination — callers typically pass this back
 * into `processImage` to generate the responsive variant ladder. We don't
 * fold cropping into processImage itself because the crop output IS the
 * new source-of-truth for downstream variants and the manifest entry, and
 * mixing the two paths would complicate cache invalidation.
 */
export async function cropToJpeg(args: {
  sourceAbs: string;
  destAbs: string;
  crop: { x: number; y: number; w: number; h: number };
  quality?: number;
}): Promise<void> {
  const { sourceAbs, destAbs, crop, quality = 92 } = args;
  const ext = extname(sourceAbs).toLowerCase();
  const isHeic = ext === ".heic" || ext === ".heif";
  const sharpInput: string | Buffer = isHeic
    ? await decodeHeicToBuffer(sourceAbs)
    : sourceAbs;
  // sharp.extract rejects fractional coords — round to integer pixels.
  // Callers typically pass image-pixel coords already, but the editor
  // computes them from CSS-pixel drags so sub-pixel values are likely.
  const x = Math.max(0, Math.round(crop.x));
  const y = Math.max(0, Math.round(crop.y));
  const w = Math.max(1, Math.round(crop.w));
  const h = Math.max(1, Math.round(crop.h));
  await mkdir(dirname(destAbs), { recursive: true });
  await sharp(sharpInput)
    .extract({ left: x, top: y, width: w, height: h })
    .jpeg({ quality, progressive: true, mozjpeg: true })
    .toFile(destAbs);
}

/**
 * Decode a HEIC/HEIF file to a PNG buffer that sharp can ingest like any
 * other source. PNG (lossless) is the intermediate so we don't double-
 * encode losses — the variants get their lossy compression later.
 *
 * heic-convert pulls in libheif as WebAssembly; first call is slow
 * (module init), subsequent calls are fast. Build cache + upload-time
 * processing means this typically runs once per HEIC upload.
 */
async function decodeHeicToBuffer(sourceAbs: string): Promise<Buffer> {
  const heic = await readFile(sourceAbs);
  const out = await heicConvert({
    buffer: heic as unknown as ArrayBufferLike,
    format: "PNG",
  });
  return Buffer.from(out as ArrayBufferLike);
}

/** Re-export for use as a default by callers that don't want the constants. */
export { dirname };
