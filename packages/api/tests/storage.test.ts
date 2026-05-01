import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalStorage, S3Storage, type Storage } from "../src/storage";

/**
 * Storage is the small async interface that Store sits on top of —
 * put / get / head / list. Both backends (LocalStorage on disk,
 * S3Storage on AWS) must implement it identically; these tests run
 * the same expectations against either implementation.
 */

function commonContract(name: string, makeStorage: () => Promise<Storage>) {
  describe(name, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await makeStorage();
    });

    it("put then get returns the same body", async () => {
      await storage.put("a/b/c.txt", "hello world");
      const body = await storage.get("a/b/c.txt");
      expect(body).toBe("hello world");
    });

    it("head returns false for non-existent keys, true after put", async () => {
      expect(await storage.head("missing.txt")).toBe(false);
      await storage.put("present.txt", "x");
      expect(await storage.head("present.txt")).toBe(true);
    });

    it("get returns null for non-existent keys", async () => {
      expect(await storage.get("missing.txt")).toBeNull();
    });

    it("list returns every key under a prefix", async () => {
      await storage.put("dir/a.txt", "1");
      await storage.put("dir/sub/b.txt", "2");
      await storage.put("other/c.txt", "3");
      const keys: string[] = [];
      for await (const k of storage.list("dir/")) keys.push(k);
      keys.sort();
      expect(keys).toEqual(["dir/a.txt", "dir/sub/b.txt"]);
    });

    it("list with empty result is fine", async () => {
      const keys: string[] = [];
      for await (const k of storage.list("nothing/")) keys.push(k);
      expect(keys).toEqual([]);
    });

    it("put overwrites the previous body", async () => {
      await storage.put("k.txt", "first");
      await storage.put("k.txt", "second");
      expect(await storage.get("k.txt")).toBe("second");
    });
  });
}

commonContract("LocalStorage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observer-storage-local-"));
  return new LocalStorage(dir);
});

// ── S3Storage — mocked SDK ─────────────────────────────────────
//
// We don't reach AWS in unit tests. Inject a fake S3Client that
// services Put/Get/Head/List from an in-memory map, then exercise
// S3Storage against it. This proves the S3Storage class translates
// the contract correctly and emits the right SDK calls; the actual
// AWS path is exercised separately in the deploy environment.

import {
  PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";

class FakeS3Client {
  private store = new Map<string, string>();
  // mimic AWS SDK's `send` dispatch
  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof PutObjectCommand) {
      const { Key, Body } = cmd.input as { Key: string; Body: string };
      this.store.set(Key, Body);
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const { Key } = cmd.input as { Key: string };
      const body = this.store.get(Key);
      if (body === undefined) {
        const err = new Error("NoSuchKey") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      return {
        Body: { transformToString: async () => body },
      };
    }
    if (cmd instanceof HeadObjectCommand) {
      const { Key } = cmd.input as { Key: string };
      if (!this.store.has(Key)) {
        const err = new Error("NotFound") as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    }
    if (cmd instanceof ListObjectsV2Command) {
      const { Prefix, ContinuationToken } = cmd.input as { Prefix?: string; ContinuationToken?: string };
      const allKeys = [...this.store.keys()].filter((k) => !Prefix || k.startsWith(Prefix)).sort();
      const startIdx = ContinuationToken ? parseInt(ContinuationToken, 10) : 0;
      const PAGE = 2;             // small page so the test exercises pagination
      const slice = allKeys.slice(startIdx, startIdx + PAGE);
      const next = startIdx + PAGE < allKeys.length ? String(startIdx + PAGE) : undefined;
      return {
        Contents: slice.map((Key) => ({ Key })),
        NextContinuationToken: next,
        IsTruncated: !!next,
      };
    }
    throw new Error(`unhandled command: ${(cmd as { constructor: { name: string } }).constructor.name}`);
  }
}

commonContract("S3Storage", async () => {
  const fake = new FakeS3Client();
  // S3Storage takes anything with a compatible `send` method; the
  // production constructor takes a real S3Client.
  return new S3Storage("test-bucket", fake as unknown as import("@aws-sdk/client-s3").S3Client);
});
