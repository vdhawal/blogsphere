/**
 * Generate placeholder image and video files for the Morocco fixture so the
 * compiler can run end-to-end without real photographs. Each image is a
 * solid-tinted JPG with a label baked in; videos are tiny one-frame MP4s.
 *
 * Re-running is idempotent — files are overwritten in place.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "morocco-2026", "assets");

const palette: Record<string, [number, number, number]> = {
  arrival: [180, 110, 70],
  market: [193, 67, 45],
  leaving: [80, 100, 130],
  cover: [120, 90, 60],
};

const images = [
  "cover.jpg",
  "arrival/rooftop.jpg",
  "arrival/alley.jpg",
  "arrival/courtyard.jpg",
  "arrival/tea.jpg",
  "arrival/lemons.jpg",
  "market/stalls.jpg",
  "market/tea.jpg",
  "market/bread.jpg",
  "market/dates.jpg",
  "market/square.jpg",
  "market/dates-poster.jpg",
  "leaving/road.jpg",
];

const videos = ["market/dates.mp4"];

async function makeImage(relPath: string) {
  const key = relPath.split("/")[0]!.replace(/\..*$/, "");
  const [r, g, b] = palette[key] ?? [120, 120, 120];
  const outPath = join(FIXTURE, relPath);
  await mkdir(dirname(outPath), { recursive: true });
  const label = relPath.replace(/\.jpg$/, "").replace(/[/_-]/g, " ");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
      <rect width="100%" height="100%" fill="rgb(${r},${g},${b})"/>
      <text x="50%" y="50%" font-family="Georgia, serif" font-size="72" fill="rgba(255,255,255,0.85)" text-anchor="middle" dominant-baseline="middle">${label}</text>
    </svg>`,
  );
  await sharp(svg).jpeg({ quality: 80 }).toFile(outPath);
}

async function makeVideo(relPath: string) {
  const outPath = join(FIXTURE, relPath);
  if (existsSync(outPath)) return;
  await mkdir(dirname(outPath), { recursive: true });
  // Try ffmpeg; fall back to writing a 1-byte placeholder so the pipeline can
  // still pass-through copy something. The viewer will fail to play it, which
  // is fine for fixture purposes — real videos come from the author.
  try {
    await execFileP("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=320x180:d=1:r=24",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-t", "1",
      outPath,
    ]);
  } catch {
    await writeFile(outPath, Buffer.from([0]));
    console.log(`  (no ffmpeg — wrote stub byte for ${relPath})`);
  }
}

async function main() {
  console.log("seeding fixture assets…");
  for (const f of images) {
    await makeImage(f);
    console.log("  img", f);
  }
  for (const f of videos) {
    await makeVideo(f);
    console.log("  vid", f);
  }
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
