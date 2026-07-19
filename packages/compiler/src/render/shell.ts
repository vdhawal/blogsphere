import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, jsonLdSafe, relativeUrl, formatDate } from "../util.js";
import type { LoadedBlogSpace, AssetManifest, ChapterGraph } from "../types.js";
import type { Series, Seo } from "@blogspace/schemas";

// Inline at compile time: eliminates the render-blocking CSS round-trip.
const VIEWER_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../static/viewer.css"),
  "utf8",
);

export interface ShellInput {
  pageUrl: string; // absolute-from-root, e.g. /chapters/01-arrival.html
  title: string;
  description: string;
  bodyHtml: string;
  /** Full SEO bundle. Optional fields fall back to series-level defaults. */
  seo: Seo;
  ogType: "article" | "website";
  /** ISO date for article-level meta. */
  publishedAt?: string;
  updatedAt?: string;
  tags?: string[];
  /** Cover image (space-root-relative) for OG card. */
  cover?: string;
  /** Section/category for the article (we use the series theme). */
  articleSection?: string;
  /** Page-relative URL of the previous chapter, for <link rel="prev">. */
  prevUrl?: string;
  /** Page-relative URL of the next chapter, for <link rel="next">. */
  nextUrl?: string;
  /** JSON-LD blocks to inject. Already-shaped objects, stringified safely. */
  jsonLd: unknown[];
  space: LoadedBlogSpace;
  manifest: AssetManifest;
  /** Provides outputFilename per chapter so the site header TOC links
   *  match the stable filenames on disk. */
  graph: ChapterGraph;
  /** Optional page-level header HTML, between site header and main content. */
  pageHeaderHtml?: string;
  /** Optional page-level footer HTML (e.g. prev/next nav, backlinks). */
  pageFooterHtml?: string;
}

// Theme-color values mirror viewer.css's light/dark backgrounds so the
// browser chrome (mobile address bar, tab strip) matches the page.
const THEME_COLOR_LIGHT = "#fbfaf7";
const THEME_COLOR_DARK = "#14120e";

export function renderShell(input: ShellInput): string {
  const series = input.space.series;
  const baseUrl = series.site?.baseUrl;
  const basePath = series.site?.basePath ?? "/";
  const rawCanonical = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}${joinBase(basePath, input.pageUrl)}`
    : input.seo.canonical;
  // Cloudflare Pages (and most hosts) serve the root as "/" not "/index.html"
  // and redirect /index.html → /. Normalise so the canonical matches the real
  // served URL, avoiding the redirect chain + "alternate page" GSC warnings.
  const canonical = rawCanonical?.replace(/\/index\.html$/, "/");

  const ogImage = pickOgImage(input.seo.ogImage ?? input.cover, input.manifest, baseUrl, basePath);
  const lang = series.language || "en";
  const author = typeof series.author === "string" ? series.author : series.author.name;

  const description = (input.seo.description ?? input.description).trim();
  const title = (input.seo.title ?? input.title).trim();

  // Asset URLs relative to the current page
  const jsHref = relativeUrl(input.pageUrl, "/assets/viewer.js");

  const rssHref = relativeUrl(input.pageUrl, "/rss.xml");
  const faviconHref = relativeUrl(input.pageUrl, "/favicon.svg");

  const ogTags = renderOgTags({
    title,
    description,
    canonical,
    ogImage: ogImage?.absolute ?? ogImage?.relative,
    ogImageWidth: ogImage?.width,
    ogImageHeight: ogImage?.height,
    ogType: input.ogType,
    siteName: series.title,
    locale: lang,
    author,
    publishedAt: input.publishedAt,
    updatedAt: input.updatedAt,
    section: input.articleSection,
    tags: input.tags,
    twitterCard: input.seo.social?.cardType ?? "summary_large_image",
    twitterHandle: input.seo.social?.twitter,
  });

  const jsonLdBlocks = input.jsonLd
    .map((obj) => `<script type="application/ld+json">${jsonLdSafe(obj)}</script>`)
    .join("\n  ");

  const header = renderSiteHeader(series, input.pageUrl, input.graph);
  const footer = renderSiteFooter(series, author);

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR_LIGHT}"/>
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR_DARK}"/>
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"/>` : ""}
${input.seo.noindex ? '<meta name="robots" content="noindex,nofollow"/>' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1"/>'}
${input.seo.keywords?.length ? `<meta name="keywords" content="${escapeHtml(input.seo.keywords.join(", "))}"/>` : ""}
<meta name="author" content="${escapeHtml(author)}"/>
${input.prevUrl ? `<link rel="prev" href="${escapeHtml(input.prevUrl)}"/>` : ""}
${input.nextUrl ? `<link rel="next" href="${escapeHtml(input.nextUrl)}"/>` : ""}
${ogTags}
<link rel="icon" href="${faviconHref}" type="image/svg+xml"/>
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(series.title)} — RSS" href="${rssHref}"/>
<style>${VIEWER_CSS}</style>
${jsonLdBlocks}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
${header}
<main id="main" tabindex="-1">
${input.pageHeaderHtml ?? ""}
${input.bodyHtml}
${input.pageFooterHtml ?? ""}
</main>
${footer}
${renderViewerChatStub(input.pageUrl)}
<script src="${jsHref}" defer></script>
</body>
</html>`;
}

/**
 * Empty chat-panel scaffolding. viewer.js fetches chat-config.json and
 * decides whether to populate this with the full panel (chat enabled) or
 * leave it hidden (no chatProxyUrl configured). We emit the structural
 * skeleton at render time so there's no layout shift when JS lights up.
 */
function renderViewerChatStub(pageUrl: string): string {
  void pageUrl;
  return `<aside class="reader-chat" id="reader-chat" hidden>
