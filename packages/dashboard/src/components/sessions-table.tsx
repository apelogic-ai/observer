"use client";

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import type { SessionRow } from "@/lib/queries";

const AGENT_VARIANT: Record<string, string> = {
  claude_code: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  codex: "bg-green-500/15 text-green-400 border-green-500/20",
  cursor: "bg-purple-500/15 text-purple-400 border-purple-500/20",
};

interface Props {
  data: SessionRow[];
  onProjectClick?: (project: string) => void;
}

export function SessionsTable({ data, onProjectClick }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Sessions</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Output Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((s) => (
              <TableRow key={s.session_id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {s.session_id.slice(0, 12)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={AGENT_VARIANT[s.agent] ?? ""}
                  >
                    {s.agent.replace("_", " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  {s.project && onProjectClick ? (
                    <button
                      className="text-sm hover:text-foreground text-muted-foreground hover:underline"
                      onClick={() => onProjectClick(s.project)}
                    >
                      {s.project}
                    </button>
                  ) : (
                    s.project ?? "-"
                  )}
                </TableCell>
                <TableCell className="text-sm">{formatDateTime(s.started)}</TableCell>
                <TableCell className="text-sm">{formatDuration(s.started, s.ended)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.entries}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.output_tokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
