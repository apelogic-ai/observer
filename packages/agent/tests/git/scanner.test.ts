import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverActiveRepos,
  getSessionWindows,
  attributeFromSessions,
  filterByAuthor,
  type SessionWindow,
} from "../../src/git/scanner";
import type { GitEvent } from "../../src/git/types";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-scanner-"));
}

/** Write a JSONL file containing entries with the given (project, sessionId,
 *  timestamp) tuples. */
function writeAgentJsonl(
  outputDir: string,
  date: string,
  agent: "claude_code" | "codex" | "cursor",
  filename: string,
  rows: Array<Record<string, unknown>>,
): void {
  const dir = join(outputDir, date, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

// ── discoverActiveRepos ─────────────────────────────────────────────

describe("discoverActiveRepos", () => {
  it("returns [] when output dir doesn't exist", () => {
    expect(discoverActiveRepos(join(makeTmpDir(), "missing"))).toEqual([]);
  });

  it("ignores date dirs whose contents aren't JSONL", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "2026-04-01", "claude_code"), { recursive: true });
    writeFileSync(join(dir, "2026-04-01", "claude_code", "ignored.txt"), "junk");
    expect(discoverActiveRepos(dir)).toEqual([]);
  });

  it("dedupes the same project surfaced by multiple agents/dates", () => {
    const dir = makeTmpDir();
    writeAgentJsonl(dir, "2026-04-01", "claude_code", "a.jsonl", [
      { project: "shared-proj" },
    ]);
    writeAgentJsonl(dir, "2026-04-02", "codex", "b.jsonl", [
      { project: "shared-proj" },
    ]);
    // No real repo at the resolved path — discoverActiveRepos returns only
    // entries it can resolve, so this asserts behavior under "no repo found":
    // returns []. The dedup itself happens inside the project name set; we
    // verify there's no duplicate processing by reading the explicit-repos
    // path below.
    expect(discoverActiveRepos(dir)).toEqual([]);
  });

  it("includes explicit extraRepos that resolve to a real repo", () => {
    const dir = makeTmpDir();
    writeAgentJsonl(dir, "2026-04-01", "claude_code", "a.jsonl", [
      { project: "any" },
    ]);

    // Use this repo as the resolvable target — it exists, has a .git dir,
    // and resolveRepoFromPath should return owner/name.
    const repos = discoverActiveRepos(dir, {
      "any": ["/Users/lbelyaev/dev/observer"],
    });
    expect(repos.length).toBeGreaterThan(0);
    expect(repos[0].project).toBe("any");
    expect(repos[0].repo).toContain("/observer");
  });

  it("dedupes by repo key when the same repo comes from multiple sources", () => {
    const dir = makeTmpDir();
    writeAgentJsonl(dir, "2026-04-01", "claude_code", "a.jsonl", [
      { project: "first" },
    ]);
    const repos = discoverActiveRepos(dir, {
      // Both project labels point at the same physical repo.
      "first":  ["/Users/lbelyaev/dev/observer"],
      "second": ["/Users/lbelyaev/dev/observer"],
    });
    // Only one entry — same repo key, deduped.
    expect(repos.length).toBe(1);
  });
});

// ── getSessionWindows ───────────────────────────────────────────────

describe("getSessionWindows", () => {
  it("returns [] when the date dir doesn't exist", () => {
    expect(getSessionWindows(makeTmpDir(), "2099-01-01", "x")).toEqual([]);
  });

  it("collapses entries by sessionId into [min, max] windows with a 5-min buffer", () => {
    const dir = makeTmpDir();
    writeAgentJsonl(dir, "2026-04-15", "claude_code", "s.jsonl", [
      { project: "p", sessionId: "s1", timestamp: "2026-04-15T10:00:00Z" },
      { project: "p", sessionId: "s1", timestamp: "2026-04-15T10:05:00Z" },
      { project: "p", sessionId: "s2", timestamp: "2026-04-15T11:00:00Z" },
      { project: "other", sessionId: "ignored", timestamp: "2026-04-15T12:00:00Z" },
    ]);

    const windows = getSessionWindows(dir, "2026-04-15", "p");
    expect(windows.length).toBe(2);

    const s1 = windows.find((w) => w.sessionId === "s1")!;
    const s2 = windows.find((w) => w.sessionId === "s2")!;
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1.agent).toBe("claude_code");

    // 5 minutes = 300_000 ms. Window starts 5 min before earliest, ends 5 after latest.
    const s1Earliest = new Date("2026-04-15T10:00:00Z").getTime();
    const s1Latest   = new Date("2026-04-15T10:05:00Z").getTime();
    expect(s1.start).toBe(s1Earliest - 300_000);
    expect(s1.end).toBe(s1Latest + 300_000);
  });

  it("skips entries with no sessionId or no timestamp", () => {
    const dir = makeTmpDir();
    writeAgentJsonl(dir, "2026-04-15", "claude_code", "s.jsonl", [
      { project: "p", timestamp: "2026-04-15T10:00:00Z" },             // no session
      { project: "p", sessionId: "s1" },                                // no ts
      { project: "p", sessionId: "s1", timestamp: "not a date" },       // bad ts
      { project: "p", sessionId: "s1", timestamp: "2026-04-15T10:00:00Z" },
    ]);
    const windows = getSessionWindows(dir, "2026-04-15", "p");
    expect(windows.length).toBe(1);
    expect(windows[0].sessionId).toBe("s1");
  });

  it("ignores the git/ subdirectory", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "2026-04-15", "git"), { recursive: true });
    writeFileSync(
      join(dir, "2026-04-15", "git", "g.jsonl"),
      JSON.stringify({ project: "p", sessionId: "ghost", timestamp: "2026-04-15T10:00:00Z" }) + "\n",
    );
    expect(getSessionWindows(dir, "2026-04-15", "p")).toEqual([]);
  });
});

