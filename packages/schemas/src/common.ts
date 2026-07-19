import { z } from "zod";

export const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.includes(".."), {
    message: "must be a relative path inside the blog space (no leading / or ..)",
  });

/**
 * Accepts either an ISO-8601 string (`2026-04-12` or `2026-04-12T09:14:00Z`)
 * or a `Date` (which js-yaml produces from unquoted ISO dates in YAML).
 * Normalizes everything to an ISO-8601 string so downstream code has one
 * shape to handle.
 */
export const isoDateSchema = z
  .union([z.string().datetime(), z.string().date(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v));

export const authorSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    avatar: relativePathSchema.optional(),
    email: z.string().email().optional(),
    // Social / canonical profile URLs for JSON-LD `sameAs` entity linking
    // (e.g. an Instagram, Mastodon, or LinkedIn profile). Used to tie the
    // author Person node to off-site identities so search engines can
    // consolidate authorship signals.
    sameAs: z.array(z.string().url()).max(10).optional(),
  }),
]);

export const seoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(200).optional(),
  keywords: z.array(z.string().min(1)).max(20).optional(),
  ogImage: relativePathSchema.optional(),
  canonical: z.string().url().optional(),
  social: z
    .object({
      twitter: z.string().optional(),
      cardType: z.enum(["summary", "summary_large_image"]).optional(),
    })
    .optional(),
  noindex: z.boolean().optional(),
});

export const aiMetadataSchema = z.object({
  summary: z.string().max(600).optional(),
  topics: z.array(z.string().min(1)).max(15).optional(),
  entities: z.array(z.string().min(1)).max(30).optional(),
});

export const generationProvenanceSchema = z.object({
  at: isoDateSchema,
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
  contentHash: z.string().min(8),
});

export type Slug = z.infer<typeof slugSchema>;
export type RelativePath = z.infer<typeof relativePathSchema>;
export type Author = z.infer<typeof authorSchema>;
export type Seo = z.infer<typeof seoSchema>;
export type AiMetadata = z.infer<typeof aiMetadataSchema>;
export type GenerationProvenance = z.infer<typeof generationProvenanceSchema>;
