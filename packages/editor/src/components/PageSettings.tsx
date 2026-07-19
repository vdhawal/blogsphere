import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { getWsClient } from "../ws";
import type { ResourceRef } from "../types";

interface Props {
  spaceId: string;
  slug: string;
  saving: boolean;
  onClose: () => void;
  onRenamed: (newSlug: string) => void;
}

/**
 * Page-level settings that aren't frontmatter — today just the URL slug,
 * which lives in the filename and series order rather than in YAML.
 */
export function PageSettings({ spaceId, slug, saving, onClose, onRenamed }: Props) {
  const [newSlug, setNewSlug] = useState(slug);
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => api.renameChapter(spaceId, slug, newSlug),
    onSuccess: (result) => {
      const bodyRes: ResourceRef = { kind: "chapter-body", spaceId, slug };
      const fmRes: ResourceRef = { kind: "chapter-frontmatter", spaceId, slug };
      const seriesRes: ResourceRef = { kind: "series", spaceId };
      const ws = getWsClient();
      ws.close(bodyRes);
      ws.close(fmRes);
      ws.close(seriesRes);
      ws.open(seriesRes);
      qc.invalidateQueries({ queryKey: ["space", spaceId] });
      qc.invalidateQueries({ queryKey: ["assets", spaceId] });
      onRenamed(result.slug);
      onClose();
    },
  });

  const slugChanged = newSlug !== slug;
  const canSave = slugChanged && newSlug.length > 0 && !saving && !mut.isPending;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Page settings</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dialog__body">
          <label className="field">
            <span className="field__label">URL slug</span>
            <input
              autoFocus
              value={newSlug}
              onChange={(e) =>
                setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
              }
              placeholder="01-arrival"
            />
          </label>
          <p className="dialog__hint">
            Lowercase kebab-case. Becomes <code>chapters/{newSlug || "…"}.html</code> when
            published. Wikilinks and asset paths under this chapter are updated automatically.
          </p>
          {saving && (
            <p className="dialog__hint">Wait for the current save to finish before renaming.</p>
          )}
          {mut.error && <p className="dialog__error">{(mut.error as Error).message}</p>}
        </div>
        <div className="dialog__actions">
          <button className="btn" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => mut.mutate()}
            disabled={!canSave}
          >
            {mut.isPending ? "Saving…" : "Save slug"}
          </button>
        </div>
      </div>
    </div>
  );
}
