import { mkdir, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, extname } from "node:path";
import type { VideoAsset, VideoVariant } from "@blogspace/schemas";
import { isHdrTransfer, mimeForVideoPath, probeVideoFile } from "./probe.js";

const execFileP = promisify(execFile);

export interface ProcessVideoOptions {
  /** Subdir for generated artifacts (poster, web mp4), e.g. "assets/.variants/01-arrival". */
  variantSubdir: string;
}

export interface ProcessVideoResult {
  asset: VideoAsset;
  warnings: string[];
  transcoded: boolean;
}

const TARGET_WIDTH = 1280;
const POSTER_OFFSET_S = 1;

/** Cloudflare Pages per-file limit is 25 MB — stay under with headroom. */
export const CDN_ASSET_MAX_BYTES = 24 * 1024 * 1024;

interface WebEncodeAttempt {
  width: number;
  crf: number;
  audioKbps: number;
}

const WEB_ENCODE_LADDER: WebEncodeAttempt[] = [
  { width: 1280, crf: 23, audioKbps: 128 },
  { width: 1280, crf: 28, audioKbps: 96 },
  { width: 960, crf: 28, audioKbps: 96 },
  { width: 720, crf: 28, audioKbps: 64 },
  { width: 720, crf: 32, audioKbps: 64 },
  { width: 640, crf: 32, audioKbps: 48 },
];

export async function processVideo(args: {
  sourceAbs: string;
  spaceRoot: string;
  sourceRelative: string;
  options: ProcessVideoOptions;
}): Promise<ProcessVideoResult> {
  const { sourceAbs, spaceRoot, sourceRelative, options } = args;
  const warnings: string[] = [];

  const hasFfmpeg = await isAvailable("ffmpeg");
  const probe = await probeVideoFile(sourceAbs);
  const width = probe?.width ?? 0;
  const height = probe?.height ?? 0;
  const durationMs = probe?.durationMs;
  const sizeBytes = probe?.bytes ?? (await stat(sourceAbs)).size;

  if (!probe) {
    warnings.push("ffprobe not installed or probe failed — video dimensions unknown");
  }

  const variantsDirAbs = join(spaceRoot, options.variantSubdir);
  await mkdir(variantsDirAbs, { recursive: true });
  const stem = basename(sourceRelative, extname(sourceRelative));

  const variants: VideoVariant[] = [];
  let posterPath: string | undefined;
  let transcoded = false;

  if (hasFfmpeg) {
    const posterRel = `${options.variantSubdir}/${stem}-poster.jpg`;
    const posterAbs = join(spaceRoot, posterRel);
    try {
      await execFileP("ffmpeg", [
        "-y",
        "-ss", String(POSTER_OFFSET_S),
        "-i", sourceAbs,
        "-frames:v", "1",
        "-q:v", "3",
        "-vf", "scale=1280:-1",
        posterAbs,
      ]);
      posterPath = posterRel;
    } catch (err) {
      warnings.push(`poster frame failed: ${(err as Error).message}`);
    }

    const webRel = `${options.variantSubdir}/${stem}-web.mp4`;
    const webAbs = join(spaceRoot, webRel);
    const hdr = probe ? probe.hdr || isHdrTransfer(probe.colorTransfer) : false;
    const naturalW = width > 0 ? width : TARGET_WIDTH;
    const naturalH = height > 0 ? height : 720;

    try {
      const webResult = await encodeWebFallback({
        sourceAbs,
        webAbs,
        naturalW,
        naturalH,
        hdr,
        warnings,
      });
      if (webResult) {
        variants.push({
          width: webResult.width,
          height: webResult.height,
          codec: "h264",
          mime: "video/mp4",
          role: "web",
          path: webRel,
          bytes: webResult.bytes,
        });
        transcoded = true;
      }
    } catch (err) {
      warnings.push(`web fallback failed: ${(err as Error).message}`);
      await unlink(webAbs).catch(() => undefined);
    }
  } else {
    warnings.push(
      "ffmpeg not installed — video passed through as-is. Install ffmpeg for poster frames and web fallbacks.",
    );
  }

  if (width > 0) {
    variants.push({
      width,
      height,
      codec: probe?.codec ?? "source",
      mime: mimeForVideoPath(sourceRelative),
      role: "source",
      path: sourceRelative,
      bytes: sizeBytes,
    });
  }

  return {
    transcoded,
    warnings,
    asset: {
      kind: "video",
      sourcePath: sourceRelative,
      width: width || 1,
      height: height || 1,
      sizeBytes,
      durationMs,
      posterPath,
      caption: "",
      uploadedAt: new Date().toISOString(),
      processingStatus: "ready",
      variants,
    },
  };
}

async function encodeWebFallback(args: {
  sourceAbs: string;
  webAbs: string;
  naturalW: number;
  naturalH: number;
  hdr: boolean;
  warnings: string[];
}): Promise<{ width: number; height: number; bytes: number } | null> {
  const { sourceAbs, webAbs, naturalW, naturalH, hdr, warnings } = args;
  let lastSize = 0;

  for (let i = 0; i < WEB_ENCODE_LADDER.length; i++) {
    const attempt = WEB_ENCODE_LADDER[i]!;
    const outW = Math.min(naturalW, attempt.width);
    const outH = Math.max(2, Math.round((naturalH / naturalW) * outW));
    const simpleVf = `scale=${outW}:${outH}:flags=lanczos,format=yuv420p`;
    const hdrVf = `scale=${outW}:${outH}:flags=lanczos,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;

    await unlink(webAbs).catch(() => undefined);

    try {
      try {
        await runWebTranscode(sourceAbs, webAbs, hdr ? hdrVf : simpleVf, attempt);
      } catch (err) {
        if (hdr) {
          await runWebTranscode(sourceAbs, webAbs, simpleVf, attempt);
        } else {
          throw err;
        }
      }
    } catch (err) {
      warnings.push(`web encode ${outW}w crf${attempt.crf} failed: ${(err as Error).message}`);
      continue;
    }

    const st = await stat(webAbs);
    lastSize = st.size;
    if (st.size <= CDN_ASSET_MAX_BYTES) {
      if (i > 0) {
        warnings.push(
          `web fallback needed stronger compression (${outW}w crf${attempt.crf}) to fit CDN limit (${Math.round(st.size / 1024 / 1024)}MB)`,
        );
      }
      return { width: outW, height: outH, bytes: st.size };
    }

    warnings.push(
      `web encode ${outW}w crf${attempt.crf} produced ${Math.round(st.size / 1024 / 1024)}MB — retrying smaller`,
    );
  }

  if (lastSize > CDN_ASSET_MAX_BYTES) {
    await unlink(webAbs).catch(() => undefined);
    warnings.push(
      `web fallback still exceeds CDN limit (${Math.round(lastSize / 1024 / 1024)}MB after all compression steps) — omitted from variants`,
    );
    return null;
  }

  return null;
}

async function isAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileP(cmd, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function runWebTranscode(
  sourceAbs: string,
  webAbs: string,
  vf: string,
  attempt: WebEncodeAttempt,
): Promise<void> {
  await execFileP("ffmpeg", [
    "-y",
    "-i", sourceAbs,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", String(attempt.crf),
    "-c:a", "aac",
    "-b:a", `${attempt.audioKbps}k`,
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    webAbs,
  ]);
}

export { TARGET_WIDTH };
