"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import type { GitSessionRow } from "@/lib/queries";

interface Props {
  data: GitSessionRow[];
  onCommitClick?: (sha: string) => void;
  onProjectClick?: (project: string) => void;
}

export function GitSessionsTable({ data, onCommitClick, onProjectClick }: Props) {
  // Default-open the most recent few sessions (a session list is far more
  // useful when its commits are visible at a glance, but keep older ones
  // collapsed to avoid drowning the view).
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(data.slice(0, 3).map((s) => s.session_id)),
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions ({data.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No sessions produced commits in this window.
          </p>
        )}
        {data.map((s) => {
          const isOpen = expanded.has(s.session_id);
          return (
            <div key={s.session_id} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => toggle(s.session_id)}
                className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-secondary/40 rounded-lg"
              >
                <span className="text-muted-foreground font-mono text-xs w-3 shrink-0">
                  {isOpen ? "▾" : "▸"}
                </span>
                <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/20 text-xs shrink-0">
                  {s.agent.replace("_", " ")}
                </Badge>
                <span
                  className="text-sm font-medium truncate"
                  onClick={
                    onProjectClick
                      ? (e) => { e.stopPropagation(); onProjectClick(s.project); }
                      : undefined
                  }
                >
                  {s.project}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDateTime(s.started)} · {formatDuration(s.started, s.ended)}
                </span>
                {(() => {
                  const insertions = s.commits.reduce((acc, c) => acc + c.insertions, 0);
                  const deletions  = s.commits.reduce((acc, c) => acc + c.deletions, 0);
                  const loc = insertions + deletions;
                  // input+output only (no cache_read). Cache reads dominate
                  // long sessions but represent re-reading the same prefix,
                  // not new model work — including them inflates the ratio
                  // 100x+ for any multi-hour conversation.
                  const newTokens = s.input_tokens + s.output_tokens;
                  const tokensPerLoc = loc > 0 ? Math.round(newTokens / loc) : null;
                  return (
                    <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                      <span>{s.commits.length} commit{s.commits.length === 1 ? "" : "s"}</span>
                      <span>
                        <span className="text-green-400">+{formatNumber(insertions)}</span>
                        {" / "}
                        <span className="text-red-400">-{formatNumber(deletions)}</span>
                      </span>
                      <span title="(input + output) tokens per line changed. Cache reads excluded — they scale with turn count, not shipped code.">
                        {tokensPerLoc !== null ? `${formatNumber(tokensPerLoc)} tok/LoC` : "—"}
                      </span>
                      <span>{formatNumber(s.entries)} entries</span>
                      <span>cache {formatNumber(s.cache_read)}</span>
                    </span>
                  );
                })()}
              </button>
              {isOpen && (
                <div className="px-3 pb-2 space-y-1 border-t border-border/50">
                  {s.commits.map((c) => (
                    <button
                      key={c.commit_sha}
                      type="button"
                      onClick={() => onCommitClick?.(c.commit_sha)}
                      className="w-full flex items-center gap-3 text-left text-sm px-1 py-1 rounded hover:bg-secondary/40"
                    >
                      <span className="font-mono text-xs text-blue-400 shrink-0">
                        {c.commit_sha.slice(0, 8)}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground shrink-0 w-32 truncate">
                        {formatDateTime(c.timestamp)}
                      </span>
                      <span className="truncate flex-1">{c.message.split("\n")[0]}</span>
                      <span className="shrink-0 tabular-nums text-xs whitespace-nowrap">
                        <span className="text-green-400">+{formatNumber(c.insertions)}</span>
                        {" / "}
                        <span className="text-red-400">-{formatNumber(c.deletions)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
