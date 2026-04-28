"use client";

import Link from "next/link";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { GitCommitRow } from "@/lib/queries";

interface Props {
  data: GitCommitRow[];
  onProjectClick?: (project: string) => void;
  onCommitClick?: (sha: string) => void;
}

export function GitCommitsTable({ data, onProjectClick, onCommitClick }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Commits</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SHA</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Author</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">+/-</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Session</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow
                key={c.commit_sha}
                className={onCommitClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}
                onClick={onCommitClick ? () => onCommitClick(c.commit_sha) : undefined}
              >
                <TableCell className="font-mono text-xs text-blue-400">
                  {c.commit_sha.slice(0, 8)}
                </TableCell>
                <TableCell className="max-w-[300px] truncate text-sm" title={c.message}>
                  {c.message.split("\n")[0]}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {c.author}
                </TableCell>
                <TableCell>
                  {c.project && onProjectClick ? (
                    <button
                      className="text-sm hover:text-foreground text-muted-foreground hover:underline"
                      onClick={(e) => { e.stopPropagation(); onProjectClick(c.project); }}
                    >
                      {c.project}
                    </button>
                  ) : (
                    c.project ?? "-"
                  )}
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {formatDateTime(c.timestamp)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                  <span className="text-green-400">+{formatNumber(c.insertions)}</span>
                  {" / "}
                  <span className="text-red-400">-{formatNumber(c.deletions)}</span>
                </TableCell>
                <TableCell>
                  {c.agent_authored ? (
                    <Badge
                      variant="outline"
                      className="bg-blue-500/15 text-blue-400 border-blue-500/20"
                    >
                      {c.agent_name ?? "agent"}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-neutral-500/15 text-neutral-400 border-neutral-500/20"
                    >
                      human
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {c.session_id ? (
                    <Link
                      href={`/session?id=${c.session_id}`}
                      className="text-blue-400 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.session_id.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
