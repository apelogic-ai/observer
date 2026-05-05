import { describe, it, expect } from "bun:test";
import {
  mergeAllowlists,
  parseAllowEntry,
  subsumes,
} from "../../src/lib/permissions-merge";

describe("parseAllowEntry", () => {
  it("parses tool-only entries", () => {
    const e = parseAllowEntry("Read");
    expect(e).not.toBeNull();
    expect(e!.tool).toBe("Read");
    expect(e!.tokens).toEqual([]);
    expect(e!.wildcard).toBe(false);
    expect(e!.reasonable).toBe(true);
  });

  it("parses Bash with :* wildcard", () => {
    const e = parseAllowEntry("Bash(bun:*)");
    expect(e!.tool).toBe("Bash");
    expect(e!.tokens).toEqual(["bun"]);
    expect(e!.wildcard).toBe(true);
    expect(e!.reasonable).toBe(true);
  });

  it("parses Bash with space-* wildcard form", () => {
    const e = parseAllowEntry("Bash(bun install *)");
    expect(e!.tool).toBe("Bash");
    expect(e!.tokens).toEqual(["bun", "install"]);
    expect(e!.wildcard).toBe(true);
  });

  it("parses Bash exact entry without wildcard", () => {
    const e = parseAllowEntry("Bash(bun --version)");
    expect(e!.tool).toBe("Bash");
    expect(e!.tokens).toEqual(["bun", "--version"]);
    expect(e!.wildcard).toBe(false);
  });

  it("parses WebFetch as opaque (not reasonable for token subsumption)", () => {
    const e = parseAllowEntry("WebFetch(domain:github.com)");
    expect(e!.tool).toBe("WebFetch");
    expect(e!.reasonable).toBe(false);
  });

  it("returns null for empty/garbage", () => {
    expect(parseAllowEntry("")).toBeNull();
    expect(parseAllowEntry("Bash(unterminated")).toBeNull();
  });
});

describe("subsumes", () => {
  const p = (s: string) => parseAllowEntry(s)!;

  it("verb wildcard subsumes subcommand entries", () => {
    expect(subsumes(p("Bash(bun:*)"), p("Bash(bun install *)"))).toBe(true);
    expect(subsumes(p("Bash(bun:*)"), p("Bash(bun --version)"))).toBe(true);
    expect(subsumes(p("Bash(bun:*)"), p("Bash(bun install foo)"))).toBe(true);
  });

  it("subcommand wildcard subsumes deeper entries", () => {
    expect(subsumes(p("Bash(bun install *)"), p("Bash(bun install foo)"))).toBe(true);
  });

  it("does not cross verbs", () => {
    expect(subsumes(p("Bash(bun:*)"), p("Bash(npm:*)"))).toBe(false);
  });

  it("non-wildcard does not subsume", () => {
    expect(subsumes(p("Bash(bun install)"), p("Bash(bun install *)"))).toBe(false);
  });

  it("space-form and colon-form are equivalent", () => {
    expect(subsumes(p("Bash(bun *)"), p("Bash(bun install foo)"))).toBe(true);
    expect(subsumes(p("Bash(bun:*)"), p("Bash(bun install foo)"))).toBe(true);
  });

  it("identity holds for opaque entries (exact dedup)", () => {
    expect(subsumes(p("WebFetch(domain:github.com)"), p("WebFetch(domain:github.com)"))).toBe(true);
    expect(subsumes(p("WebFetch(domain:github.com)"), p("WebFetch(domain:other.com)"))).toBe(false);
  });
});

