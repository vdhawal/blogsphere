import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { getWsClient } from "../ws";
import type { ResourceRef, SeriesShape, SpaceSummary } from "../types";

interface Props {
  spaces: SpaceSummary[];
  currentSpaceId: string | null;
  currentSlug: string | null;
  onSelectSpace: (id: string) => void;
  onSelectChapter: (slug: string) => void;
  /** Caller clears any selection that points at the deleted resource. */
  onSpaceDeleted: (id: string) => void;
  onChapterDeleted: (slug: string) => void;
}

/**
 * Sidebar lists blog spaces and the current space's chapters. Chapter
 * reordering uses up/down buttons that emit RFC-6902 `move` patches against
 * `series.chapters` — going through the WS edit pipeline like everything
 * else, so the spinner reports the save state of the reorder too.
 */
export function Sidebar({
  spaces,
  currentSpaceId,
  currentSlug,
  onSelectSpace,
  onSelectChapter,
  onSpaceDeleted,
  onChapterDeleted,
}: Props) {
  const [showNewSpace, setShowNewSpace] = useState(false);
  const [spaceToDelete, setSpaceToDelete] = useState<SpaceSummary | null>(null);
  const [chapterToDelete, setChapterToDelete] = useState<{ slug: string; title: string } | null>(
    null,
  );
  const qc = useQueryClient();

  const spaceDetail = useQuery({
    queryKey: ["space", currentSpaceId],
    queryFn: () => api.space(currentSpaceId!),
    enabled: !!currentSpaceId,
  });

  // Track the live series state so reorders use the latest order, including
  // changes made since the page loaded.
  const seriesRef = useRef<SeriesShape | null>(null);
  const versionRef = useRef(0);
  const clientSeqRef = useRef(0);

  useEffect(() => {
    if (!currentSpaceId) return;
    const ws = getWsClient();
    const resource: ResourceRef = { kind: "series", spaceId: currentSpaceId };
    const unsub = ws.subscribe(resource, (msg) => {
      if (msg.type === "opened" && msg.content.kind === "json") {
        seriesRef.current = msg.content.value as SeriesShape;
        versionRef.current = msg.version;
      } else if (msg.type === "ack") {
        // Pull the latest space details so the sidebar reflects the new
        // chapter order. The WS state stays the source of truth for writes,
        // but the chapter list comes from the REST query for now.
        qc.invalidateQueries({ queryKey: ["space", currentSpaceId] });
      } else if (msg.type === "error" && msg.code === "version-mismatch") {
        ws.close(resource);
        ws.open(resource);
      }
    });
    const sendOpen = () => ws.open(resource);
    const unsubConn = ws.onConnected(sendOpen);
    sendOpen();
    return () => {
      unsub();
      unsubConn();
      ws.close(resource);
    };
  }, [currentSpaceId, qc]);

  function reorder(from: number, to: number) {
    if (!currentSpaceId || !seriesRef.current) return;
    if (to < 0 || to >= seriesRef.current.chapters.length || from === to) return;
    const fromVersion = versionRef.current;
    versionRef.current = fromVersion + 1;
    clientSeqRef.current += 1;
    // Optimistically reorder the local copy so subsequent reorders compose
    // correctly before the ack lands.
    const next = [...seriesRef.current.chapters];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    seriesRef.current = { ...seriesRef.current, chapters: next };
    getWsClient().sendJsonEdit(
      { kind: "series", spaceId: currentSpaceId },
      fromVersion,
      clientSeqRef.current,
      [{ op: "move", from: `/chapters/${from}`, path: `/chapters/${to}` }],
    );
  }

  return (
    <aside className="sidebar">
      <section className="sidebar__section" aria-label="Blog spaces">
        <header className="sidebar__header">
          <h3>Blog spaces</h3>
          <button
            className="btn btn--small"
            aria-label="New blog space"
            onClick={() => setShowNewSpace(true)}
          >
            + New
          </button>
        </header>
        <ul className="sidebar__list">
          {spaces.length === 0 && <li className="sidebar__empty">No spaces yet.</li>}
          {spaces.map((s) => (
            <li
              key={s.id}
              className={`sidebar__item ${currentSpaceId === s.id ? "sidebar__item--active" : ""}`}
            >
              <div className="sidebar__item-body" onClick={() => onSelectSpace(s.id)}>
                <div className="sidebar__item-title">{s.title}</div>
                <div className="sidebar__item-meta">
                  {s.chapterCount} {s.chapterCount === 1 ? "chapter" : "chapters"} · {s.theme}
                </div>
              </div>
              <div className="sidebar__item-actions">
                <button
                  className="btn btn--ghost btn--icon"
                  aria-label={`Delete space ${s.title}`}
                  title="Delete space"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSpaceToDelete(s);
                  }}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {currentSpaceId && (
        <section className="sidebar__section sidebar__section--chapters" aria-label="Chapters">
          <header className="sidebar__header">
            <h3>Chapters</h3>
            <NewChapterButton
              spaceId={currentSpaceId}
              onCreated={(slug) => {
                qc.invalidateQueries({ queryKey: ["space", currentSpaceId] });
                qc.invalidateQueries({ queryKey: ["workspace"] });
                onSelectChapter(slug);
              }}
            />
          </header>
          <ol className="sidebar__list sidebar__list--ordered">
            {spaceDetail.data?.chapters.map((c, i) => (
              <li
                key={c.slug}
                className={`sidebar__item ${currentSlug === c.slug ? "sidebar__item--active" : ""}`}
              >
                <span className="sidebar__item-num">{String(i + 1).padStart(2, "0")}</span>
                <div className="sidebar__item-body" onClick={() => onSelectChapter(c.slug)}>
                  <div className="sidebar__item-title">{c.title}</div>
                  <div className="sidebar__item-meta">{c.summary}</div>
                </div>
                <div className="sidebar__item-actions">
                  <button
                    className="btn btn--ghost btn--icon"
                    aria-label="Move up"
                    title="Move up"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      reorder(i, i - 1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn--ghost btn--icon"
                    aria-label="Move down"
                    title="Move down"
                    disabled={i === (spaceDetail.data?.chapters.length ?? 0) - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      reorder(i, i + 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--ghost btn--icon"
                    aria-label={`Delete chapter ${c.title}`}
                    title="Delete chapter"
                    onClick={(e) => {
                      e.stopPropagation();
                      setChapterToDelete({ slug: c.slug, title: c.title });
                    }}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
            {spaceDetail.data && spaceDetail.data.chapters.length === 0 && (
              <li className="sidebar__empty">No chapters yet — create one.</li>
            )}
          </ol>
        </section>
      )}

      {showNewSpace && (
        <NewSpaceDialog
          onClose={() => setShowNewSpace(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ["workspace"] });
            onSelectSpace(id);
            setShowNewSpace(false);
          }}
        />
      )}

      {chapterToDelete && currentSpaceId && (
        <DeleteChapterDialog
          spaceId={currentSpaceId}
          chapter={chapterToDelete}
          onClose={() => setChapterToDelete(null)}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["space", currentSpaceId] });
            qc.invalidateQueries({ queryKey: ["workspace"] });
            onChapterDeleted(chapterToDelete.slug);
            setChapterToDelete(null);
          }}
        />
      )}

      {spaceToDelete && (
        <DeleteSpaceDialog
          space={spaceToDelete}
          onClose={() => setSpaceToDelete(null)}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["workspace"] });
            onSpaceDeleted(spaceToDelete.id);
            setSpaceToDelete(null);
          }}
        />
      )}
    </aside>
  );
}

