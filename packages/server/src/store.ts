import type { ChapterFrontmatter, Series } from "@blogspace/schemas";
import {
  chapterFrontmatterSchema,
  seriesSchema,
} from "@blogspace/schemas";
import type { Workspace } from "./fs-ops.js";
import { applyJsonPatches, applyTextDelta } from "./edits.js";
import type {
  ChangeDelta,
  EditPayload,
  JsonPatchOp,
  ResourceRef,
  ResourceSnapshot,
} from "./types.js";
import { resourceKey } from "./types.js";

export interface SubscriberHandle {
  id: number;
  send(msg: unknown): void;
}

/**
 * In-memory state for a single open chapter file. Body and frontmatter are
 * two *resources* the editor can edit independently, but they share one
 * file on disk, so the store coordinates writes between them.
 */
interface OpenChapter {
  spaceId: string;
  slug: string;
  body: string;
  frontmatter: ChapterFrontmatter;
  /** Independent version counters per resource. */
  bodyVersion: number;
  frontmatterVersion: number;
  flushedBodyVersion: number;
  flushedFrontmatterVersion: number;
  pendingAcks: PendingAck[];
  flushTimer: NodeJS.Timeout | null;
  flushing: Promise<void> | null;
  bodySubs: Set<SubscriberHandle>;
  frontmatterSubs: Set<SubscriberHandle>;
}

interface OpenSeries {
  spaceId: string;
  series: Series;
  version: number;
  flushedVersion: number;
  pendingAcks: PendingAck[];
  flushTimer: NodeJS.Timeout | null;
  flushing: Promise<void> | null;
  subs: Set<SubscriberHandle>;
}

interface PendingAck {
  conn: SubscriberHandle;
  /** Which resource this ack covers — multiple resources may share a flush. */
  resource: ResourceRef;
  version: number;
  clientSeq: number;
}

const FLUSH_DEBOUNCE_MS = 50;

