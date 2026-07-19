import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExportResultShape } from "../api";
import { getWsClient } from "../ws";
import { resourceKey, type ResourceRef, type SpaceSummary } from "../types";
import { PublishingSettings } from "./PublishingSettings";
import { MediaPanel } from "./MediaPanel";
import { useMediaProcessing } from "../media";
import { ExportSettingsDialog } from "./ExportSettingsDialog";

interface Props {
  wsStatus: "connecting" | "open" | "closed";
  spaceId: string | null;
  slug: string | null;
  spaces: SpaceSummary[];
}

/**
 * Top bar: workspace breadcrumb, save indicator, and the preview
 * lifecycle controls.
 *
 * Preview model:
 *   - One preview process across the whole server at any time.
 *   - "Preview" button compiles the current space and starts a
 *     `python3 -m http.server` child rooted at the freshly-compiled
 *     directory. The freshly-built zip lives alongside and is exposed
 *     for download via the editor server's static mount.
 *   - "Stop preview" terminates that child process.
 *   - The badge shows the running space + port + a link to re-open
 *     the tab if the author closed it.
 */
export function TopBar({ wsStatus, spaceId, slug, spaces }: Props) {
  const [inflight, setInflight] = useState(0);
  const qc = useQueryClient();

  useEffect(() => {
    if (!spaceId) {
      setInflight(0);
      return;
    }
    const ws = getWsClient();
    return ws.onInflightChange((map) => {
      const keys: string[] = [];
      const seriesRes: ResourceRef = { kind: "series", spaceId };
      keys.push(resourceKey(seriesRes));
      if (slug) {
        keys.push(resourceKey({ kind: "chapter-body", spaceId, slug }));
        keys.push(resourceKey({ kind: "chapter-frontmatter", spaceId, slug }));
      }
      let total = 0;
      for (const k of keys) total += map.get(k) ?? 0;
      setInflight(total);
    });
  }, [spaceId, slug]);

  // Poll for preview state so we still notice if it dies on its own
  // (e.g. the author kills python from a terminal). 3s is gentle; the
  // mutation onSuccess paths invalidate immediately for UI snappiness.
  const previewState = useQuery({
    queryKey: ["preview"],
    queryFn: api.getPreview,
    refetchInterval: 3000,
  });

  const start = useMutation({
    mutationFn: (sid: string) => api.startPreview(sid),
    onSuccess: (result) => {
      qc.setQueryData(["preview"], result);
      // Open the new tab AFTER we know the child is up (the server's
      // startPreview waits for readiness before resolving).
      window.open(result.previewUrl, "_blank", "noopener");
    },
  });
  const stop = useMutation({
    mutationFn: () => api.stopPreview(),
    onSuccess: () => qc.setQueryData(["preview"], null),
  });

  const [exportResult, setExportResult] = useState<ExportResultShape | null>(null);
  const [showExportSettings, setShowExportSettings] = useState(false);
  const exportMut = useMutation({
    mutationFn: (sids: string[]) => api.exportWorkspace(sids),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["exportSettings"] });
      setExportResult(r);
    },
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const { busy: mediaBusy } = useMediaProcessing(spaceId, slug);

  const saving = inflight > 0;
  const offline = wsStatus !== "open";
  const running = previewState.data;
  const previewBusy = start.isPending || stop.isPending;

  return (
    <header className="topbar">
      <div className="topbar__brand">Blogspace</div>
      <div className="topbar__center">
        {spaceId && (
          <span className="topbar__path">
            {spaceId}
            {slug ? ` / ${slug}` : ""}
          </span>
        )}
      </div>
      <div className="topbar__status" aria-live="polite">
        {running && (
          <span className="preview-badge" title={`Preview started ${new Date(running.startedAt).toLocaleTimeString()}`}>
            <a href={running.previewUrl} target="_blank" rel="noopener">
              ▶ {running.spaceId}<span className="preview-badge__port">:{running.port}</span>
            </a>
            <a className="preview-badge__zip" href={running.zipDownloadUrl} download>
              zip
            </a>
            <a
              className="preview-badge__zip"
              href={running.pdfDownloadUrl}
              download
              title={`PDF (${Math.round((running.pdfBytes || 0) / 1024)}KB) — for chat upload`}
            >
              pdf
            </a>
          </span>
        )}
        {spaceId && !running && (
          <button
            className="btn btn--small"
            onClick={() => start.mutate(spaceId)}
            disabled={previewBusy || saving}
            title={saving ? "Wait for save to finish before previewing" : "Compile and start preview"}
          >
            {start.isPending ? "Compiling…" : "Preview"}
          </button>
        )}
        {spaceId && (
          <button
            className="btn btn--small"
            onClick={() => setShowMedia(true)}
            title="View media encoding, variants, and processing status"
          >
            {mediaBusy ? "Media…" : "Media"}
          </button>
        )}
        {spaceId && (
          <button
            className="btn btn--small"
            onClick={() => setShowSettings(true)}
            title="Publishing & SEO settings (base URL, publisher, social)"
          >
            Settings
          </button>
        )}
        {spaceId && (
          <button
            className="btn btn--small"
            onClick={() => setShowExportSettings(true)}
            disabled={exportMut.isPending || saving}
            title={saving ? "Wait for save to finish before exporting" : "Export selected blogs to ./export/"}
          >
            {exportMut.isPending ? "Exporting…" : "Export"}
          </button>
        )}
        {running && (
          <button
            className="btn btn--small btn--danger"
            onClick={() => stop.mutate()}
            disabled={previewBusy}
            title="Stop the running preview server"
          >
            {stop.isPending ? "Stopping…" : "Stop preview"}
          </button>
        )}
        {running && spaceId && running.spaceId !== spaceId && (
          <button
            className="btn btn--small"
            onClick={() => start.mutate(spaceId)}
            disabled={previewBusy || saving}
            title={`Restart preview for the current space (${spaceId})`}
          >
            {start.isPending ? "Restarting…" : "Preview this"}
          </button>
        )}
        {offline ? (
          <span className="status status--offline" data-state="offline">disconnected</span>
        ) : saving ? (
          <span className="status status--saving" data-state="saving">
            <span className="spinner" aria-hidden="true" />
            saving…
          </span>
        ) : spaceId ? (
          <span className="status status--saved" data-state="saved">saved</span>
        ) : null}
      </div>
      {showExportSettings && (
        <ExportSettingsDialog
          spaces={spaces}
          onClose={() => setShowExportSettings(false)}
          onExport={(selectedIds) => {
            setShowExportSettings(false);
            exportMut.mutate(selectedIds);
          }}
          exportPending={exportMut.isPending}
        />
      )}
      {exportResult && (
        <ExportResultDialog result={exportResult} onClose={() => setExportResult(null)} />
      )}
      {showSettings && spaceId && (
        <PublishingSettings spaceId={spaceId} onClose={() => setShowSettings(false)} />
      )}
      {showMedia && spaceId && (
        <MediaPanel spaceId={spaceId} slug={slug} onClose={() => setShowMedia(false)} />
      )}
    </header>
  );
}