<button class="reader-chat__toggle" type="button" aria-expanded="false" aria-controls="reader-chat__body">
<span class="reader-chat__title">Ask about this blog</span>
<span class="reader-chat__caret" aria-hidden="true">▴</span>
</button>
<div class="reader-chat__body" id="reader-chat__body" hidden>
<div class="reader-chat__log" role="log" aria-live="polite"></div>
<form class="reader-chat__form">
<textarea rows="2" placeholder="Ask a question…" aria-label="Your question"></textarea>
<button type="submit" class="reader-chat__send">Send</button>
</form>
<div class="reader-chat__hint"></div>
</div>
</aside>`;
}

/**
 * A tiny self-contained SVG favicon: the series' first initial on a
 * themed rounded tile. Generated rather than requiring the author to
 * upload an icon, and SVG so it scales to any tab/bookmark size without
 * shipping a sharp-resized PNG ladder. `prefers-color-scheme` swaps the
 * tile to match the page palette.
 */
export function renderFaviconSvg(series: Series): string {
  const initial = escapeHtml((series.title.trim()[0] ?? "B").toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeHtml(series.title)}">
<style>
  .bg { fill: ${THEME_COLOR_DARK}; }
  .fg { fill: ${THEME_COLOR_LIGHT}; }
  @media (prefers-color-scheme: light) {
    .bg { fill: ${THEME_COLOR_LIGHT}; }
    .fg { fill: ${THEME_COLOR_DARK}; }
  }
</style>
<rect class="bg" width="64" height="64" rx="14"/>
<text class="fg" x="32" y="33" font-family="Georgia, 'Times New Roman', serif" font-size="38" font-weight="700" text-anchor="middle" dominant-baseline="central">${initial}</text>
</svg>`;
}

