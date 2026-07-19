import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AssetEntry, ImageVariant } from "@blogspace/schemas";
import type { Workspace } from "../fs-ops.js";
import { AssetStore } from "../asset-store.js";
import { computeStatus, getProviderForSpace, loadSpaceConfig } from "./index.js";
import { PROMPTS, SYSTEM_PROMPT_FRONTMATTER, type ChapterContext } from "./prompts.js";
import {
  RedactStream,
  buildRedactRegex,
  redactAiMetadata,
  redactStringArray,
  redactText,
} from "./redact.js";
import {
  appendChatMessages,
  clearChatHistory,
  findContextEntry,
  hashBytes,
  loadAiContext,
  loadChatHistory,
  setAiContextEntry,
} from "./chat-store.js";

interface SpellGrammarSuggestion {
  original: string;
  replacement: string;
  reason: string;
}

interface FactCheckFinding {
  claim: string;
  concern: string;
  suggestedCorrection: string;
  confidence: "likely" | "verify";
}

export function registerAiRoutes(
  app: FastifyInstance,
  workspace: Workspace,
  assets: AssetStore,
): void {
  /**
   * Boot-time status. Editor calls this once on mount to know whether to
   * render AI affordances at all. The response includes per-feature flags
   * from per-space config when a spaceId query param is supplied.
   */
  app.get<{ Querystring: { spaceId?: string } }>("/api/ai/status", async (req) => {
    const status = computeStatus();
    if (!req.query.spaceId || !status.enabled) {
      return { ...status, features: defaultFeatures() };
    }
    const cfg = await loadSpaceConfig(workspace.root, req.query.spaceId);
    return {
      ...status,
      // The configured provider wins over env when both keys are set —
      // env governs availability, config governs preference.
      activeProvider: cfg.llm.active.provider,
      activeModel: cfg.llm.active.model,
      features: cfg.ai?.features ?? defaultFeatures(),
    };
  });

  /** Generate alt text from an existing manifest image. */
  app.post<{
    Params: { spaceId: string };
    Body: { ref: string };
  }>("/api/spaces/:spaceId/ai/alt-text", async (req, reply) => {
    const provider = await getProviderForSpace({
      workspaceRoot: workspace.root,
      spaceId: req.params.spaceId,
    });
    if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
    const image = await loadImageBuffer(workspace.root, req.params.spaceId, req.body?.ref ?? "", assets);
    if (!image) return reply.code(404).send({ error: "image not found in manifest" });
    const alt = (await provider.vision({
      prompt: PROMPTS.altText(image.filename),
      image: { mime: image.mime, data: image.data },
      maxTokens: 200,
    })).trim().replace(/^["']|["']$/g, "");
    return { alt };
  });

  /** Generate a caption from an existing manifest image. */
  app.post<{
    Params: { spaceId: string };
    Body: { ref: string; alt?: string };
  }>("/api/spaces/:spaceId/ai/caption", async (req, reply) => {
    const provider = await getProviderForSpace({
      workspaceRoot: workspace.root,
      spaceId: req.params.spaceId,
    });
    if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
    const image = await loadImageBuffer(workspace.root, req.params.spaceId, req.body?.ref ?? "", assets);
    if (!image) return reply.code(404).send({ error: "image not found in manifest" });
    const caption = (await provider.vision({
      prompt: PROMPTS.caption(req.body?.alt ?? ""),
      image: { mime: image.mime, data: image.data },
      maxTokens: 240,
    })).trim().replace(/^["']|["']$/g, "");
    return { caption };
  });

  /**
   * Generate text for one or more frontmatter fields. The route is
   * unified across SEO/summary/AI metadata/tags because all of them take
   * chapter content and return a small JSON or string — branching keeps
   * the editor wiring tidy (one mutation hook, one server endpoint).
   */
  app.post<{
    Params: { spaceId: string; slug: string };
    Body: { field: "seoTitle" | "seoDescription" | "summary" | "aiMetadata" | "tags" };
  }>("/api/spaces/:spaceId/ai/generate/:slug", async (req, reply) => {
    const provider = await getProviderForSpace({
      workspaceRoot: workspace.root,
      spaceId: req.params.spaceId,
    });
    if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
    const detail = await workspace.readChapter(req.params.spaceId, req.params.slug);
    // Assemble the chapter context once — every generator shares the same
    // grounding (series + chapter body + existing tags). The system prompt
    // captures voice / editorial rules; the user prompt carries per-field
    // formatting constraints.
    const series = await workspace.readSeries(req.params.spaceId).catch(() => null);
    const ctx: ChapterContext = {
      seriesTitle: series?.title ?? req.params.spaceId,
      seriesDescription: series?.description ?? "",
      authorName:
        typeof series?.author === "string"
          ? series.author
          : series?.author?.name ?? "the author",
      chapterTitle: detail.frontmatter.title,
      chapterSummary: detail.frontmatter.summary,
      body: detail.body,
      existingTags: detail.frontmatter.tags,
    };
    const field = req.body?.field;
    // Privacy backstop: scrub protected names from every generated value
    // even if the model ignored the system-prompt instruction.
    const { regex, replacement } = await loadPrivacy(workspace.root, req.params.spaceId);
    const gen = (prompt: string, maxTokens: number) =>
      provider.generateText(prompt, { system: SYSTEM_PROMPT_FRONTMATTER, maxTokens });
    try {
      switch (field) {
        case "seoTitle":
          return { value: clampText(redactText(stripQuotes(await gen(PROMPTS.seoTitle(ctx), 200)), regex, replacement), LIMITS.seoTitle) };
        case "seoDescription":
          return { value: clampText(redactText(stripQuotes(await gen(PROMPTS.seoDescription(ctx), 240)), regex, replacement), LIMITS.seoDescription) };
        case "summary":
          return { value: clampText(redactText(stripQuotes(await gen(PROMPTS.chapterSummary(ctx), 220)), regex, replacement), LIMITS.chapterSummary) };
        case "aiMetadata": {
          const raw = await gen(PROMPTS.aiMetadata(ctx), 700);
          return { value: clampAiMetadata(redactAiMetadata(parseJsonLoose(raw), regex, replacement)) };
        }
        case "tags": {
          const raw = await gen(PROMPTS.tags(ctx), 300);
          return { value: redactStringArray(parseJsonLoose(raw), regex).slice(0, LIMITS.tags) };
        }
        default:
          return reply.code(400).send({ error: `unknown field: ${field}` });
      }
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /** Spell + grammar + fact-check pass. Text fixes are accept/reject hunks;
   *  fact-check findings are rewrite notes and are never auto-applied. */
  app.post<{ Params: { spaceId: string; slug: string } }>(
    "/api/spaces/:spaceId/ai/spell-grammar/:slug",
    async (req, reply) => {
      const provider = await getProviderForSpace({
        workspaceRoot: workspace.root,
        spaceId: req.params.spaceId,
      });
      if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
      const detail = await workspace.readChapter(req.params.spaceId, req.params.slug);
      const series = await workspace.readSeries(req.params.spaceId).catch(() => null);
      const ctx: ChapterContext = {
        seriesTitle: series?.title ?? req.params.spaceId,
        seriesDescription: series?.description ?? "",
        authorName:
          typeof series?.author === "string"
            ? series.author
            : series?.author?.name ?? "the author",
        chapterTitle: detail.frontmatter.title,
        chapterSummary: detail.frontmatter.summary,
        body: detail.body,
        existingTags: detail.frontmatter.tags,
      };
      const raw = await provider.generateText(PROMPTS.spellGrammar(ctx), {
        system: SYSTEM_PROMPT_FRONTMATTER,
        maxTokens: 3000,
      });
      const parsed = parseJsonLoose(raw);
      const suggestionsSource = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.suggestions)
          ? parsed.suggestions
          : [];
      const factChecksSource = isRecord(parsed) && Array.isArray(parsed.factChecks)
        ? parsed.factChecks
        : [];
      return {
        suggestions: suggestionsSource.filter(isSpellGrammarSuggestion),
        factChecks: factChecksSource.filter(isFactCheckFinding),
      };
    },
  );

  /**
   * Current chat context state for a space — which provider entry the
   * server will actually attach on the next chat call, plus the
   * available PDF the Sync button would re-upload. The editor shows
   * this in the chat panel header so the author can confirm grounding
   * before sending a message (a common point of confusion when a
   * grounded chat starts answering as if ungrounded).
   */
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/ai/context-status",
    async (req) => {
      const provider = await getProviderForSpace({
        workspaceRoot: workspace.root,
        spaceId: req.params.spaceId,
      });
      const context = await loadAiContext(workspace.root, req.params.spaceId);
      const entry = provider ? findContextEntry(context, provider.name) : undefined;
      const pdfPath = await locateChatPdf(workspace.root, req.params.spaceId);
      return {
        activeProvider: provider?.name ?? null,
        activeModel: provider?.model ?? null,
        attachment: entry
          ? {
              fileId: entry.fileId,
              fileSize: entry.fileSize,
              pdfHash: entry.pdfHash,
              uploadedAt: entry.uploadedAt,
            }
          : null,
        pdfAvailable: !!pdfPath,
      };
    },
  );

  /**
   * Chat history APIs. The history lives on disk so the conversation
   * survives editor restarts — single conversation per space.
   */
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/ai/chat/history",
    async (req) => loadChatHistory(workspace.root, req.params.spaceId),
  );
  app.delete<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/ai/chat/history",
    async (req) => {
      await clearChatHistory(workspace.root, req.params.spaceId);
      return { ok: true };
    },
  );

  /**
   * Streaming chat. SSE over an open response — each `data:` line is a
   * JSON-encoded token chunk. We persist the full assistant message at
   * end-of-stream so partial replies don't pollute history on cancel.
   *
   * The chat-context PDF (if uploaded) is attached on the first user
   * turn via the provider abstraction. If no PDF has been uploaded for
   * the active provider yet, the chat still works but loses the rich
   * cross-chapter grounding.
   */
  app.post<{ Params: { spaceId: string }; Body: { message: string } }>(
    "/api/spaces/:spaceId/ai/chat",
    async (req, reply) => {
      const provider = await getProviderForSpace({
        workspaceRoot: workspace.root,
        spaceId: req.params.spaceId,
      });
      if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
      const userMsg = (req.body?.message ?? "").trim();
      if (!userMsg) return reply.code(400).send({ error: "empty message" });
      // Persist the user turn before we start streaming so a network
      // failure mid-stream doesn't lose it.
      await appendChatMessages(workspace.root, req.params.spaceId, [
        { role: "user", content: userMsg, ts: new Date().toISOString() },
      ]);
      const history = await loadChatHistory(workspace.root, req.params.spaceId);
      const series = await workspace.readSeries(req.params.spaceId).catch(() => null);
      const seriesTitle = series?.title ?? req.params.spaceId;
      const authorName =
        typeof series?.author === "string"
          ? series.author
          : series?.author?.name ?? "the author";
      const context = await loadAiContext(workspace.root, req.params.spaceId);
      const fileId = findContextEntry(context, provider.name)?.fileId;
      const { regex, replacement } = await loadPrivacy(workspace.root, req.params.spaceId);
      const redactor = new RedactStream(regex, replacement);

      writeSseHeaders(req, reply);

      // `assembled` accumulates the REDACTED output so persisted history
      // can never contain a protected name either.
      let assembled = "";
      const emit = (text: string) => {
        if (!text) return;
        assembled += text;
        reply.raw.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
      };
      try {
        for await (const chunk of provider.streamChat({
          messages: history.messages
            .filter((m): m is typeof m & { role: "user" | "assistant" } => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content })),
          system: PROMPTS.chatSystem(seriesTitle, authorName),
          ...(fileId ? { fileId } : {}),
          maxTokens: 4096,
        })) {
          emit(redactor.push(chunk));
        }
        emit(redactor.flush());
        reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      } catch (err) {
        assembled += redactor.flush();
        reply.raw.write(
          `data: ${JSON.stringify({ error: (err as Error).message })}\n\n`,
        );
      } finally {
        if (assembled) {
          await appendChatMessages(workspace.root, req.params.spaceId, [
            { role: "assistant", content: assembled, ts: new Date().toISOString() },
          ]);
        }
        reply.raw.end();
      }
    },
  );

  /**
   * Stateless chat for the published viewer. Each reader has their own
   * conversation, so the server does NOT persist history here — the
   * client (viewer.js) sends the full transcript on every turn and
   * keeps it in their own browser storage. This endpoint is the
   * "chat-proxy URL" the viewer's chat-config.json points at when the
   * editor server itself hosts the proxy (i.e. in preview/dev).
   *
   * For deployed/published spaces, the author can swap this URL for a
   * lightweight edge function with the same contract.
   */
  app.post<{
    Params: { spaceId: string };
    Body: { messages: { role: "user" | "assistant"; content: string }[] };
  }>("/api/spaces/:spaceId/ai/viewer-chat", async (req, reply) => {
    const provider = await getProviderForSpace({
      workspaceRoot: workspace.root,
      spaceId: req.params.spaceId,
    });
    if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
    const incoming = (req.body?.messages ?? []).filter(
      (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
    if (incoming.length === 0) return reply.code(400).send({ error: "empty messages" });

    const series = await workspace.readSeries(req.params.spaceId).catch(() => null);
    const seriesTitle = series?.title ?? req.params.spaceId;
    const authorName =
      typeof series?.author === "string"
        ? series.author
        : series?.author?.name ?? "the author";
    const context = await loadAiContext(workspace.root, req.params.spaceId);
    const fileId = findContextEntry(context, provider.name)?.fileId;
    const { regex, replacement } = await loadPrivacy(workspace.root, req.params.spaceId);
    const redactor = new RedactStream(regex, replacement);

    writeSseHeaders(req, reply);

    const emit = (text: string) => {
      if (text) reply.raw.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
    };
    try {
      for await (const chunk of provider.streamChat({
        messages: incoming,
        system: PROMPTS.chatSystem(seriesTitle, authorName),
        ...(fileId ? { fileId } : {}),
        maxTokens: 4096,
      })) {
        emit(redactor.push(chunk));
      }
      emit(redactor.flush());
      reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      reply.raw.write(
        `data: ${JSON.stringify({ error: (err as Error).message })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  });

  /**
   * Force-refresh of the chat-context PDF. The PDF is uploaded
   * automatically as part of compile (see pipeline integration), but
   * this endpoint lets the editor trigger an upload on demand — useful
   * after the author switches providers, or to recover from a failed
   * upload during a previous compile.
   */
  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/ai/sync-context",
    async (req, reply) => {
      const provider = await getProviderForSpace({
        workspaceRoot: workspace.root,
        spaceId: req.params.spaceId,
      });
      if (!provider) return reply.code(503).send({ error: "no AI provider configured" });
      const pdfPath = await locateChatPdf(workspace.root, req.params.spaceId);
      if (!pdfPath) {
        return reply
          .code(404)
          .send({ error: "no PDF found — run Preview or Export to generate one" });
      }
      const buffer = await readFile(pdfPath);
      const hash = hashBytes(buffer);
      const ctx = await loadAiContext(workspace.root, req.params.spaceId);
      const existing = findContextEntry(ctx, provider.name);
      if (existing && existing.pdfHash === hash) {
        return { ok: true, reused: true, fileId: existing.fileId };
      }
      const filename = `${req.params.spaceId}-${hash.slice(0, 10)}.pdf`;
      const { fileId } = await provider.uploadFile({
        buffer,
        filename,
        mime: "application/pdf",
      });
      await setAiContextEntry(workspace.root, req.params.spaceId, {
        provider: provider.name,
        pdfHash: hash,
        fileId,
        fileSize: buffer.length,
        uploadedAt: new Date().toISOString(),
        filename,
      });
      return { ok: true, reused: false, fileId };
    },
  );
}

/**
 * Resolve the per-space privacy guardrail: a compiled name matcher plus
 * the placeholder used in free-text output. Returns a no-op matcher
 * (null regex) when the space has no redactNames configured.
 */
async function loadPrivacy(
  workspaceRoot: string,
  spaceId: string,
): Promise<{ regex: RegExp | null; replacement: string }> {
  const cfg = await loadSpaceConfig(workspaceRoot, spaceId).catch(() => null);
  const names = cfg?.ai?.privacy?.redactNames ?? [];
  const replacement = cfg?.ai?.privacy?.redactReplacement ?? "our child";
  return { regex: buildRedactRegex(names), replacement };
}

function defaultFeatures() {
  return {
    altText: true,
    caption: true,
    seoTitle: true,
    seoDescription: true,
    chapterSummary: true,
    aiMetadata: true,
    tagSuggestions: true,
    spellGrammar: true,
    chat: true,
  };
}

/**
 * Load a manifest image's smallest reasonable variant as a buffer, paired
 * with mime type and a filename hint for prompts. Vision endpoints accept
 * jpeg/png/webp; we always pick a jpeg variant for compatibility.
 */
async function loadImageBuffer(
  workspaceRoot: string,
  spaceId: string,
  ref: string,
  assets: AssetStore,
): Promise<{ data: Buffer; mime: string; filename: string } | null> {
  const normalized = ref.replace(/^\.\//, "").replace(/^\//, "");
  if (!normalized) return null;
  const manifest = await assets.load(spaceId);
  const entry: AssetEntry | undefined = manifest.assets.find(
    (a) => a.sourcePath === normalized,
  );
  if (!entry || entry.kind !== "image") return null;
  // Pick the smallest jpeg variant that's at least 640px wide — small
  // enough to keep the upload cheap, large enough for legible vision
  // recognition. Fall back to the smallest jpeg, then to the source.
  const jpegs = entry.variants
    .filter((v: ImageVariant) => v.format === "jpeg")
    .sort((a, b) => a.width - b.width);
  const pick: ImageVariant | { path: string } | undefined =
    jpegs.find((v) => v.width >= 640) ?? jpegs[0];
  const relPath = pick?.path ?? entry.sourcePath;
  const abs = join(workspaceRoot, spaceId, relPath);
  const data = await readFile(abs);
  const filename = relPath.split("/").pop() ?? "image";
  return { data, mime: "image/jpeg", filename };
}

/**
 * Locate `book.pdf` for a space across known output folders. Preview is
 * checked first since it's almost always the freshest copy during
 * authoring; export is the fallback so authors who only run Export get
 * a working Sync PDF too. Returns the newest path or null.
 */
async function locateChatPdf(workspaceRoot: string, spaceId: string): Promise<string | null> {
  const candidates = [
    join(workspaceRoot, ".blogspace", "preview", spaceId, "book.pdf"),
    join(workspaceRoot, "export", spaceId, "book.pdf"),
  ];
  let pick: { path: string; mtime: number } | null = null;
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (!pick || st.mtimeMs > pick.mtime) pick = { path: p, mtime: st.mtimeMs };
    } catch {
      /* missing — keep looking */
    }
  }
  return pick?.path ?? null;
}

function parseJsonLoose(raw: string): unknown {
  // Models sometimes wrap JSON in fences or prefix it. Pull the
  // first balanced JSON object/array.
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to scan for first { or [
  }
  const firstCurly = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const start =
    firstBracket >= 0 && (firstCurly < 0 || firstBracket < firstCurly)
      ? firstBracket
      : firstCurly;
  if (start < 0) return null;
  const opener = trimmed[start]!;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSpellGrammarSuggestion(value: unknown): value is SpellGrammarSuggestion {
  return (
    isRecord(value) &&
    typeof value.original === "string" &&
    typeof value.replacement === "string" &&
    typeof value.reason === "string"
  );
}

function isFactCheckFinding(value: unknown): value is FactCheckFinding {
  return (
    isRecord(value) &&
    typeof value.claim === "string" &&
    typeof value.concern === "string" &&
    typeof value.suggestedCorrection === "string" &&
    (value.confidence === "likely" || value.confidence === "verify")
  );
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^["'""]+|["'""]+$/g, "");
}

/**
 * Hard caps mirrored from @blogspace/schemas (`seoSchema`,
 * `aiMetadataSchema`, `chapterFrontmatterSchema`). The prompts ASK the
 * model to stay well under these, but models overshoot — and the store
 * validates the whole patched frontmatter on persist, so a single
 * over-long generated field makes the ENTIRE save fail `validation-failed`
 * (which the editor would otherwise swallow silently). Clamp generated
 * output to these bounds so it's always persistable. Keep in sync with
 * common.ts / chapter.ts if a schema max changes.
 */
const LIMITS = {
  seoTitle: 70,
  seoDescription: 200,
  chapterSummary: 280,
  aiSummary: 600,
  aiTopics: 4,
  aiEntities: 30,
  tags: 8, // below the schema's max of 20 — a tidy suggestion count
} as const;

/**
 * Truncate to `maxChars`, preferring a word boundary so the result reads
 * cleanly. No ellipsis — these are plain metadata fields where a clean cut
 * beats a visible "…". Only fires when the model overshoots its prompt.
 */
function clampText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Clamp generated AI metadata to the schema's per-field bounds. */
function clampAiMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as { summary?: unknown; topics?: unknown; entities?: unknown };
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (typeof v.summary === "string") out.summary = clampText(v.summary, LIMITS.aiSummary);
  if (Array.isArray(v.topics)) {
    out.topics = v.topics.filter((t): t is string => typeof t === "string").slice(0, LIMITS.aiTopics);
  }
  if (Array.isArray(v.entities)) {
    out.entities = v.entities.filter((e): e is string => typeof e === "string").slice(0, LIMITS.aiEntities);
  }
  return out;
}

/**
 * SSE endpoints flush headers via reply.raw, which bypasses fastify's
 * normal reply pipeline — meaning fastify-cors's onSend hook never fires
 * and the Access-Control-Allow-Origin header never lands on the
 * response. Streaming responses to a cross-origin viewer (preview is
 * served from a different port than the editor server) then get
 * rejected by the browser's CORS check.
 *
 * Mirror the request's Origin manually here so the SSE response carries
 * the same ACAO that fastify-cors would have set. Vary: Origin keeps
 * shared caches honest.
 */
function writeSseHeaders(req: FastifyRequest, reply: FastifyReply): void {
  const origin = req.headers.origin;
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");
  if (origin) {
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-allow-credentials", "true");
    reply.raw.setHeader("vary", "origin");
  }
  reply.raw.flushHeaders();
}

