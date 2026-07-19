import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import { visit } from "unist-util-visit";
import type {
  Root,
  Content,
  Text,
  Image,
  Link,
  PhrasingContent,
  Parent,
} from "mdast";
import {
  galleryAttrsSchema,
  videoAttrsSchema,
  mapAttrsSchema,
  quoteCardAttrsSchema,
  chapterLinkAttrsSchema,
  type GalleryAttrs,
  type MapAttrs,
  type QuoteCardAttrs,
  type ChapterLinkAttrs,
} from "@blogspace/schemas";
import {
  escapeHtml,
  normalizeRef,
  slugifyHeading,
  relativeUrl,
} from "./util.js";
import type {
  AssetManifest,
  ChapterGraph,
  ProcessedImage,
} from "./types.js";

/**
 * remark-directive produces three node types: containerDirective (`:::name`),
 * leafDirective (`::name`), textDirective (`:name`). They share these fields.
 */
interface DirectiveNode extends Parent {
  type: "containerDirective" | "leafDirective" | "textDirective";
  name: string;
  attributes?: Record<string, string | null | undefined>;
}

export interface ParsedChapter {
  slug: string;
  tree: Root;
  /** Map directives within this chapter, in document order. */
  mapDirectives: MapAttrs[];
  /** Slugs of chapters this one references via wikilink or chapter-link. */
  outboundChapterSlugs: string[];
  /** Headings, in order — for in-page nav and #anchors. */
  headings: { level: number; text: string; id: string }[];
  /** First image reference encountered in the body (space-root-relative or
   *  absolute URL). Used as a fallback chapter cover when frontmatter.cover
   *  is unset, so the home page can still show a thumbnail. */
  firstBodyImage?: string;
}

/** Parse one chapter's markdown body into mdast and collect light metadata. */
export function parseChapter(slug: string, body: string, frontmatterTitle?: string): ParsedChapter {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .parse(body) as Root;

  // If the body starts with an H1 whose text matches the frontmatter title,
  // drop it — it would otherwise duplicate the chapter header H1 we already
  // emit, hurting SEO (multiple H1s) and visual hierarchy.
  if (frontmatterTitle && tree.children[0]?.type === "heading" && tree.children[0].depth === 1) {
    const bodyTitle = mdastTextContent(tree.children[0]).trim();
    if (bodyTitle.toLowerCase() === frontmatterTitle.trim().toLowerCase()) {
      tree.children.shift();
    }
  }

  const headings: ParsedChapter["headings"] = [];
  const mapDirectives: MapAttrs[] = [];
  const outboundChapterSlugs = new Set<string>();
  let firstBodyImage: string | undefined;

  visit(tree, (node) => {
    if (!firstBodyImage && node.type === "image") {
      const url = (node as Image).url;
      if (url && !/^data:/.test(url)) firstBodyImage = url;
    }
    if (node.type === "heading") {
      const text = mdastTextContent(node);
      headings.push({ level: node.depth, text, id: slugifyHeading(text) });
    }
    if (
      node.type === "containerDirective" ||
      node.type === "leafDirective" ||
      node.type === "textDirective"
    ) {
      const dir = node as DirectiveNode;
      if (dir.name === "map") {
        const parsed = mapAttrsSchema.safeParse(coerceAttrs(dir.attributes));
        if (parsed.success) mapDirectives.push(parsed.data);
      }
      if (dir.name === "chapter-link") {
        const parsed = chapterLinkAttrsSchema.safeParse(coerceAttrs(dir.attributes));
        if (parsed.success) outboundChapterSlugs.add(parsed.data.to);
      }
    }
  });

  // Wikilinks live inside text nodes — gather their targets while we're walking.
  // The actual rewrite to anchor nodes happens at render time so we can resolve
  // the link target against the chapter graph.
  for (const target of findWikilinkTargets(tree)) {
    outboundChapterSlugs.add(target);
  }

  return {
    slug,
    tree,
    mapDirectives,
    outboundChapterSlugs: [...outboundChapterSlugs],
    headings,
    firstBodyImage,
  };
}

/** Render context passed through the recursive mdast → HTML conversion. */
export interface RenderContext {
  chapterSlug: string;
  /** URL of the current chapter, used to compute relative asset/link paths. */
  pageUrl: string;
  manifest: AssetManifest;
  graph: ChapterGraph;
  /** Used to assign stable ids to map directives (chapter-slug + ordinal). */
  mapOrdinal: { value: number };
  /** Headings already emitted on this page (for unique id assignment). */
  headingIdsSeen: Set<string>;
  warnings: string[];
}