function renderOgTags(o: {
  title: string;
  description: string;
  canonical?: string;
  ogImage?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  ogType: string;
  siteName: string;
  locale: string;
  author: string;
  publishedAt?: string;
  updatedAt?: string;
  section?: string;
  tags?: string[];
  twitterCard: string;
  twitterHandle?: string;
}): string {
  const isArticle = o.ogType === "article";
  const lines = [
    `<meta property="og:type" content="${escapeHtml(o.ogType)}"/>`,
    `<meta property="og:site_name" content="${escapeHtml(o.siteName)}"/>`,
    `<meta property="og:locale" content="${escapeHtml(toOgLocale(o.locale))}"/>`,
    `<meta property="og:title" content="${escapeHtml(o.title)}"/>`,
    `<meta property="og:description" content="${escapeHtml(o.description)}"/>`,
    o.canonical ? `<meta property="og:url" content="${escapeHtml(o.canonical)}"/>` : "",
    o.ogImage ? `<meta property="og:image" content="${escapeHtml(o.ogImage)}"/>` : "",
    o.ogImage ? `<meta property="og:image:alt" content="${escapeHtml(o.title)}"/>` : "",
    o.ogImage && o.ogImageWidth ? `<meta property="og:image:width" content="${o.ogImageWidth}"/>` : "",
    o.ogImage && o.ogImageHeight ? `<meta property="og:image:height" content="${o.ogImageHeight}"/>` : "",
    isArticle ? `<meta property="article:author" content="${escapeHtml(o.author)}"/>` : "",
    isArticle && o.section ? `<meta property="article:section" content="${escapeHtml(o.section)}"/>` : "",
    o.publishedAt ? `<meta property="article:published_time" content="${escapeHtml(o.publishedAt)}"/>` : "",
    o.updatedAt ? `<meta property="article:modified_time" content="${escapeHtml(o.updatedAt)}"/>` : "",
    ...(o.tags ?? []).map((t) => `<meta property="article:tag" content="${escapeHtml(t)}"/>`),
    `<meta name="twitter:card" content="${escapeHtml(o.twitterCard)}"/>`,
    `<meta name="twitter:title" content="${escapeHtml(o.title)}"/>`,
    `<meta name="twitter:description" content="${escapeHtml(o.description)}"/>`,
    o.ogImage ? `<meta name="twitter:image" content="${escapeHtml(o.ogImage)}"/>` : "",
    o.ogImage ? `<meta name="twitter:image:alt" content="${escapeHtml(o.title)}"/>` : "",
    o.twitterHandle ? `<meta name="twitter:site" content="${escapeHtml(o.twitterHandle)}"/>` : "",
    o.twitterHandle ? `<meta name="twitter:creator" content="${escapeHtml(o.twitterHandle)}"/>` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Map a BCP-47 language tag to an OpenGraph locale (`xx_XX`). OG wants an
 * underscore-joined locale; we best-effort uppercase any region subtag and
 * leave a bare language as-is (Facebook tolerates `en`).
 */
function toOgLocale(lang: string): string {
  const [l, region] = lang.replace("_", "-").split("-");
  return region ? `${l!.toLowerCase()}_${region.toUpperCase()}` : (l ?? "en");
}

function renderSiteHeader(series: Series, pageUrl: string, graph: ChapterGraph): string {
  // Link to "/" not "/index.html" — most hosts redirect /index.html → /.
  const homeHref = relativeUrl(pageUrl, "/");
  const links = series.chapters
    .map((slug) => {
      const filename = graph.get(slug)?.outputFilename ?? `${slug}.html`;
      const href = relativeUrl(pageUrl, `/chapters/${filename}`);
      const isCurrent = pageUrl === `/chapters/${filename}`;
      return `<li${isCurrent ? ' aria-current="page"' : ""}><a href="${href}">${escapeHtml(slug)}</a></li>`;
    })
    .join("");
  return `<header class="site-header">
<a class="site-title" href="${homeHref}">${escapeHtml(series.title)}</a>
<nav class="site-nav" aria-label="Chapters">
<ol class="chapter-toc">${links}</ol>
</nav>
</header>`;
}

function renderSiteFooter(series: Series, author: string): string {
  return `<footer class="site-footer">
<p>${escapeHtml(series.title)} · by ${escapeHtml(author)}${series.license ? ` · ${escapeHtml(series.license)}` : ""}</p>
${series.updatedAt ? `<p class="updated">Last updated <time datetime="${escapeHtml(series.updatedAt)}">${escapeHtml(formatDate(series.updatedAt, series.language))}</time></p>` : ""}
</footer>`;
}

function pickOgImage(
  ref: string | undefined,
  manifest: AssetManifest,
  baseUrl?: string,
  basePath: string = "/",
): { relative: string; absolute?: string; width?: number; height?: number } | undefined {
  if (!ref) return undefined;
  if (/^https?:\/\//.test(ref)) return { relative: ref, absolute: ref };
  const normalized = ref.replace(/^\.\//, "").replace(/^\//, "");
  const img = manifest.images.get(normalized);
  if (!img) return undefined;
  const best = [...img.variants]
    .filter((v) => v.format === "jpeg")
    .sort((a, b) => b.width - a.width)[0];
  if (!best) return undefined;
  const rel = `/${best.outputPath}`;
  const abs = baseUrl ? `${baseUrl.replace(/\/$/, "")}${joinBase(basePath, rel)}` : undefined;
  return { relative: rel, absolute: abs, width: best.width, height: best.height };
}

function joinBase(basePath: string, path: string): string {
  const left = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}
