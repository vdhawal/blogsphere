import { renderChapterBody, type ParsedChapter, type RenderContext } from "./markdown.js";
import { escapeHtml, formatDate } from "./util.js";
import type {
  AssetManifest,
  ChapterGraph,
  LoadedBlogSpace,
} from "./types.js";

/**
 * Render a single "book" HTML document: cover → table of contents →
 * every chapter, concatenated with `page-break-before: always` so a
 * headless browser renders it to one continuous PDF.
 *
 * The book reuses the standard chapter renderer (`renderChapterBody`),
 * so directives — gallery, video, map, quote-card, chapter-link — and
 * inline wikilinks serialize the same way they do for individual web
 * pages. `pageUrl` is set to `/book.html` (top of the dist tree) so
 * relative paths like `./assets/.variants/<chapter>/<name>.jpg` resolve
 * naturally when the HTML is loaded by Playwright.
 *
 * The CSS is print-tailored: A4 pages, serif body, page-break rules,
 * `<video>` hidden with a "[video]" stand-in. Chapter prev/next nav
 * and backlinks aren't emitted by `renderChapterBody` so we don't have
 * to suppress them.
 */
export function renderBookHtml(args: {
  space: LoadedBlogSpace;
  parsedChapters: ParsedChapter[];
  graph: ChapterGraph;
  manifest: AssetManifest;
  warnings: string[];
}): string {
  const { space, parsedChapters, graph, manifest, warnings } = args;
  const series = space.series;
  const author = typeof series.author === "string" ? series.author : series.author.name;
  const lang = series.language || "en";

  const chapterSections = space.chapters
    .map((chapter, idx) => {
      const parsed = parsedChapters[idx];
      if (!parsed) return "";
      const ctx: RenderContext = {
        chapterSlug: chapter.slug,
        pageUrl: "/book.html",
        manifest,
        graph,
        mapOrdinal: { value: 0 },
        headingIdsSeen: new Set(),
        warnings,
      };
      const body = renderChapterBody(parsed.tree, ctx);
      return `<section class="chapter" id="ch-${escapeHtml(chapter.slug)}">
<header class="chapter__header">
<h1>${escapeHtml(chapter.frontmatter.title)}</h1>
<p class="summary">${escapeHtml(chapter.frontmatter.summary)}</p>
${chapter.frontmatter.publishedAt ? `<p class="date"><time datetime="${escapeHtml(chapter.frontmatter.publishedAt)}">${escapeHtml(formatDate(chapter.frontmatter.publishedAt, lang))}</time></p>` : ""}
</header>
<div class="chapter__body">
${body}
</div>
</section>`;
    })
    .join("\n\n");

  const toc = space.chapters
    .map(
      (c) =>
        `<li><a href="#ch-${escapeHtml(c.slug)}">${escapeHtml(c.frontmatter.title)}</a></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(series.title)}</title>
<style>${BOOK_CSS}</style>
</head>
<body>
<section class="cover">
<h1 class="cover__title">${escapeHtml(series.title)}</h1>
<p class="cover__author">by ${escapeHtml(author)}</p>
<p class="cover__description">${escapeHtml(series.description)}</p>
${series.publishedAt ? `<p class="cover__dates"><time datetime="${escapeHtml(series.publishedAt)}">${escapeHtml(formatDate(series.publishedAt, lang))}</time></p>` : ""}
</section>

<nav class="toc">
<h2>Contents</h2>
<ol>
${toc}
</ol>
</nav>

${chapterSections}
</body>
</html>`;
}

/**
 * Print stylesheet tuned for chat-context PDFs: clean typography,
 * predictable page breaks, no chrome that would confuse a model trying
 * to summarize the prose. Keep this self-contained — book HTML is
 * generated standalone, not as part of the regular viewer bundle.
 */
const BOOK_CSS = `
@page { size: A4; margin: 1in 0.75in; }
html { font-size: 11pt; }
body {
  font-family: "Iowan Old Style", "Charter", Georgia, serif;
  line-height: 1.55;
  color: #1a1a1a;
  margin: 0;
}
h1, h2, h3, h4 { line-height: 1.2; }
p { margin: 0.5em 0; }

.cover {
  text-align: center;
  padding: 2in 0.5in 1in;
  page-break-after: always;
}
.cover__title { font-size: 32pt; margin: 0 0 0.5em; }
.cover__author { font-size: 13pt; color: #555; margin: 0.5em 0; }
.cover__description { font-size: 11pt; font-style: italic; max-width: 5in; margin: 1em auto; }
.cover__dates { font-size: 9pt; color: #888; }

.toc { page-break-after: always; padding: 0.5in 0; }
.toc h2 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 0.2em; margin-bottom: 0.5em; }
.toc ol { padding-left: 1.5em; font-size: 12pt; }
.toc li { margin: 0.4em 0; }
.toc a { text-decoration: none; color: #1a1a1a; }

.chapter { page-break-before: always; }
.chapter__header h1 { font-size: 22pt; margin: 0 0 0.2em; }
.chapter__header .summary { font-style: italic; color: #555; margin: 0 0 0.4em; }
.chapter__header .date { font-size: 9pt; color: #888; margin: 0 0 1.5em; }
.chapter__body h2 { font-size: 14pt; margin: 1.5em 0 0.3em; }
.chapter__body h3 { font-size: 12pt; margin: 1.2em 0 0.3em; }

img, picture, video { max-width: 100%; height: auto; }
figure { margin: 1em 0; break-inside: avoid; }
figcaption { font-size: 9pt; color: #666; text-align: center; margin-top: 0.4em; }

.gallery { display: grid; gap: 0.1in; margin: 1em 0; }
.gallery--single,
.gallery--carousel,
.gallery--fullbleed { grid-template-columns: 1fr; }
.gallery--tile,
.gallery--masonry { grid-template-columns: 1fr 1fr; }
.gallery__item { margin: 0; }

.quote-card {
  background: #faf6f0;
  border-left: 3px solid #b4441f;
  padding: 0.5em 1em;
  margin: 1em 0;
  break-inside: avoid;
}
.quote-card__body { font-style: italic; }
.quote-card__attr { font-size: 9pt; color: #666; margin-top: 0.5em; }
.quote-card--pulled { border-left: none; text-align: center; font-size: 14pt; padding: 0.5em 0; }
.quote-card--framed { border: 1px solid #b4441f; }

.chapter-link--card {
  display: block;
  padding: 0.5em 1em;
  background: #fbf5ee;
  margin: 1em 0;
  text-decoration: none;
  color: inherit;
  break-inside: avoid;
}
.chapter-link__cover { display: none; }
.chapter-link__eyebrow { font-size: 9pt; color: #b4441f; text-transform: uppercase; letter-spacing: 0.05em; }
.chapter-link__title { font-size: 12pt; margin: 0.2em 0; }
.chapter-link__summary { font-size: 10pt; color: #555; margin: 0; }
.chapter-link--inline, .wikilink { color: #b4441f; text-decoration: underline; }

/* Video can't render in a static PDF — emit a placeholder. */
.video video { display: none; }
.video::after {
  content: "[video — see web version]";
  display: block;
  color: #888;
  font-size: 9pt;
  text-align: center;
  padding: 0.3em;
}
.map img { background: #f0ede5; }

a { color: inherit; }
blockquote { border-left: 3px solid #b4441f; padding-left: 1em; margin: 1em 0; color: #555; }
code { background: #f4f0e8; padding: 0.05em 0.3em; border-radius: 2pt; font-family: "SF Mono", Menlo, monospace; font-size: 0.9em; }
pre { background: #f4f0e8; padding: 0.6em; border-radius: 4pt; font-size: 9pt; overflow: auto; font-family: "SF Mono", Menlo, monospace; }
pre code { background: none; padding: 0; }
`;
