/**
 * Server-side disclosure floor — authoritative clamp at ingest.
 *
 * The agent strips trace fields by configured disclosure level before
 * shipping (packages/agent/src/types.ts → applyDisclosure). But a user with
 * root on an endpoint can raise that level in config.yaml (e.g. to "full",
 * which includes file contents and tool outputs); the ingestor must not trust
 * the client. This re-applies the same field→level mapping at the trust
 * boundary we control, clamping each entry to a maximum level configured per
 * device/tenant — regardless of what the client sent.
 *
 * Like redact.ts, this is a deliberate, independent copy: the API image ships
 * only packages/api/src, so it cannot import the agent module at runtime. Keep
 * the field sets in sync with applyDisclosure when they change.
 */

export type DisclosureLevel = "basic" | "moderate" | "sensitive" | "full";

const LEVELS: readonly DisclosureLevel[] = ["basic", "moderate", "sensitive", "full"];

/** Mirror of applyDisclosure's tiers (packages/agent/src/types.ts). */
const MODERATE_FIELDS = [
  "toolCallId", "filePath", "command", "taskSummary",
  "gitRepo", "gitBranch", "gitCommit",
];
const SENSITIVE_FIELDS = [
  "userPrompt", "assistantText", "thinking", "reasoning", "systemPrompt",
];
const HIGH_RISK_FIELDS = [
  "toolResultContent", "fileContent", "stdout", "queryData",
];

/** Coerce an untrusted level string to a valid one, failing safe to the most
 *  restrictive ("basic") on anything unrecognized. */
export function normalizeLevel(level: unknown): DisclosureLevel {
  return LEVELS.includes(level as DisclosureLevel) ? (level as DisclosureLevel) : "basic";
}

export interface ClampResult {
  /** The clamped entry, re-serialized. Unchanged if input wasn't JSON. */
  json: string;
  /** Fields actually nulled (were non-null, now stripped). Empty when nothing
   *  was clamped — used to decide whether to emit a disclosure_clamped audit. */
  stripped: string[];
}

/**
 * Clamp a single entry (a JSON string of a TraceEntry) to `max`. Fields above
 * the allowed tier are set to null. Non-JSON input is returned unchanged so
 * downstream redaction still runs. Idempotent: already-null fields aren't
 * reported as stripped.
 */
export function clampDisclosure(entryJson: string, max: DisclosureLevel): ClampResult {
  const level = normalizeLevel(max);
  if (level === "full") return { json: entryJson, stripped: [] };

  let entry: Record<string, unknown>;
  try {
    const parsed = JSON.parse(entryJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { json: entryJson, stripped: [] };
    }
    entry = parsed as Record<string, unknown>;
  } catch {
    return { json: entryJson, stripped: [] }; // non-JSON → leave; redaction still runs
  }

  const toStrip: string[] = [...HIGH_RISK_FIELDS];
  if (level !== "sensitive") toStrip.push(...SENSITIVE_FIELDS);
  if (level === "basic") toStrip.push(...MODERATE_FIELDS);

  const stripped: string[] = [];
  for (const field of toStrip) {
    if (entry[field] !== null && entry[field] !== undefined) {
      entry[field] = null;
      stripped.push(field);
    }
  }

  return { json: JSON.stringify(entry), stripped };
}
