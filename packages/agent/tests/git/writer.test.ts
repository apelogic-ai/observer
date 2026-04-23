import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGitEvents, repoHash } from "../../src/git/writer";
import type { GitEvent } from "../../src/git/types";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-git-writer-"));
}

function makeEvent(overrides: Partial<GitEvent> = {}): GitEvent {
  return {
    id: "test-id-1234",
    timestamp: "2026-04-22T14:30:00+00:00",
    eventType: "commit",
    project: "test-project",
    repo: "acme/test-project",
    branch: "main",
    developer: "dev@example.com",
    machine: "test-machine",
    commitSha: "abc123",
    parentShas: null,
    filesChanged: 2,
    insertions: 10,
    deletions: 3,
    agentAuthored: false,
    agentName: null,
    author: "Test User",
    authorEmail: "test@example.com",
    coAuthors: null,
    message: "fix: something",
    files: ["src/a.ts", "src/b.ts"],
    sessionId: null,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    prBaseBranch: null,
    prHeadBranch: null,
    messageBody: "Detailed description of the fix",
    repoLocal: "/Users/dev/test-project",
    ...overrides,
  };
}

describe("writeGitEvents", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = makeTmpDir();
  });

  it("writes events to date-partitioned git directory", () => {
    const events = [makeEvent()];
    const count = writeGitEvents(events, "acme/test-project", {
      outputDir,
      disclosure: "sensitive",
    });

    expect(count).toBe(1);

    const hash = repoHash("acme/test-project");
    const filePath = join(outputDir, "2026-04-22", "git", `${hash}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.commitSha).toBe("abc123");
    expect(parsed.message).toBe("fix: something");
  });

  it("groups events by date", () => {
    const events = [
      makeEvent({ timestamp: "2026-04-21T10:00:00+00:00", commitSha: "aaa" }),
      makeEvent({ timestamp: "2026-04-22T10:00:00+00:00", commitSha: "bbb" }),
      makeEvent({ timestamp: "2026-04-22T11:00:00+00:00", commitSha: "ccc" }),
    ];

    const count = writeGitEvents(events, "acme/test-project", {
      outputDir,
      disclosure: "sensitive",
    });

    expect(count).toBe(3);

    const hash = repoHash("acme/test-project");
    const day21 = join(outputDir, "2026-04-21", "git", `${hash}.jsonl`);
    const day22 = join(outputDir, "2026-04-22", "git", `${hash}.jsonl`);

    expect(existsSync(day21)).toBe(true);
    expect(existsSync(day22)).toBe(true);

    expect(readFileSync(day21, "utf-8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(day22, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  it("applies basic disclosure — strips MODERATE + SENSITIVE fields", () => {
    const events = [makeEvent()];
    writeGitEvents(events, "acme/test-project", {
      outputDir,
      disclosure: "basic",
    });

    const hash = repoHash("acme/test-project");
    const filePath = join(outputDir, "2026-04-22", "git", `${hash}.jsonl`);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());

    // SAFE fields preserved
    expect(parsed.commitSha).toBe("abc123");
    expect(parsed.filesChanged).toBe(2);
    expect(parsed.agentAuthored).toBe(false);

    // MODERATE fields stripped
    expect(parsed.author).toBeNull();
    expect(parsed.authorEmail).toBeNull();
    expect(parsed.message).toBeNull();
    expect(parsed.files).toBeNull();

    // SENSITIVE fields stripped
    expect(parsed.messageBody).toBeNull();
    expect(parsed.repoLocal).toBeNull();
  });

  it("applies moderate disclosure — keeps MODERATE, strips SENSITIVE", () => {
    const events = [makeEvent()];
    writeGitEvents(events, "acme/test-project", {
      outputDir,
      disclosure: "moderate",
    });

    const hash = repoHash("acme/test-project");
    const filePath = join(outputDir, "2026-04-22", "git", `${hash}.jsonl`);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());

    // MODERATE fields preserved
    expect(parsed.author).toBe("Test User");
    expect(parsed.message).toBe("fix: something");
    expect(parsed.files).toEqual(["src/a.ts", "src/b.ts"]);

    // SENSITIVE fields stripped
    expect(parsed.messageBody).toBeNull();
    expect(parsed.repoLocal).toBeNull();
  });

  it("applies sensitive disclosure — keeps all fields", () => {
    const events = [makeEvent()];
    writeGitEvents(events, "acme/test-project", {
      outputDir,
      disclosure: "sensitive",
    });

    const hash = repoHash("acme/test-project");
    const filePath = join(outputDir, "2026-04-22", "git", `${hash}.jsonl`);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim());

    expect(parsed.messageBody).toBe("Detailed description of the fix");
    expect(parsed.repoLocal).toBe("/Users/dev/test-project");
  });

  it("returns 0 for empty events array", () => {
    const count = writeGitEvents([], "acme/test-project", {
      outputDir,
      disclosure: "sensitive",
    });
    expect(count).toBe(0);
  });

  it("generates consistent repo hash", () => {
    const h1 = repoHash("acme/test-project");
    const h2 = repoHash("acme/test-project");
    const h3 = repoHash("other/repo");

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(12);
  });
});