/** Render mdast root to HTML body fragment (no <html> wrapping). */
export function renderChapterBody(tree: Root, ctx: RenderContext): string {
  return renderNodes(tree.children, ctx);
}

// --------------------- internal rendering ---------------------

function renderNodes(nodes: Content[] | PhrasingContent[], ctx: RenderContext): string {
  return (nodes as Content[]).map((n) => renderNode(n, ctx)).join("");
}

function renderNode(node: Content, ctx: RenderContext): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderNodes(node.children, ctx)}</p>`;
    case "heading": {
      const text = mdastTextContent(node);
      let id = slugifyHeading(text);
      let n = 1;
      while (ctx.headingIdsSeen.has(id)) id = `${slugifyHeading(text)}-${++n}`;
      ctx.headingIdsSeen.add(id);
      const inner = renderNodes(node.children, ctx);
      return `<h${node.depth} id="${id}">${inner}</h${node.depth}>`;
    }
    case "text":
      return renderTextWithWikilinks(node, ctx);
    case "strong":
      return `<strong>${renderNodes(node.children, ctx)}</strong>`;
    case "emphasis":
      return `<em>${renderNodes(node.children, ctx)}</em>`;
    case "delete":
      return `<del>${renderNodes(node.children, ctx)}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "code":
      return `<pre><code${node.lang ? ` class="language-${escapeHtml(node.lang)}"` : ""}>${escapeHtml(node.value)}</code></pre>`;
    case "link":
      return `<a href="${escapeHtml(node.url)}"${node.title ? ` title="${escapeHtml(node.title)}"` : ""}${/^https?:\/\//.test(node.url) ? ' rel="noopener" target="_blank"' : ""}>${renderNodes(node.children, ctx)}</a>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : "";
      return `<${tag}${start}>${node.children.map((li) => renderNode(li, ctx)).join("")}</${tag}>`;
    }
    case "listItem":
      return `<li>${renderNodes(node.children, ctx)}</li>`;
    case "blockquote":
      return `<blockquote>${renderNodes(node.children, ctx)}</blockquote>`;
    case "thematicBreak":
      return `<hr/>`;
    case "break":
      return `<br/>`;
    case "image":
      return renderImage(node, ctx);
    case "html":
      // Raw HTML in markdown is passed through. The author wrote it intentionally.
      return node.value;
    case "containerDirective":
    case "leafDirective":
    case "textDirective":
      return renderDirective(node as DirectiveNode, ctx);
    default:
      // Anything we don't know: render children if it has them, else nothing.
      if ("children" in node && Array.isArray((node as Parent).children)) {
        return renderNodes((node as Parent).children, ctx);
      }
      return "";
  }
}

function renderImage(node: Image, ctx: RenderContext): string {
  if (/^https?:\/\//.test(node.url)) {
    return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt ?? "")}" loading="lazy" decoding="async"/>`;
  }
  const ref = normalizeRef(node.url);
  const processed = ctx.manifest.images.get(ref);
  if (!processed) {
    ctx.warnings.push(`unresolved image: ${ref} (in ${ctx.chapterSlug})`);
    return `<img alt="${escapeHtml(node.alt ?? "")}" data-missing="${escapeHtml(ref)}"/>`;
  }
  return buildPicture(processed, node.alt ?? "", node.title, ctx);
}

