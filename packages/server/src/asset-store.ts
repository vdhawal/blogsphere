import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  assetManifestSchema,
  emptyAssetManifest,
  type AssetEntry,
  type AssetManifest,
} from "@blogspace/schemas";
import { writeFileAtomic } from "./fs-ops.js";

/**
 * Per-space asset manifest loader/saver. Lives at
 * `<space>/.blogspace/assets.yaml`. Editing happens through the upload API
 * only — never via WS deltas — because variant metadata is derived from
 * processing, not authored.
 *
 * Reads are tolerant: missing file → empty manifest. Writes are atomic.
 */
export class AssetStore {
  /** In-memory snapshot, keyed by spaceId. */
  private cache = new Map<string, AssetManifest>();

  constructor(private workspaceRoot: string) {}

  private manifestPath(spaceId: string): string {
    return join(this.workspaceRoot, spaceId, ".blogspace", "assets.yaml");
  }

  async load(spaceId: string): Promise<AssetManifest> {
    const cached = this.cache.get(spaceId);
    if (cached) return cached;
    const path = this.manifestPath(spaceId);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = assetManifestSchema.parse(yaml.load(raw));
      this.cache.set(spaceId, parsed);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = emptyAssetManifest();
        this.cache.set(spaceId, empty);
        return empty;
      }
      throw err;
    }
  }

  /**
   * Add or replace an asset by sourcePath. The compiler treats sourcePath
   * as the lookup key when walking markdown — duplicate uploads collapse
   * to the latest variants instead of accumulating stale entries.
   */
  async upsert(spaceId: string, entry: AssetEntry): Promise<AssetManifest> {
    const manifest = await this.load(spaceId);
    const next: AssetManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      assets: [
        ...manifest.assets.filter((a) => a.sourcePath !== entry.sourcePath),
        entry,
      ],
    };
    await this.persist(spaceId, next);
    return next;
  }

  /** Drop cached manifest so the next load reads from disk. */
  evict(spaceId: string): void {
    this.cache.delete(spaceId);
  }

  /** Rewrite manifest paths after a chapter slug rename. */
  async rewriteChapterPaths(
    spaceId: string,
    fromSlug: string,
    toSlug: string,
  ): Promise<AssetManifest> {
    if (fromSlug === toSlug) return this.load(spaceId);
    const manifest = await this.load(spaceId);
    const prefix = `assets/${fromSlug}/`;
    const variantPrefix = `assets/.variants/${fromSlug}/`;
    const nextPrefix = `assets/${toSlug}/`;
    const nextVariantPrefix = `assets/.variants/${toSlug}/`;

    const rewritePath = (p: string): string => {
      if (p.startsWith(prefix)) return nextPrefix + p.slice(prefix.length);
      if (p.startsWith(variantPrefix)) return nextVariantPrefix + p.slice(variantPrefix.length);
      return p;
    };

    const next: AssetManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      assets: manifest.assets.map((entry) => {
        if (entry.kind === "image") {
          return {
            ...entry,
            sourcePath: rewritePath(entry.sourcePath),
            variants: entry.variants.map((v) => ({ ...v, path: rewritePath(v.path) })),
          };
        }
        return {
          ...entry,
          sourcePath: rewritePath(entry.sourcePath),
          ...(entry.posterPath ? { posterPath: rewritePath(entry.posterPath) } : {}),
          variants: entry.variants.map((v) => ({ ...v, path: rewritePath(v.path) })),
        };
      }),
    };
    await this.persist(spaceId, next);
    return next;
  }

  async remove(spaceId: string, sourcePath: string): Promise<AssetManifest> {
    const manifest = await this.load(spaceId);
    const next: AssetManifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      assets: manifest.assets.filter((a) => a.sourcePath !== sourcePath),
    };
    await this.persist(spaceId, next);
    return next;
  }

  async save(spaceId: string, manifest: AssetManifest): Promise<AssetManifest> {
    await this.persist(spaceId, manifest);
    return manifest;
  }

  private async persist(spaceId: string, manifest: AssetManifest): Promise<void> {
    const validated = assetManifestSchema.parse(manifest);
    await writeFileAtomic(this.manifestPath(spaceId), yaml.dump(validated, { lineWidth: 100 }));
    this.cache.set(spaceId, validated);
  }
}
