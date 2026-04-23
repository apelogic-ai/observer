/**
 * Claude Code JSONL parser.
 * Normalizes Claude Code trace entries into the unified TraceEntry schema.
 */

import type { TraceEntry, ClaudeCodeRawEntry } from "../types";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeToolName(raw: string): string {
  return raw.replace(/__/g, ":");
}

function extractText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

let entryIndex = 0;

function hashId(sessionId: string, timestamp: string): string {
  return `cc:${sessionId.slice(0, 8)}:${timestamp.replace(/\D/g, "").slice(0, 14)}:${entryIndex++}`;
}

const EMPTY_TRACE: Omit<TraceEntry, "id" | "timestamp" | "agent" | "sessionId" | "entryType" | "role" | "developer" | "machine" | "project"> = {
  model: null,
  tokenUsage: null,
  toolName: null,
  toolCallId: null,
  filePath: null,
  command: null,
  taskSummary: null,
  gitRepo: null,
  gitBranch: null,
  gitCommit: null,
  userPrompt: null,
  assistantText: null,
  thinking: null,
  reasoning: null,
  systemPrompt: null,
  toolResultContent: null,
  fileContent: null,
  stdout: null,
  queryData: null,
};

/**
 * Parse a single Claude Code JSONL entry into a TraceEntry.
 * Returns null if the entry is not parseable.
 */
export function parseClaudeEntry(
  raw: Record<string, unknown>,
  sessionId: string,
  meta?: { developer?: string; machine?: string; project?: string },
): TraceEntry | null {
  const entryType = raw.type as string | undefined;
  const timestamp = (raw.timestamp as string) || "";
  const message = raw.message as Record<string, unknown> | undefined;

  if (!message || (entryType !== "user" && entryType !== "assistant")) return null;

  const content = message.content as unknown[];
  if (!Array.isArray(content) || content.length === 0) return null;

  const usage = message.usage as Record<string, number> | undefined;
  const tokenUsage = usage?.input_tokens != null
    ? {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        reasoning: 0,
      }
    : null;

  const firstBlock = content[0] as Record<string, unknown>;
  const blockType = firstBlock?.type as string;
  const id = hashId(sessionId, timestamp);

  const base = {
    ...EMPTY_TRACE,
    id,
    timestamp,
    agent: "claude_code" as const,
    sessionId,
    model: (message.model as string) ?? null,
    tokenUsage,
    developer: meta?.developer ?? "",
    machine: meta?.machine ?? "",
    project: meta?.project ?? "",
    gitBranch: (raw.gitBranch as string) ?? null,
  };

  // Tool call
  if (blockType === "tool_use") {
    const rawName = (firstBlock.name as string) || "unknown";
    const input = firstBlock.input as Record<string, unknown> | undefined;

    // Skill meta-tool: name="Skill", input.command="pdf" → toolName="skill:pdf"
    const isSkill = rawName === "Skill" && input?.command;
    const toolName = isSkill
      ? `skill:${input!.command}`
      : normalizeToolName(rawName);

    return {
      ...base,
      entryType: "tool_call",
      role: "assistant",
      toolName,
      toolCallId: (firstBlock.id as string) ?? null,
      command: !isSkill && input?.command ? truncate(String(input.command), 200) : null,
      filePath: input?.file_path ? String(input.file_path) : null,
    };
  }

  // Tool result
  if (blockType === "tool_result") {
    const resultContent = firstBlock.content;
    const isError = firstBlock.is_error === true;
    let preview: string | null = null;

    if (typeof resultContent === "string") preview = truncate(resultContent, 200);
    else if (Array.isArray(resultContent)) preview = truncate(extractText(resultContent), 200);

    let success: boolean | null = null;
    if (isError) success = false;
    else if (preview) {
      const lower = preview.toLowerCase();
      success = !(lower.includes("error") || lower.includes("failed") || lower.includes("exception"));
    }

    return {
      ...base,
      entryType: "tool_result",
      role: "tool",
      toolCallId: (firstBlock.tool_use_id as string) ?? null,
      toolResultContent: typeof resultContent === "string"
        ? resultContent
        : Array.isArray(resultContent) ? extractText(resultContent) : null,
    };
  }

  // Thinking
  if (blockType === "thinking") {
    return {
      ...base,
      entryType: "reasoning",
      role: "assistant",
      thinking: truncate((firstBlock.thinking as string) ?? "", 500),
    };
  }

  // Text message
  if (blockType === "text") {
    const text = extractText(content);
    if (entryType === "user") {
      return {
        ...base,
        entryType: "message",
        role: "user",
        userPrompt: truncate(text, 500),
      };
    }
    return {
      ...base,
      entryType: "message",
      role: "assistant",
      assistantText: truncate(text, 500),
    };
  }

  return null;
}

/**
 * Parse a Claude Code JSONL entry, emitting one TraceEntry per content block.
 * Unlike parseClaudeEntry (which only looks at the first block), this
 * handles multi-block messages (e.g. thinking + text + tool_use).
 */
export function parseClaudeEntries(
  raw: Record<string, unknown>,
  sessionId: string,
  meta?: { developer?: string; machine?: string; project?: string },
): TraceEntry[] {
  const entryType = raw.type as string | undefined;
  const timestamp = (raw.timestamp as string) || "";
  const message = raw.message as Record<string, unknown> | undefined;

  if (!message || (entryType !== "user" && entryType !== "assistant")) return [];

  const content = message.content as unknown[];
  if (!Array.isArray(content) || content.length === 0) return [];

  const entries: TraceEntry[] = [];
  for (const block of content) {
    const singleContent = [block];
    const singleMessage = { ...message, content: singleContent };
    const singleRaw = { ...raw, message: singleMessage };
    const entry = parseClaudeEntry(singleRaw, sessionId, meta);
    if (entry) entries.push(entry);
  }
  return entries;
}

// Re-export for backward compat
export type NormalizedEntry = TraceEntry;
