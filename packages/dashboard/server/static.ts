/**
 * Static file handler for the Bun server. Serves `next build --output export`
 * output (HTML + chunks) at any non-/api/* path.
 *
 * Path resolution rules match what Next produces with `trailingSlash: true`:
 *   /                → /index.html
 *   /commit/         → /commit/index.html
 *   /commit          → /commit/index.html          (silent rewrite)
 *   /_next/static/x  → /_next/static/x             (serve as-is)
 *
 * Path traversal (`..`) is blocked by resolving relative to the static root
 * and rejecting anything that escapes. Missing files fall back to
 * `out/404.html` if present; otherwise a plain 404.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface StaticHandler {
  (pathname: string): Response | Promise<Response>;
}

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = resolve(rootDir);
  const rootExists = existsSync(root);
  const indexHtml  = existsSync(resolve(root, "index.html"));
  const notFound   = resolve(root, "404.html");

  return async function serveStatic(pathname: string): Promise<Response> {
    if (!rootExists || !indexHtml) {
      return new Response(
        `Dashboard assets not built.\n` +
        `Run \`next build\` in packages/dashboard, or point --static-dir ` +
        `at an existing out/ directory.\n` +
        `Expected: ${root}\n`,
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    }

    let rel: string;
    try { rel = decodeURIComponent(pathname); }
    catch { return new Response("bad request", { status: 400 }); }

    // Normalize trailing slash / bare paths → /index.html
    if (rel === "/" || rel.endsWith("/")) {
      rel += "index.html";
    }

    const full = resolve(root, "." + rel);
    if (!full.startsWith(root + "/") && full !== root) {
      return new Response("forbidden", { status: 403 });
    }

    // Direct file hit (has extension, asset).
    if (isFile(full)) return serve(full, 200);

    // Bare path like /commit → /commit/index.html
    const asDir = resolve(full, "index.html");
    if (asDir.startsWith(root) && isFile(asDir)) return serve(asDir, 200);

    // Fallback to 404.html so the user sees styled page not raw text.
    if (isFile(notFound)) return serve(notFound, 404);
    return new Response("not found", { status: 404 });
  };
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function serve(path: string, status: number): Response {
  const f = Bun.file(path);
  return new Response(f, {
    status,
    headers: {
      "Content-Type": f.type || "application/octet-stream",
      // Aggressive caching for hashed chunks; HTML stays fresh.
      "Cache-Control": path.includes("/_next/static/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}
