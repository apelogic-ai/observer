import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getMotifs } from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = new Date(Date.now() - 3 * 3600_000).toISOString();

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-motifs-"));

  // Session s1: 4× Bash grep (same shape "grep"), 1× Bash ls (singleton).
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s1.jsonl"), [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `s1-grep-${i}`, timestamp: T0, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: `grep -r foo${i} src/`,
      tokenUsage: { input: 100, output: 20 },
    })),
    {
      id: "s1-ls", timestamp: T0, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "ls -la",
      tokenUsage: { input: 50, output: 10 },
    },
  ]);

  // Session s2: 2× more Bash grep (so motif spans 2 sessions), 3× Read .ts.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s2.jsonl"), [
    ...Array.from({ length: 2 }, (_, i) => ({
      id: `s2-grep-${i}`, timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: `grep -n bar${i} lib/`,
      tokenUsage: { input: 80, output: 15 },
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `s2-read-${i}`, timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "beta", entryType: "tool_call", toolName: "Read",
      filePath: `/work/lib/file${i}.ts`,
      tokenUsage: { input: 200, output: 0 },
    })),
  ]);

  await initDb(DATA_DIR);
});

describe("getMotifs", () => {
  it("returns repeated (tool, shape) pairs ranked by occurrences", async () => {
    const motifs = await getMotifs({ days: 30 }, 10);

    // Bash grep: 4 in s1 + 2 in s2 = 6 occurrences across 2 sessions.
    const grep = motifs.find((m) => m.toolName === "Bash" && m.shape === "grep");
    expect(grep).toBeDefined();
    expect(grep!.occurrences).toBe(6);
    expect(grep!.sessions).toBe(2);

    // Read .ts: 3 occurrences in 1 session.
    const readTs = motifs.find((m) => m.toolName === "Read" && m.shape === ".ts");
    expect(readTs).toBeDefined();
    expect(readTs!.occurrences).toBe(3);
    expect(readTs!.sessions).toBe(1);

    // Singletons (ls appears once) must NOT show up.
    const ls = motifs.find((m) => m.toolName === "Bash" && m.shape === "ls");
    expect(ls).toBeUndefined();

    // Top of leaderboard is the most-frequent motif.
    expect(motifs[0]!.toolName).toBe("Bash");
    expect(motifs[0]!.shape).toBe("grep");
  });

  it("respects the limit argument", async () => {
    const motifs = await getMotifs({ days: 30 }, 1);
    expect(motifs.length).toBe(1);
  });

  it("includes total tokens spent in the motif", async () => {
    const motifs = await getMotifs({ days: 30 }, 10);
    const grep = motifs.find((m) => m.toolName === "Bash" && m.shape === "grep")!;
    // 4 × (100+20) + 2 × (80+15) = 480 + 190 = 670
    expect(grep.tokens).toBe(670);
  });
});
