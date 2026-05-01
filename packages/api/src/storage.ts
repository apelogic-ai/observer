/**
 * Storage abstraction. Two implementations: local filesystem and S3.
 *
 * Designed around four primitives:
 *   - put(key, body)       — write an object
 *   - get(key)             — read an object (null if missing)
 *   - head(key)            — does an object exist?
 *   - list(prefix)         — iterate all keys under a prefix
 *
 * Conspicuously absent: no append, no rename, no atomic compare-and-swap.
 * This is deliberate. S3 has no append; emulating it requires GET-PUT
 * cycles that race under concurrent writers. The store layer above this
 * encodes its dedup state as one marker object per batchId rather than
 * a single appendable file, so the abstraction stays minimal.
 *
 * Keys use forward slashes regardless of platform. LocalStorage maps
 * each key to a path under its root directory.
 */

import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, NoSuchKey,
} from "@aws-sdk/client-s3";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Storage {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  head(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<string>;
}

// ── Local filesystem ──────────────────────────────────────────────

export class LocalStorage implements Storage {
  constructor(private root: string) {}

  private path(key: string): string {
    // normalise — keys always use '/', map to platform separator implicitly
    // via path.join. Reject keys that would escape the root (defence in depth;
    // the only caller is Store, which composes its own keys, but a stray
    // ".." in a developer hash someday shouldn't punch out of the data dir).
    if (key.includes("..")) throw new Error(`refused: path traversal in key ${key}`);
    return join(this.root, key);
  }

  async put(key: string, body: string): Promise<void> {
    const file = this.path(key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  async get(key: string): Promise<string | null> {
    const file = this.path(key);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf-8");
  }

  async head(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  async *list(prefix: string): AsyncIterable<string> {
    // Walk the directory tree below `prefix`, yielding keys whose
    // path starts with `prefix`. Prefix may end mid-segment ("dir/"
    // vs "dir/file"); we just compare as a string.
    const startDir = this.path(prefix);
    const startSegment = startDir.endsWith("/") ? startDir.slice(0, -1) : startDir;
    if (!existsSync(startSegment) && !existsSync(dirname(startSegment))) return;

    // Walk from the lowest existing ancestor.
    const walkRoot = existsSync(startSegment) ? startSegment : dirname(startSegment);
    yield* this.walk(walkRoot, prefix);
  }

  private *walk(dir: string, prefix: string): IterableIterator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(fullPath, prefix);
      } else if (entry.isFile()) {
        // Convert the absolute path back into a key relative to root.
        const key = fullPath.slice(this.root.length + 1).split(/[/\\]/).join("/");
        if (key.startsWith(prefix)) yield key;
      }
    }
  }
}

// ── S3 ────────────────────────────────────────────────────────────

export interface S3StorageOpts {
  region?: string;
  endpoint?: string;     // override for S3-compatible (minio, R2)
  forcePathStyle?: boolean;
}

export class S3Storage implements Storage {
  // We keep the client typed as S3Client but accept any object with a
  // compatible `send` method so tests can inject a fake. The SDK's
  // type is structural enough that this assertion holds at runtime.
  private client: S3Client;
  private bucket: string;

  constructor(bucket: string, client: S3Client) {
    this.bucket = bucket;
    this.client = client;
  }

  /**
   * Convenience constructor — builds a real S3Client from env-style opts.
   * Tests bypass this and pass their own client to the main constructor.
   */
  static fromOpts(bucket: string, opts: S3StorageOpts = {}): S3Storage {
    const client = new S3Client({
      region: opts.region ?? process.env.AWS_REGION ?? "us-east-1",
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    });
    return new S3Storage(bucket, client);
  }

  async put(key: string, body: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
    }));
  }

  async get(key: string): Promise<string | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      const body = out.Body;
      if (!body) return null;
      // SDK v3: Body has transformToString() in browser/Node18+ runtimes
      const asAny = body as { transformToString?: () => Promise<string> };
      if (asAny.transformToString) return await asAny.transformToString();
      // Fallback: stream → string
      const stream = body as unknown as AsyncIterable<Uint8Array>;
      const chunks: Uint8Array[] = [];
      for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks).toString("utf-8");
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }

  async head(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async *list(prefix: string): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const out = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      for (const obj of out.Contents ?? []) {
        if (obj.Key) yield obj.Key;
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }
}
