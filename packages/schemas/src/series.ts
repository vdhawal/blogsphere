import { z } from "zod";
import {
  aiMetadataSchema,
  authorSchema,
  isoDateSchema,
  relativePathSchema,
  seoSchema,
  slugSchema,
} from "./common.js";

export const relatedSeriesSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  cover: z.string().url().optional(),
  description: z.string().max(200).optional(),
});

export const seriesSchema = z.object({
  id: slugSchema,
  title: z.string().min(1).max(120),
  author: authorSchema,
  description: z.string().min(1).max(500),
  theme: z.string().min(1).max(40),

  cover: relativePathSchema,

  // Ordered chapter slugs. Each must correspond to chapters/<slug>.md
  // The order of this array IS the canonical reading order — frontmatter
  // never carries an explicit `order` field to avoid two sources of truth.
  // Empty is allowed: a freshly created space has no chapters until the
  // author creates one through the editor. The compiler will refuse to
  // produce useful output for an empty space, but the schema doesn't
  // enforce that — it would block the new-space flow.
  chapters: z.array(slugSchema).default([]),

  tags: z.array(z.string().min(1)).max(20).default([]),
  related: z.array(relatedSeriesSchema).default([]),

  language: z.string().min(2).max(10).default("en"),
  license: z.string().optional(),

  publishedAt: isoDateSchema.optional(),
  updatedAt: isoDateSchema.optional(),

  /**
   * Publisher of the blog, surfaced as the schema.org `publisher`
   * Organization on every Article — Google's Article rich-result
   * eligibility effectively requires it (with a logo). For a personal
   * blog this is usually the author-as-brand. `logo` is a space-root
   * relative image path or an absolute URL; when unset the compiler
   * falls back to the series cover so a publisher logo always resolves.
   */
  publisher: z
    .object({
      name: z.string().min(1).max(120),
      logo: z.string().optional(),
      url: z.string().url().optional(),
    })
    .optional(),

  // Series-level SEO and AI metadata. Chapter-level overrides on the chapter.
  seo: seoSchema.default({}),
  ai: aiMetadataSchema.default({}),

  // Hosting hints used by the compiler to populate canonical URLs and sitemaps.
  // Optional — without it, links are emitted relative.
  site: z
    .object({
      baseUrl: z.string().url(),
      basePath: z.string().startsWith("/").default("/"),
    })
    .optional(),
});

export type Series = z.infer<typeof seriesSchema>;
export type RelatedSeries = z.infer<typeof relatedSeriesSchema>;
