#!/usr/bin/env node
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { Workspace } from "./fs-ops.js";
import { Store } from "./store.js";
import { registerApi } from "./api.js";
import { registerWebsocket } from "./ws.js";
import { PreviewManager, previewServeRoot } from "./preview.js";

/**
 * Tiny inline .env loader — no extra dep. Walks up from cwd looking for
 * a `.env` file and merges any KEY=VALUE lines into process.env without
 * overwriting values that are already set (so an exported shell var
 * still wins over the file, matching dotenv's defaults).
 *
 * Format: one entry per line, `#` comments, blank lines ignored, no
 * shell expansion, no nested quotes. Matching what the committed
 * `.env.example` produces — we don't need anything more.
 */
async function loadEnvFile(): Promise<void> {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eq = trimmed.indexOf("=");
          if (eq < 0) continue;
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          // Strip a single matching pair of surrounding quotes.
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          // Set when the file has a value AND the existing env is unset
          // OR empty. Some shells (notably Claude Desktop) export
          // `ANTHROPIC_API_KEY=` with no value, which would otherwise
          // shadow the .env's real key under a strict no-override rule.
          if (val && !process.env[key]) {
            process.env[key] = val;
          }
        }
      } catch {
        // Best-effort — never block server startup on a broken .env.
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function main() {
  await loadEnvFile();
  const workspaceDir = resolve(
    process.env.BLOGSPACE_WORKSPACE ?? process.argv[2] ?? "./workspace",
  );
  const port = Number(process.env.PORT ?? 4317);
  // The editor server's own origin — used by PreviewManager to point
  // the preview's reader chat panel at this server's viewer-chat route.
  const editorServerOrigin = `http://127.0.0.1:${port}`;

  const workspace = new Workspace(workspaceDir);
  const store = new Store(workspace);
  const preview = new PreviewManager(workspace, editorServerOrigin);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 32 * 1024 * 1024, // 32MB JSON cap (multipart has its own limit)
  });

  await app.register(fastifyCors, { origin: true, credentials: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 200 * 1024 * 1024, // 200MB — videos can be big in v1 (pass-through)
      files: 32,
    },
  });

  // Serve compiled preview output at /preview/<spaceId>/...
  const previewRoot = previewServeRoot(workspace);
  await mkdir(previewRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: previewRoot,
    prefix: "/preview/",
    decorateReply: false,
    setHeaders(res: { setHeader: (k: string, v: string) => void }) {
      // Previews are throwaway — never cache them.
      res.setHeader("cache-control", "no-store");
    },
  });

  registerApi(app, workspace, store, preview);
  registerWebsocket(app, store);

  const shutdown = async () => {
    app.log.info("flushing pending writes…");
    // Kill any running preview child so it doesn't orphan after we exit.
    await preview.stop();
    await store.flushAll();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`workspace = ${workspaceDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
