/**
 * Codex's permission format — `prefix_rule(...)` blocks in
 * `~/.codex/rules/default.rules`. We need to (a) parse the user's
 * existing file so the dashboard can show "in your settings" coloring,
 * and (b) emit the same shape from observed agent calls so they can
 * paste back without translation.
 *
 * The grammar is small enough that a hand-rolled tokenizer + recursive
 * descent parser is the right amount of machinery — no external
 * library, no Python-AST dependency.
 *
 *   file       := (rule | comment | whitespace)*
 *   rule       := "prefix_rule" "(" args ")"
 *   args       := arg ("," arg)* ","?
 *   arg        := identifier "=" value
 *   value      := string | list
 *   list       := "[" (value ("," value)* ","?)? "]"
 *   string     := "..."
 *   comment    := "#" .*\n
 *
 * Errors per malformed block are collected; the rest of the file
 * still parses. (One bad rule shouldn't blank the page.)
 */

// ── Types ──────────────────────────────────────────────────────────

/**
 * A single token (`"git"`) or a list of alternative tokens
 * (`["status", "diff", "log"]`). Codex permits arbitrary nesting in
 * theory; in practice the format we've seen uses two levels max.
 * We model only what we've observed.
 */
export type PatternNode = string | string[];

export type CodexDecision = "allow" | "prompt" | "deny";

export interface ParsedRule {
  pattern: PatternNode[];
  decision: CodexDecision;
  justification?: string;
}

export interface ParseResult {
  rules: ParsedRule[];
  errors: string[];
}

// ── Parser ─────────────────────────────────────────────────────────

interface Token {
  kind: "ident" | "string" | "punct";
  value: string;
}

/**
 * Tokenizer. Strips comments + whitespace, emits idents, double-quoted
 * strings (with `\"` and `\\` escapes), and the punctuation we care
 * about (`(`, `)`, `[`, `]`, `,`, `=`).
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    // Whitespace.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    // Comment to end-of-line.
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    // Punctuation we recognise.
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === "," || c === "=") {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    // Double-quoted string with `\` escapes.
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[j + 1]!;
          // Minimal escape table; we don't need \u or \x in this format.
          s += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      if (j >= text.length) {
        throw new ParseError(`unterminated string starting at offset ${i}`);
      }
      tokens.push({ kind: "string", value: s });
      i = j + 1;
      continue;
    }
    // Identifier (a–z, A–Z, 0–9, _).
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      tokens.push({ kind: "ident", value: text.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected char "${c}" at offset ${i}`);
  }
  return tokens;
}

class ParseError extends Error {}

/**
 * Parse Codex rules text. Returns successfully-parsed rules plus
 * per-block error strings. The top-level loop scans for
 * `prefix_rule(` openings and parses each block independently — a
 * malformed block lands in `errors` but doesn't poison the rest.
 */
export function parseCodexRules(text: string): ParseResult {
  const rules: ParsedRule[] = [];
  const errors: string[] = [];

  // Find each `prefix_rule(` opening at the source level. For each,
  // parse the args between matching `(` and `)`.
  const openRe = /\bprefix_rule\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) {
    const start = match.index;
    const argsStart = openRe.lastIndex;
    const close = findMatchingClose(text, argsStart - 1);
    if (close < 0) {
      errors.push(`unterminated prefix_rule block at offset ${start}`);
      // Skip past this opening so we keep scanning the rest of the file.
      openRe.lastIndex = argsStart;
      continue;
    }
    const body = text.slice(argsStart, close);
    try {
      const tokens = tokenize(body);
      const rule = parseArgs(tokens);
      rules.push(rule);
    } catch (e) {
      errors.push(`parse error in prefix_rule at offset ${start}: ${(e as Error).message}`);
    }
    openRe.lastIndex = close + 1;
  }

  return { rules, errors };
}

/** Find the index of the `)` that matches the `(` at `openIdx`,
 *  respecting brackets and quoted strings (so a `)` inside a string
 *  doesn't close the call). */
function findMatchingClose(text: string, openIdx: number): number {
  let depthParen = 0;
  let depthBracket = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(") depthParen++;
    else if (c === ")") {
      depthParen--;
      if (depthParen === 0 && depthBracket === 0) return i;
    } else if (c === "[") depthBracket++;
    else if (c === "]") depthBracket--;
  }
  return -1;
}

