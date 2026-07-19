import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { MediaReportShape, MediaStatusShape } from "./types";

export function mediaQueryKeys(spaceId: string, slug?: string | null) {
  return {
    status: ["media-status", spaceId] as const,
    report: ["media-report", spaceId, slug ?? "all"] as const,
  };
}

/** Polls queue + manifest processing state; speeds up while work is in flight. */
export function useMediaStatus(spaceId: string | null) {
  return useQuery({
    queryKey: spaceId ? mediaQueryKeys(spaceId).status : ["media-status", "none"],
    queryFn: () => api.mediaStatus(spaceId!),
    enabled: !!spaceId,
    refetchInterval: (q) => {
      const d = q.state.data as MediaStatusShape | undefined;
      if (!d) return 3000;
      const busy = d.queue.pending > 0 || d.queue.active || d.pendingAssets > 0;
      return busy ? 1500 : 8000;
    },
  });
}

export function useMediaReport(spaceId: string | null, slug: string | null, enabled: boolean) {
  return useQuery({
    queryKey: spaceId ? mediaQueryKeys(spaceId, slug).report : ["media-report", "none"],
    queryFn: () => api.mediaReport(spaceId!, slug ?? undefined),
    enabled: !!spaceId && enabled,
    refetchInterval: enabled
      ? (q) => {
          const d = q.state.data as MediaReportShape | undefined;
          const busy =
            (d?.queue.pending ?? 0) > 0 ||
            !!d?.queue.active ||
            (d?.summary.pending ?? 0) > 0;
          return busy ? 1500 : false;
        }
      : false,
  });
}

export function useMediaProcessing(spaceId: string | null, slug: string | null) {
  const qc = useQueryClient();
  const status = useMediaStatus(spaceId);
  const busy =
    !!status.data &&
    (status.data.queue.pending > 0 ||
      !!status.data.queue.active ||
      status.data.pendingAssets > 0);

  const invalidate = () => {
    if (!spaceId) return;
    void qc.invalidateQueries({ queryKey: mediaQueryKeys(spaceId).status });
    void qc.invalidateQueries({ queryKey: ["media-report", spaceId] });
    void qc.invalidateQueries({ queryKey: ["assets", spaceId] });
  };

  return { status, busy, invalidate };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMediaBytes(n: number): string {
  return formatBytes(n);
}

export function variantSummary(v: {
  width: number;
  height: number;
  bytes: number;
  codec?: string;
  format?: string;
  container?: string;
  mime?: string;
  hdr?: boolean;
  role?: string;
}): string {
  const parts = [`${v.width}×${v.height}`, formatBytes(v.bytes)];
  if (v.role) parts.push(v.role);
  if (v.codec) parts.push(v.codec);
  else if (v.format) parts.push(v.format);
  if (v.container) parts.push(v.container);
  if (v.hdr) parts.push("HDR");
  return parts.join(" · ");
}
