import OpenAI from "openai";
import { toFile } from "openai/uploads";
import type { AiProvider } from "./types.js";

/**
 * OpenAI implementation. Uses the Responses API (the v1 first-class
 * surface that natively handles file attachments, streaming, and vision
 * in one call shape).
 */
export function makeOpenAI(args: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): AiProvider {
  const client = new OpenAI({
    apiKey: args.apiKey,
    ...(args.baseUrl ? { baseURL: args.baseUrl } : {}),
  });

  return {
    name: "openai",
    model: args.model,

    async generateText(prompt, opts) {
      const res = await client.responses.create({
        model: args.model,
        ...(opts?.system ? { instructions: opts.system } : {}),
        input: prompt,
        max_output_tokens: opts?.maxTokens ?? 1024,
      });
      return res.output_text ?? "";
    },

    async vision({ prompt, image, system, maxTokens }) {
      const dataUrl = `data:${image.mime};base64,${image.data.toString("base64")}`;
      const res = await client.responses.create({
        model: args.model,
        ...(system ? { instructions: system } : {}),
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: dataUrl, detail: "auto" },
              { type: "input_text", text: prompt },
            ],
          },
        ],
        max_output_tokens: maxTokens ?? 512,
      });
      return res.output_text ?? "";
    },

    async uploadFile({ buffer, filename, mime }) {
      const file = await toFile(buffer, filename, { type: mime });
      // `user_data` keeps the file out of long-term retraining and works
      // as a referenceable attachment for the Responses API.
      const res = await client.files.create({ file, purpose: "user_data" });
      return { fileId: res.id };
    },

    async *streamChat({ messages, system, fileId, maxTokens }) {
      const firstUserIdx = messages.findIndex((m) => m.role === "user");
      const input = messages.map((m, i) => {
        if (m.role === "user") {
          const parts: unknown[] = [];
          if (i === firstUserIdx && fileId) {
            parts.push({ type: "input_file", file_id: fileId });
          }
          parts.push({ type: "input_text", text: m.content });
          return { role: "user" as const, content: parts };
        }
        return {
          role: "assistant" as const,
          content: [{ type: "output_text", text: m.content }],
        };
      });
      const stream = await client.responses.create({
        model: args.model,
        instructions: system,
        input: input as never,
        max_output_tokens: maxTokens ?? 4096,
        stream: true,
      });
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") {
          yield ev.delta;
        }
      }
    },
  };
}
