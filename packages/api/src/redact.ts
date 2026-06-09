/**
 * Server-side secret redaction — defence-in-depth backstop at ingest.
 *
 * The agent (packages/agent/src/security/scanner.ts) already redacts secrets
 * before shipping. This is a deliberate, independent copy: the API image only
 * ships packages/api/src, so it cannot import the agent module at runtime, and
 * an older or misbehaving client must never cause the ingestor to persist a
 * live credential. Keep the pattern set in sync with the agent scanner when it
 * changes.
 *
 * Deterministic regex matching only — no network, no false sense of an LLM
 * guardrail (§5: external guardrails enforced in code).
 */

export type SecretType =
  | "aws_access_key"
  | "aws_secret_key"
  | "database_url"
  | "github_token"
  | "anthropic_key"
  | "openai_key"
  | "slack_token"
  | "private_key"
  | "jwt_token"
  | "generic_api_key"
  | "bearer_token";

interface Pattern {
  type: SecretType;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { type: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/ },
  { type: "aws_secret_key", regex: /(?:aws_secret|secret_key|SECRET_KEY)["'\s:=]+[A-Za-z0-9/+=]{40}/ },
  { type: "database_url", regex: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@\s]{8,}@[^\s'"]+/ },
  { type: "github_token", regex: /gh[ps]_[A-Za-z0-9]{36,}/ },
  { type: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { type: "openai_key", regex: /sk-[A-Za-z0-9]{48,}/ },
  { type: "slack_token", regex: /xox[baprs]-[A-Za-z0-9\-]{20,}/ },
  { type: "private_key", regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { type: "jwt_token", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-.]+/ },
  { type: "generic_api_key", regex: /(?:x-api-key|api[_-]?key)["'\s:=]+[A-Za-z0-9_\-]{20,}/i },
  { type: "bearer_token", regex: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/ },
];

interface Finding {
  start: number;
  end: number;
  replacement: string;
}

/** Replace every detected secret in `text` with `[REDACTED:<type>]`. */
export function redactSecrets(text: string): string {
  const findings: Finding[] = [];
  for (const { type, regex } of PATTERNS) {
    const g = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      findings.push({ start: m.index, end: m.index + m[0].length, replacement: `[REDACTED:${type}]` });
      if (m[0].length === 0) g.lastIndex++; // guard against zero-width matches
    }
  }
  if (findings.length === 0) return text;

  // Apply from the end so earlier offsets stay valid. Skip findings that
  // overlap an already-applied (later-start) one.
  findings.sort((a, b) => a.start - b.start);
  let result = text;
  let lastStart = Infinity;
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    if (f.end <= lastStart) {
      result = result.slice(0, f.start) + f.replacement + result.slice(f.end);
      lastStart = f.start;
    }
  }
  return result;
}
