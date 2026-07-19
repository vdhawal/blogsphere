import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { extname } from "node:path";

const execFileP = promisify(execFile);

export interface MediaProbe {
  codec: string;
  container: string;
  mime: string;
  pixFmt: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdr: boolean;
  width: number;
  height: number;
  durationMs?: number;
  bytes: number;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileP("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function isFfprobeAvailable(): Promise<boolean> {
  try {
    await execFileP("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export function containerForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "mp4" || ext === "m4v") return "mp4";
  if (ext === "mov") return "quicktime";
  if (ext === "webm") return "webm";
  if (ext === "mkv") return "matroska";
  return ext || "unknown";
}

export function mimeForVideoPath(path: string): string {
  const c = containerForPath(path);
  if (c === "mp4") return "video/mp4";
  if (c === "quicktime") return "video/quicktime";
  if (c === "webm") return "video/webm";
  if (c === "matroska") return "video/x-matroska";
  return `video/${c}`;
}

export function isHdrTransfer(transfer?: string): boolean {
  if (!transfer) return false;
  const t = transfer.toLowerCase();
  return t.includes("2084") || t.includes("hlg") || t.includes("b67") || t.includes("smpte");
}

export async function probeVideoFile(absPath: string): Promise<MediaProbe | null> {
  if (!(await isFfprobeAvailable())) return null;
  try {
    const [{ stdout }, st] = await Promise.all([
      execFileP("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,pix_fmt,color_space,color_transfer,color_primaries",
        "-show_entries", "format=duration",
        "-of", "json",
        absPath,
      ]),
      stat(absPath),
    ]);
    const data = JSON.parse(stdout) as {
      streams?: {
        codec_name?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
        color_space?: string;
        color_transfer?: string;
        color_primaries?: string;
      }[];
      format?: { duration?: string };
    };
    const s = data.streams?.[0];
    if (!s?.width || !s.height) return null;
    const durSec = data.format?.duration ? Number(data.format.duration) : undefined;
    const colorTransfer = s.color_transfer;
    const hdr =
      isHdrTransfer(colorTransfer) ||
      s.color_primaries === "bt2020" ||
      (s.pix_fmt ?? "").includes("10");
    return {
      codec: s.codec_name ?? "unknown",
      container: containerForPath(absPath),
      mime: mimeForVideoPath(absPath),
      pixFmt: s.pix_fmt ?? "unknown",
      colorSpace: s.color_space,
      colorTransfer,
      colorPrimaries: s.color_primaries,
      hdr,
      width: s.width,
      height: s.height,
      durationMs: durSec != null && Number.isFinite(durSec) ? Math.round(durSec * 1000) : undefined,
      bytes: st.size,
    };
  } catch {
    return null;
  }
}

export function imageContainerForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "heic" || ext === "heif") return "heic";
  return ext || "unknown";
}
