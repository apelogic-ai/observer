import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import {
  getSecurityFindings,
  getSecurityTimeline,
  getSecuritySessions,
} from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = `${TODAY}T09:00:00Z`;
const T1 = `${TODAY}T11:00:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-security-"));

  // Mark every place a redaction marker can show up: Bash command,
  // file path, user prompt, assistant text, task summary. The dashboard
  // ingest scans every text field for `[REDACTED:<type>]` markers and
  // counts each as one finding tied to the row's session/agent/project.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s1.jsonl"), [
    // 2 different patterns in one tool call's command field
    { id: "f1", timestamp: T0, agent: "claude_code", sessionId: "s-alpha",
      project: "acme", entryType: "tool_call", toolName: "Bash",
      command: "curl -H 'Authorization: Bearer [REDACTED:github_token]' https://[REDACTED:database_url]/db" },
    // Same pattern again in a different tool call → 2nd aws_access_key
    { id: "f2", timestamp: T0, agent: "claude_code", sessionId: "s-alpha",
      project: "acme", entryType: "tool_call", toolName: "Bash",
      command: "AWS_ACCESS_KEY_ID=[REDACTED:aws_access_key] aws s3 ls" },
    // And in user prompt of a different session
    { id: "f3", timestamp: T1, agent: "claude_code", sessionId: "s-beta",
      project: "acme", entryType: "message", role: "user",
      userPrompt: "I had this earlier: [REDACTED:aws_access_key]" },
  ]);
  writeJsonl(join(DATA_DIR, TODAY, "codex", "s2.jsonl"), [
    { id: "f4", timestamp: T1, agent: "codex", sessionId: "s-gamma",
      project: "beta", entryType: "tool_call", toolName: "shell",
      command: "echo [REDACTED:openai_key]" },
    // entry with no marker — should not produce a finding
    { id: "f5", timestamp: T1, agent: "codex", sessionId: "s-gamma",
      project: "beta", entryType: "tool_call", toolName: "shell",
      command: "ls -la" },
  ]);

  // Project `wide`: leak markers planted in the wide text columns
  // (stdout, fileContent, toolResultContent, queryData) that the
  // dashboard drops before insert. Findings must still be extracted —
  // these are exactly where leaks are most likely to land at
  // disclosure: full.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "wide.jsonl"), [
    { id: "w1", timestamp: T0, agent: "claude_code", sessionId: "s-wide",
      project: "wide", entryType: "tool_call", toolName: "Bash",
      command: "cat .env",
      stdout: "OPENAI_API_KEY=[REDACTED:openai_key]\nDATABASE_URL=[REDACTED:database_url]" },
    { id: "w2", timestamp: T0, agent: "claude_code", sessionId: "s-wide",
      project: "wide", entryType: "tool_call", toolName: "Read",
      filePath: "/repo/secrets.env",
      fileContent: "stripe_key=[REDACTED:stripe_key]" },
    { id: "w3", timestamp: T0, agent: "claude_code", sessionId: "s-wide",
      project: "wide", entryType: "tool_call", toolName: "mcp:db:shell",
      toolResultContent: "row 1: token=[REDACTED:github_token]" },
    { id: "w4", timestamp: T0, agent: "claude_code", sessionId: "s-wide",
      project: "wide", entryType: "tool_call", toolName: "mcp:db:shell",
      queryData: "[{\"key\": \"[REDACTED:slack_token]\"}]" },
  ]);

  await initDb(DATA_DIR);
});

describe("getSecurityFindings", () => {
  it("aggregates findings by pattern type with session/project counts", async () => {
    const rows = await getSecurityFindings({ days: 30 }, 50);
    expect(rows.length).toBeGreaterThan(0);

    // aws_access_key: 2 findings across 2 distinct sessions + 1 project
    const aws = rows.find((r) => r.patternType === "aws_access_key");
    expect(aws).toBeDefined();
    expect(aws!.count).toBe(2);
    expect(aws!.sessions).toBe(2);
    expect(aws!.projects).toBe(1);

    // github_token: 1 in narrow (f1.command) + 1 in wide (w3.toolResultContent) = 2
    // database_url: 1 in narrow (f1.command) + 1 in wide (w1.stdout) = 2
    // openai_key:   1 in narrow (f4.command) + 1 in wide (w1.stdout) = 2
    const gh = rows.find((r) => r.patternType === "github_token");
    expect(gh!.count).toBe(2);
    const db = rows.find((r) => r.patternType === "database_url");
    expect(db!.count).toBe(2);
    const oai = rows.find((r) => r.patternType === "openai_key");
    expect(oai!.count).toBe(2);
    expect(oai!.sessions).toBe(2);

    // Sorted: highest count first.
    expect(rows[0]!.count).toBeGreaterThanOrEqual(rows[rows.length - 1]!.count);
  });

  it("filters by project", async () => {
    const rows = await getSecurityFindings({ days: 30, project: "acme" }, 50);
    // acme has aws_access_key, github_token, database_url — but NOT openai_key
    expect(rows.find((r) => r.patternType === "openai_key")).toBeUndefined();
    expect(rows.find((r) => r.patternType === "aws_access_key")).toBeDefined();
  });

  it("respects the limit argument", async () => {
    const rows = await getSecurityFindings({ days: 30 }, 1);
    expect(rows.length).toBe(1);
  });
});

describe("getSecurityTimeline", () => {
  it("returns per-(date, patternType) rows so the chart can stack", async () => {
    // Shape change: timeline used to return one row per date with a
    // total count. The leaks chart needs to stack by pattern type, so
    // we now return one row per (date, patternType) instead. Total
    // for a day is the sum of its rows.
    const rows = await getSecurityTimeline({ days: 30 });
    expect(rows.length).toBeGreaterThan(0);
    // Sanity-check shape without using `toMatchObject` — that matcher
    // appears to leak `expect.any(...)` placeholders back into the row
    // objects in this Bun version, breaking subsequent reads.
    for (const r of rows) {
      expect(typeof r.date).toBe("string");
      expect(typeof r.patternType).toBe("string");
      expect(typeof r.count).toBe("number");
    }
    const today = rows.filter((r) => r.date === TODAY);
    // 10 findings on TODAY across the seeded fixture (5 narrow + 5 wide).
    const todayTotal = today.reduce((s, r) => s + r.count, 0);
    expect(todayTotal).toBe(10);
    // At least one row each for the patterns we plant on TODAY.
    const todayPatterns = new Set(today.map((r) => r.patternType));
    expect(todayPatterns.has("aws_access_key")).toBe(true);
    expect(todayPatterns.has("github_token")).toBe(true);
  });
});

describe("date filter — scopes queries to one calendar day", () => {
  it("getSecurityFindings respects f.date and ignores f.days when both set", async () => {
    // The leaks page uses ?date=YYYY-MM-DD for click-to-drill on the
    // chart. Same totals on the seeded fixture (everything is on
    // TODAY), but the filter shape exists.
    const all = await getSecurityFindings({ days: 30 }, 50);
    const day = await getSecurityFindings({ days: 30, date: TODAY }, 50);
    // Sum of pattern counts must match — fixture only has findings on TODAY.
    const sumAll = all.reduce((s, r) => s + r.count, 0);
    const sumDay = day.reduce((s, r) => s + r.count, 0);
    expect(sumDay).toBe(sumAll);
    // A date with no findings returns nothing.
    const empty = await getSecurityFindings({ date: "2020-01-01" }, 50);
    expect(empty).toEqual([]);
  });

  it("getSecuritySessions respects f.date", async () => {
    const empty = await getSecuritySessions({ date: "2020-01-01" }, 50);
    expect(empty).toEqual([]);
    const today = await getSecuritySessions({ date: TODAY }, 50);
    expect(today.length).toBeGreaterThan(0);
  });

  it("getSecurityTimeline respects f.date — narrows to that one day's rows", async () => {
    const rows = await getSecurityTimeline({ date: TODAY });
    for (const r of rows) expect(r.date).toBe(TODAY);
  });
});

describe("findings extraction in wide text fields", () => {
  it("scans stdout, fileContent, toolResultContent, and queryData before they're dropped", async () => {
    // These columns get wiped from the SQLite traces table at insert
    // time (they're huge and unindexed). Findings must be extracted
    // BEFORE the drop, otherwise the security dashboard silently
    // undercounts the most leak-prone surface.
    const rows = await getSecurityFindings({ days: 30, project: "wide" }, 50);
    const byPattern = Object.fromEntries(rows.map((r) => [r.patternType, r.count]));
    expect(byPattern.openai_key).toBe(1);     // stdout
    expect(byPattern.database_url).toBe(1);   // stdout
    expect(byPattern.stripe_key).toBe(1);     // fileContent
    expect(byPattern.github_token).toBe(1);   // toolResultContent
    expect(byPattern.slack_token).toBe(1);    // queryData
  });
});
