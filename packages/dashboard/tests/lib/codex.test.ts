import { describe, it, expect } from "bun:test";
import { parseCodexRules, expandToAllowlist } from "../../src/lib/codex-parse";
import { formatCodexRules } from "../../src/lib/codex-format";

/**
 * Codex stores permissions as Python-syntax `prefix_rule(...)` blocks
 * in ~/.codex/rules/default.rules. We need to (a) parse those into a
 * structured form so the dashboard can show "in your settings"
 * coloring, and (b) emit the same format from observed agent calls so
 * the user can paste back without translation.
 *
 * The grammar is small enough that a hand-rolled recursive-descent
 * parser + tokenizer is the right amount of machinery — no external
 * library, no Python-AST dependency.
 */

describe("parseCodexRules", () => {
  it("parses a flat single-token rule", () => {
    const text = `prefix_rule(pattern=["bun"], decision="allow")`;
    const { rules, errors } = parseCodexRules(text);
    expect(errors).toEqual([]);
    expect(rules).toEqual([
      { pattern: ["bun"], decision: "allow" },
    ]);
  });

  it("parses verb + subcommand", () => {
    const text = `prefix_rule(pattern=["bun", "install"], decision="allow")`;
    const { rules } = parseCodexRules(text);
    expect(rules[0]!.pattern).toEqual(["bun", "install"]);
  });

  it("parses nested alternatives — `pattern=[\"git\", [\"status\", \"diff\"]]`", () => {
    const text = `prefix_rule(pattern=["git", ["status", "diff", "log"]], decision="allow")`;
    const { rules, errors } = parseCodexRules(text);
    expect(errors).toEqual([]);
    expect(rules[0]!.pattern).toEqual(["git", ["status", "diff", "log"]]);
  });

  it("parses an optional justification field", () => {
    const text = `prefix_rule(
      pattern = ["git", ["status", "diff"]],
      decision = "allow",
      justification = "Trusted git operations",
    )`;
    const { rules } = parseCodexRules(text);
    expect(rules[0]!.justification).toBe("Trusted git operations");
  });

  it("parses multi-line + multiple rules + comment lines", () => {
    const text = `
      # Allow common git ops
      prefix_rule(
          pattern = ["git", ["status", "diff", "log"]],
          decision = "allow",
      )

      # gh CLI
      prefix_rule(pattern=["gh", ["pr", "issue"]], decision="allow")
    `;
    const { rules, errors } = parseCodexRules(text);
    expect(errors).toEqual([]);
    expect(rules.length).toBe(2);
    expect(rules[0]!.pattern).toEqual(["git", ["status", "diff", "log"]]);
    expect(rules[1]!.pattern).toEqual(["gh", ["pr", "issue"]]);
  });

  it("supports decision=prompt and decision=deny too", () => {
    const text = `
      prefix_rule(pattern=["git", "push"], decision="prompt")
      prefix_rule(pattern=["rm", "-rf", "/"], decision="deny")
    `;
    const { rules } = parseCodexRules(text);
    expect(rules[0]!.decision).toBe("prompt");
    expect(rules[1]!.decision).toBe("deny");
  });

  it("collects parse errors per malformed block without bailing on the whole file", () => {
    const text = `
      prefix_rule(pattern=["bun"], decision="allow")
      prefix_rule(this is garbage
      prefix_rule(pattern=["uv"], decision="allow")
    `;
    const { rules, errors } = parseCodexRules(text);
    expect(rules.length).toBe(2);          // the two valid blocks
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores trailing commas (Python-friendly)", () => {
    const text = `prefix_rule(pattern=["bun", "install",], decision="allow",)`;
    const { rules, errors } = parseCodexRules(text);
    expect(errors).toEqual([]);
    expect(rules[0]!.pattern).toEqual(["bun", "install"]);
  });

  it("preserves quoted strings with internal punctuation", () => {
    const text = `prefix_rule(pattern=["uv", "run", "pytest", "tests/test_a.py"], decision="allow")`;
    const { rules, errors } = parseCodexRules(text);
    expect(errors).toEqual([]);
    expect(rules[0]!.pattern).toEqual(["uv", "run", "pytest", "tests/test_a.py"]);
  });
});

