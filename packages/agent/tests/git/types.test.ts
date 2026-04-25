import { describe, it, expect } from "bun:test";
import { applyGitDisclosure, gitEventId, type GitEvent } from "../../src/git/types";

function makeEvent(overrides: Partial<GitEvent> = {}): GitEvent {
  return {
    id: "test-id",
    timestamp: "2026-04-22T14:30:00+00:00",
    eventType: "commit",
    project: "test-project",
    repo: "acme/test-project",
    branch: "main",
    developer: "dev@example.com",
    machine: "test-machine",
    commitSha: "abc123",
    parentShas: null,
    filesChanged: 5,
    insertions: 100,
    deletions: 20,
    agentAuthored: true,
    agentName: "claude_code",
    author: "Claude",
    authorEmail: "noreply@anthropic.com",
    coAuthors: ["Claude <noreply@anthropic.com>"],
    message: "feat: add feature",
    files: ["src/a.ts"],
    sessionId: "sess-123",
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    prBaseBranch: null,
    prHeadBranch: null,
    messageBody: "Detailed body text",
    repoLocal: "/Users/dev/project",
    ...overrides,
  };
}

describe("applyGitDisclosure", () => {
  it("basic — strips MODERATE and SENSITIVE", () => {
    const result = applyGitDisclosure(makeEvent(), "basic");

    // SAFE preserved
    expect(result.commitSha).toBe("abc123");
    expect(result.filesChanged).toBe(5);
    expect(result.insertions).toBe(100);
    expect(result.agentAuthored).toBe(true);
    expect(result.agentName).toBe("claude_code");
    expect(result.developer).toBe("dev@example.com");

    // MODERATE stripped
    expect(result.author).toBeNull();
    expect(result.authorEmail).toBeNull();
    expect(result.coAuthors).toBeNull();
    expect(result.message).toBeNull();
    expect(result.files).toBeNull();
    expect(result.sessionId).toBeNull();

    // SENSITIVE stripped
    expect(result.messageBody).toBeNull();
    expect(result.repoLocal).toBeNull();
  });

  it("moderate — keeps MODERATE, strips SENSITIVE", () => {
    const result = applyGitDisclosure(makeEvent(), "moderate");

    expect(result.author).toBe("Claude");
    expect(result.message).toBe("feat: add feature");
    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.sessionId).toBe("sess-123");

    expect(result.messageBody).toBeNull();
    expect(result.repoLocal).toBeNull();
  });

  it("sensitive — keeps all", () => {
    const result = applyGitDisclosure(makeEvent(), "sensitive");

    expect(result.messageBody).toBe("Detailed body text");
    expect(result.repoLocal).toBe("/Users/dev/project");
    expect(result.author).toBe("Claude");
  });

  it("full — keeps all", () => {
    const result = applyGitDisclosure(makeEvent(), "full");
    expect(result.messageBody).toBe("Detailed body text");
    expect(result.repoLocal).toBe("/Users/dev/project");
  });
});

describe("gitEventId", () => {
  it("generates deterministic 16-char IDs", () => {
    const id1 = gitEventId("acme/repo", "commit", "abc123");
    const id2 = gitEventId("acme/repo", "commit", "abc123");
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it("different inputs produce different IDs", () => {
    const id1 = gitEventId("acme/repo", "commit", "abc123");
    const id2 = gitEventId("acme/repo", "commit", "def456");
    const id3 = gitEventId("other/repo", "commit", "abc123");
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });
});
