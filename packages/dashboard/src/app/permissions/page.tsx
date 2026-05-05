"use client";

import type React from "react";
import { useMemo, useState } from "react";
import { usePermissions, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import type { PermissionCategory, PermissionRow } from "@/lib/queries";
import { mergeAllowlists, parseAllowEntry, type MergeResult } from "@/lib/permissions-merge";

/**
 * Permissions analysis. Surfaces what tools the agent actually used
 * over the selected window, broken down by category, and produces a
 * Claude Code `settings.json` allowlist the user can paste in.
 *
 * Defaults aim for a workable allowlist out of the box: at the Bash
 * verb level (broader: `git:*` covers status / diff / log) plus all
 * file tools and MCP tools observed. The user can flip individual
 * checkboxes to narrow or widen.
 */

const CATEGORY_ORDER: PermissionCategory[] = ["core", "build", "file", "mcp", "other"];
const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  core: "Core (git, grep, find, …)",
  build: "Build & test (bun, uv, cargo, …)",
  file: "File ops (Read, Edit, Write, …)",
  mcp: "MCP",
  other: "Other",
};

const COMMAND_THRESHOLD_PCT = 5;   // hide commands seen in <5% of the busiest entry by default

function rowKey(r: PermissionRow): string {
  return `${r.tool}\t${r.path.join("\t")}`;
}

interface FragmentRowProps {
  group: { parent: PermissionRow; children: PermissionRow[] };
  parentChecked: boolean;
  expanded: boolean;
  threshold: number;
  isIncluded: (r: PermissionRow) => boolean;
  toggle: (r: PermissionRow) => void;
  onToggleExpand: () => void;
}

/**
 * Renders one verb row plus its nested subcommand rows. When the verb
 * is checked, the accordion collapses by default — children are
 * subsumed, so there's nothing to act on. Unchecking re-opens it so
 * the user can pick subcommands. The chevron always lets the user
 * peek at children regardless.
 */
function FragmentRow({ group, parentChecked, expanded, threshold, isIncluded, toggle, onToggleExpand }: FragmentRowProps): React.ReactNode {
  const { parent, children } = group;
  const hasChildren = children.length > 0;
  return (
    <>
      <tr className={`border-b border-border/50 ${parent.count < threshold ? "opacity-50" : ""}`}>
        <td className="py-2">
          <input
            type="checkbox"
            checked={isIncluded(parent)}
            onChange={() => toggle(parent)}
            className="h-4 w-4"
          />
        </td>
        <td className="py-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse subcommands" : "Expand subcommands"}
              className="font-mono text-xs text-muted-foreground select-none mr-2 hover:text-foreground transition-colors w-3 inline-block text-left"
            >
              {expanded ? "▼" : "▶"}
            </button>
          ) : (
            // Spacer that mirrors the chevron's footprint so non-Bash
            // rows (Read/Edit/Write/MCP/…) align with verb-row labels.
            <span aria-hidden="true" className="font-mono text-xs select-none mr-2 w-3 inline-block" />
          )}
          <code className="text-xs">{parent.allowlistEntry}</code>
          {hasChildren && !expanded && (
            <span className="ml-2 text-xs text-muted-foreground">({children.length} subcommand{children.length === 1 ? "" : "s"})</span>
          )}
        </td>
        <td className="py-2 tabular-nums text-right">{formatNumber(parent.count)}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(parent.sessions)}</td>
      </tr>
      {expanded && children.map((c) => {
        const covered = parentChecked;
        const childChecked = isIncluded(c);
        return (
          <tr
            key={rowKey(c)}
            className={`border-b border-border/50 ${covered ? "opacity-40" : c.count < threshold ? "opacity-50" : ""}`}
          >
            <td className="py-2 pl-8">
              <input
                type="checkbox"
                checked={covered ? true : childChecked}
                disabled={covered}
                onChange={() => toggle(c)}
                className="h-4 w-4"
              />
            </td>
            <td className="py-2">
              {/* Tree-line glyph + subcommand entry. Indented so the
                  hierarchy is obvious at a glance. */}
              <span className="font-mono text-xs text-muted-foreground select-none mr-2 ml-3">└─</span>
              <code className="text-xs">{c.allowlistEntry}</code>
              {covered && (
                <span className="ml-2 text-xs text-muted-foreground">
                  covered by <code>{parent.allowlistEntry}</code>
                </span>
              )}
            </td>
            <td className="py-2 tabular-nums text-right">{formatNumber(c.count)}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(c.sessions)}</td>
          </tr>
        );
      })}
    </>
  );
}

