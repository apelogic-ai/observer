import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticHandler } from "../../server/static";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-static-"));
}

/** Stand up a minimal static-export-shaped directory:
 *    out/index.html         "ROOT"
 *    out/commit/index.html  "COMMIT"
 *    out/_next/static/x.js  "JS"
 *    out/404.html           "NOT FOUND"
 */
function makeFixture(): string {
  const root = makeTmpDir();
  mkdirSync(join(root, "commit"), { recursive: true });
  mkdirSync(join(root, "_next", "static"), { recursive: true });
  writeFileSync(join(root, "index.html"), "ROOT");
  writeFileSync(join(root, "commit", "index.html"), "COMMIT");
  writeFileSync(join(root, "_next", "static", "x.js"), "JS");
  writeFileSync(join(root, "404.html"), "NOT FOUND");
  return root;
}

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

describe("createStaticHandler", () => {
  it("serves index.html for /", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe("ROOT");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves /commit/ → /commit/index.html", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/commit/");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe("COMMIT");
  });

  it("rewrites bare /commit (no trailing slash) to /commit/index.html", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/commit");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe("COMMIT");
  });

  it("serves hashed JS chunks with immutable cache header", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/_next/static/x.js");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe("JS");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("falls back to 404.html for unknown paths", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/does-not-exist");
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toBe("NOT FOUND");
  });

  it("blocks path traversal that would escape the static root", async () => {
    const handle = createStaticHandler(makeFixture());
    // The pathname `/../../etc/passwd` after URL parsing is still relative
    // to the root; resolve() may collapse it. Ensure we never serve a file
    // outside root regardless: status is 403 or 404, never 200.
    const res = await handle("/../../etc/passwd");
    expect([403, 404]).toContain(res.status);
  });

  it("returns 503 with a clear message when the assets aren't built", async () => {
    const handle = createStaticHandler(join(makeTmpDir(), "no-such-out"));
    const res = await handle("/");
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toContain("not built");
  });

  it("returns 400 on malformed URL-encoded path", async () => {
    const handle = createStaticHandler(makeFixture());
    const res = await handle("/%E0%A4%A");
    expect(res.status).toBe(400);
  });
});
