/**
 * Editor-side mirror of the server protocol. The two type modules are kept
 * in lockstep by hand — the surface is small enough that copying beats
 * cross-package imports inside the Vite bundle.
 */

export interface SpaceSummary {
  id: string;
  title: string;
  description: string;
  theme: string;
  cover?: string;
  chapterCount: number;
  updatedAt?: string;
}

export interface ChapterListItem {
  slug: string;
  title: string;
  summary: string;
  publishedAt?: string;
}

export interface SeriesShape {
  id: string;
  title: string;
  description: string;
  theme: string;
  author: string | { name: string; url?: string; email?: string; sameAs?: string[] };
  cover: string;
  chapters: string[];
  tags: string[];
  related: { title: string; url: string; description?: string }[];
  language: string;
  license?: string;
  publishedAt?: string;
  updatedAt?: string;
  publisher?: { name: string; logo?: string; url?: string };
  seo: SeoShape;
  ai: AiMetadataShape;
  site?: { baseUrl: string; basePath?: string };
}

export interface SpaceDetail {
  id: string;
  series: SeriesShape;
  chapters: ChapterListItem[];
}

export interface SeoShape {
  title?: string;
  description?: string;
  keywords?: string[];
  ogImage?: string;
  canonical?: string;
  social?: { twitter?: string; cardType?: "summary" | "summary_large_image" };
  noindex?: boolean;
}

export interface AiMetadataShape {
  summary?: string;
  topics?: string[];
  entities?: string[];
}

export interface ChapterFrontmatterShape {
  title: string;
  summary: string;
  cover?: string;
  publishedAt?: string;
  updatedAt?: string;
  tags: string[];
  seo: SeoShape;
  ai: AiMetadataShape;
  generated: {
    seo?: { at: string; provider: "anthropic" | "openai"; model: string; contentHash: string };
    ai?: { at: string; provider: "anthropic" | "openai"; model: string; contentHash: string };
  };
}

export interface ChapterDetail {
  slug: string;
  frontmatter: ChapterFrontmatterShape;
  body: string;
}

/* ----- WS protocol mirror ----- */

export type ResourceRef =
  | { kind: "chapter-body"; spaceId: string; slug: string }
  | { kind: "chapter-frontmatter"; spaceId: string; slug: string }
  | { kind: "series"; spaceId: string };

/**
 * CodeMirror-6 ChangeSet.toJSON() encoding. Two shapes:
 *   - a positive `number` retains that many characters
 *   - `[del, ...lines]` deletes `del` chars then inserts the remaining
 *     strings joined by "\n". CM spreads the inserted text's line array
 *     directly into the step, so multi-line inserts look like
 *     `[0, "a", "", "b"]` rather than `[0, ["a", "", "b"]]`.
 */
export type ChangeStep = number | [number, ...string[]];
export type ChangeDelta = ChangeStep[];

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export type EditPayload =
  | { kind: "text"; changes: ChangeDelta }
  | { kind: "json"; patches: JsonPatchOp[] };

export type SaveStatus = "idle" | "saving" | "error";

export function resourceKey(r: ResourceRef): string {
  return r.kind === "series" ? `${r.kind}:${r.spaceId}` : `${r.kind}:${r.spaceId}:${r.slug}`;
}

/* ----- Asset manifest mirror (read-only on the client) ----- */

export interface ImageVariant {
  width: number;
  height: number;
  format: "avif" | "webp" | "jpeg";
  path: string;
  bytes: number;
}

export interface VideoVariant {
  width: number;
  height: number;
  codec: string;
  mime: string;
  role?: "source" | "web";
  bitrate?: number;
  path: string;
  bytes: number;
}

export interface ImageAsset {
  kind: "image";
  sourcePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  blurhash: string;
  alt: string;
  uploadedAt: string;
  processingStatus?: "pending" | "ready" | "failed";
  processingError?: string;
  variants: ImageVariant[];
}

export interface VideoAsset {
  kind: "video";
  sourcePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationMs?: number;
  posterPath?: string;
  caption: string;
  uploadedAt: string;
  processingStatus?: "pending" | "ready" | "failed";
  processingError?: string;
  variants: VideoVariant[];
}

export type AssetEntry = ImageAsset | VideoAsset;

export interface AssetManifestShape {
  version: 1;
  updatedAt: string;
  assets: AssetEntry[];
}

export interface MediaVariantDetail {
  path: string;
  role?: "source" | "web";
  width: number;
  height: number;
  bytes: number;
  format?: string;
  codec?: string;
  mime?: string;
  container?: string;
  pixFmt?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdr?: boolean;
}

export interface MediaAssetDetail {
  sourcePath: string;
  kind: "image" | "video";
  label: string;
  processingStatus: "pending" | "ready" | "failed";
  processingError?: string;
  complete: boolean;
  needsWebFallback: boolean;
  source: MediaVariantDetail;
  variants: MediaVariantDetail[];
  posterPath?: string;
}

export interface MediaReportShape {
  spaceId: string;
  slug?: string;
  queue: { pending: number; active: string | null };
  assets: MediaAssetDetail[];
  summary: {
    total: number;
    complete: number;
    pending: number;
    failed: number;
    incomplete: number;
  };
}

export interface MediaStatusShape {
  queue: { pending: number; active: string | null };
  pendingAssets: number;
  failedAssets: number;
}

/* ----- AI status + chat ----- */

export interface AiFeatureFlags {
  altText: boolean;
  caption: boolean;
  seoTitle: boolean;
  seoDescription: boolean;
  chapterSummary: boolean;
  aiMetadata: boolean;
  tagSuggestions: boolean;
  spellGrammar: boolean;
  chat: boolean;
}

export interface AiStatusShape {
  enabled: boolean;
  hasAnthropic: boolean;
  hasOpenAI: boolean;
  activeProvider: "anthropic" | "openai" | null;
  activeModel: string | null;
  features: AiFeatureFlags;
}

export interface ChatMessageShape {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}

export interface ChatHistoryShape {
  version: 1;
  messages: ChatMessageShape[];
}

export interface SpellGrammarSuggestion {
  original: string;
  replacement: string;
  reason: string;
}

export interface FactCheckFinding {
  claim: string;
  concern: string;
  suggestedCorrection: string;
  confidence: "likely" | "verify";
}

export interface ExportSettingsShape {
  selectedSpaceIds: string[];
}