function buildPicture(
  img: ProcessedImage,
  alt: string,
  title: string | null | undefined,
  ctx: RenderContext,
  sizes = "(max-width: 700px) 100vw, 700px",
  className?: string,
): string {
  const byFormat = new Map<string, typeof img.variants>();
  for (const v of img.variants) {
    const arr = byFormat.get(v.format) ?? [];
    arr.push(v);
    byFormat.set(v.format, arr);
  }
  const srcsetFor = (fmt: "avif" | "webp" | "jpeg") => {
    const vs = byFormat.get(fmt) ?? [];
    return vs
      .sort((a, b) => a.width - b.width)
      .map((v) => `${relativeUrl(ctx.pageUrl, "/" + v.outputPath)} ${v.width}w`)
      .join(", ");
  };
  const jpegs = (byFormat.get("jpeg") ?? []).sort((a, b) => a.width - b.width);
  const fallback = jpegs[Math.min(2, jpegs.length - 1)] ?? jpegs[0];
  if (!fallback) {
    ctx.warnings.push(`no jpeg variant for ${img.sourceRef}`);
    return "";
  }

  const aspectRatio = `${img.width} / ${img.height}`;
  const figureCaption = title
    ? `<figcaption>${escapeHtml(title)}</figcaption>`
    : "";

  return `<figure${className ? ` class="${className}"` : ""}>
  <picture>
    <source type="image/avif" srcset="${srcsetFor("avif")}" sizes="${sizes}"/>
    <source type="image/webp" srcset="${srcsetFor("webp")}" sizes="${sizes}"/>
    <img src="${relativeUrl(ctx.pageUrl, "/" + fallback.outputPath)}"
         srcset="${srcsetFor("jpeg")}"
         sizes="${sizes}"
         alt="${escapeHtml(alt)}"
         width="${img.width}" height="${img.height}"
         loading="lazy" decoding="async"
         style="aspect-ratio:${aspectRatio};background:#eee;"
         data-blurhash="${img.blurhash}"/>
  </picture>
  ${figureCaption}
</figure>`;
}

function renderDirective(dir: DirectiveNode, ctx: RenderContext): string {
  const attrs = coerceAttrs(dir.attributes);
  switch (dir.name) {
    case "gallery":
      return renderGallery(dir, attrs, ctx);
    case "video":
      return renderVideo(dir, attrs, ctx);
    case "map":
      return renderMap(dir, attrs, ctx);
    case "quote-card":
      return renderQuoteCard(dir, attrs, ctx);
    case "chapter-link":
      return renderChapterLink(dir, attrs, ctx);
    default:
      ctx.warnings.push(`unknown directive '${dir.name}' in ${ctx.chapterSlug}`);
      return renderNodes(dir.children as Content[], ctx);
  }
}

function renderGallery(dir: DirectiveNode, raw: Record<string, unknown>, ctx: RenderContext): string {
  const parsed = galleryAttrsSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.warnings.push(`gallery attrs invalid in ${ctx.chapterSlug}: ${parsed.error.message}`);
    return "";
  }
  const attrs: GalleryAttrs = parsed.data;
  // Children of a container directive: flatten paragraphs and pull out images.
  const images: Image[] = [];
  visit(dir, "image", (n: Image) => {
    images.push(n);
  });
  if (images.length === 0) return "";

  const sizesByLayout: Record<GalleryAttrs["layout"], string> = {
    single: "(max-width: 700px) 100vw, 700px",
    tile: "(max-width: 700px) 100vw, (max-width: 1200px) 50vw, 33vw",
    masonry: "(max-width: 700px) 100vw, (max-width: 1200px) 50vw, 33vw",
    carousel: "100vw",
    fullbleed: "100vw",
  };
  const sizes = sizesByLayout[attrs.layout];

  const items = images
    .map((img) => {
      const ref = normalizeRef(img.url);
      const processed = ctx.manifest.images.get(ref);
      if (!processed) {
        ctx.warnings.push(`gallery image not resolved: ${ref}`);
        return "";
      }
      return buildPicture(processed, img.alt ?? "", img.title, ctx, sizes, "gallery__item");
    })
    .join("\n");

  return `<div class="gallery gallery--${attrs.layout}" style="--gallery-gap:${attrs.gap}px"${attrs.layout === "carousel" && attrs.autoplay > 0 ? ` data-autoplay="${attrs.autoplay}"` : ""}>
${items}
</div>`;
}

