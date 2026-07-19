import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import type { MediaAssetDetail, MediaVariantDetail } from "../types";
import {
  formatMediaBytes,
  useMediaProcessing,
  useMediaReport,
  variantSummary,
} from "../media";

interface Props {
  spaceId: string;
  slug: string | null;
  onClose: () => void;
}

export function MediaPanel({ spaceId, slug, onClose }: Props) {
  const { invalidate } = useMediaProcessing(spaceId, slug);
  const report = useMediaReport(spaceId, slug, true);
  const ensure = useMutation({
    mutationFn: () => api.ensureMedia(spaceId),
    onSuccess: () => invalidate(),
  });

  const data = report.data;
  const scopeLabel = slug ? `chapter · ${slug}` : "entire space";

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog--wide dialog--media" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <div>
            <h2>Media processing</h2>
            <p className="dialog__hint dialog__hint--tight">{scopeLabel}</p>
          </div>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dialog__body">
          {report.isLoading && <p className="dialog__hint">Loading media report…</p>}
          {report.error && (
            <p className="dialog__error">{(report.error as Error).message}</p>
          )}
          {data && (
            <>
              <div className="media-summary">
                <MediaSummaryPill label="Total" value={data.summary.total} />
                <MediaSummaryPill label="Ready" value={data.summary.complete} tone="ok" />
                <MediaSummaryPill label="Pending" value={data.summary.pending} tone="pending" />
                <MediaSummaryPill label="Incomplete" value={data.summary.incomplete} tone="warn" />
                <MediaSummaryPill label="Failed" value={data.summary.failed} tone="bad" />
              </div>
              {(data.queue.pending > 0 || data.queue.active) && (
                <p className="dialog__hint">
                  Queue: {data.queue.pending} pending
                  {data.queue.active ? ` · processing ${data.queue.active.split("/").pop()}` : ""}
                </p>
              )}
              {data.assets.length === 0 ? (
                <p className="dialog__hint">No images or videos referenced in this scope.</p>
              ) : (
                <ul className="media-list">
                  {data.assets.map((asset: MediaAssetDetail) => (
                    <MediaAssetRow key={asset.sourcePath} asset={asset} spaceId={spaceId} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="dialog__actions">
          <button
            className="btn"
            onClick={() => ensure.mutate()}
            disabled={ensure.isPending}
            title="Re-verify variants and generate any missing fallbacks"
          >
            {ensure.isPending ? "Ensuring…" : "Ensure variants"}
          </button>
          <button className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function MediaSummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "bad" | "pending";
}) {
  return (
    <span className={`media-summary__pill${tone ? ` media-summary__pill--${tone}` : ""}`}>
      <span className="media-summary__label">{label}</span>
      <span className="media-summary__value">{value}</span>
    </span>
  );
}

function MediaAssetRow({ asset, spaceId }: { asset: MediaAssetDetail; spaceId: string }) {
  const statusClass =
    asset.processingStatus === "ready" && asset.complete
      ? "media-asset--ok"
      : asset.processingStatus === "pending"
        ? "media-asset--pending"
        : "media-asset--bad";

  return (
    <li className={`media-asset ${statusClass}`}>
      <details open={!asset.complete}>
        <summary className="media-asset__summary">
          <span className={`media-asset__kind media-asset__kind--${asset.kind}`}>
            {asset.kind}
          </span>
          <span className="media-asset__label">{asset.label}</span>
          <span className="media-asset__status">
            {asset.processingStatus}
            {!asset.complete && asset.processingStatus === "ready" ? " · incomplete" : ""}
          </span>
        </summary>
        <div className="media-asset__body">
          {asset.kind === "video" && asset.needsWebFallback && (
            <p className="dialog__hint">
              Needs H.264 web fallback for Chrome/Firefox (Safari can use the HDR source).
            </p>
          )}
          {asset.processingError && (
            <p className="dialog__error">{asset.processingError}</p>
          )}
          <div className="media-asset__preview">
            {asset.kind === "image" ? (
              <img
                src={api.workspaceAssetUrl(
                  spaceId,
                  asset.variants.find((v) => v.format === "jpeg")?.path ??
                    asset.source.path,
                )}
                alt=""
                loading="lazy"
              />
            ) : (
              <img
                src={api.workspaceAssetUrl(
                  spaceId,
                  asset.posterPath ??
                    asset.variants.find((v) => v.role === "web")?.path ??
                    asset.source.path,
                )}
                alt=""
                loading="lazy"
              />
            )}
          </div>
          <VariantTable title="Source" rows={[asset.source]} />
          {asset.variants.length > 0 && (
            <VariantTable title="Variants" rows={asset.variants} />
          )}
        </div>
      </details>
    </li>
  );
}

function VariantTable({
  title,
  rows,
}: {
  title: string;
  rows: MediaVariantDetail[];
}) {
  return (
    <div className="media-variant-table">
      <h4>{title}</h4>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Resolution</th>
            <th>Size</th>
            <th>Codec / format</th>
            <th>Container</th>
            <th>Color</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.path}>
              <td className="media-variant-table__path" title={v.path}>
                {v.path.split("/").pop()}
              </td>
              <td>{v.width}×{v.height}</td>
              <td>{formatMediaBytes(v.bytes)}</td>
              <td>{v.codec ?? v.format ?? "—"}{v.role ? ` (${v.role})` : ""}{v.hdr ? " HDR" : ""}</td>
              <td>{v.container ?? v.mime ?? "—"}</td>
              <td title={variantSummary(v)}>
                {[v.colorPrimaries, v.colorTransfer, v.pixFmt].filter(Boolean).join(" / ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
