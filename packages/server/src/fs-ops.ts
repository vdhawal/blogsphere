import { readFile, writeFile, readdir, mkdir, stat, rename, rm, copyFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, basename, extname, dirname } from "node:path";
import yaml from "js-yaml";
import matter from "gray-matter";
import {
  seriesSchema,
  chapterFrontmatterSchema,
  slugSchema,
  type Series,
  type ChapterFrontmatter,
} from "@blogspace/schemas";
import type { SpaceDetail, SpaceSummary } from "./types.js";
import { replaceChapterSlugReferences } from "./chapter-slug.js";

/** Workspace = directory holding multiple blog-space subdirectories. */
export class Workspace {
  constructor(public readonly root: string) {}

  spaceDir(spaceId: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spaceId)) {
      throw new Error(`invalid space id: ${spaceId}`);
    }
    return join(this.root, spaceId);
  }

  chapterPath(spaceId: string, slug: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`invalid chapter slug: ${slug}`);
    }
    return join(this.spaceDir(spaceId), "chapters", `${slug}.md`);
  }

  async listSpaces(): Promise<SpaceSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const out: SpaceSummary[] = [];
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const seriesPath = join(this.root, e, "series.yaml");
      try {
        const s = await stat(seriesPath);
        if (!s.isFile()) continue;
        const raw = yaml.load(await readFile(seriesPath, "utf8"));
        const parsed = seriesSchema.safeParse(raw);
        if (!parsed.success) continue;
        out.push({
          id: parsed.data.id,
          title: parsed.data.title,
          description: parsed.data.description,
          theme: parsed.data.theme,
          cover: parsed.data.cover,
          chapterCount: parsed.data.chapters.length,
          updatedAt: parsed.data.updatedAt,
        });
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  async readSpace(spaceId: string): Promise<SpaceDetail> {
    const series = await this.readSeries(spaceId);
    const chapters: SpaceDetail["chapters"] = [];
    for (const slug of series.chapters) {
      try {
        const { frontmatter } = await this.readChapter(spaceId, slug);
        chapters.push({
          slug,
          title: frontmatter.title,
          summary: frontmatter.summary,
          publishedAt: frontmatter.publishedAt,
        });
      } catch {
        chapters.push({ slug, title: slug, summary: "(missing)" });
      }
    }
    return { id: series.id, series, chapters };
  }

  async readSeries(spaceId: string): Promise<Series> {
    const path = join(this.spaceDir(spaceId), "series.yaml");
    const raw = yaml.load(await readFile(path, "utf8"));
    const parsed = seriesSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`series.yaml invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async writeSeries(spaceId: string, series: Series): Promise<void> {
    const validated = seriesSchema.parse(series);
    const path = join(this.spaceDir(spaceId), "series.yaml");
    const yamlStr = yaml.dump(validated, { lineWidth: 100, noRefs: true });
    await writeFileAtomic(path, yamlStr);
  }

  async readChapter(
    spaceId: string,
    slug: string,
  ): Promise<{ frontmatter: ChapterFrontmatter; body: string }> {
    const path = this.chapterPath(spaceId, slug);
    const raw = await readFile(path, "utf8");
    const parsed = matter(raw);
    const fmResult = chapterFrontmatterSchema.safeParse(parsed.data);
    if (!fmResult.success) {
      throw new Error(`frontmatter invalid in ${slug}.md: ${fmResult.error.message}`);
    }
    return { frontmatter: fmResult.data, body: parsed.content };
  }

  /**
   * Atomically write a chapter file. Frontmatter is serialized as YAML;
   * body is appended verbatim. We preserve the leading-newline convention
   * gray-matter produces so round-tripping is stable.
   */
  async writeChapter(
    spaceId: string,
    slug: string,
    frontmatter: ChapterFrontmatter,
    body: string,
  ): Promise<void> {
    const fm = chapterFrontmatterSchema.parse(frontmatter);
    const yamlStr = yaml.dump(fm, { lineWidth: 100, noRefs: true });
    const content = `---\n${yamlStr}---\n${body.startsWith("\n") ? body : "\n" + body}`;
    await writeFileAtomic(this.chapterPath(spaceId, slug), content);
  }

  async createSpace(input: {
    id: string;
    title: string;
    description: string;
    theme: string;
    author: string;
  }): Promise<SpaceDetail> {
    const dir = this.spaceDir(input.id);
    try {
      await stat(dir);
      throw new Error(`space already exists: ${input.id}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await mkdir(join(dir, ".blogspace"), { recursive: true });

    const series: Series = seriesSchema.parse({
      id: input.id,
      title: input.title,
      description: input.description,
      theme: input.theme,
      author: input.author,
      cover: "./assets/cover.jpg",
      chapters: [],
      tags: [],
      related: [],
      language: "en",
      seo: {},
      ai: {},
    });
    await this.writeSeries(input.id, series);
    return { id: input.id, series, chapters: [] };
  }

  async createChapter(input: {
    spaceId: string;
    slug: string;
    title: string;
    summary: string;
  }): Promise<{ frontmatter: ChapterFrontmatter; body: string }> {
    const series = await this.readSeries(input.spaceId);
    if (series.chapters.includes(input.slug)) {
      throw new Error(`chapter already exists: ${input.slug}`);
    }
    const fm: ChapterFrontmatter = chapterFrontmatterSchema.parse({
      title: input.title,
      summary: input.summary,
      tags: [],
      seo: {},
      ai: {},
      generated: {},
    });
    const body = `\n# ${input.title}\n\nStart writing here.\n`;
    await this.writeChapter(input.spaceId, input.slug, fm, body);
    await this.writeSeries(input.spaceId, {
      ...series,
      chapters: [...series.chapters, input.slug],
    });
    return { frontmatter: fm, body };
  }

  /**
   * Save an uploaded asset under `<space>/assets/<chapter>/<filename>` (or
   * `<space>/assets/<filename>` if `chapter` is omitted). Filenames are
   * collision-sanitized: if a file with the same name exists, we suffix
   * `-1`, `-2`, … until we find a free slot. The author never has to
   * rename anything manually.
   *
   * Returns the original path on disk and the space-root-relative path
   * suitable for markdown references — variant generation happens in a
   * separate step (see AssetStore / @blogspace/media), so this method
   * does the bytes-to-disk part only.
   */
  async saveAsset(
    spaceId: string,
    chapter: string | undefined,
    filename: string,
    data: AsyncIterable<Buffer> | Buffer,
  ): Promise<{ assetRef: string; bytes: number; sourceAbs: string; sourceRelative: string }> {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const subdir = chapter ? join("assets", chapter) : "assets";
    const dirAbs = join(this.spaceDir(spaceId), subdir);
    await mkdir(dirAbs, { recursive: true });

    const ext = extname(safeName);
    const stem = basename(safeName, ext);
    let candidate = safeName;
    let n = 0;
    while (true) {
      try {
        await stat(join(dirAbs, candidate));
        n += 1;
        candidate = `${stem}-${n}${ext}`;
      } catch {
        break;
      }
    }
    const outAbs = join(dirAbs, candidate);
    let bytes = 0;
    if (Buffer.isBuffer(data)) {
      await writeFile(outAbs, data);
      bytes = data.length;
    } else {
      const ws = createWriteStream(outAbs);
      const readable = Readable.from(data);
      readable.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      await pipeline(readable, ws);
    }
    const assetRef = `./${subdir}/${candidate}`.replace(/\\/g, "/");
    const sourceRelative = `${subdir}/${candidate}`.replace(/\\/g, "/");
    return { assetRef, bytes, sourceAbs: outAbs, sourceRelative };
  }

  /**
   * Rename a chapter slug: move the markdown file, update series order,
   * relocate per-chapter asset folders, and rewrite wikilink / asset-path
   * references across every chapter in the space.
   */
  async renameChapter(spaceId: string, fromSlug: string, toSlug: string): Promise<void> {
    const parsed = slugSchema.safeParse(toSlug);
    if (!parsed.success) throw new Error(parsed.error.message);
    if (fromSlug === toSlug) return;

    const series = await this.readSeries(spaceId);
    if (!series.chapters.includes(fromSlug)) {
      throw new Error(`chapter not found: ${fromSlug}`);
    }
    if (series.chapters.includes(toSlug)) {
      throw new Error(`chapter already exists: ${toSlug}`);
    }

    const oldPath = this.chapterPath(spaceId, fromSlug);
    const newPath = this.chapterPath(spaceId, toSlug);
    try {
      await stat(oldPath);
    } catch {
      throw new Error(`chapter file missing: ${fromSlug}.md`);
    }
    try {
      await stat(newPath);
      throw new Error(`chapter already exists: ${toSlug}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const spaceDir = this.spaceDir(spaceId);
    for (const [fromSub, toSub] of [
      [`assets/${fromSlug}`, `assets/${toSlug}`],
      [`assets/.variants/${fromSlug}`, `assets/.variants/${toSlug}`],
    ] as const) {
      const fromDir = join(spaceDir, fromSub);
      const toDir = join(spaceDir, toSub);
      try {
        await stat(fromDir);
        await mkdir(dirname(toDir), { recursive: true });
        await rename(fromDir, toDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    let renamedBody: string | null = null;
    let renamedFrontmatter: ChapterFrontmatter | null = null;

    for (const slug of series.chapters) {
      const { frontmatter, body } = await this.readChapter(spaceId, slug);
      const newBody = replaceChapterSlugReferences(body, fromSlug, toSlug);
      const newCover = frontmatter.cover
        ? replaceChapterSlugReferences(frontmatter.cover, fromSlug, toSlug)
        : undefined;
      const newFrontmatter: ChapterFrontmatter = {
        ...frontmatter,
        ...(newCover !== undefined ? { cover: newCover } : {}),
      };

      if (slug === fromSlug) {
        renamedBody = newBody;
        renamedFrontmatter = newFrontmatter;
        continue;
      }
      if (newBody !== body || newCover !== frontmatter.cover) {
        await this.writeChapter(spaceId, slug, newFrontmatter, newBody);
      }
    }

    await rename(oldPath, newPath);
    if (renamedFrontmatter && renamedBody !== null) {
      await this.writeChapter(spaceId, toSlug, renamedFrontmatter, renamedBody);
    }

    await this.writeSeries(spaceId, {
      ...series,
      chapters: series.chapters.map((s) => (s === fromSlug ? toSlug : s)),
    });
  }

  async deleteChapter(spaceId: string, slug: string): Promise<void> {
    const path = this.chapterPath(spaceId, slug);
    await rm(path, { force: true });
    const series = await this.readSeries(spaceId);
    await this.writeSeries(spaceId, {
      ...series,
      chapters: series.chapters.filter((c) => c !== slug),
    });
  }

  /**
   * Recursively remove an entire blog space.
   *
   * Guarded against escaping the workspace root — even though spaceDir()
   * validates the slug format, the resolved path is double-checked here
   * before any rm runs. Caller is responsible for evicting any related
   * in-memory state (open chapters, series) before invoking this so that
   * a pending flush doesn't recreate files we just deleted.
   */
  async deleteSpace(spaceId: string): Promise<void> {
    const dir = this.spaceDir(spaceId);
    const rootResolved = await import("node:path").then((p) => p.resolve(this.root));
    const dirResolved = await import("node:path").then((p) => p.resolve(dir));
    if (!dirResolved.startsWith(rootResolved + "/") || dirResolved === rootResolved) {
      throw new Error(`refusing to delete '${dir}' — outside workspace root`);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write file atomically by writing to a temp sibling then renaming.
 * Prevents partial writes if the process is killed mid-flush — important
 * for an auto-saving editor where flushes happen often.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export { writeFileAtomic };