export default function PermissionsPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const rows = usePermissions(dashFilters);
  // Explicit user toggles. Anything not in the map falls back to the
  // default-selection rule keyed off `bashGranularity`. Keeping
  // overrides separate avoids the React 19 set-state-in-effect rule
  // and means changing granularity doesn't blow away the user's picks.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [bashGranularity, setBashGranularity] = useState<"verb" | "subcommand">("verb");
  const [copied, setCopied] = useState(false);
  // User's existing settings.json pasted into the textarea. Parsed
  // best-effort; bad input shows a parse-error hint but doesn't break
  // the candidate output.
  const [existingJson, setExistingJson] = useState("");
  // Per-verb accordion open/close. Falls back to "open when verb
  // unchecked" — when the verb wildcard is selected, children are
  // covered, so collapsing them is the right default. Manual chevron
  // clicks set an entry here that survives subsequent (un)checks.
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(new Map());
  // Verb wildcards the user opted into from the "suggested broadenings"
  // list (e.g. checking sqlite3 because they have ten Bash(sqlite3 …)
  // entries). Joined into the merge candidate before computing.
  const [acceptedSuggestions, setAcceptedSuggestions] = useState<Set<string>>(new Set());

  // When the scope changes (days/project/agent), the command tree
  // underneath changes too — anything the user pasted or toggled
  // belongs to the *previous* scope and would silently corrupt the
  // new view if it carried over. Reset to a clean slate. We use
  // React's prev-state-in-render pattern (the canonical way to reset
  // state in response to a prop change without a useEffect).
  const scopeKey = `${filters.days ?? "all"}|${filters.project ?? ""}|${filters.agent ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setOverrides(new Map());
    setExistingJson("");
    setCopied(false);
    setExpandOverrides(new Map());
    setAcceptedSuggestions(new Set());
  }

  // Default selection — derived purely from rows + granularity:
  //   bash at the chosen depth, plus every file/mcp/other tool.
  const defaultIncludes = useMemo(() => {
    const out = new Set<string>();
    if (!rows) return out;
    for (const r of rows) {
      if (r.tool === "Bash" || r.tool === "Shell") {
        const depth = bashGranularity === "verb" ? 2 : 3;
        if (r.path.length === depth) out.add(rowKey(r));
      } else {
        out.add(rowKey(r));
      }
    }
    return out;
  }, [rows, bashGranularity]);

  function isIncluded(r: PermissionRow): boolean {
    const k = rowKey(r);
    if (overrides.has(k)) return overrides.get(k)!;
    return defaultIncludes.has(k);
  }

  const grouped = useMemo(() => {
    const out = new Map<PermissionCategory, PermissionRow[]>();
    for (const c of CATEGORY_ORDER) out.set(c, []);
    if (rows) for (const r of rows) out.get(r.category)?.push(r);
    return out;
  }, [rows]);

  // The candidate allow list — what Observer would suggest based on
  // the user's checkbox selections. Fed into the merge function below.
  const candidateAllow = useMemo<string[]>(() => {
    if (!rows) return [];
    const included = rows.filter((r) => {
      const k = rowKey(r);
      return overrides.has(k) ? overrides.get(k) : defaultIncludes.has(k);
    });
    return included
      .filter((r) => {
        if (r.tool !== "Bash" && r.tool !== "Shell") return true;
        if (r.path.length <= 2) return true;
        const verbKey = `${r.tool}\t${r.path.slice(0, 2).join("\t")}`;
        const verbIncluded = overrides.has(verbKey)
          ? overrides.get(verbKey)
          : defaultIncludes.has(verbKey);
        return !verbIncluded;
      })
      .map((r) => r.allowlistEntry)
      .sort();
  }, [rows, overrides, defaultIncludes]);

  // Try to extract `permissions.allow` from whatever the user pasted.
  // Accept either a full settings.json shape or a raw array.
  const existingAllow = useMemo<{ list: string[]; error: string | null }>(() => {
    const trimmed = existingJson.trim();
    if (!trimmed) return { list: [], error: null };
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { list: parsed.filter((s): s is string => typeof s === "string"), error: null };
      }
      const allow = parsed?.permissions?.allow;
      if (Array.isArray(allow)) {
        return { list: allow.filter((s: unknown): s is string => typeof s === "string"), error: null };
      }
      return { list: [], error: "No permissions.allow array found in pasted JSON." };
    } catch (e) {
      return { list: [], error: `Invalid JSON: ${(e as Error).message}` };
    }
  }, [existingJson]);

  // Suggested broadenings: verbs that appear in the user's existing
  // list multiple times as exact (non-wildcard) Bash commands. Surfacing
  // them as opt-in `Bash(verb:*)` candidates lets the user collapse N
  // verbose entries into one wildcard with a single click.
  const broadeningSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    const wildcards = new Set<string>();
    for (const raw of existingAllow.list) {
      const e = parseAllowEntry(raw);
      if (!e) continue;
      if (e.tool !== "Bash" && e.tool !== "Shell" && e.tool !== "shell") continue;
      if (e.tokens.length === 0) continue;
      const verb = e.tokens[0]!;
      if (e.wildcard && e.tokens.length === 1) {
        // existing list already has Bash(verb:*) — no point suggesting.
        wildcards.add(`${e.tool}\t${verb}`);
        continue;
      }
      const key = `${e.tool}\t${verb}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const out: Array<{ tool: string; verb: string; count: number; entry: string }> = [];
    for (const [key, count] of counts) {
      if (count < 2) continue;
      if (wildcards.has(key)) continue;
      const [tool, verb] = key.split("\t");
      const entry = `${tool}(${verb}:*)`;
      out.push({ tool: tool!, verb: verb!, count, entry });
    }
    out.sort((a, b) => b.count - a.count || a.verb.localeCompare(b.verb));
    return out;
  }, [existingAllow.list]);

  // Effective candidate fed to merge: user's selection ∪ accepted suggestions.
  const candidateWithSuggestions = useMemo<string[]>(() => {
    if (acceptedSuggestions.size === 0) return candidateAllow;
    const set = new Set<string>(candidateAllow);
    for (const e of acceptedSuggestions) set.add(e);
    return Array.from(set).sort();
  }, [candidateAllow, acceptedSuggestions]);

  const merge = useMemo<MergeResult>(
    () => mergeAllowlists(existingAllow.list, candidateWithSuggestions),
    [existingAllow.list, candidateWithSuggestions],
  );

  // What's shown in the output card / copied. Falls back to candidate
  // when no existing JSON is pasted, so this page is useful from a
  // cold start as well as for incremental merges.
  const settingsJson = useMemo(() => {
    const allow = existingAllow.list.length > 0 ? merge.merged : candidateWithSuggestions;
    return JSON.stringify({ permissions: { allow } }, null, 2);
  }, [existingAllow.list.length, merge.merged, candidateWithSuggestions]);

  function toggle(r: PermissionRow): void {
    const k = rowKey(r);
    const current = isIncluded(r);
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(k, !current);
      return next;
    });
  }

  function isExpanded(groupKey: string, parentChecked: boolean): boolean {
    if (expandOverrides.has(groupKey)) return expandOverrides.get(groupKey)!;
    return !parentChecked;
  }

  function toggleExpand(groupKey: string, currentlyExpanded: boolean): void {
    setExpandOverrides((prev) => {
      const next = new Map(prev);
      next.set(groupKey, !currentlyExpanded);
      return next;
    });
  }

  function toggleSuggestion(entry: string): void {
    setAcceptedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(settingsJson);
      setCopied(true);
      // Revert label after 3s. Re-clicking before then resets the timer.
      setTimeout(() => setCopied(false), 3000);
    } catch { /* ignore */ }
  }

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Permissions"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
        onProjectChange={setProject}
        showProjectSelector
        onAgentChange={setAgent}
        showAgentSelector
        onRefresh={() => window.location.reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>What the agent actually used</CardTitle>
          <p className="text-sm text-muted-foreground">
            Frequency-ranked tool calls from the selected window. Pick a
            project to scope to one repo. Check the rows you want to allow,
            uncheck the long-tail entries that look incidental, and copy the
            generated <code className="text-xs">settings.json</code> snippet
            into <code className="text-xs">~/.claude/settings.json</code>.
            Ground truth, not guesses.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Bash granularity:</span>
            <div className="flex gap-1 rounded-lg border border-border p-1">
              {(["verb", "subcommand"] as const).map((g) => (
                <Button
                  key={g}
                  variant={bashGranularity === g ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => setBashGranularity(g)}
                >
                  {g === "verb" ? "verb (broader)" : "verb + subcommand (narrower)"}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {rows === null && (
        <Card><CardContent>Loading…</CardContent></Card>
      )}
      {rows !== null && rows.length === 0 && (
        <Card><CardContent>No tool usage in this window.</CardContent></Card>
      )}
      {rows !== null && rows.length > 0 && CATEGORY_ORDER.map((cat) => {
        const list = grouped.get(cat) ?? [];
        if (list.length === 0) return null;
        const max = Math.max(...list.map((r) => r.count));
        const threshold = Math.max(1, Math.floor((max * COMMAND_THRESHOLD_PCT) / 100));

        // Group Bash/shell rows by verb so subcommand rows nest under
        // their parent verb. Non-bash rows have no children.
        type Group = { parent: PermissionRow; children: PermissionRow[] };
        const groups: Group[] = [];
        const verbIndex = new Map<string, number>();
        for (const r of list) {
          if ((r.tool === "Bash" || r.tool === "Shell") && r.path.length === 2) {
            verbIndex.set(`${r.tool}\t${r.path[1]}`, groups.length);
            groups.push({ parent: r, children: [] });
          } else if ((r.tool === "Bash" || r.tool === "Shell") && r.path.length === 3) {
            const idx = verbIndex.get(`${r.tool}\t${r.path[1]}`);
            if (idx !== undefined) groups[idx]!.children.push(r);
          } else {
            // file/mcp/other tools — flat row, no children
            groups.push({ parent: r, children: [] });
          }
        }

        return (
          <Card key={cat}>
            <CardHeader>
              <CardTitle>{CATEGORY_LABELS[cat]}</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left">
                  <tr className="border-b border-border">
                    <th className="py-2 font-medium w-8" />
                    <th className="py-2 font-medium">Allowlist entry</th>
                    <th className="py-2 font-medium tabular-nums text-right">Count</th>
                    <th className="py-2 font-medium tabular-nums text-right">Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const parentChecked = isIncluded(g.parent);
                    const groupKey = `${g.parent.tool}\t${g.parent.path.slice(1).join("\t")}`;
                    const expanded = isExpanded(groupKey, parentChecked);
                    return (
                      <FragmentRow
                        key={rowKey(g.parent)}
                        group={g}
                        parentChecked={parentChecked}
                        expanded={expanded}
                        threshold={threshold}
                        isIncluded={isIncluded}
                        toggle={toggle}
                        onToggleExpand={() => toggleExpand(groupKey, expanded)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>Merge with existing settings.json (optional)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Paste your current <code className="text-xs">~/.claude/settings.json</code>
            {" "}or <code className="text-xs">.claude/settings.local.json</code> here.
            Observer unions it with the selection above and removes entries
            that are redundant — e.g. if you check <code className="text-xs">Bash(bun:*)</code>,
            an existing <code className="text-xs">Bash(bun install *)</code> is dropped.
            Entries Observer can&apos;t reason about (exact bash strings, <code className="text-xs">WebFetch(domain:…)</code>) pass through untouched.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={existingJson}
            onChange={(e) => setExistingJson(e.target.value)}
            placeholder='{ "permissions": { "allow": ["Bash(git:*)", "WebFetch(domain:github.com)"] } }'
            className="w-full h-32 text-xs font-mono bg-muted p-3 rounded border border-border focus:outline-none focus:ring-1 focus:ring-brand"
            spellCheck={false}
          />
          {existingAllow.error && (
            <p className="text-xs text-red-500">{existingAllow.error}</p>
          )}
          {broadeningSuggestions.length > 0 && (
            <div className="text-xs">
              <div className="font-medium text-muted-foreground mb-1">
                Suggested broadenings ({broadeningSuggestions.length})
              </div>
              <p className="text-muted-foreground mb-2">
                Verbs with multiple verbose entries in your pasted list. Opting in collapses them
                into a single wildcard. Off by default — your existing entries stay verbatim
                unless you check one here.
              </p>
              <ul className="space-y-1">
                {broadeningSuggestions.map((s) => (
                  <li key={s.entry}>
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acceptedSuggestions.has(s.entry)}
                        onChange={() => toggleSuggestion(s.entry)}
                        className="h-3 w-3"
                      />
                      <code>{s.entry}</code>
                      <span className="text-muted-foreground">would replace {s.count} existing {s.count === 1 ? "entry" : "entries"}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {existingAllow.list.length > 0 && !existingAllow.error && (
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <div className="font-medium text-muted-foreground mb-1">
                  Added ({merge.added.length})
                </div>
                {merge.added.length === 0 ? (
                  <p className="text-muted-foreground">Nothing new — your existing list already covers the candidate.</p>
                ) : (
                  <ul className="space-y-1">
                    {merge.added.map((e) => (
                      <li key={e}><code className="text-brand">+ {e}</code></li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="font-medium text-muted-foreground mb-1">
                  Subsumed ({merge.subsumed.length})
                </div>
                {merge.subsumed.length === 0 ? (
                  <p className="text-muted-foreground">Nothing redundant — every existing entry stands on its own.</p>
                ) : (
                  <ul className="space-y-1">
                    {merge.subsumed.map((s) => (
                      <li key={s.entry}>
                        <code className="line-through text-muted-foreground">- {s.entry}</code>
                        <span className="ml-1 text-muted-foreground">covered by <code>{s.subsumedBy}</code></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>
            settings.json {existingAllow.list.length > 0 && <span className="text-sm font-normal text-muted-foreground">(merged)</span>}
          </CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Target:
              <select
                disabled
                value="claude-code"
                onChange={() => { /* placeholder until we add real targets */ }}
                className="bg-muted border border-border rounded px-2 py-1 text-xs"
                aria-label="Target agent"
              >
                <option value="claude-code">Claude Code</option>
                <option value="codex" disabled>Codex (coming soon)</option>
                <option value="cursor" disabled>Cursor (coming soon)</option>
              </select>
            </label>
            <Button
              onClick={copy}
              variant="outline"
              size="sm"
              className={copied ? "text-brand border-brand" : ""}
            >
              {copied ? "✓ Copied" : "Copy"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted p-4 rounded overflow-x-auto">{settingsJson}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Paste into <code>~/.claude/settings.json</code>. When Bash verb-level
            and subcommand-level entries are both checked, the subcommand
            entries are removed as redundant.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
