import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { streamChat, useAiStatus } from "../ai";
import type { ChatMessageShape } from "../types";

/**
 * Always-visible chat panel docked at the bottom of the editor. Streams
 * assistant replies via SSE, persists history on the server so the
 * conversation survives editor restarts, and surfaces the active
 * provider/model so the author always knows which key is in use.
 *
 * Hidden entirely when no API key is set in the server env — the goal is
 * a clean UI for offline use, not a disabled affordance teasing the user.
 */
interface Props {
  spaceId: string | null;
  collapsed: boolean;
  onToggle: () => void;
}

export function ChatPanel({ spaceId, collapsed, onToggle }: Props) {
  const status = useAiStatus();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const history = useQuery({
    queryKey: ["chat-history", spaceId],
    queryFn: () => (spaceId ? api.aiChatHistory(spaceId) : null),
    enabled: !!spaceId && !!status?.enabled,
  });
  const contextStatus = useQuery({
    queryKey: ["ai-context-status", spaceId],
    queryFn: () => (spaceId ? api.aiContextStatus(spaceId) : null),
    enabled: !!spaceId && !!status?.enabled,
    refetchInterval: 8_000,
  });

  const clearMut = useMutation({
    mutationFn: () => api.aiClearChatHistory(spaceId!),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["chat-history", spaceId] }),
  });

  const syncMut = useMutation({
    mutationFn: () => api.aiSyncContext(spaceId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-history", spaceId] });
      queryClient.invalidateQueries({ queryKey: ["ai-context-status", spaceId] });
    },
  });
  const [syncToast, setSyncToast] = useState<string | null>(null);

  // Translate sync mutation outcome into a brief on-screen toast — the
  // route's 404 / 400 errors used to be invisible, leaving the author
  // confused why the model couldn't see the PDF.
  useEffect(() => {
    if (syncMut.isError) {
      setSyncToast(`Sync failed: ${(syncMut.error as Error).message}`);
      const t = setTimeout(() => setSyncToast(null), 6000);
      return () => clearTimeout(t);
    }
    if (syncMut.isSuccess) {
      const d = syncMut.data;
      setSyncToast(
        d.reused
          ? `PDF unchanged — reusing file id ${(d.fileId ?? "").slice(0, 12)}…`
          : `PDF uploaded — file id ${(d.fileId ?? "").slice(0, 12)}…`,
      );
      const t = setTimeout(() => setSyncToast(null), 6000);
      return () => clearTimeout(t);
    }
    return;
  }, [syncMut.isError, syncMut.isSuccess, syncMut.error, syncMut.data]);

  // Auto-scroll to bottom when a new message arrives or stream updates.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history.data, streaming]);

  // Hide entirely when no provider key is set. Keep the toggle button so
  // the author can re-discover the panel state without flicker.
  if (!status?.enabled) {
    return (
      <footer className="chat chat--disabled">
        <div className="chat__bar">
          <strong>Chat</strong>
          <span className="chat__hint">
            Set OPENAI_API_KEY or ANTHROPIC_API_KEY in the server env to enable.
          </span>
        </div>
      </footer>
    );
  }

  if (collapsed) {
    return (
      <footer className="chat chat--collapsed">
        <button className="chat__bar chat__bar--button" onClick={onToggle}>
          <strong>Chat</strong>
          <span className="chat__hint">
            {status.activeProvider} · {status.activeModel}
          </span>
          <span className="chat__caret">▴</span>
        </button>
      </footer>
    );
  }

  const messages: ChatMessageShape[] = history.data?.messages ?? [];

  async function send() {
    if (!spaceId || !draft.trim() || streaming !== null) return;
    const message = draft.trim();
    setDraft("");
    setStreaming("");
    abortRef.current = new AbortController();
    // Optimistically render the user turn before history refetches.
    queryClient.setQueryData(["chat-history", spaceId], {
      version: 1,
      messages: [
        ...messages,
        { role: "user", content: message, ts: new Date().toISOString() },
      ],
    });
    await streamChat({
      spaceId,
      message,
      onDelta: (chunk) => setStreaming((prev) => (prev ?? "") + chunk),
      onDone: () => {
        setStreaming(null);
        abortRef.current = null;
        queryClient.invalidateQueries({ queryKey: ["chat-history", spaceId] });
      },
      onError: (msg) => {
        setStreaming(null);
        abortRef.current = null;
        queryClient.setQueryData(["chat-history", spaceId], {
          version: 1,
          messages: [
            ...messages,
            { role: "user", content: message, ts: new Date().toISOString() },
            {
              role: "assistant",
              content: `⚠️ ${msg}`,
              ts: new Date().toISOString(),
            },
          ],
        });
      },
      signal: abortRef.current.signal,
    });
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
  }

  return (
    <footer className="chat">
      <header className="chat__bar">
        <button className="chat__bar-toggle" onClick={onToggle}>
          <strong>Chat</strong>
          <span className="chat__caret">▾</span>
        </button>
        <span className="chat__hint">
          {status.activeProvider} · {status.activeModel}
          {messages.length > 0 ? ` · ${messages.length} turns` : ""}
          {" · "}
          {contextStatus.data?.attachment ? (
            <span
              className="chat__hint-pdf chat__hint-pdf--ok"
              title={`fileId ${contextStatus.data.attachment.fileId}\nuploaded ${contextStatus.data.attachment.uploadedAt}\n${Math.round(
                contextStatus.data.attachment.fileSize / 1024,
              )} KB`}
            >
              📎 PDF attached
            </span>
          ) : contextStatus.data?.pdfAvailable ? (
            <span className="chat__hint-pdf chat__hint-pdf--warn">
              ⚠ PDF not synced — press Sync PDF
            </span>
          ) : (
            <span className="chat__hint-pdf chat__hint-pdf--warn">
              ⚠ No PDF — run Preview or Export first
            </span>
          )}
        </span>
        <span className="chat__bar-actions">
          <button
            className="btn btn--small"
            onClick={() => syncMut.mutate()}
            disabled={!spaceId || syncMut.isPending}
            title="Re-upload the chat-context PDF (no-op if unchanged)"
          >
            {syncMut.isPending ? "Syncing…" : "Sync PDF"}
          </button>
          <button
            className="btn btn--small btn--ghost"
            onClick={() => clearMut.mutate()}
            disabled={!spaceId || clearMut.isPending || messages.length === 0}
          >
            Clear
          </button>
        </span>
      </header>
      {syncToast && (
        <div className={`chat__toast ${syncMut.isError ? "chat__toast--error" : ""}`}>
          {syncToast}
        </div>
      )}
      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 && streaming === null && (
          <p className="chat__empty">
            Ask anything about this blog space. The model has the latest
            generated PDF as context — re-run Preview or Export to refresh
            it.
          </p>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} message={m} />
        ))}
        {streaming !== null && (
          <ChatMessage
            message={{
              role: "assistant",
              content: streaming || "…",
              ts: new Date().toISOString(),
            }}
            streaming
          />
        )}
      </div>
      <form
        className="chat__compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            spaceId
              ? "Ask about a chapter, find a passage, or draft new content…"
              : "Pick a blog space first"
          }
          rows={2}
          disabled={!spaceId || streaming !== null}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {streaming !== null ? (
          <button type="button" className="btn" onClick={cancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" disabled={!spaceId || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </footer>
  );
}

function ChatMessage({
  message,
  streaming,
}: {
  message: ChatMessageShape;
  streaming?: boolean;
}) {
  return (
    <div className={`chat__msg chat__msg--${message.role}`}>
      <div className="chat__msg-role">
        {message.role === "user" ? "You" : "Assistant"}
      </div>
      <div className={`chat__msg-content${streaming ? " chat__msg-content--streaming" : ""}`}>
        {message.content}
      </div>
    </div>
  );
}
