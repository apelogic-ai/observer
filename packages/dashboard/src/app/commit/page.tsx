"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useFilters } from "@/hooks/use-filters";
import { useSessionCommits } from "@/hooks/use-dashboard";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import type { CommitDetail, SessionSummary } from "@/lib/queries";

export default function CommitPage() {
  const sha = useSearchParams().get("sha") ?? "";
  const router = useRouter();
  const { buildQs } = useFilters();
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  // Skip the initial "loading" state when no sha is given — avoids setting
  // state synchronously in the guard branch of the effect.
  const [loading, setLoading] = useState(sha !== "");
  const siblingCommits = useSessionCommits(commit?.session_id ?? null);

  useEffect(() => {
    if (!sha) return;
    fetch(`/api/commit-detail?sha=${sha}`)
      .then((r) => r.json())
      .then((d) => {
        setCommit(d);
        setLoading(false);
        if (d?.session_id) {
          fetch(`/api/session-summary?id=${d.session_id}`)
            .then((r) => r.json())
            .then((s) => { if (s?.session_id) setSession(s); })
            .catch(() => {});
        }
      })
      .catch(() => setLoading(false));
  }, [sha]);

  if (!sha) {
    return (
      <main className="flex-1 p-6 max-w-[1600px] mx-auto w-full">
        <PageHeader title="Commit" breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]} />
        <p className="text-muted-foreground">No commit specified.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title={`Commit ${sha.slice(0, 8)}`}
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
      />

      {loading && (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading...
        </div>
      )}

      {commit && (
        <>
          {/* Commit info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <span className="font-mono text-sm text-muted-foreground">{commit.commit_sha}</span>
                {commit.agent_authored ? (
                  <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/20">
                    {commit.agent_name ?? "agent"}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20">
                    human
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-lg">{commit.message}</p>
              {commit.message_body && (
                <pre className="text-sm text-muted-foreground whitespace-pre-wrap bg-neutral-900 rounded-lg p-4 max-h-60 overflow-y-auto">
                  {commit.message_body}
                </pre>
              )}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Author</span>
                  <p>{commit.author}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Time</span>
                  <p>{formatDateTime(commit.timestamp)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Project</span>
                  <p>
                    <Link
                      href={`/project?name=${encodeURIComponent(commit.project)}`}
                      className="hover:text-blue-400 hover:underline"
                    >
                      {commit.project}
                    </Link>
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Repo</span>
                  <p>{commit.repo}</p>
                </div>
              </div>
              <div className="flex gap-6 text-sm">
                <span>
                  <span className="text-green-400">+{formatNumber(commit.insertions)}</span>
                  {" / "}
                  <span className="text-red-400">-{formatNumber(commit.deletions)}</span>
                </span>
                <span className="text-muted-foreground">
                  {commit.files_changed} file{commit.files_changed !== 1 ? "s" : ""} changed
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Files changed */}
          {commit.files.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Files Changed ({commit.files.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {commit.files.map((f) => (
                    <div key={f} className="font-mono text-xs text-muted-foreground">
                      {f}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Linked session with stats */}
          {commit.session_id && session && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  Session containing this commit
                  <Badge variant="outline" className="bg-blue-500/15 text-blue-400 border-blue-500/20 text-xs">
                    {session.agent.replace("_", " ")}
                  </Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(session.started)} → {formatDateTime(session.ended)} · session-wide totals below, not commit-specific
                </p>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Token stats */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Duration</span>
                    <p className="text-xl font-bold tabular-nums">{formatDuration(session.started, session.ended)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Entries</span>
                    <p className="text-xl font-bold tabular-nums">{formatNumber(session.entries)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Input Tokens</span>
                    <p className="text-xl font-bold tabular-nums">{formatNumber(session.input_tokens)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Output Tokens</span>
                    <p className="text-xl font-bold tabular-nums">{formatNumber(session.output_tokens)}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Cache Read</span>
                    <p className="text-xl font-bold tabular-nums">{formatNumber(session.cache_read)}</p>
                  </div>
                </div>

                {/* Tools */}
                {session.tools.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Tools</span>
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {session.tools.map((t) => (
                        <Badge key={t.tool_name} variant="secondary" className="text-xs font-mono">
                          {t.tool_name}
                          <span className="ml-1.5 text-muted-foreground">{t.count}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Models */}
                {session.models.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">Models</span>
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {session.models.map((m) => (
                        <Badge key={m.model} variant="outline" className="text-xs font-mono">
                          {m.model}
                          <span className="ml-1.5 text-muted-foreground">{m.count}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sibling commits — every other commit produced by this
                    same session. Without this list it's easy to read the
                    session-wide token totals as if they applied to *this*
                    commit alone. */}
                {siblingCommits && siblingCommits.length > 1 && (
                  <div className="pt-3 border-t border-border">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">
                      Commits from this session ({siblingCommits.length})
                    </span>
                    <div className="mt-2 space-y-1">
                      {siblingCommits.map((c) => {
                        const isCurrent = c.commit_sha === commit.commit_sha;
                        return (
                          <Link
                            key={c.commit_sha}
                            href={`/commit?sha=${c.commit_sha}`}
                            className={`flex items-center gap-3 px-2 py-1 rounded text-sm hover:bg-secondary/50 ${isCurrent ? "bg-secondary/40" : ""}`}
                          >
                            <span className="font-mono text-xs text-muted-foreground shrink-0">
                              {c.commit_sha.slice(0, 8)}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground shrink-0 w-32 truncate">
                              {formatDateTime(c.timestamp)}
                            </span>
                            <span className="truncate flex-1">{c.message}</span>
                            <span className="shrink-0 text-xs tabular-nums">
                              <span className="text-green-400">+{formatNumber(c.insertions)}</span>
                              {" / "}
                              <span className="text-red-400">-{formatNumber(c.deletions)}</span>
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Link to full session */}
                <div className="pt-2 border-t border-border">
                  <button
                    className="text-sm text-blue-400 hover:underline"
                    onClick={() => router.push(`/session?id=${commit.session_id}`)}
                  >
                    View full session trace ({formatNumber(session.entries)} entries)
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {commit.session_id && !session && (
            <Card>
              <CardHeader>
                <CardTitle>Linked Agent Session</CardTitle>
              </CardHeader>
              <CardContent>
                <button
                  className="font-mono text-sm text-blue-400 hover:underline"
                  onClick={() => router.push(`/session?id=${commit.session_id}`)}
                >
                  {commit.session_id}
                </button>
              </CardContent>
            </Card>
          )}

          {!commit.session_id && !commit.agent_authored && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                No linked agent session — this appears to be a manual commit.
              </CardContent>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
