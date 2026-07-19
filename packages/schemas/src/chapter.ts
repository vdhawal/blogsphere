import { z } from "zod";
import {
  aiMetadataSchema,
  generationProvenanceSchema,
  isoDateSchema,
  relativePathSchema,
  seoSchema,
} from "./common.js";

/**
 * Frontmatter that lives at the top of every chapter markdown file.
 * Note: chapter `slug` is derived from filename, not stored here.
 * Note: chapter `order` lives in series.yaml only, never here.
 */
export const chapterFrontmatterSchema = z.object({
  title: z.string().min(1).max(140),
  summary: z.string().min(1).max(280),
  cover: relativePathSchema.optional(),

  publishedAt: isoDateSchema.optional(),
  updatedAt: isoDateSchema.optional(),

  tags: z.array(z.string().min(1)).max(20).default([]),

  seo: seoSchema.default({}),
  ai: aiMetadataSchema.default({}),

  // Provenance for AI-generated fields. The editor uses contentHash to detect
  // when chapter body has drifted from the last generation and surface a
  // "regenerate" affordance. Manual edits to seo/ai fields by the author are
  // preserved — we never overwrite without an explicit user action.
  generated: z
    .object({
      seo: generationProvenanceSchema.optional(),
      ai: generationProvenanceSchema.optional(),
    })
    .default({}),
});

export type ChapterFrontmatter = z.infer<typeof chapterFrontmatterSchema>;
