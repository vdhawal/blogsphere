import Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import type { AiProvider } from "./types.js";

/**
 * Anthropic implementation. Uses the Messages API for chat + vision, and
 * the Files API (beta, opted in via `anthropic-beta` header) for PDF
 * attachments referenced by file id.
 *
 * Note: the Anthropic SDK accepts a custom `baseURL` for routing through
 * proxies / Bedrock-style edges. Keys still come from server env.
 */
export function makeAnthropic(args: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): AiProvider {
  const client = new Anthropic({
    apiKey: args.apiKey,
    ...(args.baseUrl ? { baseURL: args.baseUrl } : {}),
    defaultHeaders: { "anthropic-beta": "files-api-2025-04-14" },
  });

  return {
    name: "anthropic",
    model: args.model,

    async generateText(prompt, opts) {
      const res = await client.messages.create({
        model: args.model,
        max_tokens: opts?.maxTokens ?? 1024,
        ...(opts?.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      return collectText(res.content);
    },

    async vision({ prompt, image, system, maxTokens }) {
      const res = await client.messages.create({
        model: args.model,
        max_tokens: maxTokens ?? 512,
        ...(system ? { system } : {}),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: image.data.toString("base64"),
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      });
      return collectText(res.content);
    },

    async uploadFile({ buffer, filename, mime }) {
      // Use SDK helper to wrap the buffer into a File-like object.
      const file = await toFile(buffer, filename, { type: mime });
      const res = await (client as unknown as {
        beta: { files: { upload: (input: { file: unknown }) => Promise<{ id: string }> } };
      }).beta.files.upload({ file });
      return { fileId: res.id };
    },

    async *streamChat({ messages, system, fileId, maxTokens }) {
      const userContent = (m: { role: string; content: string }, isFirst: boolean) => {
        // Attach the PDF on the FIRST user message only — Anthropic ties
        // document content to the message it appears in, but the model
        // retains it as context for the whole conversation.
        if (isFirst && fileId && m.role === "user") {
          return [
            { type: "document" as const, source: { type: "file" as const, file_id: fileId } },
            { type: "text" as const, text: m.content },
          ];
        }
        return m.content;
      };
      const firstUserIdx = messages.findIndex((m) => m.role === "user");
      const mapped = messages.map((m, i) => ({
        role: m.role,
        content: userContent(m, i === firstUserIdx) as unknown as string,
      }));
      const stream = client.messages.stream({
        model: args.model,
        max_tokens: maxTokens ?? 4096,
        system,
        messages: mapped as never,
      });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield ev.delta.text;
        }
      }
    },
  };
}

function collectText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");
}
