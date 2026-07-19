import { mkdir, writeFile, cp, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlogSpace } from "./loader.js";
import {
  collectAssetRefs,
  emptyManifest,
  loadAssetManifest,
  renderStaticMap,
  resolveImages,
  resolveVideos,
} from "./media.js";
import { parseChapter } from "./markdown.js";
import { buildGraph } from "./graph.js";
import { renderChapterPage, renderSeriesIndex, renderNotFoundPage } from "./render/pages.js";
import { renderFaviconSvg } from "./render/shell.js";
import {
  renderSitemap,
  renderRobots,
  renderRss,
  renderLlmsTxt,
  renderLlmsFullTxt,
  renderHeaders,
} from "./render/feeds.js";
import { zipDirectory } from "./zip.js";
import { renderBookHtml } from "./book.js";
import { renderHtmlToPdf } from "./pdf.js";
import {
  COMPILER_VERSION,
  BUILD_CACHE_VERSION,
  computeRenderDepsHash,
  fileExists,
  chapterFilenameFor,
  hashChapterSource,
  hashSeriesSource,
  loadBuildCache,
  pruneOrphanAssetFiles,
  pruneOrphanChapterFiles,
  saveBuildCache,
  type BuildCache,
  type ChapterCacheEntry,
} from "./cache.js";
import type {
  AssetManifest,
  CompileOptions,
  CompileResult,
  LoadedChapter,
  ViewerManifest,
} from "./types.js";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");

/**
 * Run the full compile pipeline.
 *
 * For `format: "dir"` the output dir is preserved across invocations so
 * the incremental cache can skip re-rendering unchanged chapters. For
 * `format: "zip"` the staging dir is internal and rebuilt fresh every
 * time — incremental gains there would require keeping a separate
 * cache dir; not worth the complexity for the once-per-publish cadence.
 *
 * Incremental decision tree per chapter:
 *
 *   1. Compute current sourceHash + renderDepsHash
 *   2. If previous build's cache has the same renderDepsHash AND the
 *      previously-written file is still on disk → skip render, leave
 *      the existing file in place.
 *   3. Otherwise → render fresh, save as `<slug>.<hash>.html`
 *
 * After all chapters resolve, orphan files (old hash names from prior
 * versions of changed chapters) are pruned.
 */
