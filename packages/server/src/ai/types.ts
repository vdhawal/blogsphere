import type { LlmProvider } from "@blogspace/schemas";

/**
 * Common interface across Anthropic + OpenAI so route handlers don't
 * branch on provider. Each method maps to one provider API:
 *
 *   - `generateText`  → Messages / Responses (no file attachment)
 *   - `vision`        → Messages / Responses with an inline image
 *   - `uploadFile`    → Files API (returns provider-native file id)
 *   - `chatWithFile`  → Messages / Responses with the file id attached
 *
 * `streamChat` yields incremental text chunks. Implementations bridge
 * each SDK's stream events into a unified async iterable.
 */
export interface AiProvider {
  name: LlmProvider;
  model: string;

  generateText(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;

  vision(args: {
    prompt: string;
    image: { mime: string; data: Buffer };
    system?: string;
    maxTokens?: number;
  }): Promise<string>;

  uploadFile(args: { buffer: Buffer; filename: string; mime: string }): Promise<{ fileId: string }>;

  streamChat(args: {
    messages: { role: "user" | "assistant"; content: string }[];
    system: string;
    fileId?: string;
    maxTokens?: number;
  }): AsyncIterable<string>;
}

export class AiUnavailableError extends Error {
  constructor(public readonly reason: "no-key" | "no-config" | "no-file") {
    super(reason);
    this.name = "AiUnavailableError";
  }
}

export interface AiStatus {
  /** True if at least one provider key is present in the env. */
  enabled: boolean;
  hasAnthropic: boolean;
  hasOpenAI: boolean;
  /** Provider the server will actually use given env + config. */
  activeProvider: LlmProvider | null;
  activeModel: string | null;
}
