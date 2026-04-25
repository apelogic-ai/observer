import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitCursors } from "../../src/git/cursors";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-git-cursors-"));
}

describe("GitCursors", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  it("returns null for unknown repo", () => {
    const cursors = new GitCursors(stateDir);
    expect(cursors.get("acme/unknown")).toBeNull();
  });

  it("stores and retrieves cursor", () => {
    const cursors = new GitCursors(stateDir);
    cursors.set("acme/project", "2026-04-22");
    expect(cursors.get("acme/project")).toBe("2026-04-22");
  });

  it("persists across instances", () => {
    const c1 = new GitCursors(stateDir);
    c1.set("acme/project", "2026-04-22");
    c1.set("acme/other", "2026-04-20");
    c1.save();

    const c2 = new GitCursors(stateDir);
    expect(c2.get("acme/project")).toBe("2026-04-22");
    expect(c2.get("acme/other")).toBe("2026-04-20");
  });

  it("overwrites cursor on update", () => {
    const cursors = new GitCursors(stateDir);
    cursors.set("acme/project", "2026-04-20");
    cursors.set("acme/project", "2026-04-22");
    cursors.save();

    const c2 = new GitCursors(stateDir);
    expect(c2.get("acme/project")).toBe("2026-04-22");
  });

  it("creates file on save", () => {
    const cursors = new GitCursors(stateDir);
    cursors.set("acme/project", "2026-04-22");
    cursors.save();
    expect(existsSync(join(stateDir, "git-cursors.json"))).toBe(true);
  });

  it("handles missing state file gracefully", () => {
    // Non-existent dir is fine — load returns empty
    const cursors = new GitCursors(join(stateDir, "nonexistent"));
    expect(cursors.get("acme/project")).toBeNull();
  });
});
