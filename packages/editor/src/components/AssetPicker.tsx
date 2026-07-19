import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAiStatus } from "../ai";
import type { AssetEntry, ImageAsset, VideoAsset } from "../types";

type GalleryLayout = "tile" | "masonry" | "carousel" | "fullbleed" | "single";

interface Props {
  spaceId: string;
  onClose: () => void;
  /**
   * Called with the markdown block the editor should insert. The picker
   * doesn't dispatch the edit itself — the parent owns the EditorView and
   * inserts at the current cursor position.
   */
  onInsert: (markdownBlock: string) => void;
}

/**
 * Multi-select grid of every asset in the current space, drawn from the
 * server's asset manifest. The author picks which images/videos to compose
 * into a directive, picks a layout, and the picker emits the markdown
 * block ready to splice into the editor at the cursor.
 *
 * Videos are inserted as `::video` directives (one per selection); images
 * collapse into a single `:::gallery{layout=…}:::` block when more than
 * one is picked, or a plain markdown image when only one is.
 */
export function AssetPicker({ spaceId, onClose, onInsert }: Props) {
  const status = useAiStatus();
  const manifest = useQuery({
    queryKey: ["assets", spaceId],
    queryFn: () => api.listAssets(spaceId),
  });

  const [selected, setSelected] = useState<string[]>([]); // sourcePaths, in pick order
  const [layout, setLayout] = useState<GalleryLayout>("tile");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");

  const assets: AssetEntry[] = manifest.data?.assets ?? [];
  const visible = useMemo(
    () => assets.filter((a) => (filter === "all" ? true : a.kind === filter)),
    [assets, filter],
  );

  const toggle = (sourcePath: string) => {
    setSelected((prev) =>
      prev.includes(sourcePath) ? prev.filter((s) => s !== sourcePath) : [...prev, sourcePath],
    );
  };

  const insert = () => {
    if (selected.length === 0) return;
    const picks = selected
      .map((sp) => assets.find((a) => a.sourcePath === sp))
      .filter((a): a is AssetEntry => !!a);

    const block = composeMarkdown(picks, layout);
    onInsert(block);
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Insert from uploaded assets</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="picker__toolbar">
          <div className="picker__filters">
            {(["all", "image", "video"] as const).map((f) => (
              <button
                key={f}
                className={`btn btn--small ${filter === f ? "btn--primary" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="picker__layout">
            <label className="field__label">Layout</label>
            <select value={layout} onChange={(e) => setLayout(e.target.value as GalleryLayout)}>
              <option value="tile">tile</option>
              <option value="masonry">masonry</option>
              <option value="carousel">carousel</option>
              <option value="fullbleed">fullbleed</option>
              <option value="single">single</option>
            </select>
          </div>
        </div>

        <div className="picker__grid">
          {manifest.isLoading && <div className="panel__loading">Loading assets…</div>}
          {manifest.data && visible.length === 0 && (
            <div className="picker__empty">
              No assets uploaded yet. Drag images or videos onto the editor to upload them — they'll show up here.
            </div>
          )}
          {visible.map((a) => {
            const idx = selected.indexOf(a.sourcePath);
            return (
              <div
                key={a.sourcePath}
                className={`picker__tile ${idx >= 0 ? "picker__tile--selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => toggle(a.sourcePath)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(a.sourcePath);
                  }
                }}
              >
                <AssetThumb asset={a} spaceId={spaceId} />
                {idx >= 0 && <span className="picker__badge">{idx + 1}</span>}
                <span className="picker__label">
                  {a.sourcePath.split("/").pop()}
                  <small>
                    {a.kind} · {a.width}×{a.height}
                    {a.kind === "video" && a.durationMs ? ` · ${Math.round(a.durationMs / 1000)}s` : ""}
                  </small>
                  {a.kind === "image" && a.alt && (
                    <small className="picker__alt" title={a.alt}>
                      “{a.alt}”
                    </small>
                  )}
                </span>
                {status?.enabled && a.kind === "image" && (
                  <AssetAiActions spaceId={spaceId} asset={a} />
                )}
              </div>
            );
          })}
        </div>

        <footer className="dialog__actions">
          <div className="picker__count">{selected.length} selected</div>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={insert}
            disabled={selected.length === 0}
          >
            Insert
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Per-tile AI actions row. Click stops propagation so it doesn't toggle
 * the tile selection. On success we mutate the assets query cache so the
 * new alt/caption shows up immediately under the thumbnail label.
 */