function renderVideo(dir: DirectiveNode, raw: Record<string, unknown>, ctx: RenderContext): string {
  const parsed = videoAttrsSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.warnings.push(`video attrs invalid in ${ctx.chapterSlug}: ${parsed.error.message}`);
    return "";
  }
  const attrs = parsed.data;
  const srcRef = normalizeRef(attrs.src);
  const video = ctx.manifest.videos.get(srcRef);
  if (!video) {
    ctx.warnings.push(`video unresolved: ${srcRef}`);
    return "";
  }
  // Prefer the manifest-derived poster (always present when ffmpeg ran at
  // upload time). Fall back to an explicit `poster=` attribute resolved
  // through the image manifest. Either way the browser preloads metadata
  // only, so the poster image is the only above-the-fold cost.
  let posterUrl: string | undefined;
  if (video.posterOutputPath) {
    posterUrl = relativeUrl(ctx.pageUrl, "/" + video.posterOutputPath);
  } else if (attrs.poster) {
    const poster = ctx.manifest.images.get(normalizeRef(attrs.poster));
    const variant = poster?.variants.find((v) => v.format === "jpeg");
    if (variant) posterUrl = relativeUrl(ctx.pageUrl, "/" + variant.outputPath);
  }

  // Emit one <source> per variant, descending by width. Browsers walk
  // <source> elements top-to-bottom and pick the first they can play —
  // larger variants first means the highest-fidelity supported codec wins.
  const sortedVariants = [...video.variants].sort((a, b) => b.width - a.width);
  const sourceElements = sortedVariants
    .map((v) => `    <source src="${relativeUrl(ctx.pageUrl, "/" + v.outputPath)}" type="${escapeHtml(v.mime)}"${v.width ? ` data-width="${v.width}"` : ""}/>`)
    .join("\n");
  const fallback = sortedVariants[0];
  const caption = mdastTextContent(dir);

  return `<figure class="video">
  <video${posterUrl ? ` poster="${posterUrl}"` : ""}${attrs.controls ? " controls" : ""}${attrs.autoplay ? " autoplay" : ""}${attrs.muted || attrs.autoplay ? " muted" : ""}${attrs.loop ? " loop" : ""}${video.width ? ` width="${video.width}" height="${video.height}" style="aspect-ratio:${video.width}/${video.height};"` : ""} playsinline preload="metadata">
${sourceElements}
    ${fallback ? `<p>Your browser does not support embedded video. <a href="${relativeUrl(ctx.pageUrl, "/" + fallback.outputPath)}">Download the video</a>.</p>` : ""}
  </video>
  ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}
</figure>`;
}

function renderMap(dir: DirectiveNode, raw: Record<string, unknown>, ctx: RenderContext): string {
  const parsed = mapAttrsSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.warnings.push(`map attrs invalid in ${ctx.chapterSlug}: ${parsed.error.message}`);
    return "";
  }
  const attrs: MapAttrs = parsed.data;
  const ordinal = ++ctx.mapOrdinal.value;
  const id = `${ctx.chapterSlug}-map-${ordinal}`;
  const processed = ctx.manifest.maps.get(id);
  if (!processed) {
    ctx.warnings.push(`map not pre-rendered: ${id}`);
    return "";
  }
  const dataAttrs = attrs.interactive
    ? ` data-interactive="1" data-center="${processed.center.lat},${processed.center.lng}" data-zoom="${processed.zoom}" data-markers='${escapeHtml(JSON.stringify(processed.markers))}'`
    : "";
  return `<figure class="map"${dataAttrs}>
  <img src="${relativeUrl(ctx.pageUrl, "/" + processed.outputPath)}"
       width="${processed.width}" height="${processed.height}"
       alt="Map of ${processed.markers.length} location${processed.markers.length === 1 ? "" : "s"}"
       loading="lazy" decoding="async"/>
  ${attrs.interactive ? `<button class="map__activate" type="button" aria-label="Make map interactive">Interactive map</button>` : ""}
</figure>`;
}

