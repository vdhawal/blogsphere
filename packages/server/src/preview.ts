import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { compile, zipDirectory } from "@blogspace/compiler";
import type { Workspace } from "./fs-ops.js";
import { syncPdfContext } from "./ai/index.js";

const execFileP = promisify(execFile);

/**
 * Manages a single child-process HTTP server that hosts the most recent
 * compile output for previewing. The editor exposes start/stop endpoints
 * over this — we deliberately use a child-process model rather than the
 * always-on Fastify `@fastify/static` route so the author can release the
 * port and processes when they're done reviewing.
 *
 * Only one preview is active at a time across the whole server. Starting
 * a preview for a different space transparently stops the previous one.
 *
 * The hosted directory is `<workspace>/.blogspace/preview/<spaceId>/`.
 * The zip download sits alongside at `<spaceId>.zip` so the editor server's
 * existing `@fastify/static` mount at `/preview/` can serve it without any
 * additional plumbing.
 */
export interface PreviewState {
  spaceId: string;
  port: number;
  startedAt: string;
  /** URL the editor opens in a new tab. Always absolute, with the port. */
  previewUrl: string;
  /** Path the editor server hosts via @fastify/static for downloading. */
  zipDownloadUrl: string;
  /** Single-doc PDF intended as chat-with-blog context (uploaded to the
   *  LLM Files API in a future step). Lives inside the preview dir and
   *  is reachable via @fastify/static for direct download or upload. */
  pdfDownloadUrl: string;
  /** Compile result summary, surfaced in the UI. */
  chapters: number;
  images: number;
  pdfBytes: number;
  warnings: string[];
}

interface ActiveProcess extends PreviewState {
  child: ChildProcess;
}

const STARTUP_TIMEOUT_MS = 4000;
const SHUTDOWN_GRACE_MS = 1500;

export class PreviewManager {
  private active: ActiveProcess | null = null;

  /**
   * `editorServerOrigin` is the http://host:port of the editor server
   * itself, used to point the preview's reader chat panel at the
   * already-running viewer-chat proxy. This avoids requiring the author
   * to set up an external chatProxyUrl just to test chat locally —
   * production exports still pick up the value from `.blogspace/config.yaml`.
   */
  constructor(
    private workspace: Workspace,
    private editorServerOrigin: string,
  ) {}

  state(): PreviewState | null {
    if (!this.active) return null;
    // Strip the child handle for the wire — clients only need the URL.
    const { child: _, ...state } = this.active;
    return state;
  }

  async startForSpace(spaceId: string): Promise<PreviewState> {
    // Always stop the previous preview first, even if it's for the same
    // space — that way a re-click re-compiles and clears any stale port.
    await this.stop();

    const previewRoot = join(this.workspace.root, ".blogspace", "preview");
    await mkdir(previewRoot, { recursive: true });
    const dirPath = join(previewRoot, spaceId);

    // 1. Compile into the directory. Override chatProxyUrl so the
    //    preview's reader chat panel POSTs back to this editor server's
    //    viewer-chat endpoint (CORS is permissive for cross-port).
    const chatProxyUrlOverride = `${this.editorServerOrigin}/api/spaces/${encodeURIComponent(
      spaceId,
    )}/ai/viewer-chat`;
    const result = await compile({
      spaceDir: this.workspace.spaceDir(spaceId),
      outDir: dirPath,
      format: "dir",
      chatProxyUrlOverride,
    });

    // 2. Zip the freshly-compiled directory alongside, named <spaceId>.zip
    //    so it sits next to the served dir and is itself reachable via the
    //    editor's /preview/ static mount.
    const zipPath = join(previewRoot, `${spaceId}.zip`);
    await zipDirectory(dirPath, zipPath);

    // 3. Find a free local port without binding it permanently.
    const port = await findFreePort();

    // 4. Spawn the static server.
    const cmd = await resolvePythonCommand();
    if (!cmd) {
      throw new Error(
        "Could not find `python3` or `python` on PATH. Install Python 3 (https://www.python.org/downloads/) or the preview won't be able to host its own server.",
      );
    }
    const child = spawn(cmd, ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: dirPath,
      stdio: ["ignore", "pipe", "pipe"],
      // Detached: false so SIGTERM on the parent propagates and orphans
      // don't linger across editor-server restarts.
      detached: false,
    });

    // 5. Wait until the port answers HTTP — otherwise the new tab races
    //    the child startup and shows ERR_CONNECTION_REFUSED.
    try {
      await waitForServerReady(port);
    } catch (err) {
      child.kill("SIGKILL");
      throw err;
    }

    // Fire-and-forget PDF sync. If AI is configured and the PDF content
    // has changed since the last compile, re-upload it to the provider's
    // Files API so the chat panel's grounding stays fresh. Errors here
    // never block preview startup.
    void syncPdfContext({
      workspaceRoot: this.workspace.root,
      spaceId,
      pdfPath: join(dirPath, "book.pdf"),
      onLog: (level, msg) => {
        if (level === "warn") console.warn(`[ai] ${msg}`);
        else console.log(`[ai] ${msg}`);
      },
    });

    const previewUrl = `http://127.0.0.1:${port}/index.html`;
    const zipDownloadUrl = `/preview/${spaceId}.zip`;
    // book.pdf is written inside the compiled dir; @fastify/static at
    // /preview/ serves the whole `.blogspace/preview/` root.
    const pdfDownloadUrl = `/preview/${spaceId}/book.pdf`;
    const next: ActiveProcess = {
      spaceId,
      port,
      child,
      startedAt: new Date().toISOString(),
      previewUrl,
      zipDownloadUrl,
      pdfDownloadUrl,
      chapters: result.chaptersWritten,
      images: result.imagesProcessed,
      pdfBytes: result.pdfBytes,
      warnings: result.warnings,
    };
    this.active = next;

    // If the child dies on its own (e.g. user kills it externally), drop
    // our reference so the editor's status flips back to "stopped".
    child.on("exit", () => {
      if (this.active === next) this.active = null;
    });

    return this.state()!;
  }

  /** Tear down the active preview, if any. Idempotent. */
  async stop(): Promise<void> {
    const cur = this.active;
    if (!cur) return;
    this.active = null;
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      cur.child.once("exit", settle);
      cur.child.kill("SIGTERM");
      // Some shells / signal-handling quirks leave http.server hanging on
      // SIGTERM. Escalate to SIGKILL after a grace period.
      const killTimer = setTimeout(() => {
        if (!cur.child.killed) cur.child.kill("SIGKILL");
        settle();
      }, SHUTDOWN_GRACE_MS);
    });
  }
}

// ----- helpers -----

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("failed to allocate a port")));
      }
    });
  });
}

async function resolvePythonCommand(): Promise<string | null> {
  for (const cmd of ["python3", "python"]) {
    try {
      await execFileP(cmd, ["--version"]);
      return cmd;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function waitForServerReady(port: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`preview server didn't become ready on port ${port}`);
}

/** Used by the Fastify @fastify/static mount — same directory as before. */
export function previewServeRoot(workspace: Workspace): string {
  return join(workspace.root, ".blogspace", "preview");
}
