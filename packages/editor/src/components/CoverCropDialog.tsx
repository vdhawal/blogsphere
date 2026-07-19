import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ImageAsset } from "../types";

/**
 * Modal cropping dialog. The author drags / resizes an aspect-locked
 * rectangle over the source image; on confirm we POST the rect (in
 * source-image pixels) to the crop endpoint, which produces a thumb-
 * optimised asset with its own AVIF/WebP/JPEG variant ladder.
 *
 * The dialog measures the displayed image element's bounding rect so it
 * can translate CSS-pixel drag deltas to source-pixel coordinates — that
 * way an image far larger than the dialog still produces correct crop
 * coordinates against the original.
 */
interface Props {
  spaceId: string;
  slug: string;
  asset: ImageAsset;
  /** Target aspect ratio (width / height). Matches the home card thumb. */
  aspect?: number;
  onCancel: () => void;
  onCropped: (assetRef: string) => void;
  /** Cropping is optional — the author can keep the original uncropped. */
  onSkip?: (assetRef: string) => void;
  /** AssetRef of the original (for the Skip cropping path). */
  originalRef: string;
}

type Drag =
  | { mode: "move"; startX: number; startY: number; rect: Rect }
  | { mode: "resize"; startX: number; startY: number; rect: Rect }
  | null;

interface Rect {
  x: number; // 0..1 of image
  y: number;
  w: number;
  h: number;
}

export function CoverCropDialog({
  spaceId,
  slug,
  asset,
  aspect = 16 / 10,
  onCancel,
  onCropped,
  onSkip,
  originalRef,
}: Props) {
  // Crop is stored in normalized (0..1) image coordinates so window
  // resizing during the drag doesn't drift the rect.
  const [rect, setRect] = useState<Rect>(() => initialRect(asset.width, asset.height, aspect));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<Drag>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const src = api.workspaceAssetUrl(spaceId, asset.sourcePath);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const dx = (e.clientX - drag.startX) / box.width;
      const dy = (e.clientY - drag.startY) / box.height;
      if (drag.mode === "move") {
        setRect(clampMove({ ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }));
      } else {
        // Resize from bottom-right corner with locked image-pixel aspect.
        // Normalized coords differ in scale on each axis (×width vs ×height),
        // so the aspect calc has to go through image pixels.
        const maxW = 1 - drag.rect.x;
        const maxH = 1 - drag.rect.y;
        let w = Math.max(0.05, Math.min(maxW, drag.rect.w + dx));
        let h = (w * asset.width) / (asset.height * aspect);
        if (h > maxH) {
          h = maxH;
          w = (h * asset.height * aspect) / asset.width;
        }
        setRect({ x: drag.rect.x, y: drag.rect.y, w, h });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [asset.width, asset.height, aspect]);

  function clampMove(r: Rect): Rect {
    return {
      ...r,
      x: Math.max(0, Math.min(1 - r.w, r.x)),
      y: Math.max(0, Math.min(1 - r.h, r.y)),
    };
  }

  function beginMove(e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = { mode: "move", startX: e.clientX, startY: e.clientY, rect };
  }
  function beginResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode: "resize", startX: e.clientX, startY: e.clientY, rect };
  }

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const crop = {
        x: rect.x * asset.width,
        y: rect.y * asset.height,
        w: rect.w * asset.width,
        h: rect.h * asset.height,
      };
      const res = await api.cropAsset(spaceId, {
        source: asset.sourcePath,
        slug,
        crop,
      });
      onCropped(res.assetRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Pixel dimensions of the would-be crop, for the readout under the rect.
  const cropPx = {
    w: Math.round(rect.w * asset.width),
    h: Math.round(rect.h * asset.height),
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Crop cover thumbnail</h2>
          <button className="btn btn--ghost" onClick={onCancel} aria-label="Close">✕</button>
        </header>
        <div className="cropper">
          <p className="cropper__hint">
            Drag the box to reposition; drag the corner to resize. The home page
            thumbnail uses a {aspect.toFixed(2).replace(/\.?0+$/, "")}∶1 aspect ratio.
          </p>
          <div
            className="cropper__stage"
            ref={containerRef}
            style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
          >
            <img
              className="cropper__image"
              src={src}
              alt={asset.sourcePath}
              draggable={false}
            />
            <div
              className="cropper__rect"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
              onPointerDown={beginMove}
              role="slider"
              aria-label="Crop region"
              aria-valuetext={`${cropPx.w} by ${cropPx.h} pixels`}
            >
              <span className="cropper__readout">
                {cropPx.w}×{cropPx.h}
              </span>
              <span
                className="cropper__handle cropper__handle--br"
                onPointerDown={beginResize}
                aria-hidden
              />
            </div>
          </div>
          {error && <p className="dialog__error">{error}</p>}
        </div>
        <footer className="dialog__actions">
          <button className="btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          {onSkip && (
            <button
              className="btn"
              onClick={() => onSkip(originalRef)}
              disabled={submitting}
              title="Use the original image as cover — the home page will crop centered."
            >
              Skip cropping
            </button>
          )}
          <button
            className="btn btn--primary"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? "Cropping…" : "Use this crop"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Start with a centered max-area rect at the target aspect. */
function initialRect(imgW: number, imgH: number, aspect: number): Rect {
  const imgAspect = imgW / imgH;
  if (imgAspect > aspect) {
    // Image is wider than target — fill height, narrow width.
    const w = (aspect / imgAspect);
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  } else {
    // Image is taller than target — fill width, shorter height.
    const h = imgAspect / aspect;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
}
