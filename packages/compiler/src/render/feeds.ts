import { escapeHtml, normalizeRef } from "../util.js";
import type { LoadedBlogSpace, ChapterGraph, AssetManifest } from "../types.js";
import type { RenderedChapter } from "./pages.js";

/**
 * Compute the public absolute URL for a page, given series.site config.
 * Falls back to the page path if no site is configured (relative-only output).
 */
function pageUrl(space: LoadedBlogSpace, path: string): string {
  const base = space.series.site?.baseUrl?.replace(/\/$/, "") ?? "";
  const bp = (space.series.site?.basePath ?? "/").replace(/\/$/, "");
  return `${base}${bp}${path}`;
}

/** Compute the chapter URL, falling back to slug.html if missing from the graph. */
function chapterUrl(space: LoadedBlogSpace, graph: ChapterGraph, slug: string): string {
  const filename = graph.get(slug)?.outputFilename ?? `${slug}.html`;
  return pageUrl(space, `/chapters/${filename}`);
}

function authorName(space: LoadedBlogSpace): string {
  const a = space.series.author;
  return typeof a === "string" ? a : a.name;
}

/** Largest jpeg variant of an image ref, as an absolute (or root) URL. */
function imageUrl(
  space: LoadedBlogSpace,
  manifest: AssetManifest,
  ref: string | undefined,
): string | undefined {
  if (!ref) return undefined;
  if (/^https?:\/\//.test(ref)) return ref;
  const img = manifest.images.get(normalizeRef(ref));
  if (!img) return undefined;
  const best = [...img.variants].filter((v) => v.format === "jpeg").sort((a, b) => b.width - a.width)[0];
  if (!best) return undefined;
  return pageUrl(space, `/${best.outputPath}`);
}

export function renderSitemap(
  space: LoadedBlogSpace,
  graph: ChapterGraph,
  manifest: AssetManifest,
): string {
  const indexEntry = `<url><loc>${escapeHtml(pageUrl(space, "/"))}</loc>${
    space.series.updatedAt ?? space.series.publishedAt
      ? `<lastmod>${escapeHtml(space.series.updatedAt ?? space.series.publishedAt!)}</lastmod>`
      : ""
  }</url>`;
  const chapterEntries = space.chapters.map((c) => {
    const loc = chapterUrl(space, graph, c.slug);
    const lastmod = c.frontmatter.updatedAt ?? c.frontmatter.publishedAt;
    // Image sitemap extension: surface the chapter's cover (or its
    // fallback first-body image, carried on the graph node) so the photos
    // are discoverable by image search, not just the page.
    const cover = c.frontmatter.cover ?? graph.get(c.slug)?.cover;
    const imgUrl = imageUrl(space, manifest, cover);
    return `<url><loc>${escapeHtml(loc)}</loc>${lastmod ? `<lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}${
      imgUrl
        ? `<image:image><image:loc>${escapeHtml(imgUrl)}</image:loc><image:title>${escapeHtml(c.frontmatter.title)}</image:title></image:image>`
        : ""
    }</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${[indexEntry, ...chapterEntries].join("\n")}
</urlset>`;
}

/**
 * robots.txt. This blog WANTS to be indexed by both search and AI
 * crawlers, so we're explicitly permissive: a wildcard allow plus named
 * allows for the major AI/search agents (a positive signal — silence is
 * sometimes treated as ambiguous). Points crawlers at both the sitemap
 * and the llms.txt manifest.
 */
export function renderRobots(space: LoadedBlogSpace): string {
  const sitemapUrl = pageUrl(space, "/sitemap.xml");
  const llmsUrl = pageUrl(space, "/llms.txt");
  // Agents we explicitly welcome. Listing them is a deliberate opt-in for
  // AI training/retrieval; flip any to Disallow to opt a crawler out.
  const aiAgents = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-Web",
    "Google-Extended",
    "PerplexityBot",
    "CCBot",
    "Applebot-Extended",
  ];
  const aiBlocks = aiAgents.map((ua) => `User-agent: ${ua}\nAllow: /\n`).join("\n");
  return `User-agent: *
Allow: /

${aiBlocks}
# LLM-friendly content manifest
# ${llmsUrl}

Sitemap: ${sitemapUrl}
`;
}

export function renderRss(
  space: LoadedBlogSpace,
  graph: ChapterGraph,
  manifest: AssetManifest,
): string {
  const series = space.series;
  const author = authorName(space);
  const items = space.chapters
    .map((ch) => {
      const url = chapterUrl(space, graph, ch.slug);
      // GUID is a STABLE slug-based identity, decoupled from the URL so a
      // future URL-scheme change can't re-surface every item as brand new
      // in subscribers' readers. The <link> points at the live URL.
      const guid = pageUrl(space, `/chapters/${ch.slug}`);
      const date = ch.frontmatter.publishedAt
        ? new Date(ch.frontmatter.publishedAt).toUTCString()
        : "";
      const updated = ch.frontmatter.updatedAt ?? ch.frontmatter.publishedAt;
      return `<item>
<title>${escapeHtml(ch.frontmatter.title)}</title>
<link>${escapeHtml(url)}</link>
<guid isPermaLink="false">${escapeHtml(guid)}</guid>
<dc:creator>${escapeHtml(author)}</dc:creator>
<description>${escapeHtml(ch.frontmatter.summary)}</description>
${date ? `<pubDate>${escapeHtml(date)}</pubDate>` : ""}
${updated ? `<atom:updated>${escapeHtml(new Date(updated).toISOString())}</atom:updated>` : ""}
${ch.frontmatter.tags.map((t) => `<category>${escapeHtml(t)}</category>`).join("")}
</item>`;
    })
    .join("\n");
  const coverUrl = imageUrl(space, manifest, series.cover);
  const homeUrl = pageUrl(space, "/");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${escapeHtml(series.title)}</title>
<link>${escapeHtml(homeUrl)}</link>
<atom:link href="${escapeHtml(pageUrl(space, "/rss.xml"))}" rel="self" type="application/rss+xml"/>
<description>${escapeHtml(series.description)}</description>
<language>${escapeHtml(series.language)}</language>
<managingEditor>${escapeHtml(author)}</managingEditor>
${coverUrl ? `<image><url>${escapeHtml(coverUrl)}</url><title>${escapeHtml(series.title)}</title><link>${escapeHtml(homeUrl)}</link></image>` : ""}
${series.updatedAt ? `<lastBuildDate>${escapeHtml(new Date(series.updatedAt).toUTCString())}</lastBuildDate>` : ""}
${items}
</channel>
</rss>`;
}

/**
 * llms.txt — short manifest pointing AI crawlers at the structured content.
 * Chapter URLs use the same stable `<slug>.html` filenames as the rest of
 * the output so an AI fetching this manifest follows live URLs without 404s.
 */
export function renderLlmsTxt(space: LoadedBlogSpace, graph: ChapterGraph): string {
  const series = space.series;
  const author = authorName(space);
  const publisher = series.publisher?.name;
  const chapters = space.chapters
    .map((c) => {
      const fm = c.frontmatter;
      // Prefer the dense, retrieval-tuned AI summary when present; fall
      // back to the human card summary otherwise.
      const blurb = fm.ai.summary?.trim() || fm.summary;
      const meta: string[] = [];
      if (fm.publishedAt) meta.push(`published ${fm.publishedAt.slice(0, 10)}`);
      if (fm.updatedAt && fm.updatedAt !== fm.publishedAt) meta.push(`updated ${fm.updatedAt.slice(0, 10)}`);
      if (fm.tags.length) meta.push(`tags: ${fm.tags.join(", ")}`);
      if (fm.ai.topics?.length) meta.push(`topics: ${fm.ai.topics.join(", ")}`);
      const metaLine = meta.length ? `\n  ${meta.join(" · ")}` : "";
      return `- [${fm.title}](${chapterUrl(space, graph, c.slug)}): ${blurb}${metaLine}`;
    })
    .join("\n");
  return `# ${series.title}

> ${series.description}

Author: ${author}
${publisher ? `Publisher: ${publisher}` : ""}
${series.publishedAt ? `Published: ${series.publishedAt}` : ""}
${series.updatedAt ? `Updated: ${series.updatedAt}` : ""}
Language: ${series.language}
${series.tags.length ? `Tags: ${series.tags.join(", ")}` : ""}
${series.license ? `License: ${series.license}` : ""}

## Chapters

${chapters}

## Full text

A plain-text concatenation of every chapter is available at /llms-full.txt.
`.replace(/\n{3,}/g, "\n\n");
}

export function renderLlmsFullTxt(
  space: LoadedBlogSpace,
  rendered: RenderedChapter[],
): string {
  const series = space.series;
  const author = authorName(space);
  const sections = rendered.map((r) => {
    const ch = space.chapters.find((c) => c.slug === r.slug);
    if (!ch) return "";
    const fm = ch.frontmatter;
    // Front-load each chapter with structured metadata so a model reading
    // the concatenation can ground dates/topics/entities without parsing
    // them out of prose.
    const meta: string[] = [];
    if (fm.publishedAt) meta.push(`Published: ${fm.publishedAt.slice(0, 10)}`);
    if (fm.updatedAt && fm.updatedAt !== fm.publishedAt) meta.push(`Updated: ${fm.updatedAt.slice(0, 10)}`);
    if (fm.tags.length) meta.push(`Tags: ${fm.tags.join(", ")}`);
    if (fm.ai.topics?.length) meta.push(`Topics: ${fm.ai.topics.join(", ")}`);
    if (fm.ai.entities?.length) meta.push(`Entities: ${fm.ai.entities.join(", ")}`);
    const metaBlock = meta.length ? `${meta.join("\n")}\n\n` : "";
    const summary = fm.ai.summary?.trim() || fm.summary;
    return `# ${fm.title}

${metaBlock}${summary}

${r.plainText}
`;
  });
  return `# ${series.title}

${series.description}

Author: ${author}
${series.publishedAt ? `Published: ${series.publishedAt}` : ""}${series.updatedAt ? `\nUpdated: ${series.updatedAt}` : ""}

${sections.join("\n\n---\n\n")}`.replace(/\n{4,}/g, "\n\n\n");
}

/**
 * Cloudflare Pages `_headers` file — the caching contract for the static
 * output. It lives at the deploy root and is honoured by Pages (and is a
 * harmless plain file on any other host).
 *
 * The strategy pairs with stable `<slug>.html` URLs:
 *   - HTML revalidates on every request (`max-age=0, must-revalidate`).
 *     Since the URL no longer changes when a chapter is edited, freshness
 *     is delivered by revalidation: the browser sends If-None-Match /
 *     If-Modified-Since and gets a cheap 304 when nothing changed, or the
 *     new bytes when it did. No stale chapter is ever served.
 *   - Asset variants under /assets/ are treated as immutable and cached
 *     for a year. Their names encode width+format and Cloudflare Pages
 *     snapshots each deploy, so a returning visitor reuses them for free.
 *     (Caveat: re-uploading a *different* image to the same source path
 *     keeps the variant filename, so a year-cached client could see the
 *     old bytes until its TTL lapses. Acceptable for a personal blog; the
 *     fix, if it ever matters, is content-hashed variant names.)
 *   - Feeds/manifests get a short shared TTL so crawlers see updates
 *     within the hour without hammering the origin.
 * Security headers (`nosniff`, a conservative referrer policy) ride along
 * for every path since this file is the one place they can be set on a
 * static deploy.
 */
export function renderHeaders(): string {
  return `# Generated by Blogspace. Cloudflare Pages caching + security headers.
 
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
 
# HTML always revalidates — URLs are stable, so freshness comes from 304s.
/
  Cache-Control: public, max-age=0, must-revalidate
/**/*.html
  Cache-Control: public, max-age=0, must-revalidate
 
# Immutable, width/format-keyed asset variants — cache for a year.
/**/assets/**
  Cache-Control: public, max-age=31536000, immutable
 
# Viewer manifests and chat config in nested blog folders.
/**/manifest.json
  Cache-Control: public, max-age=0, must-revalidate
/**/chat-config.json
  Cache-Control: public, max-age=0, must-revalidate
 
# Feeds, manifests and AI files — short shared cache, revalidate hourly.
/sitemap.xml
  Cache-Control: public, max-age=3600
/rss.xml
  Cache-Control: public, max-age=3600
/**/llms.txt
/**/llms-full.txt
  Cache-Control: public, max-age=3600
`;
}