function AssetAiActions({ spaceId, asset }: { spaceId: string; asset: ImageAsset }) {
  const [busy, setBusy] = useState<"alt" | "caption" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useAiStatus();
  const queryClient = useQueryClient();

  async function genAlt(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy("alt");
    setError(null);
    try {
      const { alt } = await api.aiAltText(spaceId, asset.sourcePath);
      await api.patchAsset(spaceId, { source: asset.sourcePath, alt });
      queryClient.invalidateQueries({ queryKey: ["assets", spaceId] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function genCaption(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy("caption");
    setError(null);
    try {
      const { caption } = await api.aiCaption(spaceId, asset.sourcePath, asset.alt);
      // Caption isn't on ImageAsset schema directly — surface to the user
      // so they can paste into a figcaption or a quote block. (Schema
      // extension for image captions is a deferred R3 item.)
      window.alert(`Caption: ${caption}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="picker__ai" onClick={(e) => e.stopPropagation()}>
      {status?.features.altText && (
        <button
          type="button"
          className="btn btn--small"
          onClick={genAlt}
          disabled={busy !== null}
          title="Generate alt text via AI"
        >
          {busy === "alt" ? "…" : "AI alt"}
        </button>
      )}
      {status?.features.caption && (
        <button
          type="button"
          className="btn btn--small btn--ghost"
          onClick={genCaption}
          disabled={busy !== null}
          title="Generate a caption for this image (one-shot — copy to use)"
        >
          {busy === "caption" ? "…" : "AI caption"}
        </button>
      )}
      {error && <span className="picker__ai-error" title={error}>⚠</span>}
    </div>
  );
}

function AssetThumb({ asset, spaceId }: { asset: AssetEntry; spaceId: string }) {
  if (asset.kind === "image") {
    const small = pickSmallestImage(asset);
    // Prefer the smallest pre-generated jpeg variant (typically 320w);
    // falling back to the original source path if for some reason the
    // manifest entry has no variants yet.
    const path = small?.path ?? asset.sourcePath;
    const src = api.workspaceAssetUrl(spaceId, path);
    return (
      <img
        className="picker__thumb"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ background: blurhashToColor(asset.blurhash) }}
      />
    );
  }
  if (asset.posterPath) {
    return (
      <img
        className="picker__thumb picker__thumb--video"
        src={api.workspaceAssetUrl(spaceId, asset.posterPath)}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <div className="picker__thumb picker__thumb--video" aria-hidden>
      <span>▶</span>
    </div>
  );
}

function pickSmallestImage(a: ImageAsset): { path: string; width: number; height: number } | undefined {
  const sorted = [...a.variants].filter((v) => v.format === "jpeg").sort((x, y) => x.width - y.width);
  return sorted[0];
}

/** Hash-derived hue as a backdrop while the real thumbnail loads. */
function blurhashToColor(hash: string): string {
  let s = 0;
  for (let i = 0; i < hash.length; i++) s = (s * 31 + hash.charCodeAt(i)) >>> 0;
  const hue = s % 360;
  return `hsl(${hue}, 40%, 70%)`;
}

function composeMarkdown(picks: AssetEntry[], layout: GalleryLayout): string {
  // Videos always emit their own ::video directive — wrapping them in a
  // gallery doesn't make sense for v1, the gallery directive is image-only.
  const videos = picks.filter((a): a is VideoAsset => a.kind === "video");
  const images = picks.filter((a): a is ImageAsset => a.kind === "image");

  const videoBlocks = videos.map(
    (v) => `::video[${escapeAttr(v.caption || "")}]{src=./${v.sourcePath}}`,
  );

  let imageBlock = "";
  if (images.length === 1 && layout === "single") {
    const img = images[0]!;
    imageBlock = `![${escapeAttr(img.alt)}](./${img.sourcePath})`;
  } else if (images.length > 0) {
    const inner = images.map((i) => `![${escapeAttr(i.alt)}](./${i.sourcePath})`).join("\n");
    imageBlock = `:::gallery{layout=${layout}}\n${inner}\n:::`;
  }

  return [imageBlock, ...videoBlocks].filter(Boolean).join("\n\n");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
