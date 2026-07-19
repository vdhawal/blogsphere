import { useEffect, useRef, useState } from "react";
import { ChangeSet, EditorState, type Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { useQueryClient } from "@tanstack/react-query";
import { getWsClient } from "../ws";
import { api } from "../api";
import { Toolbar } from "./Toolbar";
import { AssetPicker } from "./AssetPicker";
import { SpellGrammarPanel } from "./SpellGrammarPanel";
import type { ChangeDelta, ResourceRef } from "../types";

interface Props {
  spaceId: string;
  slug: string;
}

/**
 * CodeMirror surface wired to text deltas for the `chapter-body` resource.
 *
 * Edit batching:
 *   Every transaction's ChangeSet is `compose()`-ed into a single pending
 *   ChangeSet. After 300ms of typing inactivity (or 1500ms cap from the
 *   first pending change, whichever comes first), the composed set is
 *   serialized via `toJSON()` and sent as one delta. This keeps the wire
 *   chatter low and prevents a "saving…" flicker on every keystroke
 *   without losing precision — `compose` is lossless.
 *
 * Hydration guard:
 *   The very first `opened` message populates the editor. Any subsequent
 *   `opened` (from WS reconnects or React StrictMode double-mount) is
 *   ignored — re-applying the doc would reset the user's cursor.
 */
export function Editor({ spaceId, slug }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const versionRef = useRef(0);
  const clientSeqRef = useRef(0);
  const hydratingRef = useRef(false);
  const hydratedRef = useRef(false);
  /** Composed ChangeSet of all keystrokes since the last flush. */
  const pendingRef = useRef<ChangeSet | null>(null);
  /** Timer for the debounced flush. */
  const flushTimerRef = useRef<number | null>(null);
  /** Time of the first un-flushed keystroke — drives the max-wait cap. */
  const oldestPendingAtRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<EditorView | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [sgOpen, setSgOpen] = useState(false);
  const qc = useQueryClient();

  const resource: ResourceRef = { kind: "chapter-body", spaceId, slug };

  // Tuneables. 300ms debounce feels native (no visible save latency for
  // pauses while reading what you wrote); 1500ms max-wait guarantees the
  // spinner clears even during sustained typing.
  const FLUSH_DEBOUNCE_MS = 300;
  const FLUSH_MAX_WAIT_MS = 1500;

  function insertAtCursor(block: string) {
    const v = viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    const before = sel.from > 0 ? v.state.doc.sliceString(sel.from - 1, sel.from) : "\n";
    const lead = before === "\n" ? "" : "\n";
    const text = `${lead}${block}\n`;
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    v.focus();
  }

  function flushPending() {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending || pending.empty) {
      pendingRef.current = null;
      oldestPendingAtRef.current = null;
      return;
    }
    const changes = pending.toJSON() as ChangeDelta;
    pendingRef.current = null;
    oldestPendingAtRef.current = null;
    const fromVersion = versionRef.current;
    versionRef.current = fromVersion + 1;
    clientSeqRef.current += 1;
    getWsClient().sendTextEdit(resource, fromVersion, clientSeqRef.current, changes);
  }

  function scheduleFlush() {
    const now = Date.now();
    if (oldestPendingAtRef.current == null) oldestPendingAtRef.current = now;
    if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
    const elapsed = now - oldestPendingAtRef.current;
    const remainingCap = Math.max(0, FLUSH_MAX_WAIT_MS - elapsed);
    const delay = Math.min(FLUSH_DEBOUNCE_MS, remainingCap);
    flushTimerRef.current = window.setTimeout(flushPending, delay);
  }

  useEffect(() => {
    const ws = getWsClient();
    const unsubResource = ws.subscribe(resource, (msg) => {
      if (msg.type === "opened" && msg.content.kind === "text") {
        versionRef.current = msg.version;
        if (hydratedRef.current) {
          // Redundant opened — usually a reconnect or StrictMode remount.
          // The local document is authoritative; just realign versions.
          return;
        }
        hydratingRef.current = true;
        if (viewRef.current) {
          viewRef.current.dispatch({
            changes: { from: 0, to: viewRef.current.state.doc.length, insert: msg.content.text },
          });
        } else {
          mountEditor(msg.content.text);
        }
        hydratingRef.current = false;
        hydratedRef.current = true;
        setReady(true);
      } else if (msg.type === "error") {
        // Whatever the server complained about, our local state has drifted.
        // Drop pending edits (they're suspect now) and re-anchor by reopening.
        pendingRef.current = null;
        oldestPendingAtRef.current = null;
        if (flushTimerRef.current != null) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        hydratedRef.current = false;
        console.warn("[editor] resync after server error", msg.code, msg.message);
        ws.close(resource);
        ws.open(resource);
      }
    });

    const sendOpen = () => ws.open(resource);
    const unsubConn = ws.onConnected(sendOpen);
    sendOpen();

    // Flush before tab close / hide so durable saves don't depend on idle
    // timers winning the race against the browser.
    const onPageHide = () => flushPending();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);

    return () => {
      flushPending();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      unsubResource();
      unsubConn();
      ws.close(resource);
      viewRef.current?.destroy();
      viewRef.current = null;
      setView(null);
      hydratedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, slug]);

  function mountEditor(initialBody: string) {
    if (!containerRef.current) return;
    const dispatch = (tr: Transaction) => {
      viewRef.current?.update([tr]);
      if (tr.docChanged && !hydratingRef.current && !tr.changes.empty) {
        // Compose into the pending ChangeSet rather than sending a delta per
        // keystroke. The next flush turns the whole batch into one wire edit.
        pendingRef.current = pendingRef.current
          ? pendingRef.current.compose(tr.changes)
          : tr.changes;
        scheduleFlush();
      }
    };
    const state = EditorState.create({
      doc: initialBody,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        // Native browser spellcheck. CodeMirror 6 disables it by default
        // because it conflicts with its DOM-managed editing model — but
        // for prose-heavy markdown the trade-off is worth it: red squiggles
        // on misspellings + right-click suggestions. The browser's
        // MutationObserver delivers accepted corrections as `input` events
        // that CM handles like any other text insert. Autocorrect and
        // autocapitalize stay off — they'd mangle markdown punctuation.
        EditorView.contentAttributes.of({
          spellcheck: "true",
          autocorrect: "off",
          autocapitalize: "off",
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-content": { fontFamily: '"SF Mono", Menlo, Consolas, monospace', padding: "16px 0" },
          ".cm-gutters": { background: "transparent", borderRight: "none" },
        }),
      ],
    });
    const v = new EditorView({ state, parent: containerRef.current, dispatch });
    viewRef.current = v;
    setView(v);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragHover(false);
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (files.length === 0 || !viewRef.current) return;
    setUploadStatus(`Uploading ${files.length} file${files.length === 1 ? "" : "s"} — processing variants…`);
    try {
      const result = await api.uploadAssets(spaceId, slug, files);
      const lines = result.saved.map(({ entry }) =>
        entry.kind === "video"
          ? `::video[${escapeBracket(entry.caption || "")}]{src=./${entry.sourcePath}}`
          : `![${escapeBracket(entry.alt)}](./${entry.sourcePath})`,
      );
      const insertion = "\n" + lines.join("\n") + "\n";
      const v = viewRef.current;
      const sel = v.state.selection.main;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertion },
        selection: { anchor: sel.from + insertion.length },
      });
      qc.invalidateQueries({ queryKey: ["assets", spaceId] });
      qc.invalidateQueries({ queryKey: ["media-status", spaceId] });
      qc.invalidateQueries({ queryKey: ["media-report", spaceId] });
      setUploadStatus(`Uploaded ${result.saved.length} · processing in background`);
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (err) {
      setUploadStatus(`Upload failed: ${(err as Error).message}`);
      setTimeout(() => setUploadStatus(null), 5000);
    }
  }

  return (
    <div
      className={`editor ${dragHover ? "editor--dragging" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragHover(true);
        }
      }}
      onDragLeave={() => setDragHover(false)}
      onDrop={handleDrop}
    >
      <Toolbar
        view={view}
        chapterSlug={slug}
        onPickFromAssets={() => setAssetPickerOpen(true)}
        onSpellGrammar={() => setSgOpen(true)}
      />
      {!ready && <div className="editor__loading">Loading {slug}…</div>}
      <div ref={containerRef} className="editor__surface" data-testid="editor-surface" />
      {dragHover && (
        <div className="editor__drop-overlay">
          <span>Drop to upload to <code>assets/{slug}/</code></span>
        </div>
      )}
      {uploadStatus && <div className="editor__upload-toast">{uploadStatus}</div>}
      {assetPickerOpen && (
        <AssetPicker
          spaceId={spaceId}
          onClose={() => setAssetPickerOpen(false)}
          onInsert={insertAtCursor}
        />
      )}
      {sgOpen && (
        <SpellGrammarPanel
          spaceId={spaceId}
          slug={slug}
          onClose={() => setSgOpen(false)}
          onApply={(original, replacement) => {
            const v = viewRef.current;
            if (!v) return;
            // Replace the first occurrence — the model returns the exact
            // substring as it appears, so this is precise enough for
            // typical hunk-sized suggestions. If the same string appears
            // multiple times, the author can re-run to catch the others.
            const doc = v.state.doc.toString();
            const idx = doc.indexOf(original);
            if (idx < 0) return;
            v.dispatch({
              changes: { from: idx, to: idx + original.length, insert: replacement },
            });
          }}
        />
      )}
    </div>
  );
}

function escapeBracket(s: string): string {
  return s.replace(/[\[\]]/g, "");
}