function parseArgs(tokens: Token[]): ParsedRule {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  const expect = (kind: Token["kind"], value?: string): Token => {
    const t = eat();
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${kind} "${value ?? ""}", got ${t ? `${t.kind} "${t.value}"` : "EOF"}`);
    }
    return t;
  };

  const pattern: PatternNode[] = [];
  let decision: CodexDecision | null = null;
  let justification: string | undefined;

  while (pos < tokens.length) {
    const name = expect("ident").value;
    expect("punct", "=");
    if (name === "pattern") {
      const value = parseValue();
      if (!Array.isArray(value)) {
        throw new ParseError(`pattern must be a list, got ${typeof value}`);
      }
      // Top-level pattern is a flat list of nodes; each node is either
      // a scalar string or a nested list of alternatives.
      for (const v of value) {
        if (typeof v === "string") pattern.push(v);
        else if (Array.isArray(v) && v.every((x) => typeof x === "string")) pattern.push(v as string[]);
        else throw new ParseError(`unexpected pattern node shape`);
      }
    } else if (name === "decision") {
      const value = parseValue();
      if (typeof value !== "string") throw new ParseError(`decision must be a string`);
      if (value !== "allow" && value !== "prompt" && value !== "deny") {
        throw new ParseError(`decision must be allow|prompt|deny, got "${value}"`);
      }
      decision = value;
    } else if (name === "justification") {
      const value = parseValue();
      if (typeof value !== "string") throw new ParseError(`justification must be a string`);
      justification = value;
    } else {
      // Unknown field — read its value to advance, then ignore.
      parseValue();
    }
    if (peek()?.kind === "punct" && peek()?.value === ",") eat();
    else break;
  }

  if (pattern.length === 0) throw new ParseError("missing pattern");
  if (decision === null) throw new ParseError("missing decision");
  return justification !== undefined
    ? { pattern, decision, justification }
    : { pattern, decision };

  // ── inner helpers (closure over pos/tokens) ──
  function parseValue(): unknown {
    const t = peek();
    if (!t) throw new ParseError("unexpected EOF");
    if (t.kind === "string") { eat(); return t.value; }
    if (t.kind === "punct" && t.value === "[") {
      eat();
      const list: unknown[] = [];
      while (pos < tokens.length) {
        if (peek()?.kind === "punct" && peek()?.value === "]") { eat(); return list; }
        list.push(parseValue());
        if (peek()?.kind === "punct" && peek()?.value === ",") eat();
        else if (peek()?.kind === "punct" && peek()?.value === "]") { eat(); return list; }
        else throw new ParseError("expected , or ] in list");
      }
      throw new ParseError("unterminated list");
    }
    throw new ParseError(`unexpected ${t.kind} "${t.value}"`);
  }
}

// ── Allowlist normalization ───────────────────────────────────────

/**
 * Flatten parsed rules into Claude-Code-shape allowlist strings so the
 * existing merge / subsumption / color-coding logic works unchanged.
 *
 *   pattern=["bun"]                     → "<Tool>(bun:*)"
 *   pattern=["bun", "install"]          → "<Tool>(bun install:*)"
 *   pattern=["git", ["status","diff"]]  → "<Tool>(git status:*)", "<Tool>(git diff:*)"
 *
 * `toolPrefix` lets the caller pick the tool name on the way out.
 * Codex itself doesn't tag rules with a tool — they're shell-only by
 * design — but the dashboard's row tags depend on what the *agent*
 * was using at trace time. For the codex target that's the
 * `shell` tool (which our normalizer PascalCases to `Shell`). Picking
 * the right prefix here is what makes the per-row "in your settings"
 * coloring actually match.
 *
 * Only `decision="allow"` rules contribute to the allowlist.
 * `prompt` and `deny` describe different intent and would be wrong
 * to surface as "you've allowed this".
 */
export function expandToAllowlist(rules: ParsedRule[], toolPrefix = "Bash"): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.decision !== "allow") continue;
    for (const expanded of expandPattern(r.pattern)) {
      out.push(`${toolPrefix}(${expanded}:*)`);
    }
  }
  return out;
}

/** Cartesian expansion across nested-alternatives in a pattern. */
function expandPattern(nodes: PatternNode[]): string[] {
  let combos: string[][] = [[]];
  for (const node of nodes) {
    const opts = typeof node === "string" ? [node] : node;
    const next: string[][] = [];
    for (const c of combos) for (const o of opts) next.push([...c, o]);
    combos = next;
  }
  return combos.map((c) => c.join(" "));
}

// The formatter (allowlist → `prefix_rule(...)` text) is its own
// file — `./codex-format.ts`.
