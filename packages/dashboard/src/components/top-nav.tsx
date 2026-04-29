"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Overview",   href: "/" },
  { label: "Stumbles",   href: "/stumbles" },
  { label: "Dark spend", href: "/dark-spend" },
  { label: "Zero code",  href: "/zero-code" },
];

/**
 * Top-level navigation. Lives in the sticky header alongside the brand.
 * Active link gets a brand-orange underline + brand text; everything else
 * uses muted-foreground until hovered.
 *
 * `isActive` matches by exact pathname for /, prefix-match for the rest —
 * /stumbles and /stumbles/anything both highlight Stumbles. With Next 16
 * trailingSlash:true the URL has a trailing slash, so we strip before
 * comparing.
 */
export function TopNav() {
  const pathname = usePathname();
  const here = pathname.replace(/\/$/, "") || "/";

  return (
    <nav className="flex items-center gap-1 text-sm">
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/" ? here === "/" : here === item.href || here.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "px-3 py-1.5 transition-colors border-b-2",
              active
                ? "text-brand border-brand"
                : "text-muted-foreground border-transparent hover:text-foreground",
            ].join(" ")}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
