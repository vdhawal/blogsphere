import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { SpaceSummary } from "../types";

interface Props {
  spaces: SpaceSummary[];
  onClose: () => void;
  onExport: (spaceIds: string[]) => void;
  exportPending: boolean;
}

export function ExportSettingsDialog({ spaces, onClose, onExport, exportPending }: Props) {
  // Omit the morocco sample space from the export selections
  const exportableSpaces = spaces.filter((s) => s.id !== "morocco-2026");

  const { data: settings, isLoading } = useQuery({
    queryKey: ["exportSettings"],
    queryFn: api.getExportSettings,
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (settings) {
      // If there are saved selections, use them. Otherwise, default to all exportable spaces.
      if (settings.selectedSpaceIds && settings.selectedSpaceIds.length > 0) {
        setSelectedIds(settings.selectedSpaceIds.filter(id => id !== "morocco-2026"));
      } else {
        setSelectedIds(exportableSpaces.map((s) => s.id));
      }
    }
  }, [settings]);

  const handleToggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    setSelectedIds(exportableSpaces.map((s) => s.id));
  };

  const handleSelectNone = () => {
    setSelectedIds([]);
  };

  const handleExport = () => {
    if (selectedIds.length === 0) return;
    onExport(selectedIds);
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>Export Blog Sphere</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close" disabled={exportPending}>
            ✕
          </button>
        </header>
        <div className="dialog__body">
          <p className="dialog__hint">
            Select the blogs to include in the exported blog sphere. They will be compiled into subfolders of a single website with a shared landing page.
          </p>
          {isLoading ? (
            <div className="panel__loading">Loading settings…</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: "12px", marginBottom: "12px", fontSize: "12px" }}>
                <button className="btn btn--ghost btn--small" onClick={handleSelectAll} style={{ padding: 0 }} disabled={exportPending}>
                  Select All
                </button>
                <button className="btn btn--ghost btn--small" onClick={handleSelectNone} style={{ padding: 0 }} disabled={exportPending}>
                  Select None
                </button>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "10px" }}>
                {exportableSpaces.map((space) => (
                  <li key={space.id}>
                    <label className="inline-check" style={{ cursor: exportPending ? "not-allowed" : "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(space.id)}
                        onChange={() => handleToggle(space.id)}
                        disabled={exportPending}
                      />
                      <div>
                        <strong>{space.title}</strong>
                        <div style={{ fontSize: "11px", color: "var(--muted)" }}>
                          {space.chapterCount} {space.chapterCount === 1 ? "chapter" : "chapters"} · {space.id}
                        </div>
                      </div>
                    </label>
                  </li>
                ))}
                {exportableSpaces.length === 0 && (
                  <li className="dialog__hint">No blogs available to export.</li>
                )}
              </ul>
            </>
          )}
        </div>
        <div className="dialog__actions">
          <button className="btn" onClick={onClose} disabled={exportPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={handleExport}
            disabled={selectedIds.length === 0 || exportPending || isLoading}
          >
            {exportPending ? "Exporting…" : "Export Selected"}
          </button>
        </div>
      </div>
    </div>
  );
}
