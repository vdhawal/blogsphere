import { join } from "node:path";
import { collectAssetRefs, loadBlogSpace } from "@blogspace/compiler";
import { ensureAssetVariants } from "@blogspace/media";
import type { Workspace } from "./fs-ops.js";
import type { AssetStore } from "./asset-store.js";
import type { AssetProcessingQueue } from "./asset-queue.js";

/** Wait for the queue, then repair any incomplete referenced assets. */
export async function ensureSpaceAssetsReady(args: {
  workspace: Workspace;
  assets: AssetStore;
  queue: AssetProcessingQueue;
  spaceId: string;
}): Promise<{ repaired: string[]; warnings: string[] }> {
  const { workspace, assets, queue, spaceId } = args;
  await queue.drain(spaceId);
  const spaceRoot = workspace.spaceDir(spaceId);
  const space = await loadBlogSpace(spaceRoot);
  const { imageRefs, videoRefs } = collectAssetRefs(space);
  const manifest = await assets.load(spaceId);
  const result = await ensureAssetVariants({
    spaceRoot,
    imageRefs,
    videoRefs,
    manifest,
    repair: true,
  });
  await assets.save(spaceId, {
    version: 1,
    updatedAt: new Date().toISOString(),
    assets: result.entries,
  });
  return { repaired: result.repaired, warnings: result.warnings };
}
