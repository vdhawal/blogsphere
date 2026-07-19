import type {
  AiStatusShape,
  AssetEntry,
  AssetManifestShape,
  ChapterDetail,
  ChapterFrontmatterShape,
  FactCheckFinding,
  ChatHistoryShape,
  MediaReportShape,
  MediaStatusShape,
  SpaceDetail,
  SpaceSummary,
  SpellGrammarSuggestion,
  ExportSettingsShape,
} from "./types";

async function json<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  workspace: () =>
    json<{ root: string; spaces: SpaceSummary[] }>(fetch("/api/workspace")),

  space: (spaceId: string) =>
    json<SpaceDetail>(fetch(`/api/spaces/${spaceId}`)),

  chapter: (spaceId: string, slug: string) =>
    json<ChapterDetail>(fetch(`/api/spaces/${spaceId}/chapters/${slug}`)),

  createSpace: (input: {
    id: string;
    title: string;
    description: string;
    theme: string;
    author: string;
  }) =>
    json<SpaceDetail>(
      fetch("/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),

  createChapter: (
    spaceId: string,
    input: { slug: string; title: string; summary: string },
  ) =>
    json<{ frontmatter: ChapterFrontmatterShape; body: string }>(
      fetch(`/api/spaces/${spaceId}/chapters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),

  deleteChapter: (spaceId: string, slug: string) =>
    json<{ ok: true }>(
      fetch(`/api/spaces/${spaceId}/chapters/${slug}`, { method: "DELETE" }),
    ),

  renameChapter: (spaceId: string, slug: string, newSlug: string) =>
    json<{ slug: string }>(
      fetch(`/api/spaces/${spaceId}/chapters/${slug}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newSlug }),
      }),
    ),

  deleteSpace: (spaceId: string) =>
    json<{ ok: true }>(fetch(`/api/spaces/${spaceId}`, { method: "DELETE" })),

  /**
   * Upload one or more files to a chapter's asset folder. Returns the
   * relative paths the editor should insert into markdown.
   */
  uploadAssets: async (
    spaceId: string,
    slug: string,
    files: File[],
  ): Promise<{ saved: { assetRef: string; entry: AssetEntry }[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    return json(fetch(`/api/spaces/${spaceId}/assets/${slug}`, {
      method: "POST",
      body: fd,
    }));
  },

  /** Fetch the asset manifest for a space (drives the picker UI). */
  listAssets: (spaceId: string) =>
    json<AssetManifestShape>(fetch(`/api/spaces/${spaceId}/assets`)),

  mediaReport: (spaceId: string, slug?: string) =>
    json<MediaReportShape>(
      fetch(
        `/api/spaces/${spaceId}/media/report${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`,
      ),
    ),

  mediaStatus: (spaceId: string) =>
    json<MediaStatusShape>(fetch(`/api/spaces/${spaceId}/media/status`)),

  ensureMedia: (spaceId: string) =>
    json<{ repaired: string[]; warnings: string[] }>(
      fetch(`/api/spaces/${spaceId}/media/ensure`, { method: "POST" }),
    ),

  /** Patch alt text / caption on an existing asset (no variant churn). */
  patchAsset: (
    spaceId: string,
    input: { source: string; alt?: string; caption?: string },
  ) =>
    json<AssetManifestShape>(
      fetch(`/api/spaces/${spaceId}/assets`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),

  /**
   * Crop a source image into a new cover-sized asset. `crop` coords are
   * in source-image pixels. Returns the new assetRef the editor should
   * write into the chapter's `cover` frontmatter field.
   */
  cropAsset: (
    spaceId: string,
    input: {
      source: string;
      slug: string;
      crop: { x: number; y: number; w: number; h: number };
    },
  ) =>
    json<{ assetRef: string; entry: AssetEntry }>(
      fetch(`/api/spaces/${spaceId}/assets/crop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),

  /** Compile + start a child-process HTTP server for the given space. */
  startPreview: (spaceId: string) =>
    json<PreviewStateShape>(
      fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceId }),
      }),
    ),

  /** Kill the active preview's child process. Idempotent. */
  stopPreview: () =>
    json<{ ok: true }>(fetch("/api/preview", { method: "DELETE" })),

  /** Returns the running preview state, or `null` if none is active. */
  getPreview: async (): Promise<PreviewStateShape | null> => {
    const res = await fetch("/api/preview");
    if (!res.ok) throw new Error(await res.text());
    const value = (await res.json()) as PreviewStateShape | null;
    return value;
  },

  /**
   * One-shot export: compiles dir + zip + PDF into
   * `<workspace>/export/<spaceId>/...` and returns the absolute paths so
   * the editor can display them to the author. Same build-cache as
   * preview, so repeat exports of unchanged content are near-instant.
   */
  exportSpace: (spaceId: string) =>
    json<ExportResultShape>(
      fetch(`/api/spaces/${spaceId}/export`, { method: "POST" }),
    ),

  /**
   * URL for the smallest reasonable variant of an asset in the workspace.
   * Returns the raw file path served through `/api/workspace-asset/`.
   * The path is space-root-relative (matches `AssetEntry.sourcePath` and
   * the `path` field on each variant).
   */
  workspaceAssetUrl: (spaceId: string, relPath: string): string => {
    const clean = relPath.replace(/^\.\//, "").replace(/^\//, "");
    return `/api/workspace-asset/${encodeURIComponent(spaceId)}/${clean
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  },

  /* ----- AI ----- */

  /** Boot-time AI capability check. Pass spaceId to get per-space feature flags. */
  aiStatus: (spaceId?: string) =>
    json<AiStatusShape>(
      fetch(`/api/ai/status${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`),
    ),

  /** Generate alt text for a manifest image. */
  aiAltText: (spaceId: string, ref: string) =>
    json<{ alt: string }>(
      fetch(`/api/spaces/${spaceId}/ai/alt-text`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref }),
      }),
    ),

  /** Generate a caption for a manifest image. */
  aiCaption: (spaceId: string, ref: string, alt?: string) =>
    json<{ caption: string }>(
      fetch(`/api/spaces/${spaceId}/ai/caption`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref, alt }),
      }),
    ),

  /** Generate a frontmatter field via the unified generate route. */
  aiGenerateFrontmatter: <T = unknown>(
    spaceId: string,
    slug: string,
    field: "seoTitle" | "seoDescription" | "summary" | "aiMetadata" | "tags",
  ) =>
    json<{ value: T }>(
      fetch(`/api/spaces/${spaceId}/ai/generate/${slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field }),
      }),
    ),

  /** Run a spell + grammar and contextual fact-check pass on the chapter body. */
  aiSpellGrammar: (spaceId: string, slug: string) =>
    json<{ suggestions: SpellGrammarSuggestion[]; factChecks: FactCheckFinding[] }>(
      fetch(`/api/spaces/${spaceId}/ai/spell-grammar/${slug}`, { method: "POST" }),
    ),

  /** Load the persisted chat history for a space. */
  aiChatHistory: (spaceId: string) =>
    json<ChatHistoryShape>(fetch(`/api/spaces/${spaceId}/ai/chat/history`)),

  /** Clear the persisted chat history. */
  aiClearChatHistory: (spaceId: string) =>
    json<{ ok: true }>(
      fetch(`/api/spaces/${spaceId}/ai/chat/history`, { method: "DELETE" }),
    ),

  /** Force-sync the chat-context PDF (re-upload on demand). */
  aiSyncContext: (spaceId: string) =>
    json<{ ok: boolean; reused: boolean; fileId?: string }>(
      fetch(`/api/spaces/${spaceId}/ai/sync-context`, { method: "POST" }),
    ),

  /** Read the live chat context state (does the next chat have a PDF attached?). */
  aiContextStatus: (spaceId: string) =>
    json<{
      activeProvider: "anthropic" | "openai" | null;
      activeModel: string | null;
      attachment: {
        fileId: string;
        fileSize: number;
        pdfHash: string;
        uploadedAt: string;
      } | null;
      pdfAvailable: boolean;
    }>(fetch(`/api/spaces/${spaceId}/ai/context-status`)),

  /** Reveal a path in the OS file browser (macOS Finder / Linux file manager / Windows Explorer). */
  reveal: (path: string) =>
    json<{ ok: true }>(
      fetch("/api/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      }),
    ),

  getExportSettings: () =>
    json<ExportSettingsShape>(fetch("/api/export/settings")),

  exportWorkspace: (spaceIds: string[]) =>
    json<ExportResultShape>(
      fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spaceIds }),
      }),
    ),
};

export interface ExportResultShape {
  dirPath: string;
  zipPath: string;
  pdfPath: string;
  parentPath: string;
  chapters: number;
  chaptersRendered: number;
  chaptersReused: number;
  imagesProcessed: number;
  pdfBytes: number;
  zipBytes: number;
  warnings: string[];
}

export interface PreviewStateShape {
  spaceId: string;
  port: number;
  startedAt: string;
  previewUrl: string;
  zipDownloadUrl: string;
  pdfDownloadUrl: string;
  chapters: number;
  images: number;
  pdfBytes: number;
  warnings: string[];
}
