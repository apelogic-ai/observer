/**
 * Store — persists received batches to the lakehouse.
 *
 * Hive-style partitioned key layout (same on local FS and S3):
 *   raw/year=YYYY/month=MM/day=DD/agent=X/dev=HASH/{batchId}.jsonl
 *   raw/year=YYYY/month=MM/day=DD/agent=X/dev=HASH/{batchId}.meta.json
 *   dedup/{devHash}/{batchId}      # zero-byte marker; presence = "seen"
 *
 * Partitioned by: ship date, agent, developer (SHA-256 prefix for privacy).
 *
 * Why per-batchId dedup markers instead of an appendable dedup.log:
 * S3 has no append. A single canonical mechanism that works on both
 * backends is one object per batchId — `head(dedup/{dev}/{batchId})`
 * answers "duplicate?" in one round trip; `list(dedup/{dev}/)` enumerates
 * everything seen for a developer. Local FS just creates a 0-byte file.
 *
 * Cross-boundary sessions: a session spanning midnight ships as one batch
 * partitioned by shippedAt. The downstream Parquet zone re-partitions by
 * entry timestamp.
 */

import { createHash } from "node:crypto";
import { LocalStorage, type Storage } from "./storage";

export interface StoredBatch {
  batchId?: string;
  developer: string;
  machine: string;
  agent: string;
  project: string;
  sourceFile: string;
  shippedAt: string;
  receivedAt: string;
  entries: string[];
}

export interface SaveResult {
  entryCount: number;
  filePath: string;
  duplicate?: boolean;
}

export interface BatchMeta {
  batchId: string;
  developer: string;
  machine: string;
  agent: string;
  project: string;
  shippedAt: string;
  receivedAt: string;
  entryCount: number;
  filePath: string;
}

export class Store {
  private storage: Storage;
  /** Per-developer dedup caches, loaded lazily on first access. */
  private dedupByDev: Map<string, Set<string>> = new Map();

  /**
   * Construct from either a Storage instance directly or a local
   * filesystem path (which gets wrapped in LocalStorage). The path
   * form preserves the original test ergonomics.
   */
  constructor(storageOrPath: Storage | string) {
    this.storage = typeof storageOrPath === "string"
      ? new LocalStorage(storageOrPath)
      : storageOrPath;
  }

  private devHash(developer: string): string {
    return createHash("sha256").update(developer).digest("hex").slice(0, 12);
  }

  /**
   * Load (or return cached) the set of batchIds previously seen for a
   * developer. The first call lists `dedup/{devHash}/`; subsequent
   * calls hit the cache.
   */
  private async getDedupSet(devKey: string): Promise<Set<string>> {
    if (this.dedupByDev.has(devKey)) return this.dedupByDev.get(devKey)!;
    const ids = new Set<string>();
    const prefix = `dedup/${devKey}/`;
    for await (const key of this.storage.list(prefix)) {
      // key is "dedup/{devKey}/{batchId}" — strip the prefix.
      ids.add(key.slice(prefix.length));
    }
    this.dedupByDev.set(devKey, ids);
    return ids;
  }

  async isDuplicate(batchId: string | undefined, developer?: string): Promise<boolean> {
    if (!batchId || !developer) return false;
    const devKey = this.devHash(developer);
    const set = await this.getDedupSet(devKey);
    return set.has(batchId);
  }

  async saveBatch(batch: StoredBatch): Promise<SaveResult> {
    const devKey = this.devHash(batch.developer);

    const batchId = batch.batchId ?? createHash("sha256")
      .update(`${batch.developer}:${batch.shippedAt}:${batch.entries.length}:${Date.now()}`)
      .digest("hex")
      .slice(0, 16);

    const dedupSet = await this.getDedupSet(devKey);
    if (dedupSet.has(batchId)) {
      return { entryCount: 0, filePath: "", duplicate: true };
    }

    const date = new Date(batch.shippedAt || batch.receivedAt);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");

    const partitionKey = [
      "raw",
      `year=${year}`,
      `month=${month}`,
      `day=${day}`,
      `agent=${batch.agent}`,
      `dev=${devKey}`,
    ].join("/");

    const entriesKey = `${partitionKey}/${batchId}.jsonl`;
    const metaKey = `${partitionKey}/${batchId}.meta.json`;

    await this.storage.put(entriesKey, batch.entries.join("\n") + "\n");

    const meta: BatchMeta = {
      batchId,
      developer: batch.developer,
      machine: batch.machine,
      agent: batch.agent,
      project: batch.project,
      shippedAt: batch.shippedAt,
      receivedAt: batch.receivedAt,
      entryCount: batch.entries.length,
      filePath: entriesKey,
    };
    await this.storage.put(metaKey, JSON.stringify(meta, null, 2));

    // Marker for the dedup index — empty body, presence is the signal.
    await this.storage.put(`dedup/${devKey}/${batchId}`, "");
    dedupSet.add(batchId);

    return { entryCount: batch.entries.length, filePath: entriesKey };
  }

  async listBatches(): Promise<BatchMeta[]> {
    const metas: BatchMeta[] = [];
    for await (const key of this.storage.list("raw/")) {
      if (!key.endsWith(".meta.json")) continue;
      const body = await this.storage.get(key);
      if (!body) continue;
      try {
        metas.push(JSON.parse(body) as BatchMeta);
      } catch { /* skip malformed */ }
    }
    return metas;
  }
}
