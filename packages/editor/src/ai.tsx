import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { AiStatusShape } from "./types";

/**
 * Shared AI status — fetched once per space change, cached by react-query.
 * Any component that needs to know whether AI features should render reads
 * from this context. When the status is `null`, AI is disabled globally and
 * AI affordances must hide themselves (not show a disabled state).
 */
const AiStatusCtx = createContext<AiStatusShape | null>(null);

export function useAiStatus(): AiStatusShape | null {
  return useContext(AiStatusCtx);
}

export function AiStatusProvider({
  spaceId,
  children,
}: {
  spaceId: string | null;
  children: React.ReactNode;
}) {
  const query = useQuery({
    queryKey: ["ai-status", spaceId ?? "global"],
    queryFn: () => api.aiStatus(spaceId ?? undefined),
    staleTime: 30_000,
  });
  return <AiStatusCtx.Provider value={query.data ?? null}>{children}</AiStatusCtx.Provider>;
}

/** Stream the server's SSE chat response, calling `onDelta` for each token. */
export async function streamChat(args: {
  spaceId: string;
  message: string;
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { spaceId, message, onDelta, onDone, onError, signal } = args;
  const res = await fetch(`/api/spaces/${spaceId}/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    onError(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines. Drain complete frames.
      let nl = buffer.indexOf("\n\n");
      while (nl >= 0) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim()) as
              | { delta: string }
              | { done: true }
              | { error: string };
            if ("delta" in payload) onDelta(payload.delta);
            else if ("done" in payload) onDone();
            else if ("error" in payload) onError(payload.error);
          } catch {
            // Ignore malformed frames — usually a keepalive.
          }
        }
        nl = buffer.indexOf("\n\n");
      }
    }
    onDone();
  } catch (err) {
    if ((err as { name?: string }).name !== "AbortError") {
      onError((err as Error).message);
    }
  }
}