describe("expandToAllowlist", () => {
  it("flattens single-pattern rules to one entry each", () => {
    const rules = parseCodexRules(`
      prefix_rule(pattern=["bun"], decision="allow")
      prefix_rule(pattern=["uv"], decision="allow")
    `).rules;
    expect(expandToAllowlist(rules).sort()).toEqual([
      "Bash(bun:*)",
      "Bash(uv:*)",
    ]);
  });

  it("expands nested-alternatives into one entry per option", () => {
    const rules = parseCodexRules(
      `prefix_rule(pattern=["git", ["status", "diff", "log"]], decision="allow")`,
    ).rules;
    expect(expandToAllowlist(rules).sort()).toEqual([
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git status:*)",
    ]);
  });

  it("emits the requested toolPrefix — Shell for Codex auto-load (matches the agent's row tag)", () => {
    const rules = parseCodexRules(`
      prefix_rule(pattern=["bun"], decision="allow")
      prefix_rule(pattern=["git", ["status","diff"]], decision="allow")
    `).rules;
    expect(expandToAllowlist(rules, "Shell").sort()).toEqual([
      "Shell(bun:*)",
      "Shell(git diff:*)",
      "Shell(git status:*)",
    ]);
  });

  it("only emits decision=allow rules — prompt/deny don't grant permission", () => {
    const rules = parseCodexRules(`
      prefix_rule(pattern=["bun"], decision="allow")
      prefix_rule(pattern=["git", "push"], decision="prompt")
      prefix_rule(pattern=["rm"], decision="deny")
    `).rules;
    expect(expandToAllowlist(rules)).toEqual(["Bash(bun:*)"]);
  });
});

describe("formatCodexRules", () => {
  it("emits one prefix_rule block per allowlist entry", () => {
    const out = formatCodexRules(["Bash(bun:*)", "Bash(uv:*)"]);
    expect(out).toContain('prefix_rule(pattern=["bun"], decision="allow")');
    expect(out).toContain('prefix_rule(pattern=["uv"], decision="allow")');
  });

  it("compacts sibling subcommands of one verb into a single nested-alternatives rule", () => {
    // Bash(git status:*) and Bash(git diff:*) share the same verb;
    // the Codex format collapses them into one rule with a nested
    // pattern array. Cleaner to read than two separate rules.
    const out = formatCodexRules([
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
    ]);
    // Order of subcommands in the alternatives list: lexicographic
    // (deterministic so the diff doesn't churn).
    expect(out).toContain('prefix_rule(pattern=["git", ["diff", "log", "status"]], decision="allow")');
    // No three separate git-* rules.
    expect(out.match(/prefix_rule\(pattern=\["git",/g)?.length ?? 0).toBe(1);
  });

  it("does NOT collapse when a verb has both wildcard + narrow entries", () => {
    // If `Bash(bun:*)` is present, `Bash(bun install:*)` is redundant
    // — but that subsumption is the merge layer's job, not the
    // formatter's. The formatter just emits what it's given.
    const out = formatCodexRules(["Bash(bun:*)", "Bash(bun install:*)"]);
    // The verb-only wildcard renders as `pattern=["bun"]`, the
    // narrower one as `pattern=["bun", "install"]`. Both should
    // appear so callers see exactly what they fed in.
    expect(out).toContain('pattern=["bun"]');
    expect(out).toContain('pattern=["bun", "install"]');
  });

  it("round-trips through parse → format → parse", () => {
    const original = [
      "Bash(bun:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(uv run:*)",
    ];
    const formatted = formatCodexRules(original);
    const parsed = parseCodexRules(formatted);
    expect(parsed.errors).toEqual([]);
    const flattened = expandToAllowlist(parsed.rules).sort();
    expect(flattened).toEqual(original.sort());
  });

  it("formats Shell(...) entries the same as Bash(...) — both are shell-tool prefixes", () => {
    // The dashboard's row tag is Shell(...) when the agent is Codex;
    // formatter must accept either prefix or codex output goes blank.
    const out = formatCodexRules(["Shell(bun:*)", "Shell(git status:*)", "Shell(git diff:*)"]);
    expect(out).toContain('pattern=["bun"]');
    expect(out).toContain('pattern=["git", ["diff", "status"]]');
  });

  it("ignores non-Bash tool entries (Claude-Code-only — Codex is shell-only)", () => {
    // Codex rules describe shell command prefixes only; entries like
    // bare `Read` or `WebFetch(...)` don't translate. Skip them.
    const out = formatCodexRules(["Read", "Edit", "Bash(bun:*)", "WebFetch(domain:github.com)"]);
    expect(out).toContain('pattern=["bun"]');
    expect(out).not.toContain("Read");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("WebFetch");
  });
});
