import type {
  Series,
  ChapterFrontmatter,
  Seo,
  AiMetadata,
} from "@blogspace/schemas";

/**
 * Source-level chapter as loaded from disk, before compilation.
 */
export interface LoadedChapter {
  slug: string;
  filePath: string;
  frontmatter: ChapterFrontmatter;
  body: string;
}

/**
 * Series + its chapters, all validated, with paths resolved.
 */
export interface LoadedBlogSpace {
  rootDir: string;
  series: Series;
  chapters: LoadedChapter[];
}

/**
 * One processed image variant on disk.
 */
export interface ImageVariant {
  format: "avif" | "webp" | "jpeg";
  width: number;
  height: number;
  /** Path relative to output root */
  outputPath: string;
  bytes: number;
}

/**
 * Result of processing one source image into many variants.
 */
export interface ProcessedImage {
  /** Original source path as referenced in markdown, normalized to space-root-relative. */
  sourceRef: string;
  variants: ImageVariant[];
  /** Natural dimensions of the source. */
  width: number;
  height: number;
  /** Tiny base64 blurhash placeholder, ~30 chars. */
  blurhash: string;
  /** Best-guess alt text (empty if author didn't supply). */
  alt: string;
  /**
   * Hash of the original source bytes — present when this image was
   * produced by the runtime fallback path and cached in build-cache.yaml.
   * Manifest-served images don't need this; the manifest is the source
   * of truth for what variants exist.
   */
  sourceHash?: string;
}

/**
 * Result of resolving a video for the compiled output. Mirrors the manifest's
 * VideoAsset but with `outputPath` references rooted at the dist tree.
 */
export interface ProcessedVideo {
  sourceRef: string;
  width: number;
  height: number;
  durationMs?: number;
  /** Output path of the poster jpg, if any (relative to dist root). */
  posterOutputPath?: string;
  /** All sources to emit as <source> elements, descending by width. */
  variants: {
    width: number;
    height: number;
    mime: string;
    outputPath: string;
    bytes: number;
  }[];
}

/**
 * Result of rendering a map directive — either a real static image or
 * a generated SVG placeholder when no tile API key is available.
 */
export interface ProcessedMap {
  /** Stable id derived from chapter slug + directive ordinal. */
  id: string;
  outputPath: string;
  width: number;
  height: number;
  /** Whether the runtime should offer "click to make interactive". */
  interactive: boolean;
  /** Re-emitted so the viewer can hydrate Leaflet with the same args. */
  center: { lat: number; lng: number };
  zoom: number;
  markers: { lat: number; lng: number; label?: string }[];
}

/**
 * Pre-resolved asset metadata, keyed by space-root-relative path.
 * Built once per compile and consulted while rendering markdown.
 */
export interface AssetManifest {
  images: Map<string, ProcessedImage>;
  maps: Map<string, ProcessedMap>;
  /** Resolved video metadata, keyed by space-root-relative source path. */
  videos: Map<string, ProcessedVideo>;
}

/**
 * Bidirectional chapter graph derived from series order + wikilinks.
 *
 * `outputFilename` carries the stable on-disk/URL filename (`<slug>.html`)
 * that all internal references — prev/next nav, chapter-link cards,
 * wikilinks, sitemap, RSS, manifest — should use. Threading it through a
 * single field means every renderer agrees on the URL for any given
 * chapter. (Cache-busting is handled by HTTP headers + per-deploy CDN
 * invalidation, not by mangling the URL — see AGENTS.md.)
 */
export interface ChapterGraphNode {
  slug: string;
  title: string;
  summary: string;
  cover?: string;
  publishedAt?: string;
  prev?: string;
  next?: string;
  /** Slugs of chapters this chapter links *to* (via wikilink or chapter-link). */
  outbound: string[];
  /** Slugs of chapters that link *to* this chapter (backlinks for wiki nav). */
  inbound: string[];
  /** Stable filename on disk and in URLs: `<slug>.html`. */
  outputFilename: string;
}

export type ChapterGraph = Map<string, ChapterGraphNode>;

/**
 * The viewer needs a manifest of chapters for hover-preview cards and
 * client-side navigation. Shipped as /manifest.json in the output.
 */
export interface ViewerManifest {
  series: {
    id: string;
    title: string;
    description: string;
    cover: string;
  };
  chapters: {
    slug: string;
    title: string;
    summary: string;
    url: string;
    cover?: string;
  }[];
}

export interface CompileOptions {
  spaceDir: string;
  /**
   * Output root. Interpretation depends on `format`:
   *   - "dir":  the directory IS the static output (HTML + assets land directly here)
   *   - "zip":  the parent of the zip. Staging dir lives here transiently.
   *   - "both": the parent of BOTH the named static folder AND the zip
   *             (i.e. `<outDir>/<spaceId>/` and `<outDir>/<spaceId>.zip`)
   */
  outDir: string;
  format: "dir" | "zip" | "both";
  /**
   * Optional override for the reader chat panel's POST target. When set,
   * overrides whatever `.blogspace/config.yaml#ai.endpoints.chatProxyUrl`
   * carries — used by the editor's PreviewManager to point preview-mode
   * chat at the running editor server, so the author doesn't have to
   * configure a real proxy URL just to try chat locally. Production
   * exports leave this unset and pick up the value from config.yaml.
   */
  chatProxyUrlOverride?: string;
  /** Optional override for the series basePath used when compiling to a nested export folder. */
  siteBasePathOverride?: string;
  /** If true, write only what's changed. Not implemented in v1. */
  incremental?: boolean;
  /** If true, regenerate placeholder fixture assets if missing. */
  seedMissingAssets?: boolean;
}

export interface CompileResult {
  /**
   * Primary output the caller asked about. For format="dir" this is the
   * static directory; for "zip" and "both" it's the zip file. Kept for
   * back-compat with callers that don't distinguish formats.
   */
  outputPath: string;
  /** Absolute path to the static dir, or null when format="zip". */
  dirPath: string | null;
  /** Absolute path to the zip, or null when format="dir". */
  zipPath: string | null;
  /**
   * Absolute path to the generated PDF — a single-doc rendering of every
   * chapter, designed to be uploaded to an LLM Files API (OpenAI's
   * Responses API in v1) as the context surface for chat-with-blog.
   * Always written, regardless of output format.
   */
  pdfPath: string;
  pdfBytes: number;
  chaptersWritten: number;
  /** Number of chapters that were re-rendered this compile (vs reused from cache). */
  chaptersRendered: number;
  /** Number of chapters whose previous HTML was reused without re-rendering. */
  chaptersReused: number;
  /** Whether the PDF was re-rendered this compile. */
  pdfRendered: boolean;
  imagesProcessed: number;
  /** Images that came verbatim from the upload manifest (fast path). */
  imagesManifestServed: number;
  /** Images reused from build-cache without re-encoding. */
  imagesReusedFromCache: number;
  /** Images that required a full sharp re-encoding this compile. */
  imagesRegenerated: number;
  variantsWritten: number;
  bytesWritten: number;
  warnings: string[];
}

export type { Series, ChapterFrontmatter, Seo, AiMetadata };
