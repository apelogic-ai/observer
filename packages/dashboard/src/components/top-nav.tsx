"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface NavLeaf { label: string; href: string }
interface NavGroup { label: string; children: NavLeaf[] }
type NavItem = NavLeaf | NavGroup;

const NAV_ITEMS: NavItem[] = [
  { label: "Overview",    href: "/" },
  { label: "Timeline",    href: "/comparison" },
  { label: "Security",    href: "/security" },
  { label: "Permissions", href: "/permissions" },
  { label: "Skills",      href: "/skills" },
  {
    label: "Analyze",
    children: [
      { label: "Productivity", href: "/productivity" },
      { label: "Validation",   href: "/validation" },
      { label: "Autonomy",     href: "/autonomy" },
      { label: "Efficiency",   href: "/efficiency" },
      { label: "Stumbles",     href: "/stumbles" },
      { label: "Dark spend",   href: "/dark-spend" },
      { label: "Zero code",    href: "/zero-code" },
    ],
  },
];

/**
 * Top-level navigation. Lives in the sticky header alongside the brand.
 * Active link gets a brand-orange underline + brand text; everything else
 * uses muted-foreground until hovered.
 *
 * `isActive` matches by exact pathname for /, prefix-match for the rest —
 * /stumbles and /stumbles/anything both highlight Stumbles. With Next 16
 * trailingSlash:true the URL has a trailing slash, so we strip before
 * comparing. Groups (e.g. Analyze) light up when any of their children
 * match.
 */
export function TopNav() {
  const pathname = usePathname();
  const here = pathname.replace(/\/$/, "") || "/";

  return (
    <nav className="flex items-center gap-1 text-sm">
      {NAV_ITEMS.map((item) => {
        if ("children" in item) {
          return <NavGroupItem key={item.label} item={item} here={here} />;
        }
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

function NavGroupItem({ item, here }: { item: NavGroup; here: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anyChildActive = item.children.some((c) => here === c.href || here.startsWith(c.href + "/"));

  // Click outside / Escape closes the dropdown — keyboard-friendly and
  // avoids the "menu stays open after navigating" jank if Next's
  // soft-navigation doesn't unmount our header.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={[
          "px-3 py-1.5 transition-colors border-b-2 flex items-center gap-1",
          anyChildActive
            ? "text-brand border-brand"
            : "text-muted-foreground border-transparent hover:text-foreground",
        ].join(" ")}
      >
        <span>{item.label}</span>
        <ChevronDown
          aria-hidden
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-1 min-w-[180px] rounded-md border border-border bg-background shadow-lg z-50 py-1"
        >
          {item.children.map((c) => {
            const childActive = here === c.href || here.startsWith(c.href + "/");
            return (
              <Link
                key={c.href}
                href={c.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={[
                  "block px-3 py-1.5 text-sm transition-colors",
                  childActive
                    ? "text-brand"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30",
                ].join(" ")}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
