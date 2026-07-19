import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { getWsClient } from "./ws";
import { AiStatusProvider } from "./ai";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { FrontmatterPanel } from "./components/FrontmatterPanel";
import { ChatPanel } from "./components/ChatPanel";
import { TopBar } from "./components/TopBar";

export function App() {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.workspace });

  useEffect(() => {
    const ws = getWsClient();
    return ws.onStatus(setWsStatus);
  }, []);

  // Auto-select the first space + first chapter on initial load so the editor
  // never lands on a blank slate.
  useEffect(() => {
    if (!workspace.data || spaceId) return;
    const first = workspace.data.spaces[0];
    if (first) setSpaceId(first.id);
  }, [workspace.data, spaceId]);

  return (
    <AiStatusProvider spaceId={spaceId}>
      <div className={`app${chatCollapsed ? " app--chat-collapsed" : ""}`}>
        <TopBar wsStatus={wsStatus} spaceId={spaceId} slug={slug} spaces={workspace.data?.spaces ?? []} />
        <div className="app__main">
          <Sidebar
            spaces={workspace.data?.spaces ?? []}
            currentSpaceId={spaceId}
            currentSlug={slug}
            onSelectSpace={(id) => {
              setSpaceId(id);
              setSlug(null);
            }}
            onSelectChapter={setSlug}
            onSpaceDeleted={(deletedId) => {
              if (deletedId === spaceId) {
                setSpaceId(null);
                setSlug(null);
              }
            }}
            onChapterDeleted={(deletedSlug) => {
              if (deletedSlug === slug) setSlug(null);
            }}
          />
          <main className="app__editor">
            {spaceId && slug ? (
              <Editor key={`${spaceId}/${slug}`} spaceId={spaceId} slug={slug} />
            ) : (
              <EmptyState />
            )}
          </main>
          {spaceId && slug ? (
            <FrontmatterPanel
              key={`${spaceId}/${slug}/fm`}
              spaceId={spaceId}
              slug={slug}
              onSlugChanged={setSlug}
            />
          ) : (
            <aside className="app__panel app__panel--empty" />
          )}
        </div>
        <ChatPanel
          spaceId={spaceId}
          collapsed={chatCollapsed}
          onToggle={() => setChatCollapsed((c) => !c)}
        />
      </div>
    </AiStatusProvider>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <h2>Pick a chapter to start writing</h2>
      <p>Or create a new blog space from the sidebar.</p>
    </div>
  );
}
