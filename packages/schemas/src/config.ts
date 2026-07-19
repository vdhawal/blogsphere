import { z } from "zod";

/**
 * Per-blog-space configuration kept at <space>/.blogspace/config.yaml.
 * Holds author preferences that aren't user-facing publication metadata —
 * notably which LLM the author uses for SEO/AI generation.
 *
 * Models are listed by id; provider determines which env var supplies the key:
 *   anthropic -> ANTHROPIC_API_KEY (Messages API, claude-* models)
 *   openai    -> OPENAI_API_KEY    (Responses API, gpt-* models)
 */

export const llmProviderSchema = z.enum(["anthropic", "openai"]);

export const llmModelSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().min(1),
  // Optional display label for the editor's model picker.
  label: z.string().optional(),
});

/**
 * AI feature toggles. Keyed by feature name so we can wire/disable each
 * one independently from a single switch. All default-on when an API
 * key is present in the environment; the editor still asks the server
 * for status at boot so absent keys disable the UI affordances.
 */
export const aiFeatureFlagsSchema = z
  .object({
    altText: z.boolean().default(true),
    caption: z.boolean().default(true),
    seoTitle: z.boolean().default(true),
    seoDescription: z.boolean().default(true),
    chapterSummary: z.boolean().default(true),
    aiMetadata: z.boolean().default(true),
    tagSuggestions: z.boolean().default(true),
    spellGrammar: z.boolean().default(true),
    chat: z.boolean().default(true),
  })
  .default({});

/**
 * Privacy guardrail for AI-generated output. Names listed here are
 * scrubbed from EVERY AI feature's output — SEO title/description,
 * AI metadata (summary/topics/entities), and the chat stream — even
 * though the underlying chapter text and grounding PDF still contain
 * them. The model is also instructed to refer to these people
 * generically; the deterministic scrub is the belt-and-braces backstop
 * for when the model ignores the instruction. Matching is
 * case-insensitive and word-boundary'd, so partial-word collisions
 * (e.g. a place name that embeds the string) are left untouched.
 *
 * Intended use: a single author's minor children, whose names appear in
 * the author's prose but must never surface in machine-generated
 * metadata or chat replies.
 */
export const aiPrivacySchema = z
  .object({
    /** Names to strip from all AI-generated output. Single tokens. */
    redactNames: z.array(z.string().min(1)).default([]),
    /** What a redacted name is replaced with in free-text output. */
    redactReplacement: z.string().default("our child"),
  })
  .default({});

/**
 * Endpoint overrides for the configured provider. Set baseUrl to point
 * at an Azure deployment, AWS Bedrock-routed endpoint, or internal edge
 * proxy. API keys still come from server env (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY) — config never carries secrets.
 */
export const aiEndpointsSchema = z
  .object({
    anthropicBaseUrl: z.string().url().optional(),
    openaiBaseUrl: z.string().url().optional(),
    /**
     * URL the published viewer POSTs reader chat turns to. Same wire
     * shape as the editor server's `/api/spaces/:id/ai/viewer-chat`
     * route. Empty / unset → viewer hides the chat panel entirely.
     *
     * In preview/dev this typically points at the editor server itself
     * (`http://127.0.0.1:4317/api/spaces/<spaceId>/ai/viewer-chat`); in
     * production the author hosts an edge function with their key.
     */
    chatProxyUrl: z.string().url().optional(),
  })
  .default({});

export const workspaceConfigSchema = z.object({
  llm: z
    .object({
      // Active selection — what the editor uses when the author hits
      // "Generate SEO" or "Suggest alt text".
      active: llmModelSchema,
      // Models the author has enabled in the picker. Editor pre-seeds this
      // with sensible defaults on first run.
      available: z.array(llmModelSchema).min(1),
    })
    .default({
      active: { provider: "anthropic", model: "claude-opus-4-7" },
      available: [
        { provider: "anthropic", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { provider: "openai", model: "gpt-5.2", label: "GPT-5.2" },
      ],
    }),

  ai: z
    .object({
      features: aiFeatureFlagsSchema,
      endpoints: aiEndpointsSchema,
      privacy: aiPrivacySchema,
    })
    .default({ features: {}, endpoints: {}, privacy: {} } as never),

  // Used to populate author info in series.yaml when creating a new space.
  author: z
    .object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
});

export type LlmProvider = z.infer<typeof llmProviderSchema>;
export type LlmModel = z.infer<typeof llmModelSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type AiFeatureFlags = z.infer<typeof aiFeatureFlagsSchema>;
export type AiEndpoints = z.infer<typeof aiEndpointsSchema>;
export type AiPrivacy = z.infer<typeof aiPrivacySchema>;

/**
 * Per-space record of the chat-context PDF that was uploaded to the AI
 * provider's Files API. Bundled into the export so the file id travels
 * with the space — when readers chat with the blog, the same file id is
 * referenced. Content-hash dedup'd: we only re-upload when the bytes
 * actually change, even if the export ran.
 *
 * Lives at <space>/.blogspace/ai-context.yaml. Multiple entries are
 * possible if the author switches providers; the lookup is by
 * (provider, model) — re-upload happens on hash mismatch.
 */
export const aiContextEntrySchema = z.object({
  provider: llmProviderSchema,
  pdfHash: z.string().min(8),
  fileId: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  uploadedAt: z.string(),
  /** Filename hint passed to the Files API for the upload. */
  filename: z.string().min(1),
});

export const aiContextSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(aiContextEntrySchema).default([]),
});

export type AiContextEntry = z.infer<typeof aiContextEntrySchema>;
export type AiContext = z.infer<typeof aiContextSchema>;

export function emptyAiContext(): AiContext {
  return { version: 1, entries: [] };
}

/**
 * Per-space chat history — stored alongside ai-context.yaml so the
 * author can resume a conversation across editor restarts. Bounded by
 * count (the latest N turns are kept) to keep the file small.
 */
export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  ts: z.string(),
});

export const chatHistorySchema = z.object({
  version: z.literal(1).default(1),
  messages: z.array(chatMessageSchema).default([]),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatHistory = z.infer<typeof chatHistorySchema>;

export const exportSettingsSchema = z.object({
  selectedSpaceIds: z.array(z.string()).default([]),
});
export type ExportSettings = z.infer<typeof exportSettingsSchema>;

