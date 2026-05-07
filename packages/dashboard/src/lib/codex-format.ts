/**
 * Format a Claude-Code-shape allowlist (`["Bash(verb:*)", …]`) as
 * Codex `prefix_rule(...)` text. Pure string manipulation — kept in
 * `src/lib/` so both the client (output card) and any future server
 * write-back path can use it without dragging server-only deps into
 * the client bundle.
 *
 * Compacts sibling subcommands of one verb into a single nested-
 * alternatives rule for readability:
 *
 *   ["Bash(git status:*)", "Bash(git diff:*)"]
 *   →
 *   prefix_rule(pattern=["git", ["diff", "status"]], decision="allow")
 *
 * Verb-only wildcards (`Bash(git:*)`) and exact entries with quoting
 * we can't tokenize cleanly are emitted as their own rules. Non-Bash
 * tools (Read/Edit/WebFetch/MCP) are skipped — Codex's grammar only
 * describes shell command prefixes.
 */
export function formatCodexRules(allowEntries: string[]): string {
  const verbWildcards = new Set<string>();
  const bySubcommand = new Map<string, Set<string>>();
  const passthrough: string[] = [];

  for (const raw of allowEntries) {
    // Either prefix is a shell-tool entry: `Bash(...)` from Claude
    // Code's tool, or `Shell(...)` from our PascalCased Codex tool.
    // Anything else (Read, Edit, WebFetch, MCP, …) doesn't translate
    // into Codex's shell-only grammar and gets skipped.
    const m = /^(?:Bash|Shell)\((.+):\*\)$/.exec(raw);
    if (!m) continue;
    const inner = m[1]!.trim();
    const tokens = inner.split(/\s+/);
    // Any token containing a Codex-special char means we can't safely
    // break this entry into a clean tokenized pattern. Emit verbatim.
    if (tokens.some((t) => /[(){}\[\]"\\,]/.test(t))) {
      passthrough.push(`prefix_rule(pattern=[${tokens.map(jsonStr).join(", ")}], decision="allow")`);
      continue;
    }
    if (tokens.length === 1) {
      verbWildcards.add(tokens[0]!);
    } else {
      const verb = tokens[0]!;
      const sub = tokens.slice(1).join(" ");
      const set = bySubcommand.get(verb) ?? new Set<string>();
      set.add(sub);
      bySubcommand.set(verb, set);
    }
  }

  const lines: string[] = [];
  for (const verb of [...verbWildcards].sort()) {
    lines.push(`prefix_rule(pattern=[${jsonStr(verb)}], decision="allow")`);
  }
  for (const [verb, subs] of [...bySubcommand.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...subs].sort();
    if (sorted.length === 1) {
      lines.push(`prefix_rule(pattern=[${jsonStr(verb)}, ${jsonStr(sorted[0]!)}], decision="allow")`);
    } else {
      const alts = sorted.map(jsonStr).join(", ");
      lines.push(`prefix_rule(pattern=[${jsonStr(verb)}, [${alts}]], decision="allow")`);
    }
  }
  lines.push(...passthrough);
  return lines.join("\n");
}

function jsonStr(s: string): string {
  return JSON.stringify(s);
}
