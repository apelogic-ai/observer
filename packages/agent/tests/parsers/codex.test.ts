import { describe, it, expect } from "bun:test";
import { parseCodexEntry } from "../../src/parsers/codex"
import type { TraceEntry } from "../../src/types";

describe("parseCodexEntry", () => {
  const sessionId = "codex-session-1";

  it("parses a function_call", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"ls -la","workdir":"/tmp"}',
        call_id: "call_123",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("tool_call");
    expect(entry!.toolName).toBe("shell");
    expect(entry!.command).toContain("ls -la");
    expect(entry!.agent).toBe("codex");
  });

  it("normalizes exec_command to shell", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}' },
    };
    expect(parseCodexEntry(raw, sessionId)!.toolName).toBe("shell");
  });

  it("normalizes apply_patch to edit", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "apply_patch", arguments: '{"patch":"..."}' },
    };
    expect(parseCodexEntry(raw, sessionId)!.toolName).toBe("edit");
  });

  it("preserves MCP tool names with prefix", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__myapp__run_sql",
        arguments: '{"sql":"SELECT 1"}',
      },
    };
    expect(parseCodexEntry(raw, sessionId)!.toolName).toBe("mcp:myapp:run_sql");
  });

  it("parses a function_call_output", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "total 42\ndrwxr-xr-x  5 user staff 160 Apr 8 file.txt",
        call_id: "call_123",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("tool_result");
    expect(entry!.toolResultContent).toContain("total 42");
  });

  it("parses a task_complete as task_summary", () => {
    const raw = {
      timestamp: "2026-04-08T12:30:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_abc",
        last_agent_message: "Fixed the CORS issue by adding the correct headers.",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("task_summary");
    expect(entry!.taskSummary).toContain("CORS");
  });

  it("parses a user message", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix the login page" }],
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("message");
    expect(entry!.role).toBe("user");
    expect(entry!.userPrompt).toBe("Fix the login page");
  });

  it("parses an agent_message", () => {
    const raw = {
      timestamp: "2026-04-08T12:01:00.000Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        content: [{ type: "output_text", text: "I've fixed the login page." }],
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("message");
    expect(entry!.role).toBe("assistant");
  });

  it("parses reasoning entries", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:30.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        content: [{ type: "text", text: "The user wants me to check CORS headers..." }],
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("reasoning");
    expect(entry!.reasoning).toContain("CORS");
  });

  it("returns null for token_count entries", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", rate_limits: {} },
    };
    expect(parseCodexEntry(raw, sessionId)).toBeNull();
  });

  it("captures call_id on function_call_output for correlation", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "file.txt created",
        call_id: "call_456",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry).not.toBeNull();
    expect(entry!.entryType).toBe("tool_result");
    expect(entry!.toolCallId).toBe("call_456");
  });

  it("function_call_output extracts exit code from the embedded `Process exited with code N` line", () => {
    // Codex doesn't emit exit_code as a structured field — it's
    // serialized into the output text. Pull it out so downstream
    // metrics (validation outcomes, failed-command loops) get a
    // first-class signal instead of substring-scanning the body.
    const raw = {
      timestamp: "2026-04-08T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nfile.txt created\n",
        call_id: "call_okay",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry!.exitCode).toBe(0);
    expect(entry!.success).toBe(true);
  });

  it("non-zero exit code marks success=false", () => {
    const raw = {
      timestamp: "2026-04-08T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "Chunk ID: abc124\nWall time: 1.2 seconds\nProcess exited with code 1\nOutput:\nbash: command not found\n",
        call_id: "call_fail",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry!.exitCode).toBe(1);
    expect(entry!.success).toBe(false);
  });

  it("function_call_output extracts wall time as durationMs", () => {
    // Wall time uses fractional seconds; we report milliseconds for
    // consistency with the rest of the schema.
    const raw = {
      timestamp: "2026-04-08T12:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "Chunk ID: abc125\nWall time: 2.5 seconds\nProcess exited with code 0\nOutput:\n",
        call_id: "call_dur",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry!.durationMs).toBe(2500);
  });

  it("function_call_output without the codex envelope leaves exitCode/durationMs null", () => {
    // If a tool didn't go through codex's shell wrapper (older
    // formats, custom tools), the output won't have the
    // "Process exited with code" / "Wall time" lines — surface
    // explicit nulls rather than guess.
    const raw = {
      timestamp: "2026-04-08T12:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "just a plain string",
        call_id: "call_plain",
      },
    };
    const entry = parseCodexEntry(raw, sessionId);
    expect(entry!.exitCode).toBeNull();
    expect(entry!.durationMs).toBeNull();
    expect(entry!.success).toBeNull();
  });

  it("returns null for unparseable entries", () => {
    expect(parseCodexEntry({}, sessionId)).toBeNull();
    expect(parseCodexEntry({ type: "unknown" }, sessionId)).toBeNull();
  });
});
