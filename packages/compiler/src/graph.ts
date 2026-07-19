import type { LoadedBlogSpace } from "./types.js";
import type { ChapterGraph, ChapterGraphNode } from "./types.js";
import type { ParsedChapter } from "./markdown.js";

/**
 * Build the chapter graph: prev/next from series.yaml order, inbound/outbound
 * from wikilinks and chapter-link directives, plus the stable
 * `outputFilename` (`<slug>.html`) for each chapter. The compiler renders
 * this once and threads it through every renderer so URLs are consistent
 * across all outputs (chapter HTML, index, sitemap, manifest, RSS, llms.txt).
 */
export function buildGraph(
  space: LoadedBlogSpace,
  parsed: ParsedChapter[],
): ChapterGraph {
  const graph: ChapterGraph = new Map();
  const order = space.series.chapters;

  for (let i = 0; i < order.length; i++) {
    const slug = order[i];
    if (!slug) continue;
    const ch = space.chapters.find((c) => c.slug === slug);
    if (!ch) continue;
    // Fall back to the chapter's first body image so the home page can
    // still show a thumbnail when the author hasn't set an explicit cover.
    const p = parsed.find((x) => x.slug === slug);
    const cover = ch.frontmatter.cover ?? p?.firstBodyImage;
    const node: ChapterGraphNode = {
      slug,
      title: ch.frontmatter.title,
      summary: ch.frontmatter.summary,
      cover,
      publishedAt: ch.frontmatter.publishedAt,
      prev: i > 0 ? order[i - 1] : undefined,
      next: i < order.length - 1 ? order[i + 1] : undefined,
      outbound: [],
      inbound: [],
      outputFilename: `${slug}.html`,
    };
    graph.set(slug, node);
  }

  // Fill outbound from parsed chapters, then derive inbound.
  for (const p of parsed) {
    const node = graph.get(p.slug);
    if (!node) continue;
    node.outbound = p.outboundChapterSlugs.filter((s) => graph.has(s) && s !== p.slug);
  }
  for (const [slug, node] of graph) {
    for (const out of node.outbound) {
      const target = graph.get(out);
      if (target && !target.inbound.includes(slug)) {
        target.inbound.push(slug);
      }
    }
  }

  return graph;
}
