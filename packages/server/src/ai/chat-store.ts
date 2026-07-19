import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import {
  chatHistorySchema,
  aiContextSchema,
  emptyAiContext,
  type AiContext,
  type AiContextEntry,
  type ChatHistory,
  type ChatMessage,
  type LlmProvider,
} from "@blogspace/schemas";
import { writeFileAtomic } from "../fs-ops.js";

const HISTORY_MAX = 200;

/** Path inside a space where chat + ai-context yaml live. */
function aiDir(workspaceRoot: string, spaceId: string): string {
  return join(workspaceRoot, spaceId, ".blogspace");
}

function chatPath(workspaceRoot: string, spaceId: string): string {
  return join(aiDir(workspaceRoot, spaceId), "chat-history.yaml");
}

function contextPath(workspaceRoot: string, spaceId: string): string {
  return join(aiDir(workspaceRoot, spaceId), "ai-context.yaml");
}

export async function loadChatHistory(
  workspaceRoot: string,
  spaceId: string,
): Promise<ChatHistory> {
  try {
    const raw = await readFile(chatPath(workspaceRoot, spaceId), "utf8");
    return chatHistorySchema.parse(yaml.load(raw) ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return chatHistorySchema.parse({});
    }
    throw err;
  }
}

export async function appendChatMessages(
  workspaceRoot: string,
  spaceId: string,
  toAppend: ChatMessage[],
): Promise<ChatHistory> {
  const current = await loadChatHistory(workspaceRoot, spaceId);
  const next: ChatHistory = {
    version: 1,
    messages: [...current.messages, ...toAppend].slice(-HISTORY_MAX),
  };
  await writeFileAtomic(
    chatPath(workspaceRoot, spaceId),
    yaml.dump(chatHistorySchema.parse(next)),
  );
  return next;
}

export async function clearChatHistory(
  workspaceRoot: string,
  spaceId: string,
): Promise<void> {
  await writeFileAtomic(
    chatPath(workspaceRoot, spaceId),
    yaml.dump(chatHistorySchema.parse({})),
  );
}

export async function loadAiContext(
  workspaceRoot: string,
  spaceId: string,
): Promise<AiContext> {
  try {
    const raw = await readFile(contextPath(workspaceRoot, spaceId), "utf8");
    return aiContextSchema.parse(yaml.load(raw) ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyAiContext();
    throw err;
  }
}

export async function setAiContextEntry(
  workspaceRoot: string,
  spaceId: string,
  entry: AiContextEntry,
): Promise<AiContext> {
  const current = await loadAiContext(workspaceRoot, spaceId);
  const next: AiContext = {
    version: 1,
    entries: [
      ...current.entries.filter((e) => e.provider !== entry.provider),
      entry,
    ],
  };
  await writeFileAtomic(
    contextPath(workspaceRoot, spaceId),
    yaml.dump(aiContextSchema.parse(next)),
  );
  return next;
}

export function findContextEntry(
  ctx: AiContext,
  provider: LlmProvider,
): AiContextEntry | undefined {
  return ctx.entries.find((e) => e.provider === provider);
}

/** Sha256 of a buffer's bytes, hex-encoded — used as the pdfHash key. */
export function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