export async function compile(opts: CompileOptions): Promise<CompileResult> {
  const warnings: string[] = [];
  const loadedSpace = await loadBlogSpace(opts.spaceDir);
  const space = opts.siteBasePathOverride
    ? {
        ...loadedSpace,
        series: {
          ...loadedSpace.series,
          site: {
            ...(loadedSpace.series.site ?? {}),
            basePath: opts.siteBasePathOverride,
          },
        },
      }
    : loadedSpace;

  // Resolve the staging directory per format:
  //   - "dir":  staging IS the final output dir
  //   - "zip":  staging is a transient scratch dir, deleted after zipping
  //   - "both": staging is the named static dir kept alongside the zip
  //             (e.g. `<outDir>/<spaceId>/`)
  const stagingDir =
    opts.format === "zip"
      ? join(opts.outDir, ".build-staging")
      : opts.format === "both"
        ? join(opts.outDir, space.series.id)
        : opts.outDir;
  // Pure zip mode rebuilds clean every time — there's no cache benefit
  // when the artifact is a single archive that gets re-zipped end-to-end
  // anyway. Dir and both modes preserve the dir so prior compiles' HTML
  // can be reused via the incremental cache.
  const isZip = opts.format === "zip";
  const willEmitZip = opts.format === "zip" || opts.format === "both";
  if (isZip) {
    await rm(stagingDir, { recursive: true, force: true });
  }
  await mkdir(stagingDir, { recursive: true });
  await mkdir(join(stagingDir, "chapters"), { recursive: true });

  // Parse every chapter — cheap, and required to discover map directives
  // and build the chapter graph before any rendering.
  const parsed = space.chapters.map((c) => parseChapter(c.slug, c.body, c.frontmatter.title));

  // Compute source hashes — used both as identity for chapters and as
  // inputs to render-deps hashes.
  const sourceHashes = new Map<string, string>();
  for (const ch of space.chapters) {
    sourceHashes.set(ch.slug, hashChapterSource(ch));
  }
  const seriesSourceHash = hashSeriesSource(space);

  // Build the chapter graph once. Filenames are stable (`<slug>.html`) so
  // there's no longer a chicken-and-egg with the render-deps hash — the
  // hash is now a pure cache key, not part of the URL.
  const graph = buildGraph(space, parsed);

  // Compute per-chapter render-deps hashes. The deps set captures every
  // input that can affect this chapter's rendered HTML — see cache.ts
  // for the full list.
  const renderDepsHashes = new Map<string, string>();
  for (const slug of space.series.chapters) {
    const node = graph.get(slug);
    if (!node) continue;
    const ownSourceHash = sourceHashes.get(slug)!;
    const neighborSourceHashes = [node.prev, node.next].map((s) =>
      s ? sourceHashes.get(s) ?? null : null,
    );
    const inboundSourceHashes = node.inbound
      .map((s) => sourceHashes.get(s))
      .filter((h): h is string => !!h);
    const outboundChapterLinkTargetHashes = node.outbound
      .map((s) => sourceHashes.get(s))
      .filter((h): h is string => !!h);
    renderDepsHashes.set(
      slug,
      computeRenderDepsHash({
        ownSourceHash,
        seriesSourceHash,
        neighborSourceHashes,
        inboundSourceHashes,
        outboundChapterLinkTargetHashes,
        compilerVersion: COMPILER_VERSION,
      }),
    );
  }

  // Load the previous build cache (if any). Determines which chapters we
  // can skip rendering. Pure zip mode skips the cache entirely (it deletes
  // its staging dir at the end so cached file paths wouldn't survive); dir
  // and both modes keep a persistent output dir and benefit from caching.
  const prevCache = isZip ? null : await loadBuildCache(space.rootDir);
  const cacheStats = { reused: 0, rendered: 0 };

  // ----- assets -----
  const { imageRefs, videoRefs } = collectAssetRefs(space);
  const assetManifest = await loadAssetManifest(space.rootDir);
  const manifest: AssetManifest = emptyManifest();
  // Replay the previous asset cache (runtime-fallback metadata) into a Map
  // so resolveImages can short-circuit unchanged sources without re-encoding.
  const prevAssetCache = new Map(Object.entries(prevCache?.assets ?? {}));
  const imageResult = await resolveImages({
    space,
    outRoot: stagingDir,
    refs: imageRefs,
    manifest: assetManifest,
    prevAssetCache,
    warnings,
  });
  manifest.images = imageResult.resolved;
  manifest.videos = await resolveVideos(space, stagingDir, videoRefs, assetManifest, warnings);

  // ----- maps -----
  // Maps are tied to a chapter's content — if the chapter is reusable
  // we don't need to regenerate, but the SVG output is tiny so we just
  // re-emit unconditionally for simplicity.
  for (const p of parsed) {
    for (let i = 0; i < p.mapDirectives.length; i++) {
      const m = p.mapDirectives[i];
      if (!m) continue;
      const id = `${p.slug}-map-${i + 1}`;
      const [latStr, lngStr] = m.center.split(",");
      const markers = parseMarkers(m.markers);
      const processed = await renderStaticMap(stagingDir, id, {
        center: { lat: Number(latStr), lng: Number(lngStr) },
        zoom: m.zoom,
        markers,
        width: m.width,
        height: m.height,
        style: m.style,
        interactive: m.interactive,
      });
      manifest.maps.set(id, processed);
    }
  }

  // ----- chapter render or reuse -----
  const renderedChapters: { slug: string; html: string; plainText: string; isFresh: boolean }[] = [];
  for (let idx = 0; idx < space.chapters.length; idx++) {
    const chapter = space.chapters[idx]!;
    const parsedCh = parsed[idx]!;
    const slug = chapter.slug;
    const renderHash = renderDepsHashes.get(slug)!;
    const targetFilename = chapterFilenameFor(slug);
    const targetPath = join(stagingDir, "chapters", targetFilename);

    const prevEntry: ChapterCacheEntry | undefined = prevCache?.chapters[slug];
    const isFresh =
      !!prevEntry &&
      prevEntry.renderDepsHash === renderHash &&
      (await fileExists(targetPath));

    if (isFresh) {
      cacheStats.reused += 1;
      // The chapter HTML is already on disk from a previous compile and
      // its renderDepsHash matches — nothing affecting its output changed.
      // We still need the plainText for llms-full.txt and the book PDF
      // generation, so derive it from the parsed AST.
      const plainText = bodyToPlainTextFromTree(parsedCh.tree);
      renderedChapters.push({ slug, html: "", plainText, isFresh: true });
    } else {
      cacheStats.rendered += 1;
      const result = renderChapterPage({
        chapter,
        parsed: parsedCh,
        space,
        graph,
        manifest,
        warnings,
      });
      await writeFile(targetPath, result.html, "utf8");
      renderedChapters.push({ ...result, isFresh: false });
    }
  }

  // ----- always-emit artifacts -----
  // index.html, sitemap, robots, rss, llms, manifest.json, viewer.* are
  // small enough that re-emitting unconditionally is simpler than tracking
  // their dependencies. The series-level header chrome on chapter HTMLs is
  // gated through the renderDepsHash (seriesSourceHash is part of it), so
  // when the series changes, every chapter is also re-rendered.
  const indexHtml = renderSeriesIndex({ space, graph, manifest });
  await writeFile(join(stagingDir, "index.html"), indexHtml, "utf8");
  await writeFile(join(stagingDir, "404.html"), renderNotFoundPage({ space, graph, manifest }), "utf8");
  await writeFile(join(stagingDir, "favicon.svg"), renderFaviconSvg(space.series), "utf8");

  await writeFile(join(stagingDir, "sitemap.xml"), renderSitemap(space, graph, manifest), "utf8");
  await writeFile(join(stagingDir, "robots.txt"), renderRobots(space), "utf8");
  // Cloudflare Pages caching contract — lives at the deploy root; inert
  // on other hosts. HTML revalidates (URLs are stable), assets immutable.
  await writeFile(join(stagingDir, "_headers"), renderHeaders(), "utf8");
  await writeFile(join(stagingDir, "rss.xml"), renderRss(space, graph, manifest), "utf8");
  await writeFile(join(stagingDir, "llms.txt"), renderLlmsTxt(space, graph), "utf8");
  // llms-full.txt needs each chapter's plain text. For freshly-rendered
  // chapters we already have it; for reused ones we derived it from the
  // AST above. Same shape, same content.
  await writeFile(
    join(stagingDir, "llms-full.txt"),
    renderLlmsFullTxt(space, renderedChapters),
    "utf8",
  );

  const viewerManifest: ViewerManifest = {
    series: {
      id: space.series.id,
      title: space.series.title,
      description: space.series.description,
      cover: space.series.cover,
    },
    chapters: space.chapters.map((c) => ({
      slug: c.slug,
      title: c.frontmatter.title,
      summary: c.frontmatter.summary,
      url: `/chapters/${graph.get(c.slug)?.outputFilename ?? c.slug + ".html"}`,
      cover: c.frontmatter.cover,
    })),
  };
  await writeFile(join(stagingDir, "manifest.json"), JSON.stringify(viewerManifest, null, 2), "utf8");

  // chat-config.json — public, reader-facing companion to ai-context.yaml.
  // The viewer fetches this on load to decide whether to render the chat
  // panel and where to POST messages. Author-visible config keys
  // (chatProxyUrl) come from `.blogspace/config.yaml`; per-provider file
  // ids come from `.blogspace/ai-context.yaml`. Both are optional —
  // missing files just produce a config that hides the chat panel.
  await writeChatConfig(
    stagingDir,
    opts.spaceDir,
    space.series.id,
    opts.chatProxyUrlOverride,
  );

  await mkdir(join(stagingDir, "assets"), { recursive: true });
  await cp(join(STATIC_DIR, "viewer.css"), join(stagingDir, "assets", "viewer.css"));
  await cp(join(STATIC_DIR, "viewer.js"), join(stagingDir, "assets", "viewer.js"));

  // ----- orphan cleanup -----
  // Any HTML files left in chapters/ from a previous compile that aren't
  // in the current chapter set are stale and removed. With stable
  // `<slug>.html` filenames this only fires when a chapter is deleted or
  // its slug changes — content edits overwrite in place.
  const expectedChapterFiles = new Set<string>(
    space.chapters.map((c) => chapterFilenameFor(c.slug)),
  );
  await pruneOrphanChapterFiles(join(stagingDir, "chapters"), expectedChapterFiles);

  // Build the set of asset paths this compile wants to keep. Anything
  // left under stagingDir/assets/ that isn't on this list is an orphan
  // from a previous compile whose source reference was since removed;
  // wipe it so re-exports don't carry stale variants. Static map outputs
  // and ProcessedImage / ProcessedVideo variants are the full set.
  const keepAssetPaths = new Set<string>();
  for (const img of manifest.images.values()) {
    for (const v of img.variants) keepAssetPaths.add(v.outputPath);
  }
  for (const vid of manifest.videos.values()) {
    for (const v of vid.variants) keepAssetPaths.add(v.outputPath);
    if (vid.posterOutputPath) keepAssetPaths.add(vid.posterOutputPath);
  }
  for (const m of manifest.maps.values()) {
    keepAssetPaths.add(m.outputPath);
  }
  const prunedAssets = await pruneOrphanAssetFiles({
    assetsDir: join(stagingDir, "assets"),
    keepPaths: keepAssetPaths,
  });
  if (prunedAssets.removedFiles > 0) {
    warnings.push(
      `pruned ${prunedAssets.removedFiles} orphan asset file(s) (${Math.round(
        prunedAssets.removedBytes / 1024,
      )} KB) from previous build`,
    );
  }

  // ----- book + PDF -----
  // The PDF takes ~2s to render — only do it if anything changed. If every
  // chapter was reused AND the previous PDF exists, leave the previous PDF
  // in place. (Series-level changes are caught above via renderDepsHash.)
  const anyChapterChanged = renderedChapters.some((r) => !r.isFresh);
  const bookHtmlPath = join(stagingDir, "book.html");
  const pdfStagingPath = join(stagingDir, "book.pdf");
  let pdfBytes = 0;
  let pdfRendered = false;
  if (anyChapterChanged || !(await fileExists(pdfStagingPath))) {
    pdfRendered = true;
    const bookHtml = renderBookHtml({
      space,
      parsedChapters: parsed,
      graph,
      manifest,
      warnings,
    });
    await writeFile(bookHtmlPath, bookHtml, "utf8");
    const pdfResult = await renderHtmlToPdf({ htmlPath: bookHtmlPath, pdfPath: pdfStagingPath });
    pdfBytes = pdfResult.bytes;
  } else {
    // Reuse the prior PDF — read its size for the result report.
    pdfBytes = (await readFile(pdfStagingPath)).length;
  }

  // ----- finalize -----
  let outputPath = stagingDir;
  let dirPath: string | null = stagingDir;
  let zipPath: string | null = null;
  let bytesWritten = 0;
  let pdfPath = pdfStagingPath;

  if (willEmitZip) {
    const zipName = `${space.series.id}.zip`;
    zipPath = join(opts.outDir, zipName);
    // PDF moves to sibling-of-zip so it lives at the same level as the
    // distributable archive (and, in "both" mode, alongside the static dir).
    pdfPath = join(opts.outDir, `${space.series.id}.pdf`);
    await cp(pdfStagingPath, pdfPath);
    await rm(pdfStagingPath, { force: true });
    bytesWritten = await zipDirectory(stagingDir, zipPath);
    outputPath = zipPath;
  }

  if (isZip) {
    // Pure zip mode: throw away the staging dir; the archive is the artifact.
    await rm(stagingDir, { recursive: true, force: true });
    dirPath = null;
  }

  const variantsWritten = [...manifest.images.values()].reduce(
    (s, img) => s + img.variants.length,
    0,
  );

  // ----- save build cache (skip for zip mode — no incremental benefit) -----
  if (!isZip) {
    const newCache: BuildCache = {
      version: BUILD_CACHE_VERSION,
      compilerVersion: COMPILER_VERSION,
      lastBuildAt: new Date().toISOString(),
      seriesSourceHash,
      chapters: Object.fromEntries(
        space.chapters.map((c) => [
          c.slug,
          {
            sourceHash: sourceHashes.get(c.slug)!,
            renderDepsHash: renderDepsHashes.get(c.slug)!,
            outputFilename: chapterFilenameFor(c.slug),
          },
        ]),
      ),
      // Only assets that are actually referenced this compile survive into
      // the next cache. Anything previously cached but no longer referenced
      // (e.g. an image whose markdown ref was deleted) is implicitly pruned.
      assets: Object.fromEntries(imageResult.newAssetCache),
    };
    await saveBuildCache(space.rootDir, newCache);
  }

  // Surface the incremental breakdown unconditionally — it's load-bearing
  // for an author who wants to know whether their edit produced a tight
  // rebuild or cascaded across the series.

  return {
    outputPath,
    dirPath,
    zipPath,
    pdfPath,
    pdfBytes,
    chaptersWritten: renderedChapters.length,
    chaptersRendered: cacheStats.rendered,
    chaptersReused: cacheStats.reused,
    pdfRendered,
    imagesProcessed: manifest.images.size,
    imagesManifestServed: imageResult.stats.manifestServed,
    imagesReusedFromCache: imageResult.stats.reusedFromCache,
    imagesRegenerated: imageResult.stats.regenerated,
    variantsWritten,
    bytesWritten,
    warnings,
  };
}

