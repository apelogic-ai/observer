"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useFilters } from "@/hooks/use-filters";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { SessionDetail } from "@/lib/queries";

const AGENT_VARIANT: Record<string, string> = {
  claude_code: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  codex: "bg-green-500/15 text-green-400 border-green-500/20",
  cursor: "bg-purple-500/15 text-purple-400 border-purple-500/20",
};

const ENTRY_ICONS: Record<string, string> = {
  tool_call: "T",
  tool_result: "R",
  message: "M",
  token_usage: "$",
  task_summary: "S",
};

export default function SessionPage() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const { buildQs } = useFilters();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setLoading(false); return; }
    fetch(`/api/session-detail?id=${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d && d.session_id) setSession(d);
        else setError("Session not found");
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [id]);

  if (!id) {
    return (
      <main className="flex-1 p-6 max-w-[1600px] mx-auto w-full">
        <PageHeader title="Session" breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]} />
        <p className="text-muted-foreground">No session specified.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title={`Session ${id.slice(0, 12)}`}
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
      />

      {loading && (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading...
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {session && (
        <>
          {/* Session header */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className={AGENT_VARIANT[session.agent] ?? ""}>
              {session.agent.replace("_", " ")}
            </Badge>
            <Link
              href={`/project?name=${encodeURIComponent(session.project)}`}
              className="text-sm text-muted-foreground hover:text-blue-400 hover:underline"
            >
              {session.project}
            </Link>
            <span className="text-sm text-muted-foreground">
              {formatDateTime(session.started)} — {formatDateTime(session.ended)}
            </span>
            <Badge variant="outline" className="text-xs">
              {session.entries.length} entries
            </Badge>
          </div>

          {/* Tool summary */}
          {session.tool_summary.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Tools Used</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {session.tool_summary.map((t) => (
                    <Badge key={t.tool_name} variant="secondary" className="text-xs font-mono">
                      {t.tool_name}
                      <span className="ml-1.5 text-muted-foreground">{t.count}</span>
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Linked commits */}
          {session.commits.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Commits from this Session ({session.commits.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SHA</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead className="text-right">+/-</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {session.commits.map((c) => (
                      <TableRow key={c.commit_sha}>
                        <TableCell>
                          <button
                            className="font-mono text-xs text-muted-foreground hover:text-blue-400 hover:underline"
                            onClick={() => router.push(`/commit?sha=${c.commit_sha}`)}
                          >
                            {c.commit_sha.slice(0, 8)}
                          </button>
                        </TableCell>
                        <TableCell className="max-w-[400px] truncate text-sm">
                          {c.message}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDateTime(c.timestamp)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                          <span className="text-green-400">+{formatNumber(c.insertions)}</span>
                          {" / "}
                          <span className="text-red-400">-{formatNumber(c.deletions)}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Trace timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Trace Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-[600px] overflow-y-auto">
                {session.entries.map((e, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 py-1.5 border-b border-border/50 last:border-0"
                  >
                    {/* Type badge */}
                    <span className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold bg-neutral-800 text-muted-foreground">
                      {ENTRY_ICONS[e.entry_type] ?? "?"}
                    </span>

                    {/* Timestamp */}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums w-16">
                      {new Date(e.timestamp).toLocaleTimeString("en-US", {
                        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
                      })}
                    </span>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {e.entry_type === "tool_call" && e.tool_name && (
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px] font-mono">
                            {e.tool_name}
                          </Badge>
                          {e.file_path && (
                            <span className="text-xs text-muted-foreground font-mono truncate">
                              {e.file_path}
                            </span>
                          )}
                          {e.command && !e.file_path && (
                            <code className="text-xs text-muted-foreground truncate">
                              {e.command}
                            </code>
                          )}
                        </div>
                      )}
                      {e.entry_type === "message" && e.user_prompt && (
                        <p className="text-sm truncate text-blue-300">
                          {e.user_prompt}
                        </p>
                      )}
                      {e.entry_type === "message" && e.assistant_text && !e.user_prompt && (
                        <p className="text-sm truncate text-muted-foreground">
                          {e.assistant_text}
                        </p>
                      )}
                      {e.entry_type === "token_usage" && (
                        <span className="text-xs text-muted-foreground">
                          {e.model && <span className="mr-2">{e.model}</span>}
                          {e.input_tokens != null && <span className="mr-2">in: {formatNumber(e.input_tokens)}</span>}
                          {e.output_tokens != null && <span>out: {formatNumber(e.output_tokens)}</span>}
                        </span>
                      )}
                      {e.entry_type === "task_summary" && e.assistant_text && (
                        <p className="text-sm text-yellow-300/80 truncate">
                          {e.assistant_text}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