function renderQuoteCard(dir: DirectiveNode, raw: Record<string, unknown>, ctx: RenderContext): string {
  const parsed = quoteCardAttrsSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.warnings.push(`quote-card attrs invalid in ${ctx.chapterSlug}: ${parsed.error.message}`);
    return "";
  }
  const attrs: QuoteCardAttrs = parsed.data;
  const body = renderNodes(dir.children as Content[], ctx);
  const sourceMeta = [
    attrs.source ? `<cite${attrs.cite ? ` cite="${escapeHtml(attrs.cite)}"` : ""}>${escapeHtml(attrs.source)}</cite>` : "",
    attrs.year ? `<span class="quote-card__year">${attrs.year}</span>` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<blockquote class="quote-card quote-card--${attrs.variant}">
  <div class="quote-card__body">${body}</div>
  <footer class="quote-card__attr">
    <span class="quote-card__author">${escapeHtml(attrs.author)}</span>
    ${sourceMeta ? `<span class="quote-card__source">${sourceMeta}</span>` : ""}
  </footer>
</blockquote>`;
}

function renderChapterLink(dir: DirectiveNode, raw: Record<string, unknown>, ctx: RenderContext): string {
  const parsed = chapterLinkAttrsSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.warnings.push(`chapter-link attrs invalid in ${ctx.chapterSlug}: ${parsed.error.message}`);
    return "";
  }
  const attrs: ChapterLinkAttrs = parsed.data;
  const target = ctx.graph.get(attrs.to);
  const label = mdastTextContent(dir) || target?.title || attrs.to;
  if (!target) {
    ctx.warnings.push(`chapter-link target '${attrs.to}' not found in ${ctx.chapterSlug}`);
    return `<a href="#" class="chapter-link chapter-link--broken" data-broken-target="${escapeHtml(attrs.to)}">${escapeHtml(label)}</a>`;
  }
  const href = chapterHref(attrs.to, attrs.anchor, ctx);
  if (attrs.variant === "inline") {
    return `<a href="${href}" class="chapter-link chapter-link--inline" data-chapter-preview="${escapeHtml(attrs.to)}">${escapeHtml(label)}</a>`;
  }
  // Card style
  const coverImg = target.cover ? ctx.manifest.images.get(normalizeRef(target.cover)) : undefined;
  const cover = coverImg
    ? buildPicture(coverImg, target.title, undefined, ctx, "(max-width: 700px) 100vw, 400px", "chapter-link__cover")
    : "";
  return `<a href="${href}" class="chapter-link chapter-link--card" data-chapter-preview="${escapeHtml(attrs.to)}">
  ${cover}
  <div class="chapter-link__body">
    <span class="chapter-link__eyebrow">${escapeHtml(label)}</span>
    <h3 class="chapter-link__title">${escapeHtml(target.title)}</h3>
    <p class="chapter-link__summary">${escapeHtml(target.summary)}</p>
  </div>
</a>`;
}

// --------------------- wikilinks ---------------------

// Wikilinks may span a soft line break in source markdown — allow newlines
// inside, then collapse whitespace to a single space at render time.
const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;

/** Walk an mdast tree and collect every wikilink target slug. */
function findWikilinkTargets(tree: Root): Set<string> {
  const out = new Set<string>();
  visit(tree, "text", (n: Text) => {
    for (const m of n.value.matchAll(WIKILINK_RE)) {
      const body = m[1] ?? "";
      const target = body.split("|")[0]?.split("#")[0]?.trim();
      if (target) out.add(target);
    }
  });
  return out;
}

/** Render a text node, substituting [[slug|label]] with anchors as we go. */
function renderTextWithWikilinks(node: Text, ctx: RenderContext): string {
  const value = node.value;
  const matches = [...value.matchAll(WIKILINK_RE)];
  if (matches.length === 0) return escapeHtml(value);
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    const at = m.index ?? 0;
    out += escapeHtml(value.slice(cursor, at));
    const body = (m[1] ?? "").replace(/\s+/g, " ");
    const [targetPart, displayPart] = body.split("|");
    const [slug, anchor] = (targetPart ?? "").split("#");
    const target = ctx.graph.get((slug ?? "").trim());
    const label = (displayPart ?? slug ?? "").trim();
    if (!target) {
      ctx.warnings.push(`wikilink target not found: ${slug} (in ${ctx.chapterSlug})`);
      out += `<a href="#" class="wikilink wikilink--broken" data-broken-target="${escapeHtml(slug ?? "")}">${escapeHtml(label)}</a>`;
    } else {
      const href = chapterHref((slug ?? "").trim(), anchor?.trim(), ctx);
      out += `<a href="${href}" class="wikilink" data-chapter-preview="${escapeHtml((slug ?? "").trim())}">${escapeHtml(label)}</a>`;
    }
    cursor = at + m[0].length;
  }
  out += escapeHtml(value.slice(cursor));
  return out;
}

function chapterHref(slug: string, anchor: string | undefined, ctx: RenderContext): string {
  // Use the graph's stable filename so internal links match the files on
  // disk. The graph is built before any rendering, so every chapter knows
  // the others' filenames.
  const target = ctx.graph.get(slug);
  const filename = target?.outputFilename ?? `${slug}.html`;
  const targetUrl = `/chapters/${filename}`;
  const rel = relativeUrl(ctx.pageUrl, targetUrl);
  return anchor ? `${rel}#${slugifyHeading(anchor)}` : rel;
}

// --------------------- helpers ---------------------

function mdastTextContent(node: Parent | Content): string {
  if (!("children" in node) || !Array.isArray((node as Parent).children)) {
    if ("value" in node && typeof node.value === "string") return node.value;
    return "";
  }
  return (node as Parent).children
    .map((c) => mdastTextContent(c as Content))
    .join("");
}

function coerceAttrs(
  attrs: Record<string, string | null | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export { findWikilinkTargets };
