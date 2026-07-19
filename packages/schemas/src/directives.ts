import { z } from "zod";
import { relativePathSchema, slugSchema } from "./common.js";

/**
 * Schemas for the *attributes* of custom remark-directive blocks.
 * The directive's body content (children) is validated separately during
 * markdown parsing. These schemas exist so the editor can lint directives
 * inline and the compiler can fail fast on bad input.
 */

export const galleryLayoutSchema = z.enum([
  "single",
  "tile",
  "masonry",
  "carousel",
  "fullbleed",
]);

export const galleryAttrsSchema = z.object({
  layout: galleryLayoutSchema.default("tile"),
  // gap in px, applied between items in tile/masonry
  gap: z.coerce.number().int().min(0).max(64).default(8),
  // for carousel only — autoplay interval ms, 0 disables
  autoplay: z.coerce.number().int().min(0).max(30000).default(0),
});

export const videoAttrsSchema = z.object({
  src: relativePathSchema,
  poster: relativePathSchema.optional(),
  autoplay: z.coerce.boolean().default(false),
  loop: z.coerce.boolean().default(false),
  muted: z.coerce.boolean().default(false),
  controls: z.coerce.boolean().default(true),
});

/**
 * Map markers use a compact pipe-delimited string so authors can write them
 * inline without nesting YAML inside markdown attributes. Format:
 *   "lat,lng:Label|lat,lng:Label"
 * Parsed by the compiler into a structured list.
 */
const latLngString = z
  .string()
  .regex(
    /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/,
    "expected 'lat,lng' decimal degrees",
  );

export const mapAttrsSchema = z.object({
  center: latLngString,
  zoom: z.coerce.number().int().min(1).max(20).default(13),
  markers: z.string().optional(),
  width: z.coerce.number().int().min(200).max(2400).default(1200),
  height: z.coerce.number().int().min(150).max(1600).default(600),
  style: z.enum(["streets", "satellite", "outdoors", "light", "dark"]).default("streets"),
  // When true the static image is interactive on click (loads Leaflet on demand).
  interactive: z.coerce.boolean().default(true),
});

export const quoteCardAttrsSchema = z.object({
  author: z.string().min(1),
  source: z.string().optional(),
  year: z.coerce.number().int().min(0).max(3000).optional(),
  cite: z.string().url().optional(),
  variant: z.enum(["plain", "pulled", "framed"]).default("plain"),
});

export const chapterLinkAttrsSchema = z.object({
  to: slugSchema,
  // Optional anchor within target chapter (heading slug).
  anchor: z.string().optional(),
  // Visual style. "card" is the big block; "inline" matches a wikilink look.
  variant: z.enum(["card", "inline"]).default("card"),
});

export type GalleryAttrs = z.infer<typeof galleryAttrsSchema>;
export type VideoAttrs = z.infer<typeof videoAttrsSchema>;
export type MapAttrs = z.infer<typeof mapAttrsSchema>;
export type QuoteCardAttrs = z.infer<typeof quoteCardAttrsSchema>;
export type ChapterLinkAttrs = z.infer<typeof chapterLinkAttrsSchema>;
export type GalleryLayout = z.infer<typeof galleryLayoutSchema>;

export const directiveAttrSchemas = {
  gallery: galleryAttrsSchema,
  video: videoAttrsSchema,
  map: mapAttrsSchema,
  "quote-card": quoteCardAttrsSchema,
  "chapter-link": chapterLinkAttrsSchema,
} as const;

export type DirectiveName = keyof typeof directiveAttrSchemas;