/**
 * Modal shown after a successful export. Surfaces the three artifact
 * paths with one-click copy plus a "Show in Finder" button that calls
 * the host server's reveal endpoint. Keeps the author in the loop about
 * exactly where on disk their deliverable lives.
 */
function ExportResultDialog({
  result,
  onClose,
}: {
  result: ExportResultShape;
  onClose: () => void;
}) {
  const reveal = useMutation({
    mutationFn: (p: string) => api.reveal(p),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API failures are silent — typical when the page isn't
      // served over https in some browsers. The path is still readable on
      // screen so the author can copy it manually.
    }
  };
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Export ready</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="dialog__body">
          <p>
            Compiled {result.chapters} chapter{result.chapters === 1 ? "" : "s"} ·{" "}
            {result.imagesProcessed} images · zip{" "}
            {(result.zipBytes / 1024).toFixed(0)} KB · pdf{" "}
            {(result.pdfBytes / 1024).toFixed(0)} KB
          </p>
          <ul className="export-paths">
            <li>
              <span className="export-paths__label">Static folder</span>
              <code className="export-paths__path">{result.dirPath}</code>
              <button className="btn btn--small" onClick={() => copy(result.dirPath)}>
                Copy
              </button>
            </li>
            <li>
              <span className="export-paths__label">Zip</span>
              <code className="export-paths__path">{result.zipPath}</code>
              <button className="btn btn--small" onClick={() => copy(result.zipPath)}>
                Copy
              </button>
            </li>
            <li>
              <span className="export-paths__label">PDF</span>
              <code className="export-paths__path">{result.pdfPath}</code>
              <button className="btn btn--small" onClick={() => copy(result.pdfPath)}>
                Copy
              </button>
            </li>
          </ul>
          {result.warnings.length > 0 && (
            <details className="export-warnings">
              <summary>{result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}</summary>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div className="dialog__actions">
          <button
            className="btn"
            onClick={() => reveal.mutate(result.parentPath)}
            disabled={reveal.isPending}
            title="Open the output folder in your file browser"
          >
            {reveal.isPending ? "Opening…" : "Show in Finder"}
          </button>
          <button className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
