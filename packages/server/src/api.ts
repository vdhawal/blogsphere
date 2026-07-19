import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { compile, renderWorkspaceIndex, renderHeaders, zipDirectory } from "@blogspace/compiler";
import type { Workspace } from "./fs-ops.js";
import type { SpaceDetail } from "./types.js";
import { chapterFrontmatterSchema, seriesSchema, exportSettingsSchema, type AssetEntry, type ImageAsset, type VideoAsset, type Series } from "@blogspace/schemas";
import type { PreviewManager } from "./preview.js";
import { AssetStore } from "./asset-store.js";
import { AssetProcessingQueue } from "./asset-queue.js";
import { ensureSpaceAssetsReady } from "./ensure-assets.js";
import { buildMediaReport } from "./media-report.js";
import type { Store } from "./store.js";
import { registerAiRoutes } from "./ai/routes.js";
import { syncPdfContext, loadAiContext } from "./ai/index.js";
import { writeFile, rm, readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { cropToJpeg, processImage, probeVideoFile } from "@blogspace/media";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, posix, resolve as pathResolve, relative as pathRelative } from "node:path";

const execFileP = promisify(execFile);

export function registerApi(
  app: FastifyInstance,
  workspace: Workspace,
  store: Store,
  preview: PreviewManager,
): void {
  // One asset store per server instance — caches manifests in memory and
  // serializes manifest writes through atomic file replaces.
  const assets = new AssetStore(workspace.root);
  const assetQueue = new AssetProcessingQueue(
    (spaceId) => workspace.spaceDir(spaceId),
    assets,
  );
  registerAiRoutes(app, workspace, assets);
  app.get("/api/workspace", async () => {
    const spaces = await workspace.listSpaces();
    return { root: workspace.root, spaces };
  });

  app.get("/api/export/settings", async () => {
    const settingsPath = join(workspace.root, ".blogspace", "export-settings.yaml");
    try {
      const raw = await readFile(settingsPath, "utf8");
      const parsed = exportSettingsSchema.safeParse(yaml.load(raw));
      return parsed.success ? parsed.data : { selectedSpaceIds: [] };
    } catch {
      return { selectedSpaceIds: [] };
    }
  });

  app.post<{ Body: { spaceIds: string[] } }>(
    "/api/export",
    async (req, reply) => {
      const spaceIds = req.body?.spaceIds;
      if (!Array.isArray(spaceIds)) {
        return reply.code(400).send({ error: "missing or invalid spaceIds array in body" });
      }

      try {
        // 1. Save settings
        const settingsPath = join(workspace.root, ".blogspace", "export-settings.yaml");
        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(settingsPath, yaml.dump({ selectedSpaceIds: spaceIds }), "utf8");

        const exportRoot = join(workspace.root, "export");
        await rm(exportRoot, { recursive: true, force: true });
        await mkdir(exportRoot, { recursive: true });

        const warnings: string[] = [];
        let totalChapters = 0;
        let totalImages = 0;

        // 2. Compile each selected space
        for (const spaceId of spaceIds) {
          const ensured = await ensureSpaceAssetsReady({
            workspace,
            assets,
            queue: assetQueue,
            spaceId,
          });
 
          const result = await compile({
            spaceDir: workspace.spaceDir(spaceId),
            outDir: join(exportRoot, spaceId),
            format: "dir",
            siteBasePathOverride: `/${spaceId}/`,
          });
 
          totalChapters += result.chaptersWritten;
          totalImages += result.imagesProcessed;

          if (ensured.warnings.length) {
            warnings.push(...ensured.warnings.map((w) => `${spaceId} assets: ${w}`));
          }
          if (result.warnings.length) {
            warnings.push(...result.warnings.map((w) => `${spaceId}: ${w}`));
          }
 
          // Remove blog-specific root artifact duplicates from the combined export.
          const perBlogRootFiles = ["_headers", "404.html", "favicon.svg", "robots.txt", "rss.xml", "sitemap.xml"];
          for (const fileName of perBlogRootFiles) {
            await rm(join(exportRoot, spaceId, fileName), { force: true, recursive: true });
          }
 
          // Sync PDF context if it was rendered
          const pdfAbs = result.pdfPath;
          if (pdfAbs) {
            await syncPdfContext({
              workspaceRoot: workspace.root,
              spaceId,
              pdfPath: pdfAbs,
              onLog: (level, msg) =>
                level === "warn" ? req.log.warn(msg) : req.log.info(msg),
            });
          }
        }

        // 3. Load all compiled space metadata to generate the shared root pages.
        const spaceDetails: SpaceDetail[] = [];
        for (const spaceId of spaceIds) {
          try {
            const space = await workspace.readSpace(spaceId);
            spaceDetails.push(space);
          } catch (err) {
            req.log.warn(`Failed to read space metadata for ${spaceId}: ${(err as Error).message}`);
          }
        }
 
        // 4. Generate the shared root index.html and deployment manifests.
        const indexHtml = renderWorkspaceIndex(spaceDetails.map((s) => s.series));
        await writeFile(join(exportRoot, "index.html"), indexHtml, "utf8");
        await writeFile(join(exportRoot, "_headers"), renderHeaders(), "utf8");
        await writeFile(join(exportRoot, "404.html"), renderExportNotFound(), "utf8");
        await writeFile(join(exportRoot, "favicon.svg"), renderExportFaviconSvg(), "utf8");
        await writeFile(join(exportRoot, "robots.txt"), renderExportRobots(), "utf8");
        await writeFile(join(exportRoot, "sitemap.xml"), renderExportSitemap(spaceDetails), "utf8");
        await writeFile(join(exportRoot, "rss.xml"), renderExportRss(spaceDetails), "utf8");
        await writeFile(join(exportRoot, "llms.txt"), renderExportLlmsIndex(spaceDetails), "utf8");

        // 5. Create a root zip representing the whole export folder
        const zipPath = join(workspace.root, "export.zip");
        await rm(zipPath, { force: true });
        const zipBytes = await zipDirectory(exportRoot, zipPath);

        return {
          dirPath: exportRoot,
          zipPath,
          pdfPath: "", // no single PDF for multi-blog
          parentPath: exportRoot,
          chapters: totalChapters,
          chaptersRendered: totalChapters,
          chaptersReused: 0,
          imagesProcessed: totalImages,
          pdfBytes: 0,
          zipBytes,
          warnings,
        };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Body: { id: string; title: string; description: string; theme: string; author: string } }>(
    "/api/spaces",
    async (req, reply) => {
      const body = req.body;
      if (!body?.id || !body.title || !body.description || !body.theme || !body.author) {
        return reply.code(400).send({ error: "missing required fields: id, title, description, theme, author" });
      }
      try {
        return await workspace.createSpace(body);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { spaceId: string } }>("/api/spaces/:spaceId", async (req, reply) => {
    try {
      return await workspace.readSpace(req.params.spaceId);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put<{ Params: { spaceId: string }; Body: unknown }>(
    "/api/spaces/:spaceId/series",
    async (req, reply) => {
      const parsed = seriesSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      await workspace.writeSeries(req.params.spaceId, parsed.data);
      return { ok: true };
    },
  );

  app.post<{ Params: { spaceId: string }; Body: { slug: string; title: string; summary: string } }>(
    "/api/spaces/:spaceId/chapters",
    async (req, reply) => {
      const body = req.body;
      if (!body?.slug || !body.title || !body.summary) {
        return reply.code(400).send({ error: "missing required fields: slug, title, summary" });
      }
      try {
        const result = await workspace.createChapter({ spaceId: req.params.spaceId, ...body });
        store.appendSeriesChapter(req.params.spaceId, body.slug);
        return result;
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { spaceId: string; slug: string } }>(
    "/api/spaces/:spaceId/chapters/:slug",
    async (req, reply) => {
      try {
        return await workspace.readChapter(req.params.spaceId, req.params.slug);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.delete<{ Params: { spaceId: string; slug: string } }>(
    "/api/spaces/:spaceId/chapters/:slug",
    async (req) => {
      const { spaceId, slug } = req.params;
      await workspace.deleteChapter(spaceId, slug);
      store.removeSeriesChapter(spaceId, slug);
      store.evictChapter(spaceId, slug);
      return { ok: true };
    },
  );

  app.post<{ Params: { spaceId: string; slug: string }; Body: { newSlug?: string } }>(
    "/api/spaces/:spaceId/chapters/:slug/rename",
    async (req, reply) => {
      const newSlug = req.body?.newSlug?.trim();
      if (!newSlug) {
        return reply.code(400).send({ error: "missing required field: newSlug" });
      }
      const { spaceId, slug: fromSlug } = req.params;
      try {
        await store.prepareChapterRename(spaceId, fromSlug);
        await workspace.renameChapter(spaceId, fromSlug, newSlug);
        await assets.rewriteChapterPaths(spaceId, fromSlug, newSlug);
        store.patchSeriesChapterSlug(spaceId, fromSlug, newSlug);
        return { slug: newSlug };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * Delete an entire blog space. Order matters: evict in-memory state
   * BEFORE removing the directory, otherwise a pending debounced flush
   * may resurrect the chapter files we just removed.
   */
  app.delete<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId",
    async (req, reply) => {
      try {
        store.evictSpace(req.params.spaceId);
        await workspace.deleteSpace(req.params.spaceId);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.put<{ Params: { spaceId: string; slug: string }; Body: unknown }>(
    "/api/spaces/:spaceId/chapters/:slug/frontmatter",
    async (req, reply) => {
      const parsed = chapterFrontmatterSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { body } = await workspace.readChapter(req.params.spaceId, req.params.slug);
      await workspace.writeChapter(req.params.spaceId, req.params.slug, parsed.data, body);
      return { ok: true };
    },
  );

  /**
   * Upload assets. Each uploaded file is:
   *   1. Saved as the original under <space>/assets/<chapter>/<name>
   *   2. Processed by @blogspace/media → variant set written to
   *      <space>/assets/.variants/<chapter>/<name>-<width>.<fmt>
   *   3. Added to <space>/.blogspace/assets.yaml as a manifest entry
   *
   * The response includes the full AssetEntry so the editor can show the
   * thumbnail (blurhash + smallest variant) without a refetch, and insert
   * markdown referencing the source path.
   */
  app.post<{ Params: { spaceId: string; slug?: string } }>(
    "/api/spaces/:spaceId/assets/:slug?",
    async (req, reply) => {
      const { spaceId, slug } = req.params;
      const parts = (req as FastifyRequest & { parts: () => AsyncIterableIterator<MultipartFile> }).parts();
      const saved: { assetRef: string; entry: AssetEntry; warnings?: string[] }[] = [];
      for await (const part of parts) {
        if (part.type !== "file") continue;
        try {
          const file = await workspace.saveAsset(spaceId, slug, part.filename, part.file);
          // Variant directory mirrors the chapter folder so we don't mix
          // unrelated chapters' variants. Keep it under `assets/.variants/`
          // so it sits alongside originals but is easy to grep-exclude.
          const variantSubdir = posix.join("assets", ".variants", slug ?? "_");
          const isImage =
            (part.mimetype ?? "").startsWith("image/") ||
            /\.(jpe?g|png|webp|avif|gif|heic|heif)$/i.test(file.sourceRelative);
          const isVideo =
            (part.mimetype ?? "").startsWith("video/") ||
            /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.sourceRelative);
          if (!isImage && !isVideo) {
            return reply.code(400).send({ error: `unsupported asset: ${file.sourceRelative}` });
          }
          const kind = isImage ? "image" : "video";
          const pending = await buildPendingEntry({
            sourceAbs: file.sourceAbs,
            sourceRelative: file.sourceRelative,
            kind,
            sizeBytes: file.bytes,
          });
          await assets.upsert(spaceId, pending);
          assetQueue.enqueue({ spaceId, sourceRelative: file.sourceRelative, kind });
          saved.push({ assetRef: file.assetRef, entry: pending });
          req.log.debug({ spaceId, ref: file.assetRef, kind }, "asset queued for processing");
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      }
      if (saved.length === 0) return reply.code(400).send({ error: "no file parts in request" });
      return { saved };
    },
  );

  /**
   * Crop an existing image into a new asset suitable for a chapter cover.
   *
   * The author picks a crop rect in the cover-cropper dialog (typically
   * 16:10 to match the home-page card aspect ratio). The server runs the
   * crop via `cropToJpeg`, then feeds the cropped jpeg through
   * `processImage` with a thumb-sized variant ladder so the home page
   * thumbnail gets correctly-sized AVIF/WebP/JPEG sources instead of
   * shipping the full-resolution original.
   *
   * Cropped assets live at `assets/.crops/<chapter>/<stem>__<rect>.jpg`
   * so they're easy to grep-distinguish from author-uploaded originals.
   * They're treated as first-class manifest entries — referenced from
   * chapter frontmatter exactly like any other image.
   */
  app.post<{
    Params: { spaceId: string };
    Body: {
      source: string;
      slug: string;
      crop: { x: number; y: number; w: number; h: number };
    };
  }>("/api/spaces/:spaceId/assets/crop", async (req, reply) => {
    const { spaceId } = req.params;
    const { source, slug, crop } = req.body ?? ({} as never);
    if (!source || !slug || !crop) {
      return reply.code(400).send({ error: "missing source, slug, or crop" });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return reply.code(400).send({ error: `invalid chapter slug: ${slug}` });
    }
    const spaceRoot = workspace.spaceDir(spaceId);
    const normalized = source.replace(/^\.\//, "").replace(/^\//, "");
    const sourceAbs = join(spaceRoot, normalized);
    // Sanity guard — keep crops local to the space.
    if (!sourceAbs.startsWith(spaceRoot + "/") && sourceAbs !== spaceRoot) {
      return reply.code(400).send({ error: "source escapes space root" });
    }
    const stem = (normalized.split("/").pop() ?? "cover").replace(/\.[^.]+$/, "");
    const rectId = `c${Math.round(crop.x)}x${Math.round(crop.y)}x${Math.round(crop.w)}x${Math.round(crop.h)}`;
    const destRelative = posix.join("assets", ".crops", slug, `${stem}__${rectId}.jpg`);
    const destAbs = join(spaceRoot, destRelative);
    try {
      await cropToJpeg({ sourceAbs, destAbs, crop });
      // Smaller, thumb-friendly ladder. The home card is at most ~560px
      // wide at 2x DPI, so 320/640/960 covers it without bloating variants.
      const entry = await processImage({
        sourceAbs: destAbs,
        spaceRoot,
        sourceRelative: destRelative,
        options: {
          variantSubdir: posix.join("assets", ".variants", ".crops", slug),
          widths: [320, 640, 960],
        },
      });
      const manifest = await assets.upsert(spaceId, entry);
      req.log.debug({ spaceId, ref: destRelative, total: manifest.assets.length }, "crop processed");
      return { assetRef: `./${destRelative}`, entry };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Return the parsed asset manifest for a space. The editor's asset picker
   * uses this to render thumbnails. Empty manifest → `assets: []`.
   */
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/assets",
    async (req) => {
      return await assets.load(req.params.spaceId);
    },
  );

  app.delete<{ Params: { spaceId: string }; Querystring: { source?: string } }>(
    "/api/spaces/:spaceId/assets",
    async (req, reply) => {
      const source = req.query.source;
      if (!source) return reply.code(400).send({ error: "missing ?source=<sourcePath>" });
      const manifest = await assets.remove(req.params.spaceId, source);
      return manifest;
    },
  );

  /**
   * Update editable fields on a manifest asset (alt text, video caption).
   * AI-generated alt text writes through this — sourcePath is the lookup
   * key, the variant set and timestamps stay untouched.
   */
  app.patch<{
    Params: { spaceId: string };
    Body: { source: string; alt?: string; caption?: string };
  }>("/api/spaces/:spaceId/assets", async (req, reply) => {
    const { source, alt, caption } = req.body ?? ({} as never);
    if (!source) return reply.code(400).send({ error: "missing source" });
    const normalized = source.replace(/^\.\//, "").replace(/^\//, "");
    const manifest = await assets.load(req.params.spaceId);
    const entry = manifest.assets.find((a) => a.sourcePath === normalized);
    if (!entry) return reply.code(404).send({ error: "asset not found" });
    const patched: AssetEntry =
      entry.kind === "image"
        ? { ...entry, alt: alt ?? entry.alt }
        : { ...entry, caption: caption ?? entry.caption };
    const next = await assets.upsert(req.params.spaceId, patched);
    return next;
  });

  app.get<{ Params: { spaceId: string }; Querystring: { slug?: string } }>(
    "/api/spaces/:spaceId/media/report",
    async (req, reply) => {
      try {
        return await buildMediaReport({
          workspace,
          assets,
          queue: assetQueue,
          spaceId: req.params.spaceId,
          slug: req.query.slug,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/media/status",
    async (req) => {
      const manifest = await assets.load(req.params.spaceId);
      const pendingAssets = manifest.assets.filter((a) => a.processingStatus === "pending").length;
      const failedAssets = manifest.assets.filter((a) => a.processingStatus === "failed").length;
      return {
        queue: assetQueue.status(req.params.spaceId),
        pendingAssets,
        failedAssets,
      };
    },
  );

  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/media/ensure",
    async (req, reply) => {
      try {
        const result = await ensureSpaceAssetsReady({
          workspace,
          assets,
          queue: assetQueue,
          spaceId: req.params.spaceId,
        });
        return result;
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * Stream a raw file from within a space directory. The editor uses this
   * to render asset thumbnails (cover field, AssetPicker) — there is no
   * compile/publish step in between, so it can show the actual file the
   * author just dropped on disk.
   *
   * Safety: spaceId is validated by `workspace.spaceDir`; the request path
   * is resolved against that root and the result must still be inside it
   * (rejects `..` traversal and absolute paths). No directory listing.
   */
  app.get<{ Params: { spaceId: string; "*": string } }>(
    "/api/workspace-asset/:spaceId/*",
    async (req, reply) => {
      const { spaceId } = req.params;
      const requested = req.params["*"] ?? "";
      if (!requested) return reply.code(400).send({ error: "missing asset path" });
      let root: string;
      try {
        root = workspace.spaceDir(spaceId);
      } catch {
        return reply.code(400).send({ error: "invalid space id" });
      }
      const abs = pathResolve(root, requested);
      const rel = pathRelative(root, abs);
      if (rel === "" || rel.startsWith("..") || pathResolve(root, rel) !== abs) {
        return reply.code(403).send({ error: "path escapes space root" });
      }
      let st;
      try {
        st = await stat(abs);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!st.isFile()) return reply.code(404).send({ error: "not a file" });
      reply.header("cache-control", "private, max-age=60");
      reply.type(mimeForPath(abs));
      return reply.send(createReadStream(abs));
    },
  );

  /* Build a manifest stub so the editor can reference the upload immediately
   * while the background queue generates variants. */
  async function buildPendingEntry(args: {
    sourceAbs: string;
    sourceRelative: string;
    kind: "image" | "video";
    sizeBytes: number;
  }): Promise<AssetEntry> {
    const now = new Date().toISOString();
    if (args.kind === "image") {
      let width = 1;
      let height = 1;
      let blurhash = "L00000000000";
      try {
        const meta = await sharp(args.sourceAbs).metadata();
        width = meta.width ?? 1;
        height = meta.height ?? 1;
      } catch {
        // queue worker will fill in on process
      }
      const stub: ImageAsset = {
        kind: "image",
        sourcePath: args.sourceRelative,
        width,
        height,
        sizeBytes: args.sizeBytes,
        blurhash,
        alt: "",
        uploadedAt: now,
        variants: [],
        processingStatus: "pending",
      };
      return stub;
    }
    const probe = await probeVideoFile(args.sourceAbs);
    const stub: VideoAsset = {
      kind: "video",
      sourcePath: args.sourceRelative,
      width: probe?.width ?? 1,
      height: probe?.height ?? 1,
      sizeBytes: probe?.bytes ?? args.sizeBytes,
      durationMs: probe?.durationMs,
      caption: "",
      uploadedAt: now,
      variants: [],
      processingStatus: "pending",
    };
    return stub;
  }

  /**
   * Preview lifecycle. The single-preview-at-a-time model is intentional:
   * one running child process across the editor server, replaced by
   * subsequent `POST /api/preview` calls. The editor's "Stop preview"
   * button is the only way to release the port without restarting the
   * server itself.
   *
   * Side effects of POST:
   *   - Recompiles into `<workspace>/.blogspace/preview/<spaceId>/`
   *   - Writes a fresh zip at `<workspace>/.blogspace/preview/<spaceId>.zip`
   *     (downloadable via the editor server's `/preview/<spaceId>.zip`)
   *   - Spawns `python3 -m http.server` rooted at the dir, on a free port
   *   - Waits for the child to answer HTTP before returning
   */
  app.post<{ Body: { spaceId: string } }>("/api/preview", async (req, reply) => {
    const spaceId = req.body?.spaceId;
    if (!spaceId) return reply.code(400).send({ error: "missing spaceId" });
    try {
      const ensured = await ensureSpaceAssetsReady({
        workspace,
        assets,
        queue: assetQueue,
        spaceId,
      });
      const state = await preview.startForSpace(spaceId);
      if (ensured.warnings.length) {
        state.warnings.push(...ensured.warnings.map((w) => `assets: ${w}`));
      }
      if (ensured.repaired.length) {
        state.warnings.push(`repaired ${ensured.repaired.length} asset(s): ${ensured.repaired.join(", ")}`);
      }
      return state;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/preview", async () => {
    await preview.stop();
    return { ok: true };
  });

  app.get("/api/preview", async () => {
    return preview.state();
  });

  /**
   * One-shot export. Runs the compiler in `format: "both"` mode so the
   * output folder ends up with BOTH a static HTML directory and a zip
   * sitting alongside it (plus the chat-context PDF). Output root is
   * `<workspace>/export/`; per spec the folder containing the static
   * files takes the blog space's slug as its name.
   *
   * Returns absolute paths so the editor can show them to the author —
   * authors want to know exactly where on disk the deliverable landed.
   * Uses the same build cache as preview, so a recently-previewed space
   * exports almost instantly.
   */
  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/export",
    async (req, reply) => {
      const spaceId = req.params.spaceId;
      try {
        const ensured = await ensureSpaceAssetsReady({
          workspace,
          assets,
          queue: assetQueue,
          spaceId,
        });
        const exportRoot = join(workspace.root, "export");
        await mkdir(exportRoot, { recursive: true });
        const result = await compile({
          spaceDir: workspace.spaceDir(spaceId),
          outDir: exportRoot,
          format: "both",
        });
        const exportWarnings = [
          ...ensured.warnings.map((w) => `assets: ${w}`),
          ...result.warnings,
        ];
        if (ensured.repaired.length) {
          exportWarnings.unshift(
            `repaired ${ensured.repaired.length} asset(s): ${ensured.repaired.join(", ")}`,
          );
        }
        // Sync + bundle the chat-context PDF. Hash-dedup'd, so a no-op
        // export of unchanged content doesn't re-upload. Then drop the
        // ai-context.yaml into the export dir so the file id travels
        // with the space when it's deployed.
        const pdfAbs = result.pdfPath;
        const dirAbs = result.dirPath;
        if (pdfAbs) {
          await syncPdfContext({
            workspaceRoot: workspace.root,
            spaceId,
            pdfPath: pdfAbs,
            onLog: (level, msg) =>
              level === "warn" ? req.log.warn(msg) : req.log.info(msg),
          });
          if (dirAbs) {
            const ctx = await loadAiContext(workspace.root, spaceId);
            if (ctx.entries.length > 0) {
              await writeFile(
                join(dirAbs, "ai-context.yaml"),
                yaml.dump(ctx),
                "utf8",
              );
            }
          }
        }
        return {
          dirPath: result.dirPath,
          zipPath: result.zipPath,
          pdfPath: result.pdfPath,
          parentPath: exportRoot,
          chapters: result.chaptersWritten,
          chaptersRendered: result.chaptersRendered,
          chaptersReused: result.chaptersReused,
          imagesProcessed: result.imagesProcessed,
          pdfBytes: result.pdfBytes,
          zipBytes: result.bytesWritten,
          warnings: exportWarnings,
        };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * Reveal a path in the host OS's file browser. Single-user local app —
   * we accept absolute paths from the client because they're paths WE
   * just returned. Defensive checks ensure the path is inside the
   * workspace root so a stray client can't reveal arbitrary filesystem
   * locations.
   */
  app.post<{ Body: { path: string } }>(
    "/api/reveal",
    async (req, reply) => {
      const requested = req.body?.path;
      if (!requested) return reply.code(400).send({ error: "missing path" });
      const absRequested = pathResolve(requested);
      const absRoot = pathResolve(workspace.root);
      if (!absRequested.startsWith(absRoot + "/") && absRequested !== absRoot) {
        return reply.code(400).send({ error: "refusing to reveal a path outside the workspace" });
      }
      try {
        // macOS first — that's the documented host. xdg-open / explorer
        // fallbacks could land here later for Linux / Windows users.
        if (process.platform === "darwin") {
          await execFileP("open", [absRequested]);
        } else if (process.platform === "linux") {
          await execFileP("xdg-open", [absRequested]);
        } else if (process.platform === "win32") {
          // `start "" "<path>"` is the Windows incantation — wrap in cmd /c
          await execFileP("cmd", ["/c", "start", "", absRequested]);
        } else {
          return reply.code(501).send({ error: `reveal not supported on ${process.platform}` });
        }
        return { ok: true };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );
}

/** Minimal extension → MIME map for the workspace-asset route. Browsers
 * are forgiving with unknown types but content-sniffing breaks AVIF/HEIC
 * detection; supplying an explicit type keeps `<img>` happy. */
function mimeForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "jpg": case "jpeg": return "image/jpeg";
    case "png":              return "image/png";
    case "webp":             return "image/webp";
    case "avif":             return "image/avif";
    case "gif":              return "image/gif";
    case "heic":             return "image/heic";
    case "heif":             return "image/heif";
    case "svg":              return "image/svg+xml";
    case "mp4":              return "video/mp4";
    case "webm":             return "video/webm";
    case "mov":              return "video/quicktime";
    case "m4v":              return "video/x-m4v";
    default:                 return "application/octet-stream";
  }
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"]+/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return ch;
    }
  });
}

function renderExportRobots(): string {
  const aiAgents = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "Google-Extended",
    "PerplexityBot",
    "CCBot",
    "Applebot-Extended",
  ];
  const aiBlocks = aiAgents.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join("\n");
  return `User-agent: *\nAllow: /\n\n${aiBlocks}# LLM-friendly content manifest\n# /llms.txt\n\nSitemap: /sitemap.xml\n`;
}


function renderExportNotFound(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f4; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .page { max-width: 32rem; padding: 2rem; background: white; border-radius: 18px; box-shadow: 0 16px 40px rgba(0,0,0,.08); }
    a { color: #1b61ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="page">
    <h1>404 — Page not found</h1>
    <p>Sorry, the page you are looking for does not exist.</p>
    <p><a href="/">Return to the blog sphere home page</a></p>
  </div>
</body>
</html>`;
}

function renderExportFaviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Blog Sphere">
  <style>
    .bg { fill: #14120e; }
    .fg { fill: #fbfaf7; }
    @media (prefers-color-scheme: light) {
      .bg { fill: #fbfaf7; }
      .fg { fill: #14120e; }
    }
  </style>
  <rect class="bg" width="64" height="64" rx="14"/>
  <text class="fg" x="32" y="38" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-weight="700" text-anchor="middle" dominant-baseline="middle">B</text>
</svg>`;
}

function exportPageUrl(series: Series, spaceId: string, path: string): string {
  const base = series.site?.baseUrl?.replace(/\/$/, "") ?? "";
  const bp = `/${spaceId}`.replace(/\/$/, "");
  return base ? `${base}${bp}${path}` : `${bp}${path}`;
}

function renderExportSitemap(spaces: SpaceDetail[]): string {
  const entries: string[] = [];
  for (const space of spaces) {
    const rootUrl = exportPageUrl(space.series, space.id, "/");
    const lastmod = space.series.updatedAt ?? space.series.publishedAt;
    entries.push(` <url><loc>${escapeHtml(rootUrl)}</loc>${lastmod ? `<lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}</url>`);
    entries.push(` <url><loc>${escapeHtml(exportPageUrl(space.series, space.id, "/llms.txt"))}</loc></url>`);
    entries.push(` <url><loc>${escapeHtml(exportPageUrl(space.series, space.id, "/llms-full.txt"))}</loc></url>`);
    for (const chapter of space.chapters) {
      const chapterUrl = exportPageUrl(space.series, space.id, `/chapters/${chapter.slug}.html`);
      const chapterLastmod = chapter.publishedAt;
      entries.push(` <url><loc>${escapeHtml(chapterUrl)}</loc>${chapterLastmod ? `<lastmod>${escapeHtml(chapterLastmod)}</lastmod>` : ""}</url>`);
    }
  }
  const baseUrl = spaces.find((space) => space.series.site?.baseUrl)?.series.site?.baseUrl?.replace(/\/$/, "") ?? "";
  const rootLlmsUrl = baseUrl ? `${baseUrl}/llms.txt` : "/llms.txt";
  entries.push(` <url><loc>${escapeHtml(rootLlmsUrl)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`;
}

function renderExportRss(spaces: SpaceDetail[]): string {
  const items = spaces.flatMap((space) =>
    space.chapters.map((chapter) => {
      const url = exportPageUrl(space.series, space.id, `/chapters/${chapter.slug}.html`);
      const guid = url;
      const date = chapter.publishedAt ? new Date(chapter.publishedAt).toUTCString() : "";
      const author = typeof space.series.author === "string" ? space.series.author : space.series.author.name;
      return {
        title: `${chapter.title} — ${space.series.title}`,
        url,
        guid,
        author,
        description: chapter.summary,
        date,
      };
    }),
  );
  items.sort((a, b) => {
    if (a.date === b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
  const rootUrl = spaces.find((space) => space.series.site?.baseUrl)?.series.site?.baseUrl?.replace(/\/$/, "") ?? "/";
  const selfLink = rootUrl === "/" ? "/rss.xml" : `${rootUrl}/rss.xml`;
  const channelItems = items
    .map((item) => ` <item>
<title>${escapeHtml(item.title)}</title>
<link>${escapeHtml(item.url)}</link>
<guid isPermaLink="false">${escapeHtml(item.guid)}</guid>
<dc:creator>${escapeHtml(item.author)}</dc:creator>
<description>${escapeHtml(item.description)}</description>
${item.date ? `<pubDate>${escapeHtml(item.date)}</pubDate>` : ""}
</item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n<title>Blog Sphere</title>\n<link>${escapeHtml(rootUrl)}</link>\n<atom:link href="${escapeHtml(selfLink)}" rel="self" type="application/rss+xml"/>\n<description>A unified feed for the Blog Sphere.</description>\n${channelItems}\n</channel>\n</rss>`;
}

function renderExportLlmsIndex(spaces: SpaceDetail[]): string {
  const sections = spaces.map((space) => {
    const title = space.series.title;
    const description = space.series.description || "";
    const basePath = `/${space.id}`;
    return `## ${escapeHtml(title)}\n${description ? `${escapeHtml(description)}\n` : ""}- llms: ${escapeHtml(`${basePath}/llms.txt`)}\n- llms-full: ${escapeHtml(`${basePath}/llms-full.txt`)}\n`;
  });
  return `# Blog Sphere LLM manifests\n\n${sections.join("\n")}`;
}