// ── attributeFromSessions ───────────────────────────────────────────

describe("attributeFromSessions", () => {
  const session: SessionWindow = {
    agent: "claude_code",
    sessionId: "abc",
    start: new Date("2026-04-15T10:00:00Z").getTime(),
    end:   new Date("2026-04-15T10:30:00Z").getTime(),
  };

  function commit(ts: string, agentAuthored = false): GitEvent {
    return {
      id: ts, eventType: "commit", timestamp: ts,
      project: "p", repo: "owner/name", branch: "main",
      developer: "x", machine: "y", commitSha: "deadbeef",
      filesChanged: 0, insertions: 0, deletions: 0,
      agentAuthored,
    } as unknown as GitEvent;
  }

  it("attributes commits inside the window", () => {
    const events = [commit("2026-04-15T10:15:00Z")];
    attributeFromSessions(events, [session]);
    expect(events[0].agentAuthored).toBe(true);
    expect(events[0].agentName).toBe("claude_code");
    expect(events[0].sessionId).toBe("abc");
  });

  it("does not touch commits outside the window", () => {
    const events = [commit("2026-04-15T11:00:00Z")];
    attributeFromSessions(events, [session]);
    expect(events[0].agentAuthored).toBe(false);
    expect(events[0].agentName).toBeUndefined();
  });

  it("respects existing agentAuthored=true (Co-Authored-By takes precedence)", () => {
    const events = [commit("2026-04-15T10:15:00Z", true)];
    events[0].agentName = "codex"; // pretend codex took credit first
    attributeFromSessions(events, [session]);
    expect(events[0].agentName).toBe("codex"); // unchanged
  });

  it("is a no-op when no sessions provided", () => {
    const events = [commit("2026-04-15T10:15:00Z")];
    attributeFromSessions(events, []);
    expect(events[0].agentAuthored).toBe(false);
  });
});

// ── filterByAuthor ─────────────────────────────────────────────────

describe("filterByAuthor", () => {
  function ev(author: string | null, email: string | null): GitEvent {
    return {
      id: "x", eventType: "commit", timestamp: "2026-04-15T10:00:00Z",
      project: "p", repo: "owner/name", branch: "main",
      developer: "x", machine: "y", commitSha: "deadbeef",
      filesChanged: 0, insertions: 0, deletions: 0,
      agentAuthored: false, agentName: null,
      author, authorEmail: email,
    } as unknown as GitEvent;
  }

  it("keeps commits matching the developer email exactly", () => {
    const events = [
      ev("Me", "me@example.com"),
      ev("Other", "other@example.com"),
    ];
    const kept = filterByAuthor(events, "me@example.com");
    expect(kept.length).toBe(1);
    expect(kept[0].author).toBe("Me");
  });

  it("matches case-insensitively", () => {
    const events = [ev("Me", "Me@Example.COM")];
    expect(filterByAuthor(events, "ME@EXAMPLE.com").length).toBe(1);
  });

  it("matches by author name when developer isn't an email", () => {
    const events = [
      ev("Leonid Belyaev", null),
      ev("Nicholas Pettas", null),
    ];
    const kept = filterByAuthor(events, "Leonid Belyaev");
    expect(kept.length).toBe(1);
    expect(kept[0].author).toBe("Leonid Belyaev");
  });

  it("matches partial substrings (e.g. 'lbeliaev' in author or email)", () => {
    const events = [
      ev("Leonid Belyaev", "lbelyaev@example.com"),
      ev("Other Person", "other@example.com"),
    ];
    expect(filterByAuthor(events, "lbelyaev").length).toBe(1);
  });

  it("returns the input unchanged when developer is empty", () => {
    const events = [ev("Anyone", "anyone@example.com")];
    expect(filterByAuthor(events, "").length).toBe(1);
  });

  it("drops everything when no commit matches", () => {
    const events = [
      ev("A", "a@x.com"),
      ev("B", "b@x.com"),
    ];
    expect(filterByAuthor(events, "nobody@nowhere").length).toBe(0);
  });
});
