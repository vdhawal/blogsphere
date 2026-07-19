import { join } from "node:path";
import type { AssetEntry } from "@blogspace/schemas";
import { processImage, processVideo, variantSubdirForRef } from "@blogspace/media";
import type { AssetStore } from "./asset-store.js";

export interface AssetJob {
  spaceId: string;
  sourceRelative: string;
  kind: "image" | "video";
}

export interface QueueStatus {
  pending: number;
  active: string | null;
}

/** Single-worker in-process queue — enough for the local single-user editor. */
export class AssetProcessingQueue {
  private jobs: AssetJob[] = [];
  private pumping = false;
  private pendingBySpace = new Map<string, number>();
  private activeBySpace = new Map<string, string | null>();

  constructor(
    private spaceRootFor: (spaceId: string) => string,
    private assets: AssetStore,
  ) {}

  enqueue(job: AssetJob): void {
    this.pendingBySpace.set(job.spaceId, (this.pendingBySpace.get(job.spaceId) ?? 0) + 1);
    this.jobs.push(job);
    void this.pump();
  }

  status(spaceId: string): QueueStatus {
    return {
      pending: this.pendingBySpace.get(spaceId) ?? 0,
      active: this.activeBySpace.get(spaceId) ?? null,
    };
  }

  /** Block until all queued jobs for a space finish. */
  async drain(spaceId: string): Promise<void> {
    while ((this.pendingBySpace.get(spaceId) ?? 0) > 0 || this.activeBySpace.get(spaceId)) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.activeBySpace.set(job.spaceId, job.sourceRelative);
      try {
        await this.runJob(job);
      } finally {
        this.activeBySpace.set(job.spaceId, null);
        const left = (this.pendingBySpace.get(job.spaceId) ?? 1) - 1;
        if (left <= 0) this.pendingBySpace.delete(job.spaceId);
        else this.pendingBySpace.set(job.spaceId, left);
      }
    }
    this.pumping = false;
  }

  private async runJob(job: AssetJob): Promise<void> {
    const spaceRoot = this.spaceRootFor(job.spaceId);
    const sourceAbs = join(spaceRoot, job.sourceRelative);
    const variantSubdir = variantSubdirForRef(job.sourceRelative);
    try {
      let entry: AssetEntry;
      if (job.kind === "image") {
        entry = await processImage({
          sourceAbs,
          spaceRoot,
          sourceRelative: job.sourceRelative,
          options: { variantSubdir },
        });
      } else {
        const result = await processVideo({
          sourceAbs,
          spaceRoot,
          sourceRelative: job.sourceRelative,
          options: { variantSubdir },
        });
        entry = result.asset;
      }
      await this.assets.upsert(job.spaceId, {
        ...entry,
        processingStatus: "ready",
        processingError: undefined,
      });
    } catch (err) {
      const manifest = await this.assets.load(job.spaceId);
      const prev = manifest.assets.find((a) => a.sourcePath === job.sourceRelative);
      if (prev) {
        await this.assets.upsert(job.spaceId, {
          ...prev,
          processingStatus: "failed",
          processingError: (err as Error).message,
        });
      }
    }
  }
}
