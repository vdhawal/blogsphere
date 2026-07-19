import { readFile, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import yaml from "js-yaml";
import matter from "gray-matter";
import {
  seriesSchema,
  chapterFrontmatterSchema,
  type Series,
} from "@blogspace/schemas";
import type { LoadedBlogSpace, LoadedChapter } from "./types.js";

/**
 * Load and validate a blog space from disk. Errors fast with a readable
 * message — the editor (step 4) can catch these and surface them inline.
 */
export async function loadBlogSpace(rootDir: string): Promise<LoadedBlogSpace> {
  const seriesPath = join(rootDir, "series.yaml");
  let seriesRaw: unknown;
  try {
    seriesRaw = yaml.load(await readFile(seriesPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read or parse series.yaml at ${seriesPath}: ${(err as Error).message}`,
    );
  }

  const seriesResult = seriesSchema.safeParse(seriesRaw);
  if (!seriesResult.success) {
    throw new Error(
      `series.yaml failed schema validation:\n${formatZodIssues(seriesResult.error.issues)}`,
    );
  }
  const series: Series = seriesResult.data;

  const chaptersDir = join(rootDir, "chapters");
  const filesOnDisk = (await readdir(chaptersDir))
    .filter((f) => extname(f) === ".md")
    .map((f) => basename(f, ".md"));

  // Verify every listed chapter exists, and warn if there are extra files
  // on disk that aren't listed in series.yaml.
  const listed = new Set(series.chapters);
  const onDisk = new Set(filesOnDisk);
  const missing = series.chapters.filter((s) => !onDisk.has(s));
  if (missing.length > 0) {
    throw new Error(
      `series.yaml lists chapters that don't exist on disk: ${missing.join(", ")}`,
    );
  }

  const chapters: LoadedChapter[] = [];
  for (const slug of series.chapters) {
    const filePath = join(chaptersDir, `${slug}.md`);
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const fmResult = chapterFrontmatterSchema.safeParse(parsed.data);
    if (!fmResult.success) {
      throw new Error(
        `Frontmatter in ${slug}.md failed validation:\n${formatZodIssues(fmResult.error.issues)}`,
      );
    }
    chapters.push({
      slug,
      filePath,
      frontmatter: fmResult.data,
      body: parsed.content,
    });
  }

  return { rootDir, series, chapters };
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}