describe("mergeAllowlists", () => {
  it("returns candidate when existing is empty", () => {
    const r = mergeAllowlists([], ["Read", "Bash(bun:*)"]);
    expect(r.merged).toEqual(["Bash(bun:*)", "Read"]);
    expect(r.added.sort()).toEqual(["Bash(bun:*)", "Read"]);
    expect(r.subsumed).toEqual([]);
  });

  it("returns existing when candidate is empty", () => {
    const r = mergeAllowlists(["Read", "Bash(git:*)"], []);
    expect(r.merged).toEqual(["Bash(git:*)", "Read"]);
    expect(r.added).toEqual([]);
    expect(r.subsumed).toEqual([]);
  });

  it("dedups exact duplicates", () => {
    const r = mergeAllowlists(["Read"], ["Read"]);
    expect(r.merged).toEqual(["Read"]);
    expect(r.added).toEqual([]);
  });

  it("verb-level entry subsumes redundant subcommand entries", () => {
    const r = mergeAllowlists(
      ["Bash(bun install *)"],
      ["Bash(bun:*)"],
    );
    expect(r.merged).toEqual(["Bash(bun:*)"]);
    expect(r.added).toEqual(["Bash(bun:*)"]);
    expect(r.subsumed).toEqual([{ entry: "Bash(bun install *)", subsumedBy: "Bash(bun:*)" }]);
  });

  it("preserves user's exact bash commands as opaque pass-through", () => {
    const r = mergeAllowlists(
      ['Bash(curl -sL "https://example.com")'],
      ["Bash(curl:*)"],
    );
    // The verb-wildcard subsumes the exact command — that's intentional.
    expect(r.merged).toEqual(["Bash(curl:*)"]);
    expect(r.subsumed).toEqual([
      { entry: 'Bash(curl -sL "https://example.com")', subsumedBy: "Bash(curl:*)" },
    ]);
  });

  it("preserves WebFetch(domain:x) entries (Observer can't reason about them)", () => {
    const r = mergeAllowlists(
      ["WebFetch(domain:github.com)"],
      ["Read", "Bash(bun:*)"],
    );
    expect(r.merged.sort()).toEqual(
      ["Bash(bun:*)", "Read", "WebFetch(domain:github.com)"].sort(),
    );
    expect(r.subsumed).toEqual([]);
  });

  it("treats space-form and colon-form wildcards as equivalent for subsumption", () => {
    const r = mergeAllowlists(
      ["Bash(bun install *)"],
      ["Bash(bun *)"],
    );
    expect(r.merged).toEqual(["Bash(bun *)"]);
    expect(r.subsumed).toEqual([
      { entry: "Bash(bun install *)", subsumedBy: "Bash(bun *)" },
    ]);
  });

  it("keeps both when neither subsumes the other", () => {
    const r = mergeAllowlists(
      ["Bash(npm:*)"],
      ["Bash(bun:*)"],
    );
    expect(r.merged).toEqual(["Bash(bun:*)", "Bash(npm:*)"]);
    expect(r.added).toEqual(["Bash(bun:*)"]);
    expect(r.subsumed).toEqual([]);
  });

  it("realistic merge scenario", () => {
    const existing = [
      "Bash(command -v bun)",
      "Bash(bun install *)",
      "WebFetch(domain:github.com)",
      "Read",
    ];
    const candidate = [
      "Bash(bun:*)",
      "Bash(git:*)",
      "Read",
      "Edit",
    ];
    const r = mergeAllowlists(existing, candidate);
    // Bash(command -v bun) starts with "command", not "bun" — Bash(bun:*) does NOT subsume it.
    // Bash(bun install *) starts with "bun" — Bash(bun:*) DOES subsume it.
    expect(r.merged.sort()).toEqual([
      "Bash(bun:*)",
      "Bash(command -v bun)",
      "Bash(git:*)",
      "Edit",
      "Read",
      "WebFetch(domain:github.com)",
    ]);
    const subsumedEntries = r.subsumed.map((s) => s.entry).sort();
    expect(subsumedEntries).toEqual(["Bash(bun install *)"]);
    expect(r.added.sort()).toEqual(["Bash(bun:*)", "Bash(git:*)", "Edit"]);
  });

  it("trims whitespace and ignores blank entries", () => {
    const r = mergeAllowlists(
      ["  Read  ", "", "Bash(bun:*)"],
      [],
    );
    expect(r.merged).toEqual(["Bash(bun:*)", "Read"]);
  });
});