/**
 * Extract plain text from a parsed mdast tree — used to backfill
 * llms-full.txt content for chapters we reuse from cache (their HTML
 * is on disk but we don't re-read it; we re-derive from the AST).
 */
function bodyToPlainTextFromTree(tree: { children: unknown[] }): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; value?: string; children?: unknown[] };
    if (node.type === "text" && typeof node.value === "string") out.push(node.value);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(tree);
  return out.join("").replace(/\s+/g, " ").trim();
}

/**
 * Read `.blogspace/config.yaml` + `.blogspace/ai-context.yaml` from the
 * source space and emit a single `chat-config.json` into the stagingDir.
 * Output shape is intentionally narrow — only the bits the viewer needs
 * to render its chat panel and POST messages to the right URL.
 *
 * When chatProxyUrl is unset OR no ai-context entry matches a known
 * provider, we still emit the file (with `enabled: false`) so the viewer
 * doesn't 404 on the fetch.
 */
async function writeChatConfig(
  stagingDir: string,
  spaceDir: string,
  spaceId: string,
  chatProxyUrlOverride?: string,
): Promise<void> {
  const yaml = (await import("js-yaml")).default;
  const fs = await import("node:fs/promises");
  let chatProxyUrl: string | undefined = chatProxyUrlOverride;
  if (!chatProxyUrl) {
    try {
      const raw = await fs.readFile(join(spaceDir, ".blogspace", "config.yaml"), "utf8");
      const parsed = yaml.load(raw) as
        | { ai?: { endpoints?: { chatProxyUrl?: string } } }
        | undefined;
      chatProxyUrl = parsed?.ai?.endpoints?.chatProxyUrl;
    } catch {
      /* config missing — chat disabled */
    }
  }
  let provider: string | undefined;
  let model: string | undefined;
  let fileId: string | undefined;
  try {
    const raw = await fs.readFile(join(spaceDir, ".blogspace", "ai-context.yaml"), "utf8");
    const parsed = yaml.load(raw) as
      | { entries?: { provider: string; fileId: string }[] }
      | undefined;
    const entry = parsed?.entries?.[0];
    if (entry) {
      provider = entry.provider;
      fileId = entry.fileId;
    }
  } catch {
    /* no context yet — Sync PDF hasn't been run */
  }
  const config = {
    spaceId,
    enabled: !!chatProxyUrl,
    chatProxyUrl: chatProxyUrl ?? null,
    provider: provider ?? null,
    model: model ?? null,
    fileId: fileId ?? null,
  };
  await writeFile(join(stagingDir, "chat-config.json"), JSON.stringify(config, null, 2), "utf8");
}

function parseMarkers(markers: string | undefined): { lat: number; lng: number; label?: string }[] {
  if (!markers) return [];
  return markers
    .split("|")
    .map((segment) => {
      const [coords, ...labelParts] = segment.split(":");
      const [latStr, lngStr] = (coords ?? "").split(",");
      const lat = Number(latStr);
      const lng = Number(lngStr);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      const label = labelParts.join(":").trim();
      return label ? { lat, lng, label } : { lat, lng };
    })
    .filter((m): m is { lat: number; lng: number; label?: string } => m !== null);
}