/**
 * Single-confirm dialog for chapter deletion. Chapters are file-scoped and
 * cheap to recreate, so we don't require type-to-confirm — but the action
 * is still irreversible from the editor, so the dialog is explicit about it.
 */
function DeleteChapterDialog({
  spaceId,
  chapter,
  onClose,
  onDeleted,
}: {
  spaceId: string;
  chapter: { slug: string; title: string };
  onClose: () => void;
  onDeleted: () => void;
}) {
  const mut = useMutation({
    mutationFn: () => api.deleteChapter(spaceId, chapter.slug),
    onSuccess: onDeleted,
  });
  return (
    <DialogShell title="Delete chapter" onClose={onClose}>
      <p>
        Permanently delete <strong>{chapter.title}</strong>?
      </p>
      <p className="dialog__hint">
        The chapter file (<code>chapters/{chapter.slug}.md</code>) is removed and
        its slug is taken out of the series order. Uploaded assets stay on disk
        in case they're referenced elsewhere.
      </p>
      {mut.error && <p className="dialog__error">{(mut.error as Error).message}</p>}
      <div className="dialog__actions">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          Cancel
        </button>
        <button
          className="btn btn--danger"
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
        >
          {mut.isPending ? "Deleting…" : "Delete chapter"}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * Type-to-confirm dialog for blog-space deletion. Space deletion is total
 * (chapters, assets, manifest, variants, everything) so we make the author
 * type the space's slug exactly before the Delete button enables. Same
 * pattern as GitHub repo deletion and S3 bucket deletion — high-friction
 * by design.
 */
function DeleteSpaceDialog({
  space,
  onClose,
  onDeleted,
}: {
  space: SpaceSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const mut = useMutation({
    mutationFn: () => api.deleteSpace(space.id),
    onSuccess: onDeleted,
  });
  const canDelete = confirmText === space.id && !mut.isPending;
  return (
    <DialogShell title="Delete blog space" onClose={onClose}>
      <p>
        This will permanently delete <strong>{space.title}</strong> including all{" "}
        {space.chapterCount} chapter{space.chapterCount === 1 ? "" : "s"}, every
        uploaded image and video, all pre-generated variants, and the asset
        manifest.
      </p>
      <p className="dialog__hint">
        There is no undo. Type the space's slug{" "}
        <code className="dialog__code">{space.id}</code> to confirm.
      </p>
      <input
        autoFocus
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={space.id}
      />
      {mut.error && <p className="dialog__error">{(mut.error as Error).message}</p>}
      <div className="dialog__actions">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          Cancel
        </button>
        <button
          className="btn btn--danger"
          onClick={() => mut.mutate()}
          disabled={!canDelete}
        >
          {mut.isPending ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </DialogShell>
  );
}

function NewChapterButton({
  spaceId,
  onCreated,
}: {
  spaceId: string;
  onCreated: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="btn btn--small"
        aria-label="New chapter"
        onClick={() => setOpen(true)}
      >
        + New
      </button>
      {open && (
        <NewChapterDialog
          spaceId={spaceId}
          onClose={() => setOpen(false)}
          onCreated={(slug) => {
            onCreated(slug);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function NewSpaceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [theme, setTheme] = useState("travel");
  const [author, setAuthor] = useState("");
  const mut = useMutation({
    mutationFn: () => api.createSpace({ id, title, description, theme, author }),
    onSuccess: (s) => onCreated(s.id),
  });

  return (
    <DialogShell title="New blog space" onClose={onClose}>
      <Field label="Slug (url id)">
        <input
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
          placeholder="morocco-2026"
        />
      </Field>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A Month in Morocco" />
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="A short summary of the series."
        />
      </Field>
      <Field label="Theme">
        <input value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="travel" />
      </Field>
      <Field label="Author">
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Your name" />
      </Field>
      {mut.error && <p className="dialog__error">{(mut.error as Error).message}</p>}
      <div className="dialog__actions">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending || !id || !title || !description || !theme || !author}
        >
          {mut.isPending ? "Creating…" : "Create space"}
        </button>
      </div>
    </DialogShell>
  );
}

function NewChapterDialog({
  spaceId,
  onClose,
  onCreated,
}: {
  spaceId: string;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const mut = useMutation({
    mutationFn: () => api.createChapter(spaceId, { slug, title, summary }),
    onSuccess: () => onCreated(slug),
  });

  return (
    <DialogShell title="New chapter" onClose={onClose}>
      <Field label="Slug">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
          placeholder="01-arrival"
        />
      </Field>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Arrival" />
      </Field>
      <Field label="Summary">
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          placeholder="One sentence describing the chapter."
        />
      </Field>
      {mut.error && <p className="dialog__error">{(mut.error as Error).message}</p>}
      <div className="dialog__actions">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending || !slug || !title || !summary}
        >
          {mut.isPending ? "Creating…" : "Create chapter"}
        </button>
      </div>
    </DialogShell>
  );
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>{title}</h2>
          <button className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="dialog__body">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}
