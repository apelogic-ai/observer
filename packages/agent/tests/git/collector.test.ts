import { describe, it, expect } from "vitest";
import { parseGitLog } from "../../src/git/collector";

const META = {
  project: "test-project",
  repo: "acme/test-project",
  developer: "dev@example.com",
  machine: "test-machine",
  repoPath: "/Users/dev/test-project",
};

const SEP = "---GIT_EVENT_FIELD---";
const BEGIN = "---GIT_EVENT_BEGIN---";

function makeCommit(fields: {
  sha?: string;
  parents?: string;
  author?: string;
  email?: string;
  date?: string;
  subject?: string;
  body?: string;
  numstat?: string;
}): string {
  const {
    sha = "abc123def456",
    parents = "",
    author = "Test User",
    email = "test@example.com",
    date = "2026-04-22T10:30:00+00:00",
    subject = "fix: something",
    body = "",
    numstat = "",
  } = fields;

  // Mimics real git log --format="BEGIN...fields" --numstat output:
  // BEGINsha|parents|...|body\nnumstat_lines
  return BEGIN + [sha, parents, author, email, date, subject, body].join(SEP)
    + (numstat ? "\n" + numstat : "");
}

describe("parseGitLog", () => {
  it("parses a simple commit", () => {
    const raw = makeCommit({
      sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      author: "Jane Dev",
      email: "jane@example.com",
      date: "2026-04-22T14:30:00+00:00",
      subject: "feat: add login page",
      numstat: "10\t2\tsrc/login.tsx\n3\t0\tsrc/api.ts",
    });

    const events = parseGitLog(raw, META);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.eventType).toBe("commit");
    expect(e.commitSha).toBe("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
    expect(e.author).toBe("Jane Dev");
    expect(e.authorEmail).toBe("jane@example.com");
    expect(e.message).toBe("feat: add login page");
    expect(e.filesChanged).toBe(2);
    expect(e.insertions).toBe(13);
    expect(e.deletions).toBe(2);
    expect(e.files).toEqual(["src/login.tsx", "src/api.ts"]);
    expect(e.agentAuthored).toBe(false);
    expect(e.agentName).toBeNull();
    expect(e.project).toBe("test-project");
    expect(e.repo).toBe("acme/test-project");
  });

  it("detects Claude agent from Co-Authored-By", () => {
    const raw = makeCommit({
      subject: "feat: add auth middleware",
      body: "Co-Authored-By: Claude <noreply@anthropic.com>",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].agentAuthored).toBe(true);
    expect(events[0].agentName).toBe("claude_code");
    expect(events[0].coAuthors).toEqual(["Claude <noreply@anthropic.com>"]);
  });

  it("detects Claude from Anthropic Co-Authored-By variations", () => {
    const raw = makeCommit({
      subject: "refactor: cleanup",
      body: "Co-Authored-By: Claude Opus 4 <noreply@anthropic.com>",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].agentAuthored).toBe(true);
    expect(events[0].agentName).toBe("claude_code");
  });

  it("detects Codex from Co-Authored-By", () => {
    const raw = makeCommit({
      subject: "fix: resolve lint errors",
      body: "Co-Authored-By: Codex <noreply@openai.com>",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].agentAuthored).toBe(true);
    expect(events[0].agentName).toBe("codex");
  });

  it("detects agent from author email", () => {
    const raw = makeCommit({
      email: "noreply@anthropic.com",
      subject: "auto-commit",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].agentAuthored).toBe(true);
    expect(events[0].agentName).toBe("claude_code");
  });

  it("parses merge commit with multiple parents", () => {
    const raw = makeCommit({
      sha: "merge1234",
      parents: "parent1 parent2",
      subject: "Merge branch 'feat/x' into main",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].parentShas).toEqual(["parent1", "parent2"]);
  });

  it("handles commit with no numstat (empty diff)", () => {
    const raw = makeCommit({
      subject: "chore: empty commit",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].filesChanged).toBe(0);
    expect(events[0].insertions).toBe(0);
    expect(events[0].deletions).toBe(0);
    expect(events[0].files).toBeNull();
  });

  it("parses multiple commits", () => {
    const raw = [
      makeCommit({ sha: "aaa", date: "2026-04-22T10:00:00+00:00", subject: "first" }),
      makeCommit({ sha: "bbb", date: "2026-04-22T11:00:00+00:00", subject: "second" }),
      makeCommit({ sha: "ccc", date: "2026-04-22T09:00:00+00:00", subject: "earliest" }),
    ].join("\n");

    const events = parseGitLog(raw, META);
    expect(events).toHaveLength(3);
    // Should be sorted by timestamp
    expect(events[0].message).toBe("earliest");
    expect(events[1].message).toBe("first");
    expect(events[2].message).toBe("second");
  });

  it("handles binary files in numstat", () => {
    const raw = makeCommit({
      subject: "add image",
      numstat: "-\t-\tassets/logo.png\n5\t0\tREADME.md",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].filesChanged).toBe(2);
    expect(events[0].insertions).toBe(5); // binary "-" parsed as NaN, skipped
    expect(events[0].files).toEqual(["assets/logo.png", "README.md"]);
  });

  it("handles empty input", () => {
    expect(parseGitLog("", META)).toEqual([]);
    expect(parseGitLog("  \n  ", META)).toEqual([]);
  });

  it("generates deterministic IDs", () => {
    const raw = makeCommit({ sha: "abc123" });
    const events1 = parseGitLog(raw, META);
    const events2 = parseGitLog(raw, META);
    expect(events1[0].id).toBe(events2[0].id);
    expect(events1[0].id).toHaveLength(16);
  });

  it("extracts multiple Co-Authored-By trailers", () => {
    const raw = makeCommit({
      subject: "pair programming",
      body: "Co-Authored-By: Alice <alice@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>",
    });

    const events = parseGitLog(raw, META);
    expect(events[0].coAuthors).toEqual([
      "Alice <alice@example.com>",
      "Claude <noreply@anthropic.com>",
    ]);
    expect(events[0].agentAuthored).toBe(true);
  });

  it("sets repoLocal and project from meta", () => {
    const raw = makeCommit({});
    const events = parseGitLog(raw, META);
    expect(events[0].repoLocal).toBe("/Users/dev/test-project");
    expect(events[0].developer).toBe("dev@example.com");
    expect(events[0].machine).toBe("test-machine");
  });
});
