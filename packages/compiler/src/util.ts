import { posix, relative as nodeRelative } from "node:path";

/**
 * Escape a string for safe insertion as HTML text or attribute content.
 * Conservative — escapes everything that could break out of either context.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * Escape a JSON string for safe embedding inside <script type="application/ld+json">.
 * Prevents `</script>` in content from breaking out of the script tag, and
 * line/paragraph separators from breaking JS parsing in older engines.
 */
export function jsonLdSafe(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/**
 * Compute a POSIX path from one output file to another, relative to the
 * first. Always use forward slashes (we're writing for the web).
 */
export function relativeUrl(fromUrl: string, toUrl: string): string {
  const fromDir = posix.dirname(fromUrl);
  const rel = posix.relative(fromDir, toUrl);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Normalize a path reference from markdown to a space-root-relative path.
 * Strips leading `./`. Errors if the path tries to escape the space.
 */
export function normalizeRef(ref: string): string {
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("//")) {
    return ref;
  }
  let r = ref.replace(/^\.\//, "");
  if (r.startsWith("/")) r = r.slice(1);
  if (r.includes("..")) {
    throw new Error(`Asset reference may not contain '..': ${ref}`);
  }
  return r;
}

/**
 * Slug-ify a heading text into an anchor id.
 * Matches the way most markdown renderers slug headings — lowercase,
 * non-alphanumerics to hyphens, collapsed. Strips combining marks.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Pretty-format an ISO date for human display in HTML.
 */
export function formatDate(iso: string, locale = "en"): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Filesystem-safe join that always returns POSIX (output paths are URLs).
 */
export const joinUrl = (...parts: string[]): string =>
  posix.join(...parts).replace(/^\/+/, "");

export { nodeRelative };