/** Current time as an ISO-8601 timestamp — the `updatedAt` stamp source. */
function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  private chapters = new Map<string, OpenChapter>();
  private series = new Map<string, OpenSeries>();

  constructor(private workspace: Workspace) {}

  async open(resource: ResourceRef, sub: SubscriberHandle): Promise<ResourceSnapshot & { version: number }> {
    if (resource.kind === "series") {
      const state = await this.openSeries(resource.spaceId);
      state.subs.add(sub);
      return { kind: "json", value: state.series, version: state.version };
    }
    const chapter = await this.openChapter(resource.spaceId, resource.slug);
    if (resource.kind === "chapter-body") {
      chapter.bodySubs.add(sub);
      return { kind: "text", text: chapter.body, version: chapter.bodyVersion };
    }
    chapter.frontmatterSubs.add(sub);
    return { kind: "json", value: chapter.frontmatter, version: chapter.frontmatterVersion };
  }

  async close(resource: ResourceRef, sub: SubscriberHandle): Promise<void> {
    if (resource.kind === "series") {
      const state = this.series.get(resource.spaceId);
      if (!state) return;
      state.subs.delete(sub);
      state.pendingAcks = state.pendingAcks.filter((p) => p.conn !== sub);
      if (state.subs.size === 0) {
        // See note in chapter close — keep state, just flush.
        await this.flushSeries(state);
      }
      return;
    }
    const key = `${resource.spaceId}/${resource.slug}`;
    const chapter = this.chapters.get(key);
    if (!chapter) return;
    if (resource.kind === "chapter-body") chapter.bodySubs.delete(sub);
    else chapter.frontmatterSubs.delete(sub);
    chapter.pendingAcks = chapter.pendingAcks.filter(
      (p) => !(p.conn === sub && resourceKey(p.resource) === resourceKey(resource)),
    );
    if (chapter.bodySubs.size === 0 && chapter.frontmatterSubs.size === 0) {
      // Flush but DON'T evict. Keeping the version counter alive across
      // brief subscription gaps (React StrictMode double-invoke, WS
      // reconnects, chapter switches) avoids spurious version-mismatch
      // errors that would otherwise force a full document re-hydration
      // and reset the user's cursor to position 0. Memory is bounded by
      // the number of chapters the user touches in one session — fine
      // for the single-author scope.
      await this.flushChapter(chapter);
    }
  }

  applyEdit(
    resource: ResourceRef,
    fromVersion: number,
    edit: EditPayload,
    clientSeq: number,
    sub: SubscriberHandle,
  ): { version: number } {
    if (resource.kind === "series") {
      return this.applySeriesEdit(resource, fromVersion, edit, clientSeq, sub);
    }
    return this.applyChapterEdit(resource, fromVersion, edit, clientSeq, sub);
  }

  async flushAll(): Promise<void> {
    await Promise.all([
      ...[...this.chapters.values()].map((c) => this.flushChapter(c)),
      ...[...this.series.values()].map((s) => this.flushSeries(s)),
    ]);
  }

  /**
   * Drop all in-memory state for a space without flushing. Call this right
   * before deleting the space's directory on disk — any pending flush
   * would otherwise race the delete and recreate files (or fail noisily).
   *
   * Subscribers still attached when this is invoked will get no further
   * acks; they're expected to be cleaned up by the editor closing the
   * resources once the space is gone.
   */
  /**
   * Flush pending edits for a chapter (and its space's series) then drop
   * the chapter from memory. Used before a slug rename so bytes on disk
   * match what the author sees and the old map key can go away.
   */
  async prepareChapterRename(spaceId: string, fromSlug: string): Promise<void> {
    const key = `${spaceId}/${fromSlug}`;
    const chapter = this.chapters.get(key);
    if (chapter) {
      if (chapter.flushTimer) {
        clearTimeout(chapter.flushTimer);
        chapter.flushTimer = null;
      }
      await this.flushChapter(chapter);
      this.chapters.delete(key);
    }
    const series = this.series.get(spaceId);
    if (series) {
      if (series.flushTimer) {
        clearTimeout(series.flushTimer);
        series.flushTimer = null;
      }
      await this.flushSeries(series);
    }
  }

  /** Keep in-memory series.chapters in sync after a slug rename on disk. */
  patchSeriesChapterSlug(spaceId: string, fromSlug: string, toSlug: string): void {
    const series = this.series.get(spaceId);
    if (!series) return;
    series.series = {
      ...series.series,
      chapters: series.series.chapters.map((s) => (s === fromSlug ? toSlug : s)),
    };
  }

  /** REST createChapter wrote a new slug to series.yaml — mirror it for open WS subs. */
  appendSeriesChapter(spaceId: string, slug: string): void {
    const state = this.series.get(spaceId);
    if (!state || state.series.chapters.includes(slug)) return;
    state.series = { ...state.series, chapters: [...state.series.chapters, slug] };
    this.notifySeriesSubs(state);
  }

  /** REST deleteChapter removed a slug from series.yaml — mirror it for open WS subs. */
  removeSeriesChapter(spaceId: string, slug: string): void {
    const state = this.series.get(spaceId);
    if (!state) return;
    state.series = {
      ...state.series,
      chapters: state.series.chapters.filter((s) => s !== slug),
    };
    this.notifySeriesSubs(state);
  }

  /** Drop chapter state after REST delete so a stale body/frontmatter can't flush back. */
  evictChapter(spaceId: string, slug: string): void {
    const key = `${spaceId}/${slug}`;
    const chapter = this.chapters.get(key);
    if (!chapter) return;
    if (chapter.flushTimer) clearTimeout(chapter.flushTimer);
    this.chapters.delete(key);
  }

  evictSpace(spaceId: string): void {
    for (const [key, chapter] of this.chapters) {
      if (chapter.spaceId !== spaceId) continue;
      if (chapter.flushTimer) clearTimeout(chapter.flushTimer);
      this.chapters.delete(key);
    }
    const series = this.series.get(spaceId);
    if (series) {
      if (series.flushTimer) clearTimeout(series.flushTimer);
      this.series.delete(spaceId);
    }
  }

  /* ------------- chapters -------------- */

  private async openChapter(spaceId: string, slug: string): Promise<OpenChapter> {
    const key = `${spaceId}/${slug}`;
    let chapter = this.chapters.get(key);
    if (chapter) return chapter;
    const { frontmatter, body } = await this.workspace.readChapter(spaceId, slug);
    chapter = {
      spaceId,
      slug,
      body,
      frontmatter,
      bodyVersion: 0,
      frontmatterVersion: 0,
      flushedBodyVersion: 0,
      flushedFrontmatterVersion: 0,
      pendingAcks: [],
      flushTimer: null,
      flushing: null,
      bodySubs: new Set(),
      frontmatterSubs: new Set(),
    };
    this.chapters.set(key, chapter);
    return chapter;
  }

  private applyChapterEdit(
    resource: Extract<ResourceRef, { kind: "chapter-body" | "chapter-frontmatter" }>,
    fromVersion: number,
    edit: EditPayload,
    clientSeq: number,
    sub: SubscriberHandle,
  ): { version: number } {
    const key = `${resource.spaceId}/${resource.slug}`;
    const chapter = this.chapters.get(key);
    if (!chapter) throw new Error("chapter not open");

    if (resource.kind === "chapter-body") {
      if (edit.kind !== "text") throw new Error("chapter-body requires a text edit");
      if (fromVersion !== chapter.bodyVersion) {
        throw new VersionMismatchError(
          `body fromVersion=${fromVersion} server=${chapter.bodyVersion}`,
        );
      }
      chapter.body = applyTextDelta(chapter.body, edit.changes);
      chapter.bodyVersion += 1;
      chapter.pendingAcks.push({ conn: sub, resource, version: chapter.bodyVersion, clientSeq });
      this.scheduleChapterFlush(chapter);
      return { version: chapter.bodyVersion };
    }

    // chapter-frontmatter — JSON patches against the parsed frontmatter.
    if (edit.kind !== "json") throw new Error("chapter-frontmatter requires a json edit");
    if (fromVersion !== chapter.frontmatterVersion) {
      throw new VersionMismatchError(
        `frontmatter fromVersion=${fromVersion} server=${chapter.frontmatterVersion}`,
      );
    }
    const candidate = applyJsonPatches(chapter.frontmatter, edit.patches as JsonPatchOp[]);
    const validated = chapterFrontmatterSchema.safeParse(candidate);
    if (!validated.success) {
      throw new ValidationError(`patched frontmatter is invalid: ${validated.error.message}`);
    }
    chapter.frontmatter = validated.data;
    chapter.frontmatterVersion += 1;
    chapter.pendingAcks.push({
      conn: sub,
      resource,
      version: chapter.frontmatterVersion,
      clientSeq,
    });
    this.scheduleChapterFlush(chapter);
    return { version: chapter.frontmatterVersion };
  }

  private scheduleChapterFlush(chapter: OpenChapter): void {
    if (chapter.flushTimer) return;
    chapter.flushTimer = setTimeout(() => {
      chapter.flushTimer = null;
      void this.flushChapter(chapter).catch((err) =>
        this.emitFlushError(chapter.pendingAcks, err),
      );
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushChapter(chapter: OpenChapter): Promise<void> {
    if (chapter.flushing) {
      await chapter.flushing;
      return;
    }
    const bodyDirty = chapter.bodyVersion !== chapter.flushedBodyVersion;
    const fmDirty = chapter.frontmatterVersion !== chapter.flushedFrontmatterVersion;
    if (!bodyDirty && !fmDirty && chapter.pendingAcks.length === 0) return;
    if (chapter.flushTimer) {
      clearTimeout(chapter.flushTimer);
      chapter.flushTimer = null;
    }
    const targetBody = chapter.bodyVersion;
    const targetFm = chapter.frontmatterVersion;
    // Stamp last-modified on any real content change (body OR frontmatter).
    // Done at flush, not on every keystroke, and WITHOUT bumping the
    // frontmatter version — the editor neither sends nor displays
    // `updatedAt`, so silently persisting it can't desync the client's
    // version counter. This is the single source that feeds dateModified,
    // OG article:modified_time, the sitemap <lastmod>, and the footer.
    if (bodyDirty || fmDirty) {
      chapter.frontmatter = { ...chapter.frontmatter, updatedAt: nowIso() };
    }
    chapter.flushing = (async () => {
      try {
        await this.workspace.writeChapter(
          chapter.spaceId,
          chapter.slug,
          chapter.frontmatter,
          chapter.body,
        );
        chapter.flushedBodyVersion = targetBody;
        chapter.flushedFrontmatterVersion = targetFm;
        this.drainAcks(chapter.pendingAcks, (a) =>
          a.resource.kind === "chapter-body"
            ? a.version <= targetBody
            : a.version <= targetFm,
        );
        chapter.pendingAcks = chapter.pendingAcks.filter((a) =>
          a.resource.kind === "chapter-body"
            ? a.version > targetBody
            : a.version > targetFm,
        );
      } finally {
        chapter.flushing = null;
      }
    })();
    await chapter.flushing;
  }

  /* ------------- series -------------- */

  private notifySeriesSubs(state: OpenSeries): void {
    if (state.subs.size === 0) return;
    const resource: ResourceRef = { kind: "series", spaceId: state.spaceId };
    const msg = {
      type: "opened" as const,
      resource,
      content: { kind: "json" as const, value: state.series },
      version: state.version,
    };
    for (const sub of state.subs) sub.send(msg);
  }

  private async openSeries(spaceId: string): Promise<OpenSeries> {
    let state = this.series.get(spaceId);
    if (state) return state;
    const series = await this.workspace.readSeries(spaceId);
    state = {
      spaceId,
      series,
      version: 0,
      flushedVersion: 0,
      pendingAcks: [],
      flushTimer: null,
      flushing: null,
      subs: new Set(),
    };
    this.series.set(spaceId, state);
    return state;
  }

  private applySeriesEdit(
    resource: Extract<ResourceRef, { kind: "series" }>,
    fromVersion: number,
    edit: EditPayload,
    clientSeq: number,
    sub: SubscriberHandle,
  ): { version: number } {
    const state = this.series.get(resource.spaceId);
    if (!state) throw new Error("series not open");
    if (edit.kind !== "json") throw new Error("series requires a json edit");
    if (fromVersion !== state.version) {
      throw new VersionMismatchError(
        `series fromVersion=${fromVersion} server=${state.version}`,
      );
    }
    const candidate = applyJsonPatches(state.series, edit.patches as JsonPatchOp[]);
    const validated = seriesSchema.safeParse(candidate);
    if (!validated.success) {
      throw new ValidationError(`patched series.yaml is invalid: ${validated.error.message}`);
    }
    state.series = validated.data;
    state.version += 1;
    state.pendingAcks.push({ conn: sub, resource, version: state.version, clientSeq });
    this.scheduleSeriesFlush(state);
    return { version: state.version };
  }

  private scheduleSeriesFlush(state: OpenSeries): void {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void this.flushSeries(state).catch((err) =>
        this.emitFlushError(state.pendingAcks, err),
      );
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushSeries(state: OpenSeries): Promise<void> {
    if (state.flushing) {
      await state.flushing;
      return;
    }
    const dirty = state.version !== state.flushedVersion;
    if (!dirty && state.pendingAcks.length === 0) return;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    const target = state.version;
    // See the chapter flush note — stamp series last-modified on real
    // changes only, without touching the version counter.
    if (dirty) {
      state.series = { ...state.series, updatedAt: nowIso() };
    }
    state.flushing = (async () => {
      try {
        await this.workspace.writeSeries(state.spaceId, state.series);
        state.flushedVersion = target;
        this.drainAcks(state.pendingAcks, (a) => a.version <= target);
        state.pendingAcks = state.pendingAcks.filter((a) => a.version > target);
      } finally {
        state.flushing = null;
      }
    })();
    await state.flushing;
  }

  /* ------------- ack draining -------------- */

  /**
   * Per (subscriber, resource), coalesce to the highest version and emit
   * one `ack`. The client treats any ack as "everything earlier is safely
   * flushed" — exactly one ack per resource per flush is enough.
   */
  private drainAcks(acks: PendingAck[], shouldAck: (a: PendingAck) => boolean): void {
    const last = new Map<string, PendingAck>();
    for (const a of acks) {
      if (!shouldAck(a)) continue;
      const k = `${a.conn.id}|${resourceKey(a.resource)}`;
      const prev = last.get(k);
      if (!prev || a.version > prev.version) last.set(k, a);
    }
    for (const a of last.values()) {
      a.conn.send({
        type: "ack",
        resource: a.resource,
        version: a.version,
        clientSeq: a.clientSeq,
      });
    }
  }

  private emitFlushError(acks: PendingAck[], err: unknown): void {
    const seen = new Set<string>();
    for (const a of acks) {
      const k = `${a.conn.id}|${resourceKey(a.resource)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      a.conn.send({
        type: "error",
        code: "write-failed",
        message: (err as Error).message,
        resource: a.resource,
      });
    }
  }
}

export class VersionMismatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "VersionMismatchError";
  }
}
export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

// Re-export so the WS layer can import types from here too.
export type { ChangeDelta, JsonPatchOp };
