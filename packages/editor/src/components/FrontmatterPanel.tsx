import { useEffect, useRef, useState } from "react";
import * as jsonpatch from "fast-json-patch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWsClient } from "../ws";
import { api } from "../api";
import { useAiStatus } from "../ai";
import { CoverCropDialog } from "./CoverCropDialog";
import { PageSettings } from "./PageSettings";
import type { ChapterFrontmatterShape, ImageAsset, ResourceRef } from "../types";
import { resourceKey } from "../types";

interface Props {
  spaceId: string;
  slug: string;
  onSlugChanged: (slug: string) => void;
}

/**
 * Edits chapter frontmatter as a structured form. Every commit computes a
 * JSON Patch (RFC 6902) diff against the last-known-good state and ships
 * it through the same WS edit pipeline as text edits. The save spinner
 * tracks this resource independently of the body.
 */
export function FrontmatterPanel({ spaceId, slug, onSlugChanged }: Props) {
  const resource: ResourceRef = { kind: "chapter-frontmatter", spaceId, slug };

  const [draft, setDraft] = useState<ChapterFrontmatterShape | null>(null);
  const [showPageSettings, setShowPageSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  // Surfaced when the server rejects a save (e.g. an AI-generated field that
  // overshot a schema bound). Previously these were console.error-only, so a
  // failed persist looked like success to the author.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Last known server state — the base we compute patches against.
  const baselineRef = useRef<ChapterFrontmatterShape | null>(null);
  const versionRef = useRef(0);
  const clientSeqRef = useRef(0);
  const hydratingRef = useRef(false);

  useEffect(() => {
    setShowPageSettings(false);
    setSaving(false);
    // Reset per-chapter transient state when the slug changes (the panel is
    // reused across chapters, not remounted).
    setSaveError(null);
    const ws = getWsClient();
    const unsubResource = ws.subscribe(resource, (msg) => {
      if (msg.type === "opened" && msg.content.kind === "json") {
        versionRef.current = msg.version;
        hydratingRef.current = true;
        const fm = msg.content.value as ChapterFrontmatterShape;
        baselineRef.current = jsonpatch.deepClone(fm);
        setDraft(fm);
        hydratingRef.current = false;
      } else if (msg.type === "ack" && baselineRef.current) {
        // Server has the latest. Re-base patches against the current draft so
        // we don't re-send them.
        baselineRef.current = jsonpatch.deepClone(currentRef.current!);
        setSaveError(null);
      } else if (msg.type === "error") {
        if (msg.code === "version-mismatch") {
          // Stale base — resync from the server. The reopened snapshot
          // re-bases us; the unsaved local edit is intentionally dropped
          // (single-writer model), so flag it rather than lose it silently.
          ws.close(resource);
          ws.open(resource);
          setSaveError("This chapter changed elsewhere — reloaded from disk; re-apply your last change.");
        } else {
          // validation-failed / invalid-edit / write-failed. The edit did
          // NOT persist; tell the author instead of failing silently.
          console.error("[frontmatter]", msg.code, msg.message);
          setSaveError(
            msg.code === "validation-failed"
              ? "Couldn't save — a field exceeded its allowed length or format. Try shortening it."
              : `Couldn't save (${msg.code}).`,
          );
        }
      }
    });
    const sendOpen = () => ws.open(resource);
    const unsubConn = ws.onConnected(sendOpen);
    sendOpen();
    return () => {
      unsubResource();
      unsubConn();
      ws.close(resource);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, slug]);

  useEffect(() => {
    const bodyRes: ResourceRef = { kind: "chapter-body", spaceId, slug };
    const fmRes: ResourceRef = { kind: "chapter-frontmatter", spaceId, slug };
    const ws = getWsClient();
    return ws.onInflightChange((map) => {
      const total = (map.get(resourceKey(bodyRes)) ?? 0) + (map.get(resourceKey(fmRes)) ?? 0);
      setSaving(total > 0);
    });
  }, [spaceId, slug]);

  // Track latest draft for the ack-rebase above — useState doesn't expose
  // its value to event listeners synchronously.
  const currentRef = useRef<ChapterFrontmatterShape | null>(null);
  useEffect(() => {
    currentRef.current = draft;
  }, [draft]);

  function commit(next: ChapterFrontmatterShape) {
    setDraft(next);
    if (hydratingRef.current || !baselineRef.current) return;
    const patches = jsonpatch.compare(baselineRef.current, next) as Parameters<
      ReturnType<typeof getWsClient>["sendJsonEdit"]
    >[3];
    if (patches.length === 0) return;
    const fromVersion = versionRef.current;
    versionRef.current = fromVersion + 1;
    clientSeqRef.current += 1;
    getWsClient().sendJsonEdit(resource, fromVersion, clientSeqRef.current, patches);
  }

  if (!draft) {
    return (
      <aside className="app__panel">
        <div className="panel__loading">Loading frontmatter…</div>
      </aside>
    );
  }

  const setSeo = (patch: Partial<ChapterFrontmatterShape["seo"]>) =>
    setDraft({ ...draft, seo: { ...draft.seo, ...patch } });
  const setAi = (patch: Partial<ChapterFrontmatterShape["ai"]>) =>
    setDraft({ ...draft, ai: { ...draft.ai, ...patch } });

  const applyValue = (
    field: "seoTitle" | "seoDescription" | "summary" | "aiMetadata" | "tags",
    value: unknown,
  ) => {
    let next: ChapterFrontmatterShape;
    if (field === "seoTitle") next = { ...draft, seo: { ...draft.seo, title: String(value) } };
    else if (field === "seoDescription") next = { ...draft, seo: { ...draft.seo, description: String(value) } };
    else if (field === "summary") next = { ...draft, summary: String(value) };
    else if (field === "tags") {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      // Append-only — keep manually-curated tags, dedupe.
      next = { ...draft, tags: Array.from(new Set([...draft.tags, ...arr])) };
    } else {
      const v = value as { summary?: string; topics?: string[]; entities?: string[] };
      next = {
        ...draft,
        ai: {
          summary: v.summary ?? draft.ai.summary,
          topics: v.topics ?? draft.ai.topics,
          entities: v.entities ?? draft.ai.entities,
        },
      };
    }
    setDraft(next);
    commit(next);
  };

  return (
    <aside className="app__panel">
      <div className="panel__toolbar">
        <button
          className="btn btn--small"
          onClick={() => setShowPageSettings(true)}
          title="Change URL slug and other page-level settings"
        >
          Page settings
        </button>
      </div>
      {saveError && (
        <div className="panel__save-error" role="alert">
          <span>{saveError}</span>
          <button className="btn btn--small btn--ghost" onClick={() => setSaveError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <Section title="Basic">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onBlur={() => commit(draft)}
          />
        </Field>
        <Field
          label="Summary"
          ai={<AiGen spaceId={spaceId} slug={slug} field="summary" featureKey="chapterSummary" onValue={(v) => applyValue("summary", v)} />}
        >
          <textarea
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            onBlur={() => commit(draft)}
            rows={2}
          />
        </Field>
        <Field label="Cover image">
          <CoverField
            value={draft.cover}
            spaceId={spaceId}
            slug={slug}
            onChange={(next) => {
              const updated = { ...draft, cover: next };
              setDraft(updated);
              commit(updated);
            }}
          />
        </Field>
        <Field label="Published">
          <input
            type="date"
            value={(draft.publishedAt ?? "").slice(0, 10)}
            onChange={(e) => {
              const next = { ...draft, publishedAt: e.target.value || undefined };
              setDraft(next);
              commit(next);
            }}
          />
        </Field>
        <Field
          label="Tags (comma-separated)"
          ai={<AiGen spaceId={spaceId} slug={slug} field="tags" featureKey="tagSuggestions" onValue={(v) => applyValue("tags", v)} />}
        >
          <CsvInput
            value={draft.tags}
            onCommit={(next) => {
              const updated = { ...draft, tags: next };
              setDraft(updated);
              commit(updated);
            }}
          />
        </Field>
      </Section>

      <Section title="SEO">
        <Field
          label="SEO title"
          ai={<AiGen spaceId={spaceId} slug={slug} field="seoTitle" featureKey="seoTitle" onValue={(v) => applyValue("seoTitle", v)} />}
        >
          <input
            value={draft.seo.title ?? ""}
            onChange={(e) => setSeo({ title: e.target.value || undefined })}
            onBlur={() => commit(draft)}
            placeholder="Inherits chapter title"
          />
        </Field>
        <Field
          label="Meta description"
          ai={<AiGen spaceId={spaceId} slug={slug} field="seoDescription" featureKey="seoDescription" onValue={(v) => applyValue("seoDescription", v)} />}
        >
          <textarea
            value={draft.seo.description ?? ""}
            onChange={(e) => setSeo({ description: e.target.value || undefined })}
            onBlur={() => commit(draft)}
            rows={2}
            placeholder="Up to ~155 characters"
          />
        </Field>
        <Field label="Keywords">
          <CsvInput
            value={draft.seo.keywords ?? []}
            onCommit={(next) => {
              const updated = {
                ...draft,
                seo: { ...draft.seo, keywords: next.length ? next : undefined },
              };
              setDraft(updated);
              commit(updated);
            }}
          />
        </Field>
        <Field label="OG image (path)">
          <input
            value={draft.seo.ogImage ?? ""}
            onChange={(e) => setSeo({ ogImage: e.target.value || undefined })}
            onBlur={() => commit(draft)}
          />
        </Field>
        <Field label="Noindex">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={!!draft.seo.noindex}
              onChange={(e) => {
                const next = { ...draft, seo: { ...draft.seo, noindex: e.target.checked } };
                setDraft(next);
                commit(next);
              }}
            />
            <span>exclude from search engines</span>
          </label>
        </Field>
      </Section>

      <Section
        title="AI metadata"
        action={
          <AiGen
            spaceId={spaceId}
            slug={slug}
            field="aiMetadata"
            featureKey="aiMetadata"
            label="Generate all"
            onValue={(v) => applyValue("aiMetadata", v)}
          />
        }
      >
        <Field label="Summary (for AI agents)">
          <textarea
            value={draft.ai.summary ?? ""}
            onChange={(e) => setAi({ summary: e.target.value || undefined })}
            onBlur={() => commit(draft)}
            rows={3}
          />
        </Field>
        <Field label="Topics">
          <CsvInput
            value={draft.ai.topics ?? []}
            onCommit={(next) => {
              const updated = {
                ...draft,
                ai: { ...draft.ai, topics: next.length ? next : undefined },
              };
              setDraft(updated);
              commit(updated);
            }}
          />
        </Field>
        <Field label="Entities">
          <CsvInput
            value={draft.ai.entities ?? []}
            onCommit={(next) => {
              const updated = {
                ...draft,
                ai: { ...draft.ai, entities: next.length ? next : undefined },
              };
              setDraft(updated);
              commit(updated);
            }}
          />
        </Field>
      </Section>

      {(draft.generated.seo || draft.generated.ai) && (
        <Section title="Generation provenance" muted>
          {draft.generated.seo && (
            <p className="panel__provenance">
              <strong>SEO</strong> last generated by {draft.generated.seo.model} on{" "}
              {new Date(draft.generated.seo.at).toLocaleDateString()}.
            </p>
          )}
          {draft.generated.ai && (
            <p className="panel__provenance">
              <strong>AI metadata</strong> last generated by {draft.generated.ai.model} on{" "}
              {new Date(draft.generated.ai.at).toLocaleDateString()}.
            </p>
          )}
        </Section>
      )}
      {showPageSettings && (
        <PageSettings
          spaceId={spaceId}
          slug={slug}
          saving={saving}
          onClose={() => setShowPageSettings(false)}
          onRenamed={onSlugChanged}
        />
      )}
    </aside>
  );
}

function Section({
  title,
  children,
  muted,
  action,
}: {
  title: string;
  children: React.ReactNode;
  muted?: boolean;
  /** Optional inline action (e.g. AI "Generate all" button). */
  action?: React.ReactNode;
}) {
  return (
    <section className={`panel-section ${muted ? "panel-section--muted" : ""}`}>
      <div className="panel-section__header">
        <h3 className="panel-section__title">{title}</h3>
        {action}
      </div>
      <div className="panel-section__body">{children}</div>
    </section>
  );
}

/**
 * AI-generate button that dispatches the unified frontmatter generation
 * endpoint and pipes the response through `onValue`. Hidden when AI is
 * disabled or the matching feature flag is off — so it never blocks the
 * existing manual-edit flow.
 */
function AiGen({
  spaceId,
  slug,
  field,
  featureKey,
  label = "AI",
  onValue,
}: {
  spaceId: string;
  slug: string;
  field: "seoTitle" | "seoDescription" | "summary" | "aiMetadata" | "tags";
  featureKey:
    | "seoTitle"
    | "seoDescription"
    | "chapterSummary"
    | "aiMetadata"
    | "tagSuggestions";
  label?: string;
  onValue: (value: unknown) => void;
}) {
  const status = useAiStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status?.enabled || !status.features[featureKey]) return null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { value } = await api.aiGenerateFrontmatter(spaceId, slug, field);
      onValue(value);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="field__ai">
      <button
        type="button"
        className="btn btn--small"
        onClick={run}
        disabled={busy}
        title={error ?? `Generate via AI`}
      >
        {busy ? "…" : label}
      </button>
      {error && <span className="field__ai-error" title={error}>⚠</span>}
    </span>
  );
}

/**
 * Cover input + upload button. Empty cover falls back to the chapter's
 * first body image at compile time, so an explicit value only matters
 * when the author wants an override. After upload, sets cover to the
 * returned space-root-relative path (prefixed with `./` to match how
 * paths appear in markdown).
 */
function CoverField({
  value,
  spaceId,
  slug,
  onChange,
}: {
  value?: string;
  spaceId: string;
  slug: string;
  onChange: (next: string | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Asset for the cropper dialog. When set, the dialog is open with this
  // asset as its source — `pending.originalRef` is what we fall back to if
  // the author hits "Skip cropping" or "Cancel" after a fresh upload (so
  // the upload isn't wasted).
  const [pending, setPending] = useState<
    { asset: ImageAsset; originalRef: string } | null
  >(null);

  const queryClient = useQueryClient();
  const manifest = useQuery({
    queryKey: ["assets", spaceId],
    queryFn: () => api.listAssets(spaceId),
  });

  const normalized = (value ?? "").replace(/^\.\//, "").replace(/^\//, "");
  const match = manifest.data?.assets.find(
    (a): a is ImageAsset => a.kind === "image" && a.sourcePath === normalized,
  );

  async function handlePick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0]!;
    setUploading(true);
    setError(null);
    try {
      const res = await api.uploadAssets(spaceId, slug, [file]);
      const saved = res.saved[0];
      if (!saved) return;
      // Refresh the manifest cache so the cropper sees the new asset and the
      // CoverPreview tile reflects it without a manual reload.
      queryClient.invalidateQueries({ queryKey: ["assets", spaceId] });
      if (saved.entry.kind === "image") {
        setPending({ asset: saved.entry, originalRef: saved.assetRef });
      } else {
        // Non-image (shouldn't reach here given the accept filter) — just set it.
        onChange(saved.assetRef);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function reCrop() {
    if (!match) return;
    setPending({ asset: match, originalRef: `./${match.sourcePath}` });
  }

  return (
    <div className="cover-field">
      <div className="cover-field__row">
        <input
          className="cover-field__path"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="auto: first body image"
        />
        <button
          type="button"
          className="btn btn--small"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? "Uploading…" : "Upload…"}
        </button>
        {match && (
          <button
            type="button"
            className="btn btn--small"
            onClick={reCrop}
            title="Pick a new crop region from this image"
          >
            Crop…
          </button>
        )}
        {value && (
          <button
            type="button"
            className="btn btn--small btn--ghost"
            onClick={() => onChange(undefined)}
            title="Clear — fall back to first body image"
          >
            Clear
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => handlePick(e.target.files)}
      />
      {error && <p className="field__error">{error}</p>}
      <CoverPreview asset={match} spaceId={spaceId} />
      {!value && (
        <p className="field__hint">
          Leave empty to use the chapter's first body image on the home page.
        </p>
      )}
      {pending && (
        <CoverCropDialog
          spaceId={spaceId}
          slug={slug}
          asset={pending.asset}
          originalRef={pending.originalRef}
          onCancel={() => {
            // If this was the post-upload step and the cover was unset,
            // fall back to the original upload — don't strand the asset.
            if (!value) onChange(pending.originalRef);
            setPending(null);
          }}
          onSkip={(ref) => {
            onChange(ref);
            setPending(null);
          }}
          onCropped={(ref) => {
            onChange(ref);
            queryClient.invalidateQueries({ queryKey: ["assets", spaceId] });
            setPending(null);
          }}
        />
      )}
    </div>
  );
}

function CoverPreview({ asset, spaceId }: { asset: ImageAsset | undefined; spaceId: string }) {
  if (!asset) return null;
  const smallJpeg = [...asset.variants]
    .filter((v) => v.format === "jpeg")
    .sort((a, b) => a.width - b.width)[0];
  const path = smallJpeg?.path ?? asset.sourcePath;
  return (
    <div
      className="cover-field__preview"
      style={{ background: blurhashToColor(asset.blurhash) }}
    >
      <img
        src={api.workspaceAssetUrl(spaceId, path)}
        alt={`Cover preview: ${asset.sourcePath}`}
        loading="lazy"
        decoding="async"
      />
      <span className="cover-field__meta">
        {asset.width}×{asset.height}
      </span>
    </div>
  );
}

function blurhashToColor(hash: string): string {
  let s = 0;
  for (let i = 0; i < hash.length; i++) s = (s * 31 + hash.charCodeAt(i)) >>> 0;
  const hue = s % 360;
  return `hsl(${hue}, 40%, 70%)`;
}

function Field({
  label,
  children,
  ai,
}: {
  label: string;
  children: React.ReactNode;
  ai?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__row">
        <span className="field__label">{label}</span>
        {ai}
      </span>
      {children}
    </label>
  );
}

/**
 * Input for a string-array field that uses a comma-separated raw text
 * representation. Holds the user's typed text locally in state so spaces
 * and partial commas survive while the user is mid-keystroke — the
 * previous controlled-array round-trip ate any character that didn't
 * survive split/trim/filter (i.e. trailing spaces and the comma itself).
 *
 * The committed value is the parsed array, surfaced only on blur. Stays
 * in sync when the parent's `value` changes from outside (e.g. an AI
 * generator filling the field).
 */
function CsvInput({
  value,
  onCommit,
  placeholder,
}: {
  value: string[];
  onCommit: (next: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => value.join(", "));
  const lastExternalRef = useRef(value.join(", "));
  // External updates (AI fill, "Clear", reload) overwrite local text —
  // but only when they actually differ from what we last reflected
  // outward, so user typing isn't fought by the controlled prop.
  useEffect(() => {
    const incoming = value.join(", ");
    if (incoming !== lastExternalRef.current) {
      setText(incoming);
      lastExternalRef.current = incoming;
    }
  }, [value]);

  const commit = () => {
    const parsed = text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const next = parsed.join(", ");
    lastExternalRef.current = next;
    // Reflect the normalized form back into the visible input — so
    // trailing whitespace / orphan commas tidy up on blur, without
    // hampering typing.
    if (next !== text) setText(next);
    onCommit(parsed);
  };

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      {...(placeholder ? { placeholder } : {})}
    />
  );
}
