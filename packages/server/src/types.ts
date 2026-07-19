import type { ChapterFrontmatter, Series } from "@blogspace/schemas";

/* ----- REST shapes -------------------------------------------------- */

export interface SpaceSummary {
  id: string;
  title: string;
  description: string;
  theme: string;
  cover?: string;
  chapterCount: number;
  updatedAt?: string;
}

export interface SpaceDetail {
  id: string;
  series: Series;
  chapters: { slug: string; title: string; summary: string; publishedAt?: string }[];
}

export interface ChapterDetail {
  slug: string;
  frontmatter: ChapterFrontmatter;
  body: string;
  version: number;
}

/* ----- WebSocket protocol -----------------------------------------------
 *
 * One unified `edit` message handles all edits. Every edit names:
 *
 *   - a `resource` — which piece of state on disk it touches
 *   - an `edit` payload — text deltas (positional) or JSON patches (structured)
 *
 * Text deltas are pure positional ops in CodeMirror 6's ChangeSet.toJSON()
 * encoding — best for free-form prose where the canonical form is the text.
 *
 * JSON Patches (RFC 6902) edit a parsed object, e.g. moving an entry in
 * series.chapters[] or replacing seo.title. Best for structured data where
 * the canonical form is the object, not its serialized text.
 *
 * Resources are versioned independently so the editor knows exactly what
 * has been durably persisted.
 * --------------------------------------------------------------------- */

export type ResourceRef =
  | { kind: "chapter-body"; spaceId: string; slug: string }
  | { kind: "chapter-frontmatter"; spaceId: string; slug: string }
  | { kind: "series"; spaceId: string };

/**
 * CodeMirror-6 ChangeSet.toJSON() encoding. There are exactly two shapes:
 *
 *   - positive `number`         → retain that many characters
 *   - `[del, ...lines]` array   → delete `del` chars, then insert the
 *                                 remaining strings joined by "\n"
 *
 * The array form is uniform regardless of how many lines are inserted —
 * CodeMirror spreads `text.toJSON()` (an array of line strings) directly
 * into the step rather than nesting it. So:
 *
 *   [0]                          → delete 0, insert nothing
 *   [5]                          → delete 5
 *   [0, "hello"]                 → insert "hello"
 *   [3, "line1", "line2"]        → delete 3, insert "line1\nline2"
 *   [2, "", "", ""]              → delete 2, insert "\n\n"
 *
 * Anything that pretends inserts are a single string field will silently
 * break the moment the author presses Enter or pastes multi-line text.
 */
export type ChangeStep = number | [number, ...string[]];
export type ChangeDelta = ChangeStep[];

/** RFC 6902 — we use a permissive shape and let fast-json-patch validate. */
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

export type WsClientMessage =
  | { type: "open"; resource: ResourceRef }
  | { type: "close"; resource: ResourceRef }
  | {
      type: "edit";
      resource: ResourceRef;
      fromVersion: number;
      clientSeq: number;
      edit: EditPayload;
    };

export type ResourceSnapshot =
  | { kind: "text"; text: string }
  | { kind: "json"; value: unknown };

export type WsServerMessage =
  | {
      type: "opened";
      resource: ResourceRef;
      content: ResourceSnapshot;
      version: number;
    }
  | {
      type: "ack";
      resource: ResourceRef;
      version: number;
      clientSeq: number;
    }
  | { type: "closed"; resource: ResourceRef }
  | {
      type: "error";
      code:
        | "version-mismatch"
        | "not-found"
        | "invalid-edit"
        | "write-failed"
        | "validation-failed"
        | "internal";
      message: string;
      resource?: ResourceRef;
    };

export function resourceKey(r: ResourceRef): string {
  return r.kind === "series" ? `${r.kind}:${r.spaceId}` : `${r.kind}:${r.spaceId}:${r.slug}`;
}
