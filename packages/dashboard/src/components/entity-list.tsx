"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

interface EntityItem {
  name: string;
  count: number;
  href: string;
}

interface Props {
  title: string;
  items: EntityItem[];
}

export function EntityList({ title, items }: Props) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {items.map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-secondary transition-colors"
            >
              <span className="text-foreground truncate">{item.name}</span>
              <span className="tabular-nums text-muted-foreground ml-2 shrink-0">
                {formatNumber(item.count)}
              </span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
