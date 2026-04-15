import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShippedBatch } from "../src/shipper";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-disk-shipper-"));
}

function makeBatch(overrides?: Partial<ShippedBatch>): ShippedBatch {
  return {
    batchId: "abc123",
    developer: "dev@example.com",
    machine: "test-machine",
    agent: "claude_code",
    project: "my-project",
    sourceFile: "/tmp/traces/test.jsonl",
    shippedAt: "2026-04-13T10:30:00.000Z",
    entries: [],
    ...overrides,
  };
}

// Claude Code raw JSONL entry (user message with text)
function claudeUserEntry(text: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-04-13T10:30:00Z",
    message: { content: [{ type: "text", text }] },
  });
}

// Claude Code raw JSONL entry (assistant with tool_use)
function claudeToolEntry(toolName: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-13T10:30:01Z",
    message: {
      model: "claude-sonnet-4-20250514",
      content: [{ type: "tool_use", name: toolName, id: "tu_1", input: { command: "ls" } }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
}

// Codex raw JSONL entry (function_call)
function codexFunctionCallEntry(name: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-04-13T10:30:00Z",
    payload: { type: "function_call", name, call_id: "call_1", arguments: '{"cmd":"ls"}' },
  });
}

describe("createDiskShipper", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = makeTmpDir();
  });

  it("writes normalized entries to date/agent partitioned path", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      entries: [claudeUserEntry("hello world"), claudeToolEntry("Bash")],
    });
    await ship(batch);

    // Should write to {outputDir}/2026-04-13/claude_code/{batchId}.jsonl
    const datePath = join(outputDir, "2026-04-13", "claude_code");
    expect(existsSync(datePath)).toBe(true);

    const files = readdirSync(datePath);
    expect(files).toContain("abc123.jsonl");

    const content = readFileSync(join(datePath, "abc123.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    // Each line is a parsed TraceEntry JSON
    const entry0 = JSON.parse(lines[0]);
    expect(entry0.agent).toBe("claude_code");
    expect(entry0.entryType).toBe("message");
    expect(entry0.userPrompt).toBe("hello world");

    const entry1 = JSON.parse(lines[1]);
    expect(entry1.entryType).toBe("tool_call");
    expect(entry1.toolName).toBe("Bash");
  });

  it("applies disclosure — basic strips moderate and sensitive fields", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "basic" });

    const batch = makeBatch({
      entries: [claudeUserEntry("secret prompt")],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    // basic disclosure strips userPrompt (SENSITIVE field)
    expect(entry.userPrompt).toBeNull();
  });

  it("sensitive disclosure preserves prompts and responses", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      entries: [claudeUserEntry("keep this prompt")],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    expect(entry.userPrompt).toBe("keep this prompt");
  });

  it("always strips HIGH_RISK fields regardless of disclosure", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    // tool_result entries have toolResultContent (HIGH_RISK)
    const rawEntry = JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-13T10:30:00Z",
      message: {
        content: [{
          type: "tool_result",
          content: "secret file contents here",
          tool_use_id: "tu_1",
        }],
      },
    });

    const batch = makeBatch({ entries: [rawEntry] });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    expect(entry.toolResultContent).toBeNull();
  });

  it("redacts secrets in entry content", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive", redactSecrets: true });

    const batch = makeBatch({
      entries: [claudeUserEntry("my key is AKIAIOSFODNN7EXAMPLE")],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    expect(entry.userPrompt).toContain("[REDACTED:");
    expect(entry.userPrompt).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("handles codex entries", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      agent: "codex",
      entries: [codexFunctionCallEntry("exec_command")],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "codex", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    expect(entry.agent).toBe("codex");
    expect(entry.entryType).toBe("tool_call");
    expect(entry.toolName).toBe("shell");
  });

  it("skips unparseable entries without failing", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      entries: [
        "not valid json",
        claudeUserEntry("valid entry"),
        JSON.stringify({ type: "unknown_garbage" }),
      ],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    // Only the valid parseable entry should be written
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).userPrompt).toBe("valid entry");
  });

  it("writes nothing when all entries are unparseable", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      entries: ["garbage", "more garbage"],
    });
    await ship(batch);

    // Directory should not be created for empty output
    const datePath = join(outputDir, "2026-04-13", "claude_code");
    if (existsSync(datePath)) {
      const files = readdirSync(datePath).filter(f => f.endsWith(".jsonl"));
      if (files.length > 0) {
        const content = readFileSync(join(datePath, files[0]), "utf-8").trim();
        expect(content).toBe("");
      }
    }
  });

  it("populates developer/machine/project from batch metadata", async () => {
    const { createDiskShipper } = await import("../src/disk-shipper");
    const ship = createDiskShipper({ outputDir, disclosure: "sensitive" });

    const batch = makeBatch({
      developer: "jane@acme.com",
      machine: "janes-macbook",
      project: "cool-project",
      entries: [claudeUserEntry("test")],
    });
    await ship(batch);

    const content = readFileSync(
      join(outputDir, "2026-04-13", "claude_code", "abc123.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(content.trim());
    expect(entry.developer).toBe("jane@acme.com");
    expect(entry.machine).toBe("janes-macbook");
    expect(entry.project).toBe("cool-project");
  });
});
