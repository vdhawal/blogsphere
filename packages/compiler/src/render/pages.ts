import { escapeHtml, formatDate, relativeUrl, normalizeRef, slugifyHeading } from "../util.js";
import { renderShell } from "./shell.js";
import { renderChapterBody, parseChapter, type RenderContext } from "../markdown.js";
import type { Series } from "@blogspace/schemas";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../static/viewer.css"),
  "utf8",
);

import type {
  LoadedBlogSpace,
  LoadedChapter,
  AssetManifest,
  ChapterGraph,
  ProcessedImage,
} from "../types.js";

interface Comment {
  id: string;
  name: string;
  message: string;
  date: string;
  replyTo: string | null;
}

interface CommentNode extends Comment {
  replies: CommentNode[];
}

function loadCommentsForChapter(rootDir: string, slug: string): Comment[] {
  const comments: Comment[] = [];
  const possibleDirs = [slug, `chapters-${slug}`, `chapters_${slug}`];
  const repoRoot = join(rootDir, "..", "..");
  for (const dir of possibleDirs) {
    const commentsDirs = [
      join(rootDir, "_data", "comments", dir),
      join(rootDir, "_data", "welcomments", dir),
      join(repoRoot, "_data", "comments", dir),
      join(repoRoot, "_data", "welcomments", dir),
    ];
    for (const commentsDir of commentsDirs) {
      if (existsSync(commentsDir)) {
        const files = readdirSync(commentsDir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          try {
            const raw = readFileSync(join(commentsDir, file), "utf8");
            const data = JSON.parse(raw) as Record<string, unknown>;
            const id = String(data.id || data._id || file.replace(/\.json$/, ""));
            
            // Handle flat vs nested author object from Welcomments JSON structure
            let name = "Anonymous";
            if (data.name) {
              name = String(data.name);
            } else if (data.author) {
              if (typeof data.author === "string") {
                name = data.author;
              } else if (typeof data.author === "object" && data.author !== null) {
                const authorObj = data.author as Record<string, unknown>;
                if (authorObj.name) {
                  name = String(authorObj.name);
                }
              }
            }

            const message = String(data.message || data.comment || data.body || "");
            const date = String(data.date || data.createdAt || new Date().toISOString());
            const replyTo = data.reply_to || data.replyTo ? String(data.reply_to || data.replyTo) : null;
            comments.push({ id, name, message, date, replyTo });
          } catch (e) {
            // Ignore unparseable comment files
          }
        }
      }
    }
  }
  return comments.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function buildCommentTree(comments: Comment[]): CommentNode[] {
  const map = new Map<string, CommentNode>();
  const roots: CommentNode[] = [];
  for (const c of comments) {
    map.set(c.id, { ...c, replies: [] });
  }
  for (const node of map.values()) {
    if (node.replyTo && map.has(node.replyTo)) {
      map.get(node.replyTo)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function renderCommentNode(node: CommentNode, depth = 0, websiteId?: string): string {
  const dateStr = new Date(node.date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  let repliesHtml = "";
  if (node.replies.length > 0) {
    repliesHtml = `<ol class="comments-list">${node.replies.map((r) => renderCommentNode(r, depth + 1, websiteId)).join("\n")}</ol>`;
  }
  const nestingClasses = ["welcomments__comment"];
  if (depth > 0) nestingClasses.push(`welcomments__nesting-level-${depth}`);
  const replyLink = depth < 3 && websiteId
    ? `<a class="welcomments__comment-reply-link comment__reply-btn" href="https://api.welcomments.io/api/websites/${escapeHtml(websiteId)}/comments/${escapeHtml(node.id)}/reply">Reply to ${escapeHtml(node.name)}</a>`
    : "";
  const paragraphs = node.message
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
  return `<article class="${nestingClasses.join(" ")}" data-comment-id="${escapeHtml(node.id)}" data-author-name="${escapeHtml(node.name)}" data-nesting-level="${depth}">
  <div class="comment__meta">
    <span class="comment__author">${escapeHtml(node.name)}</span>
    <time class="comment__date" datetime="${escapeHtml(node.date)}">${escapeHtml(dateStr)}</time>
    ${replyLink}
  </div>
  <div class="comment__body">${paragraphs}</div>
  ${repliesHtml}
</article>`;
}

export interface RenderedChapter {
  slug: string;
  html: string;
  plainText: string;
}

export function renderChapterPage(args: {
  chapter: LoadedChapter;
  parsed: ReturnType<typeof parseChapter>;
  space: LoadedBlogSpace;
  graph: ChapterGraph;
  manifest: AssetManifest;
  warnings: string[];
}): RenderedChapter {
  const { chapter, parsed, space, graph, manifest, warnings } = args;
  const pageUrl = `/chapters/${graph.get(chapter.slug)?.outputFilename ?? chapter.slug + ".html"}`;
  const ctx: RenderContext = {
    chapterSlug: chapter.slug,
    pageUrl,
    manifest,
    graph,
    mapOrdinal: { value: 0 },
    headingIdsSeen: new Set(),
    warnings,
  };

  const bodyHtml = renderChapterBody(parsed.tree, ctx);
  const graphNode = graph.get(chapter.slug);

  // Word count / reading time: derived from the same plain-text extraction
  // used for llms-full.txt, so the two never disagree.
  const plainText = bodyToPlainText(parsed.tree);
  const wordCount = countWords(plainText);
  const readingMinutes = Math.max(1, Math.round(wordCount / 200));

  // Chapter <header> with title, summary, date, reading time.
  const pageHeaderHtml = `<article class="chapter">
<header class="chapter__header">
<h1 class="chapter__title" id="${slugifyHeading(chapter.frontmatter.title)}">${escapeHtml(chapter.frontmatter.title)}</h1>
<p class="chapter__summary">${escapeHtml(chapter.frontmatter.summary)}</p>
<p class="chapter__meta">
${chapter.frontmatter.publishedAt ? `<time datetime="${escapeHtml(chapter.frontmatter.publishedAt)}">${escapeHtml(formatDate(chapter.frontmatter.publishedAt, space.series.language))}</time>` : ""}
${chapter.frontmatter.updatedAt && chapter.frontmatter.updatedAt !== chapter.frontmatter.publishedAt ? ` · <span class="chapter__updated">updated <time datetime="${escapeHtml(chapter.frontmatter.updatedAt)}">${escapeHtml(formatDate(chapter.frontmatter.updatedAt, space.series.language))}</time></span>` : ""}
 · <span class="chapter__reading">${readingMinutes} min read</span>
${chapter.frontmatter.tags.length ? ` · <span class="chapter__tags">${chapter.frontmatter.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</span>` : ""}
</p>
</header>
<div class="chapter__body">`;

  const prevNext = renderPrevNext(graphNode, pageUrl, graph);
  const backlinks = renderBacklinks(graphNode, pageUrl, graph);

  let commentsHtml = "";
  const commentsConfig = space.series.comments;
  if (commentsConfig && commentsConfig.provider === "welcomments" && commentsConfig.welcommentsWebsiteId) {
    const commentsList = loadCommentsForChapter(space.rootDir, chapter.slug);
    const roots = buildCommentTree(commentsList);
    const commentsThreadHtml = roots.map((r) => renderCommentNode(r, 0, commentsConfig.welcommentsWebsiteId)).join("\n");
    const baseUrl = space.series.site?.baseUrl;
    const basePath = space.series.site?.basePath ?? "/";
    
    // Normalise path and form canonical URL
    const rawCanonical = baseUrl
      ? `${baseUrl.replace(/\/$/, "")}${join(basePath, pageUrl).replace(/\\/g, "/")}`
      : "";
    const canonicalUrl = rawCanonical.replace(/\/index\.html$/, "/");

    commentsHtml = `
<section class="comments-section" id="comments">
<h3 id="welcomments__comment-count-title" style="font-family: var(--font-sans); margin-bottom: 2rem;">Comments (${commentsList.length})</h3>
<div id="welcomments__comment-container">
${commentsList.length > 0 ? commentsThreadHtml : `<p style="font-family: var(--font-sans); font-size: 0.9rem; color: var(--muted); margin-bottom: 2rem;">No comments yet. Be the first to share your thoughts!</p>`}
</div>

<div class="comment-form-section" style="margin-top: 3rem;">
<h4 style="font-family: var(--font-sans); margin-bottom: 1rem;">Leave a comment</h4>
<form id="welcomments__form" class="welcomments__comment-form" action="https://welcomments.io/api/comments" method="post" style="display: flex; flex-direction: column; gap: 1rem;">
<input type="hidden" name="website-id" id="website-id" value="${escapeHtml(commentsConfig.welcommentsWebsiteId)}" />
<input type="hidden" name="permalink" id="permalink" value="${escapeHtml(canonicalUrl)}" />
<input type="hidden" name="page-slug" id="page-slug" value="${escapeHtml(chapter.slug)}" />
<input type="hidden" name="replying-to" id="welcomments_reply_to" value="" />

<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
<div style="display: flex; flex-direction: column;">
<label for="welcomments__author" style="font-family: var(--font-sans); font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem;">Name</label>
<input type="text" id="welcomments__author" name="author-name" required placeholder="Your name" style="font: inherit; padding: 0.5rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg);" />
</div>
<div style="display: flex; flex-direction: column;">
<label for="welcomments__email" style="font-family: var(--font-sans); font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem;">Email <span style="font-size: 0.75rem; color: var(--muted);">(optional, not published)</span></label>
<input type="email" id="welcomments__email" name="author-email" placeholder="you@example.com" style="font: inherit; padding: 0.5rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg);" />
</div>
</div>

<div style="display: flex; flex-direction: column;">
<label for="welcomments__comment" style="font-family: var(--font-sans); font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem;">Comment</label>
<textarea id="welcomments__comment" name="message" required rows="4" style="font: inherit; padding: 0.5rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg); resize: vertical;"></textarea>
</div>

<div>
<button type="submit" id="welcomments__submit-button" class="comment__reply-btn" style="margin-left: 0; padding: 0.5rem 1.25rem; font-size: 0.85rem; border: 1px solid var(--rule); border-radius: 4px;">Post Comment</button>
</div>
</form>
</div>
</section>`;
  }

  const pageFooterHtml = `</div>
${prevNext}
${backlinks}
${commentsHtml}
</article>`;

  // JSON-LD: Article + BreadcrumbList. Series-level CreativeWorkSeries goes on
  // the series landing page; here we just link back via isPartOf.
  const jsonLd = buildChapterJsonLd({
    chapter,
    space,
    pageUrl,
    wordCount,
    coverImage: imageObject(chapter.frontmatter.cover ?? space.series.cover, space, manifest),
    manifest,
  });

  // Head rel=prev/next so crawlers understand the chapter sequence.
  const prevNode = graphNode?.prev ? graph.get(graphNode.prev) : undefined;
  const nextNode = graphNode?.next ? graph.get(graphNode.next) : undefined;

  const html = renderShell({
    pageUrl,
    title: chapter.frontmatter.title,
    description: chapter.frontmatter.summary,
    bodyHtml: "", // chapter body lives in pageHeaderHtml / pageFooterHtml so we can wrap <article>
    seo: chapter.frontmatter.seo,
    ogType: "article",
    publishedAt: chapter.frontmatter.publishedAt,
    updatedAt: chapter.frontmatter.updatedAt,
    tags: chapter.frontmatter.tags,
    cover: chapter.frontmatter.cover ?? space.series.cover,
    articleSection: space.series.theme,
    ...(prevNode ? { prevUrl: relativeUrl(pageUrl, `/chapters/${prevNode.outputFilename}`) } : {}),
    ...(nextNode ? { nextUrl: relativeUrl(pageUrl, `/chapters/${nextNode.outputFilename}`) } : {}),
    jsonLd,
    space,
    manifest,
    graph,
    pageHeaderHtml: pageHeaderHtml + bodyHtml,
    pageFooterHtml,
  });

  return { slug: chapter.slug, html, plainText };
}

export function renderSeriesIndex(args: {
  space: LoadedBlogSpace;
  graph: ChapterGraph;
  manifest: AssetManifest;
}): string {
  const { space, graph, manifest } = args;
  const pageUrl = `/index.html`;
  const series = space.series;
  const author = typeof series.author === "string" ? series.author : series.author.name;

  const coverImg = series.cover ? manifest.images.get(normalizeRef(series.cover)) : undefined;
  const heroHtml = coverImg ? buildHero(coverImg, series.title, pageUrl) : "";

  // When there is no series hero the first chapter card with a cover is the LCP
  // element — give it fetchpriority="high" so the browser fetches it immediately.
  const hasHero = !!coverImg;
  let firstThumbPriorityUsed = false;

  const cards = series.chapters
    .map((slug) => {
      const node = graph.get(slug);
      if (!node) return "";
      const href = relativeUrl(pageUrl, `/chapters/${node.outputFilename}`);
      const cover = node.cover ? manifest.images.get(normalizeRef(node.cover)) : undefined;
      let coverHtml = "";
      if (cover) {
        const isLcp = !hasHero && !firstThumbPriorityUsed;
        if (isLcp) firstThumbPriorityUsed = true;
        coverHtml = buildThumb(cover, node.title, pageUrl, isLcp);
      }
      const cardClass = cover ? "chapter-card chapter-card--with-cover" : "chapter-card";
      return `<li class="${cardClass}">
<a href="${href}">
${coverHtml}
<div class="chapter-card__body">
<h2 class="chapter-card__title">${escapeHtml(node.title)}</h2>
<p class="chapter-card__summary">${escapeHtml(node.summary)}</p>
${node.publishedAt ? `<time datetime="${escapeHtml(node.publishedAt)}">${escapeHtml(formatDate(node.publishedAt, series.language))}</time>` : ""}
</div>
</a>
</li>`;
    })
    .join("\n");

  const relatedHtml = series.related.length
    ? `<section class="related-series">
<h2>Related</h2>
<ul>${series.related
        .map(
          (r) =>
            `<li><a href="${escapeHtml(r.url)}" rel="external">${escapeHtml(r.title)}</a>${r.description ? ` — ${escapeHtml(r.description)}` : ""}</li>`,
        )
        .join("")}</ul>
</section>`
    : "";

  const bodyHtml = `<section class="series-intro">
${heroHtml}
<h1>${escapeHtml(series.title)}</h1>
<p class="series-description">${escapeHtml(series.description)}</p>
<p class="series-meta">by ${escapeHtml(author)}${series.publishedAt ? ` · <time datetime="${escapeHtml(series.publishedAt)}">${escapeHtml(formatDate(series.publishedAt, series.language))}</time>` : ""}</p>
</section>
<ol class="chapter-list">${cards}</ol>
${relatedHtml}`;

  const jsonLd = buildSeriesJsonLd({ space, manifest, graph });

  return renderShell({
    pageUrl,
    title: series.title,
    description: series.description,
    bodyHtml,
    seo: series.seo,
    ogType: "website",
    publishedAt: series.publishedAt,
    updatedAt: series.updatedAt,
    tags: series.tags,
    cover: series.cover,
    jsonLd,
    space,
    manifest,
    graph,
  });
}

/**
 * Static 404 page. Most hosts (Cloudflare Pages, Netlify, GitHub Pages)
 * serve `/404.html` for unknown paths. Marked noindex so search engines
 * don't index the error page itself.
 */
export function renderNotFoundPage(args: {
  space: LoadedBlogSpace;
  graph: ChapterGraph;
  manifest: AssetManifest;
}): string {
  const { space, graph, manifest } = args;
  const pageUrl = `/404.html`;
  const homeHref = relativeUrl(pageUrl, "/index.html");
  const bodyHtml = `<section class="series-intro not-found">
<h1>Page not found</h1>
<p class="series-description">That page doesn't exist or may have moved. Head back to the start of <strong>${escapeHtml(space.series.title)}</strong>.</p>
<p><a class="btn" href="${homeHref}">Go to the home page</a></p>
</section>`;
  return renderShell({
    pageUrl,
    title: `Page not found · ${space.series.title}`,
    description: "The page you were looking for could not be found.",
    bodyHtml,
    seo: { noindex: true },
    ogType: "website",
    cover: space.series.cover,
    jsonLd: [],
    space,
    manifest,
    graph,
  });
}

function renderPrevNext(node: ReturnType<ChapterGraph["get"]>, pageUrl: string, graph: ChapterGraph): string {
  if (!node) return "";
  const prev = node.prev ? graph.get(node.prev) : undefined;
  const next = node.next ? graph.get(node.next) : undefined;
  if (!prev && !next) return "";
  const prevHtml = prev
    ? `<a class="chapter-nav__prev" rel="prev" href="${relativeUrl(pageUrl, `/chapters/${prev.outputFilename}`)}">
<span class="chapter-nav__label">Previous</span>
<span class="chapter-nav__title">${escapeHtml(prev.title)}</span>
</a>`
    : "";
  const nextHtml = next
    ? `<a class="chapter-nav__next" rel="next" href="${relativeUrl(pageUrl, `/chapters/${next.outputFilename}`)}">
<span class="chapter-nav__label">Next</span>
<span class="chapter-nav__title">${escapeHtml(next.title)}</span>
</a>`
    : "";
  return `<nav class="chapter-nav" aria-label="Chapter navigation">${prevHtml}${nextHtml}</nav>`;
}

function renderBacklinks(node: ReturnType<ChapterGraph["get"]>, pageUrl: string, graph: ChapterGraph): string {
  if (!node || node.inbound.length === 0) return "";
  const items = node.inbound
    .map((slug) => {
      const ref = graph.get(slug);
      if (!ref) return "";
      const href = relativeUrl(pageUrl, `/chapters/${ref.outputFilename}`);
      return `<li><a href="${href}" data-chapter-preview="${escapeHtml(slug)}">${escapeHtml(ref.title)}</a></li>`;
    })
    .join("");
  return `<aside class="backlinks" aria-label="Referenced from">
<h2 class="backlinks__heading">Referenced from</h2>
<ul>${items}</ul>
</aside>`;
}

function buildHero(img: ProcessedImage, alt: string, pageUrl: string): string {
  return buildPictureSimple(img, alt, pageUrl, "hero", "100vw", { priority: true });
}
function buildThumb(img: ProcessedImage, alt: string, pageUrl: string, priority = false): string {
  // Desktop card grid column is a hard 280px (viewer.css: grid-template-columns: 280px 1fr).
  // Telling the browser 280px means 1× picks the 320px variant and 2× picks 640px.
  // Cap srcset at 640w: desktop 2× needs 560px (640 covers it); mobile ~375px CSS at
  // 1.75–2× DPR needs 656–750px (640 is 85–97% — indistinguishable at thumbnail size).
  return buildPictureSimple(img, alt, pageUrl, "thumb", "(max-width: 700px) 100vw, 280px", { maxSrcsetWidth: 640, priority });
}
function buildPictureSimple(
  img: ProcessedImage,
  alt: string,
  pageUrl: string,
  className: string,
  sizes: string,
  options: { priority?: boolean; maxSrcsetWidth?: number } = {},
): string {
  const { priority = false, maxSrcsetWidth } = options;
  const withinWidth = (v: { width: number }) => maxSrcsetWidth === undefined || v.width <= maxSrcsetWidth;
  const srcset = (fmt: "avif" | "webp" | "jpeg") =>
    img.variants
      .filter((v) => v.format === fmt && withinWidth(v))
      .sort((a, b) => a.width - b.width)
      .map((v) => `${relativeUrl(pageUrl, "/" + v.outputPath)} ${v.width}w`)
      .join(", ");
  // Fallback src: use the smallest JPEG within the width cap (for thumbnails this
  // is the ~320px variant rather than the old third-smallest which was 1024px).
  const jpegs = img.variants
    .filter((v) => v.format === "jpeg" && withinWidth(v))
    .sort((a, b) => a.width - b.width);
  const fb = jpegs[0] ?? img.variants.filter((v) => v.format === "jpeg").sort((a, b) => a.width - b.width)[0];
  if (!fb) return "";
  const priorityAttr = priority ? ' fetchpriority="high"' : "";
  return `<picture class="${className}">
<source type="image/avif" srcset="${srcset("avif")}" sizes="${sizes}"/>
<source type="image/webp" srcset="${srcset("webp")}" sizes="${sizes}"/>
<img src="${relativeUrl(pageUrl, "/" + fb.outputPath)}" srcset="${srcset("jpeg")}" sizes="${sizes}" alt="${escapeHtml(alt)}" width="${img.width}" height="${img.height}"${priorityAttr} loading="eager" decoding="async" style="aspect-ratio:${img.width}/${img.height};"/>
</picture>`;
}

/**
 * Resolve an image reference to its largest jpeg variant as an absolute
 * (or root-relative when no baseUrl) URL plus natural dimensions, so
 * JSON-LD and OG can emit proper ImageObjects.
 */
function imageObject(
  ref: string | undefined,
  space: LoadedBlogSpace,
  manifest: AssetManifest,
): { url: string; width?: number; height?: number } | undefined {
  if (!ref) return undefined;
  if (/^https?:\/\//.test(ref)) return { url: ref };
  const img = manifest.images.get(normalizeRef(ref));
  if (!img) return undefined;
  const best = [...img.variants]
    .filter((v) => v.format === "jpeg")
    .sort((a, b) => b.width - a.width)[0];
  if (!best) return undefined;
  const base = space.series.site?.baseUrl?.replace(/\/$/, "") ?? "";
  const path = space.series.site?.basePath ?? "/";
  const url = `${base}${path.replace(/\/$/, "")}/${best.outputPath}`;
  return { url, width: best.width, height: best.height };
}

function toImageObject(img: { url: string; width?: number; height?: number }): unknown {
  if (img.width && img.height) {
    return { "@type": "ImageObject", url: img.url, width: img.width, height: img.height };
  }
  return img.url;
}

/** schema.org Person for the series author, with optional url + sameAs. */
function buildAuthor(series: LoadedBlogSpace["series"]): unknown {
  if (typeof series.author === "string") {
    return { "@type": "Person", name: series.author };
  }
  return {
    "@type": "Person",
    name: series.author.name,
    ...(series.author.url ? { url: series.author.url } : {}),
    ...(series.author.sameAs?.length ? { sameAs: series.author.sameAs } : {}),
  };
}

/**
 * schema.org Organization for the publisher. Falls back to author-as-brand
 * for the name and the series cover for the logo when an explicit
 * publisher block isn't configured — so Article rich-result eligibility
 * doesn't silently depend on the author filling a separate field.
 */
function buildPublisher(space: LoadedBlogSpace, manifest: AssetManifest): unknown {
  const series = space.series;
  const name =
    series.publisher?.name ??
    (typeof series.author === "string" ? series.author : series.author.name);
  const logoRef = series.publisher?.logo ?? series.cover;
  const logo = imageObject(logoRef, space, manifest);
  return {
    "@type": "Organization",
    name,
    ...(series.publisher?.url ? { url: series.publisher.url } : {}),
    ...(logo ? { logo: toImageObject(logo) } : {}),
  };
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function buildSeriesJsonLd(args: { space: LoadedBlogSpace; manifest: AssetManifest; graph: ChapterGraph }): unknown[] {
  const { space, manifest, graph } = args;
  const series = space.series;
  const baseUrl = series.site?.baseUrl?.replace(/\/$/, "");
  const basePath = series.site?.basePath ?? "/";
  const url = baseUrl ? `${baseUrl}${basePath}` : undefined;

  const hasPart = series.chapters.map((slug) => {
    const ch = space.chapters.find((c) => c.slug === slug);
    const filename = graph.get(slug)?.outputFilename ?? `${slug}.html`;
    return {
      "@type": "BlogPosting",
      headline: ch?.frontmatter.title ?? slug,
      url: url ? `${url}chapters/${filename}` : `chapters/${filename}`,
      datePublished: ch?.frontmatter.publishedAt,
      dateModified: ch?.frontmatter.updatedAt ?? ch?.frontmatter.publishedAt,
    };
  });

  const coverImg = imageObject(series.cover, space, manifest);

  return [
    {
      "@context": "https://schema.org",
      "@type": "CreativeWorkSeries",
      ...(url ? { "@id": `${url}#series` } : {}),
      name: series.title,
      description: series.description,
      url,
      ...(coverImg ? { image: toImageObject(coverImg) } : {}),
      author: buildAuthor(series),
      publisher: buildPublisher(space, manifest),
      datePublished: series.publishedAt,
      dateModified: series.updatedAt,
      inLanguage: series.language,
      keywords: series.tags.join(", "),
      hasPart,
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      ...(url ? { "@id": `${url}#website`, url } : {}),
      name: series.title,
      description: series.description,
      inLanguage: series.language,
      publisher: buildPublisher(space, manifest),
    },
  ];
}

function buildChapterJsonLd(args: {
  chapter: LoadedChapter;
  space: LoadedBlogSpace;
  pageUrl: string;
  wordCount: number;
  coverImage?: { url: string; width?: number; height?: number };
  manifest: AssetManifest;
}): unknown[] {
  const { chapter, space, pageUrl, wordCount, coverImage, manifest } = args;
  const series = space.series;
  const baseUrl = series.site?.baseUrl?.replace(/\/$/, "");
  const basePath = series.site?.basePath ?? "/";
  const absUrl = baseUrl ? `${baseUrl}${basePath.replace(/\/$/, "")}${pageUrl}` : undefined;
  const seriesUrl = baseUrl ? `${baseUrl}${basePath}` : undefined;
  const fm = chapter.frontmatter;
  const aboutTopics = fm.ai.topics?.length ? fm.ai.topics : undefined;

  return [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      ...(absUrl ? { "@id": absUrl } : {}),
      headline: fm.title,
      description: fm.ai.summary ?? fm.summary,
      abstract: fm.summary,
      datePublished: fm.publishedAt,
      dateModified: fm.updatedAt ?? fm.publishedAt,
      author: buildAuthor(series),
      publisher: buildPublisher(space, manifest),
      inLanguage: series.language,
      ...(coverImage ? { image: toImageObject(coverImage) } : {}),
      url: absUrl,
      mainEntityOfPage: absUrl,
      wordCount,
      articleSection: series.theme,
      keywords: fm.tags.join(", "),
      ...(aboutTopics ? { about: aboutTopics.map((t) => ({ "@type": "Thing", name: t })) } : {}),
      isPartOf: {
        "@type": "CreativeWorkSeries",
        name: series.title,
        url: seriesUrl,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: series.title,
          item: seriesUrl,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: chapter.frontmatter.title,
          item: absUrl,
        },
      ],
    },
  ];
}

/** Crude plain-text extraction for embeddings and llms-full.txt. */
function bodyToPlainText(tree: { children: { type: string; value?: string; children?: unknown[] }[] }): string {
  const out: string[] = [];
  const walk = (n: { type: string; value?: string; children?: unknown[] }) => {
    if (n.type === "text" && typeof n.value === "string") out.push(n.value);
    if (n.children) for (const c of n.children) walk(c as typeof n);
  };
  walk(tree as unknown as typeof tree.children[number]);
  return out.join("").replace(/\s+/g, " ").trim();
}

export function renderWorkspaceIndex(spaces: Series[]): string {
  const cardsHtml = spaces.map((space) => {
    const coverUrl = space.cover ? `./${space.id}/${space.cover.replace(/^\.\//, "")}` : "";
    const href = `./${space.id}/index.html`;
    const authorName = typeof space.author === "string" ? space.author : space.author.name;
    
    let coverHtml = "";
    if (coverUrl) {
      coverHtml = `<div class="thumb"><img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(space.title)}" loading="lazy" /></div>`;
    }
    
    const cardClass = coverUrl ? "chapter-card chapter-card--with-cover" : "chapter-card";
    
    return `<li class="${cardClass}">
<a href="${escapeHtml(href)}">
${coverHtml}
<div class="chapter-card__body">
<h2 class="chapter-card__title">${escapeHtml(space.title)}</h2>
<p class="chapter-card__summary">${escapeHtml(space.description || "")}</p>
<time>by ${escapeHtml(authorName)}</time>
</div>
</a>
</li>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf7"/>
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#14120e"/>
<title>Blog Sphere</title>
<meta name="description" content="A collection of series and journals"/>
<style>${VIEWER_CSS}</style>
</head>
<body>
<header class="site-header">
  <span class="site-title">Blog Sphere</span>
</header>
<main id="main" tabindex="-1">
  <section class="series-intro">
    <h1>Blog Sphere</h1>
    <p class="series-description">A collection of series and journals</p>
  </section>
  <ol class="chapter-list">
    ${cardsHtml}
  </ol>
</main>
<footer class="site-footer">
  <p>Powered by <a href="https://github.com/google-antigravity/blogspace" style="color: inherit;">Blogspace</a></p>
</footer>
</body>
</html>
`;
}
