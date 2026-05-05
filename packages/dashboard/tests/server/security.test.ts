import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import {
  getSecurityFindings,
  getSecurityTimeline,
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

    // github_token, database_url, openai_key: 1 each
    const gh = rows.find((r) => r.patternType === "github_token");
    expect(gh!.count).toBe(1);
    const db = rows.find((r) => r.patternType === "database_url");
    expect(db!.count).toBe(1);
    const oai = rows.find((r) => r.patternType === "openai_key");
    expect(oai!.count).toBe(1);
    expect(oai!.sessions).toBe(1);

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
  it("buckets findings per date with per-pattern counts", async () => {
    const rows = await getSecurityTimeline({ days: 30 });
    expect(rows.length).toBeGreaterThan(0);
    // Today's date should have entries
    const today = rows.find((r) => r.date === TODAY);
    expect(today).toBeDefined();
    // 5 findings total: 2 in f1 + 1 in f2 + 1 in f3 + 1 in f4
    expect(today!.count).toBe(5);
  });
});
