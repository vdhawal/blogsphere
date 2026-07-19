import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  workspaceConfigSchema,
  type LlmProvider,
  type WorkspaceConfig,
} from "@blogspace/schemas";
import { makeAnthropic } from "./anthropic.js";
import { makeOpenAI } from "./openai.js";
import { AiUnavailableError, type AiProvider, type AiStatus } from "./types.js";

export { AiUnavailableError, type AiProvider, type AiStatus };
export {
  loadAiContext,
  loadChatHistory,
  setAiContextEntry,
  findContextEntry,
  hashBytes,
} from "./chat-store.js";

/**
 * Hash-compare a PDF against the per-space ai-context.yaml; if the bytes
 * have changed (or there's no entry yet for the active provider) upload
 * to the provider's Files API and persist the new file id. No-op when no
 * provider is available — chat will still work for the rest of the
 * conversation without rich PDF grounding.
 *
 * Errors are swallowed and logged via `onLog` so this can be invoked
 * fire-and-forget after compile without blocking preview/export.
 */
export async function syncPdfContext(args: {
  workspaceRoot: string;
  spaceId: string;
  pdfPath: string;
  onLog?: (level: "info" | "warn", msg: string) => void;
}): Promise<{ uploaded: boolean; reason?: string; fileId?: string }> {
  const { workspaceRoot, spaceId, pdfPath, onLog } = args;
  try {
    const provider = await getProviderForSpace({ workspaceRoot, spaceId });
    if (!provider) return { uploaded: false, reason: "no provider" };
    const { readFile } = await import("node:fs/promises");
    const { hashBytes, loadAiContext, findContextEntry, setAiContextEntry } = await import(
      "./chat-store.js"
    );
    let buffer: Buffer;
    try {
      buffer = await readFile(pdfPath);
    } catch {
      return { uploaded: false, reason: "pdf not found" };
    }
    const hash = hashBytes(buffer);
    const ctx = await loadAiContext(workspaceRoot, spaceId);
    const existing = findContextEntry(ctx, provider.name);
    if (existing && existing.pdfHash === hash) {
      onLog?.("info", `PDF unchanged (${provider.name}) — reusing file id`);
      return { uploaded: false, reason: "hash match", fileId: existing.fileId };
    }
    const filename = `${spaceId}-${hash.slice(0, 10)}.pdf`;
    const { fileId } = await provider.uploadFile({
      buffer,
      filename,
      mime: "application/pdf",
    });
    await setAiContextEntry(workspaceRoot, spaceId, {
      provider: provider.name,
      pdfHash: hash,
      fileId,
      fileSize: buffer.length,
      uploadedAt: new Date().toISOString(),
      filename,
    });
    onLog?.("info", `PDF uploaded to ${provider.name} → ${fileId}`);
    return { uploaded: true, fileId };
  } catch (err) {
    onLog?.("warn", `PDF sync failed: ${(err as Error).message}`);
    return { uploaded: false, reason: (err as Error).message };
  }
}

/**
 * Resolve the active provider from env + per-space config. The space's
 * `.blogspace/config.yaml` chooses the model; env decides which provider
 * is actually reachable. Returns null when no key is present at all.
 */
export async function getProviderForSpace(args: {
  workspaceRoot: string;
  spaceId: string;
  preferred?: LlmProvider;
}): Promise<AiProvider | null> {
  const { workspaceRoot, spaceId } = args;
  const status = computeStatus();
  if (!status.enabled) return null;
  const config = await loadSpaceConfig(workspaceRoot, spaceId);
  const desired = args.preferred ?? config.llm.active.provider;
  // Fall back to whichever key is present if the desired provider has
  // no key — the editor's status indicator still shows "AI enabled".
  const actualProvider: LlmProvider = ((): LlmProvider => {
    if (desired === "anthropic" && status.hasAnthropic) return "anthropic";
    if (desired === "openai" && status.hasOpenAI) return "openai";
    return status.hasAnthropic ? "anthropic" : "openai";
  })();
  const model =
    config.llm.active.provider === actualProvider
      ? config.llm.active.model
      : defaultModelFor(actualProvider);
  if (actualProvider === "anthropic") {
    return makeAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model,
      ...(config.ai?.endpoints?.anthropicBaseUrl
        ? { baseUrl: config.ai.endpoints.anthropicBaseUrl }
        : {}),
    });
  }
  return makeOpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    model,
    ...(config.ai?.endpoints?.openaiBaseUrl
      ? { baseUrl: config.ai.endpoints.openaiBaseUrl }
      : {}),
  });
}

export function computeStatus(): AiStatus {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const enabled = hasAnthropic || hasOpenAI;
  const activeProvider: LlmProvider | null = hasAnthropic
    ? "anthropic"
    : hasOpenAI
      ? "openai"
      : null;
  return {
    enabled,
    hasAnthropic,
    hasOpenAI,
    activeProvider,
    activeModel: activeProvider ? defaultModelFor(activeProvider) : null,
  };
}

function defaultModelFor(p: LlmProvider): string {
  return p === "anthropic" ? "claude-opus-4-7" : "gpt-5.2";
}

export async function loadSpaceConfig(
  workspaceRoot: string,
  spaceId: string,
): Promise<WorkspaceConfig> {
  const path = join(workspaceRoot, spaceId, ".blogspace", "config.yaml");
  try {
    const raw = await readFile(path, "utf8");
    return workspaceConfigSchema.parse(yaml.load(raw) ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return workspaceConfigSchema.parse({});
    }
    throw err;
  }
}
