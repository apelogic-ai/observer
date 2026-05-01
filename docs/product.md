# Observer: Product Description

**Version:** 0.1.15 (next: 0.1.16, unreleased — adds OS keychain backend for secrets, init wizard prompts for storage choice)
**Date:** 2026-05-01

---

## 1. What is Observer

Observer is a **single-binary toolkit for AI-coding-agent observability**.
One install delivers two things:

1. **A local dashboard** that runs against a developer's own trace history.
   Open `localhost:3457` and see token costs, project mix, session
   drill-down, git-event attribution, repeated-loop incidents, and
   per-session inefficiency metrics — all without sending any data off
   the machine.

2. **A centralized lakehouse pipeline** for organizations. The same
   binary runs as a daemon that watches agent trace directories,
   redacts secrets, enforces per-field disclosure policy, and ships
   batches to a self-hosted **API server** (the ingestor) which writes
   to a Hive-partitioned lakehouse.

The two are independent. Most developers will run only the local
dashboard; organizations adding centralized analytics deploy the
ingestor separately.

Observer normalizes Claude Code, Codex, and Cursor into a unified
`TraceEntry` schema so dashboards, security scanning, knowledge mining,
and DX diagnostics work across agents without per-vendor logic.

---

## 2. Design Goals

1. **Local-first observability.** A developer should be able to run
   `observer dashboard` and see meaningful analytics about their own
   work in under 30 seconds, with zero network calls.
2. **Organizational AI observability.** Answer the corporate question:
   *"How much are we spending on AI? Is it worth it? Who's using it?
   Are we exposed?"* — without exposing prompts or content.
3. **Zero-trust data pipeline.** Secrets never leave the machine.
   Content exposure is controlled by a four-level disclosure slider
   (basic → moderate → sensitive → full). HIGH_RISK data (raw query
   results, file contents) never ships to the centralized lakehouse.
4. **Cross-agent unification.** Claude Code, Codex, and Cursor emit
   different formats (JSONL, SQLite). Observer normalizes all three
   into a unified `TraceEntry` schema so downstream consumers don't
   care which agent produced the data.
5. **Idempotent, fault-tolerant shipping.** Cursor-based tracking
   ensures entries are shipped exactly once. Deterministic batch IDs
   enable safe retries. The ingestor deduplicates at the API level.
6. **Opt-in by default.** Nothing watches, nothing ships, until the
   developer explicitly configures it. Each agent source is
   individually enabled. Only traces from whitelisted GitHub
   organizations are shipped.
7. **Programmatic detection over LLM analysis.** Stuck-agent patterns
   (redundant loops, dark spend, zero-code sessions) are surfaced via
   deterministic SQL aggregations on the local DB — fast, cheap,
   reproducible. LLM-based analysis (skill mining via the dreamer)
   sits one layer up and consumes the leaderboard as its work queue.
8. **Single binary, zero runtime deps.** Compiled with
   `bun build --compile` to ~50–80 MB. The dashboard's static export
   is embedded in the binary; no separate web server.

---

## 3. Design Principles

**Privacy as architecture, not policy.** Disclosure levels are
enforced by the type system — every field in every agent's trace
format is classified into one of four sensitivity tiers (SAFE,
MODERATE, SENSITIVE, HIGH_RISK). The shipper strips fields based on
the configured tier before serialization. There is no "trust the
server" path.

**Deterministic over agentic.** Secret scanning, field
classification, retry detection, dashboard analytics, and stumble
detection are all pattern-based. No LLM is needed for the core
pipeline. This makes the system fast, reproducible, auditable, and
free of inference costs.

**Immutable storage.** Every batch (in the lakehouse) is write-once.
Dedup logs are append-only. No file is ever updated in place. This
eliminates corruption from concurrent writes and simplifies GDPR
deletion (remove the partition).

**Developer as partition key.** Lakehouse storage is partitioned by
hashed developer ID. This enables per-developer S3 IAM policies, GDPR
deletion via `rm -rf dev=HASH/`, and write isolation between
developers.

**Ship date, not entry date.** Lakehouse batches are partitioned by
the date they were shipped, not the dates of individual entries. This
keeps writes atomic. Downstream Parquet normalization re-partitions
by entry timestamp for query performance.

**Graceful degradation.** Auth methods are alternatives — either API
key OR Ed25519 is sufficient. If the OAuth IdP is down, Ed25519 still
works. If a parser encounters unknown entry types, they are skipped
(not errored).

---

## 4. Architecture

```
Developer Machine                                   Centralized Infrastructure
─────────────────                                   ─────────────────────────────

Agent trace dirs                                    API server (ingestor)
  ~/.claude/projects/                                 stateless HTTP, S3-backed
  ~/.codex/sessions/                                    │
  ~/.cursor/  (SQLite)                                  │  authenticate
        │                                               │  deduplicate
        ▼                                               │  store
  ┌─────────────────────┐                               ▼
  │  observer daemon    │                        ┌──────────────────┐
  │                     │   HTTP POST            │  Lakehouse (S3)  │
  │  discover           │ ──────────────────►    │                  │
  │  parse              │   + Auth header        │  Raw zone        │
  │  classify fields    │   + Ed25519 sig        │  (JSONL, Hive)   │
  │  scan secrets       │                        │                  │
  │  enforce disclosure │   ───── OR ─────►      │  Normalized zone │
  │  ship (idempotent)  │                        │  (Parquet)       │
  └──────────┬──────────┘   local-only path      └────────┬─────────┘
             │              (full disclosure)             │
             ▼                                            │
  ~/.observer/traces/normalized/  ◄──── reads ────┐       ▼
  (Hive-partitioned JSONL)                        │   Downstream
             │                                    │   pipelines
             ▼                                    │
  ┌─────────────────────┐                         │
  │  observer dashboard │                         │
  │  (embedded in       │                         │
  │   binary as static  │                         │
  │   Next.js export)   │                         │
  │                     │                         │
  │  in-memory SQLite   │                         │
  │  + Bun HTTP server  │                         │
  │                     │                         │
  │  Pages:             │                         │
  │  - Overview         │                         │
  │  - Stumbles         │                         │
  │  - Dark spend       │                         │
  │  - Zero code        │                         │
  │  - Session drill-in │                         │
  └─────────────────────┘                         │
                                                  │
                                  ┌───────────────┼───────────────┐
                                  ▼               ▼               ▼
                            Knowledge       Analytics       Security
                            extractor       (Grafana)       scanner
                            (dreamer)
```

### Two data flows

**Local-only (default for individual developers):**

1. **Discover** — scan `~/.claude/`, `~/.codex/`, `~/.cursor/` for trace files.
2. **Parse** — per-agent parsers convert raw formats into `TraceEntry[]`.
3. **Normalize** — write to `~/.observer/traces/normalized/` as
   Hive-partitioned JSONL using the local-only `full` disclosure level
   (the data never leaves the machine).
4. **Read** — the dashboard scans this directory at boot and rebuilds an
   in-memory SQLite database. Pages query that DB.

**Centralized (organizational):**

1. **Discover** + **Parse** as above.
2. **Classify** — each field is tagged with its sensitivity tier.
3. **Scan** — deterministic regex scanner finds secrets, replaces with
   `[REDACTED:pattern]`.
4. **Filter** — disclosure policy strips fields above the configured
   tier (basic / moderate / sensitive — `full` is local-only).
5. **Scope** — repo-resolver checks git remote against `include_orgs`;
   non-matching projects are skipped.
6. **Ship** — HTTP POST to ingestor with auth headers; cursor advances
   only on 200 OK.
7. **Store** — ingestor deduplicates by batch ID, writes to
   Hive-partitioned raw zone in S3 (or local FS in dev).

The two flows share the daemon process. A developer running both
keeps a local trace cache for the dashboard and ships filtered
batches to the corporate ingestor — neither pipeline blocks the other.

---

## 5. Components

The repository is a Bun workspace monorepo with three packages.

### 5.1 Agent (`packages/agent/`)

The local daemon. TypeScript on Bun runtime. Compiles to a standalone
binary that also embeds the dashboard's static export.

| Module | File | Purpose |
|--------|------|---------|
| **CLI** | `src/cli.ts` | Commands: `init`, `scan`, `status`, `daemon`, `start`, `stop`, `dashboard`, `logs`, `cursor-usage`, `keychain`, `update`, `uninstall`. See Appendix A. |
| **Daemon** | `src/daemon.ts` | Continuous poll loop: discover → parse → scan → ship. Configurable interval (default 5 min). |
| **Discovery** | `src/discover.ts` | Scans standard agent directories. Returns trace file paths grouped by agent. |
| **Parsers** | `src/parsers/claude.ts` | Claude Code JSONL → `TraceEntry[]`. Handles message, tool_use, tool_result, thinking. |
| | `src/parsers/codex.ts` | Codex JSONL → `TraceEntry[]`. Maps function_call/function_call_output, task summaries. |
| | `src/parsers/cursor.ts` | Cursor SQLite `.vscdb` → `TraceEntry[]`. Reads `cursorDiskKV` table. |
| **Type system** | `src/types.ts` | `TraceEntry` schema with per-field sensitivity. Per-vendor raw entry types. |
| **Secret scanner** | `src/security/scanner.ts` | 11 regex patterns (AWS, DB URLs, GitHub tokens, JWTs, OpenAI keys, etc.). Three-layer filtering: regex + entry-type + project exclusions. |
| **Shipper (HTTP)** | `src/http-shipper.ts` | POSTs batches to ingestor. Cursor-based, idempotent. Surfaces 4xx/5xx via stderr — no silent failures. |
| **Shipper (disk)** | `src/disk-shipper.ts` | Writes to a local destination's `endpoint` (typically `~/.observer/traces/normalized/`) for the local dashboard. |
| **Git scanner** | `src/git/scanner.ts` | Walks configured project repos, emits `git_event` rows for commits. Links commits back to sessions by timestamp + author + Co-Authored-By trailer. |
| **Identity** | `src/identity.ts` | Ed25519 keypair generation, signing, verification, fingerprinting. `loadKeypairWithKeychain` reads from the OS keychain when configured (§ 5.9), else from `~/.observer/observer.key`. |
| **Repo resolver** | `src/repo-resolver.ts` | Maps trace file paths to git repos. Extracts org/repo from remote for scope filtering. |
| **Config** | `src/config.ts` | YAML config loader. New `destinations[]` shape (§ 5.8) with auto-migration of legacy `ship:` blocks at parse time. |
| **Secure store** | `src/secure-store.ts` | OS-keychain abstraction for API keys + Ed25519 private key. macOS Keychain, Linux libsecret, NoOp fallback elsewhere. |
| **Init wizard** | `src/init.ts` | Interactive setup: detect agents, configure scope, generate keypair, ask where to store the API key (keychain / env / literal / Ed25519-only), install service. |
| **Service** | `src/service.ts` | Platform-native service management: launchd (macOS), systemd (Linux). Argv-form invocations (no shell interpolation). |

**Test suite:** ~80 tests across parsers, shipper idempotency, security
scanner, config, identity, repo resolver, discovery, CLI, daemon, git
scanner, and service management.

### 5.2 Dashboard (`packages/dashboard/`)

Next.js 16 static export + Bun HTTP server in one. Compiled into a
single tarball that's embedded in the agent binary via `with { type:
"file" }`.

| Module | File | Purpose |
|--------|------|---------|
| **Server** | `server/index.ts` | Bun HTTP. Routes `/api/*` to query handlers; everything else to the static export. |
| **DB** | `server/db.ts` | In-memory SQLite (bun:sqlite). Scans `OBSERVER_DATA_DIR` at boot, ingests JSONL into `traces` and `git_events` tables. Watches the dir for live updates. |
| **Queries** | `server/queries.ts` | All read-side aggregations: stats, activity, heatmap, tokens, tools, projects, models, sessions, skills, git stats/timeline/commits, **stumbles**, **dark spend**, **zero code**. |
| **UI pages** | `src/app/*/page.tsx` | Overview (`/`), session drill-in (`/session`), commit drill-in (`/commit`), tool/model/project pages, **`/stumbles`**, **`/dark-spend`**, **`/zero-code`**. |
| **Top nav** | `src/components/top-nav.tsx` | Sticky header nav: Overview / Stumbles / Dark spend / Zero code. Active link in brand orange. |
| **Filters** | `src/hooks/use-filters.ts` | URL-based filter state: days, project, agent, tool, granularity. History API + popstate (Next 16 static-export workaround). |
| **Build** | `scripts/bundle-static.ts` | Packs `out/` into `dist/out.tar` + a `build-info.json` so the agent binary can extract on first run. |
| **Static handler** | `server/static.ts` | Serves the embedded tarball at runtime. |

**Test suite:** ~60 server tests (queries) + ~25 e2e Playwright tests
covering chart rendering, filters, heatmap, sessions, stumbles, dark
spend, zero code, and top-nav active state.

The dashboard reads from `OBSERVER_DATA_DIR` (default
`~/.observer/traces/normalized`) — the directory the agent's
disk-shipper writes to. Dashboard and shipper run in the same binary
but are independent components.

### 5.3 API server / ingestor (`packages/api/`)

Stateless HTTP server. Receives trace batches, authenticates,
deduplicates, stores. Detailed deployment in **Section 8**.

| Module | File | Purpose |
|--------|------|---------|
| **Server** | `src/server.ts` | HTTP endpoints: `GET /health`, `POST /api/ingest`. Dual auth (Bearer key OR Ed25519). Batch-level dedup. 8 MiB default body cap. |
| **Store** | `src/store.ts` | Immutable batch persistence. Hive-style partitioning: `raw/year=YYYY/month=MM/day=DD/agent=X/dev=HASH/{batchId}.jsonl`. Append-only dedup log. Per-developer isolation. |
| **Main** | `src/main.ts` | Server startup. CLI flags: `--port`, `--data-dir`. Env: `OBSERVER_API_KEYS`. |

**Dependencies:** none (pure Bun/Node HTTP + filesystem).

**Test suite:** 3 files (e2e, server, store) — full agent → ingestor
→ lakehouse flow, both auth modes, oversized-body rejection,
partitioning, dedup.

### 5.4 Storage layout

**Local (every developer):**

```
~/.observer/                          # Agent + dashboard state
├── config.yaml                       # User configuration
├── config.local.yaml                 # Local overrides (IT-managed)
├── observer.key                      # Ed25519 private key (0600)
├── observer.pub                      # Ed25519 public key
├── shipper-cursors.json              # Per-file shipping progress
├── auth.json                         # OAuth tokens (enterprise) (0600)
├── logs/
│   ├── observer.log                  # Daemon activity
│   └── dashboard.log                 # Dashboard server
└── traces/
    └── normalized/                   # Local-only trace cache (`full` disclosure)
        └── YYYY-MM-DD/
            ├── claude_code/
            │   └── {sessionHash}.jsonl
            ├── codex/
            │   └── {sessionHash}.jsonl
            ├── cursor/
            │   ├── {sessionHash}.jsonl
            │   └── _usage.json       # Sidecar: real Cursor token usage from API
            └── git/
                └── {repo}.jsonl       # Git event stream
```

**Lakehouse (centralized, S3 in production):**

```
{lakehouse}/
└── raw/
    └── year=2026/
        └── month=04/
            └── day=29/
                └── agent=claude_code/
                    └── dev=a1b2c3d4...      # SHA-256 prefix of developer email (12 chars)
                        ├── {batchId}.jsonl  # Immutable, write-once
                        ├── {batchId}.meta.json
                        └── dedup.log        # Append-only batchId log
```

### 5.5 Disclosure policy

Every field in agent traces is classified into one of four sensitivity
tiers:

| Tier | Contains | Examples |
|------|----------|----------|
| **SAFE** | Metadata only | Timestamps, model name, token counts, session ID, role, stop reason |
| **MODERATE** | Behavioral data | Tool names, file paths, commands, git metadata, task summaries |
| **SENSITIVE** | Content | User prompts, assistant responses, thinking/reasoning |
| **HIGH_RISK** | Raw data | Tool results (stdout, file contents, query data, diffs) |

The developer (or IT policy) selects a disclosure level:

| Level | Ships | Strips | Use case |
|-------|-------|--------|----------|
| `basic` | SAFE only | Everything else | Cost + adoption analytics, zero content risk |
| `moderate` (default for HTTP) | SAFE + MODERATE | SENSITIVE + HIGH_RISK | Behavioral analytics, DX diagnostics |
| `sensitive` | SAFE + MODERATE + SENSITIVE | HIGH_RISK only | Full knowledge mining (with consent) |
| `full` | Everything (incl. HIGH_RISK) | Nothing | **Local disk shipper only.** Powers the dashboard's session drill-in with real tool args. Never permitted by the HTTP shipper. |

HIGH_RISK data **never ships over the network** regardless of disclosure
level. The `full` disclosure level only applies to the local disk
shipper writing into `~/.observer/traces/normalized/`.

**Anonymous mode** (`anonymize: true`): replaces developer identity
with a deterministic one-way hash. Cross-correlation still works;
de-anonymization requires a separate mapping held by the org.

### 5.6 Git events

A parallel data entity to traces. The agent's git scanner walks
configured repos and emits one row per commit with:

- `commitSha`, `parentShas`, `branch`, `repo`, `project`
- `filesChanged`, `insertions`, `deletions`, `files[]`
- `agentAuthored` (true if Co-Authored-By trailer matches a known
  agent), `agentName`
- `sessionId` — set if the commit's timestamp falls inside an active
  session window for the same author. The dashboard's ingest also
  runs a backfill pass to catch commits that lacked sessionId on disk
  but match a session window after re-grouping.

Git events flow through the same disk + HTTP shippers as traces.

### 5.7 Programmatic detectors (local-only)

Three deterministic SQL aggregations on the dashboard's in-memory DB
that surface stuck-agent patterns without LLM analysis:

| Page | What it ranks | Detection | Useful for |
|------|---------------|-----------|------------|
| **Stumbles** (`/stumbles`) | Per-session repeated tool calls | Group by `(sessionId, toolName, normalized-args)`; flag clusters with `occurrences >= 3`. File-iteration tools (Read/Edit/Write) excluded. | Catching db-mcp poking, MCP query spam, repeated greps. Each row is one concrete incident drillable to the session trace. |
| **Dark spend** (`/dark-spend`) | Sessions with `LoC > 0` by tokens / LoC | `tokens / max(LoC, 1)`, descending | Finding sessions that shipped code expensively. |
| **Zero code** (`/zero-code`) | Sessions with `LoC = 0` by tokens | Tokens descending | Finding flail (agent ran for hours, shipped nothing) and analysis sessions (legitimate non-code work). Project filter separates the two. |

Each row links to the session detail page. The dashboard also shows
**active time** (wall minus idle gaps over 5 min) so sessions reused
across days don't appear as multi-day.

These detectors are intentionally cheap and shallow. Their value is as
the work queue for an LLM-based "dreamer" pass that turns surfaced
patterns into skill drafts or `AGENTS.md` rules.

### 5.8 Configuration shape

The agent config is a list of independent **destinations**. Each owns
its own disclosure, schedule, redact, anonymize, and scope.

```yaml
developer: jane@acme.com
sources:
  claude_code: true
  codex: true
  cursor: false

destinations:
  - name: local-dashboard
    endpoint: ~/.observer/traces/normalized   # path → disk shipper
    disclosure: full
    schedule: realtime
    useLocalTime: true
    redactSecrets: true
    anonymize: false

  - name: corp-ingestor
    endpoint: https://api.observer.acme.com/api/ingest   # https → http shipper
    apiKeyKeychain: observer.corp                        # see § 5.9
    disclosure: moderate
    schedule: hourly
    useLocalTime: false
    redactSecrets: true
    anonymize: true
    orgs:
      include: [acme-corp]
    projects:
      exclude: [/Users/me/personal]

git:
  enabled: true
  onlySelf: true
  repos: {}

privacy:
  excludeProjects: []     # global hard floor — never reaches any destination

pollIntervalMs: 300000    # daemon poll cadence (each destination's schedule
                          # decides whether THIS tick flushes)
```

**Endpoint kind is inferred** from the value: `http://` / `https://` →
HTTP shipper; anything else (absolute path, `~/...`, `./...`,
`file://...`) → disk shipper. Discriminated union at the type level so
HTTP-only fields like `apiKeyKeychain` can't be set on disk
destinations.

**Auto-migration of legacy `ship:` blocks** happens at parse time, in
memory only — the file on disk is never rewritten. A pre-existing
`ship: { endpoint, localOutputDir, disclosure, ... }` translates to one
or two destinations carrying the legacy shared values. Setting BOTH
`ship:` and `destinations:` is an authoring error and fails at load.

**Per-destination scope filters** apply on top of the global
`privacy.excludeProjects` floor. A path listed in `privacy` cannot be
re-included by a destination's `projects.include`.

### 5.9 Secret storage

API keys and the Ed25519 private key live in OS-native keychains by
default; file/env paths remain available as fallbacks.

**Backends** (auto-detected at daemon start):

| OS | Backend | Mechanism |
|----|---------|-----------|
| macOS | macOS Keychain (`/usr/bin/security`) | login keychain; on Apple Silicon the keychain master key is Secure-Enclave-protected |
| Linux | libsecret (`secret-tool`) | gnome-keyring / kwallet bridge; falls back to file/env if libsecret-tools isn't installed |
| Other | NoOp | `get` returns null (callers fall through to env/literal); `put` throws so misconfiguration is loud |

Secrets travel over stdin (never argv) so they don't appear in `ps` or
shell history. The `observer keychain set/get/delete` subcommand is
the supported way to populate entries.

**API-key resolution per HTTP destination** (first match wins):

```
apiKeyKeychain → apiKeyEnv (process.env lookup) → apiKey (literal in config)
```

**Ed25519 private key resolution**:

```
keypairKeychain (top-level) → ~/.observer/observer.key (file)
```

The public key always comes from `~/.observer/observer.pub` — it isn't
secret, and the file form keeps fingerprint display + ingestor
registration trivial.

**The init wizard** asks where to store the key on first run. Choices:
keychain (default when available), environment variable, literal,
Ed25519-only. Picking `keychain` populates the entry and writes only
the service name to `config.yaml` — the secret value never touches the
file.

**Hardware-bound keys (Phase 3, design only)**: Apple's Secure Enclave
supports P-256 ECDSA but not Ed25519. A future native helper using
`Security.framework` with `kSecAttrTokenIDSecureEnclave` would generate
a P-256 key inside the Enclave (non-exportable; signing happens via
SecKey API). Out of scope for this version — current keychain-stored
Ed25519 is encrypted at rest, which is meaningfully better than the
file form for solo-dev threat models.

### 5.10 Enterprise / MDM (Phase 2, design only)

Two-layer config for org-managed deployments:

| Layer | Path (macOS / Linux) | Owner | Writeable by user? |
|-------|----------------------|-------|--------------------|
| Managed | `/Library/Application Support/Observer/config.yaml` / `/etc/observer/config.yaml` | IT (root, 0644) | No |
| User | `~/.observer/config.yaml` | Developer | Yes (only on whitelisted fields) |

A managed config declares which fields the user can override:

```yaml
managed:
  policy: deny-by-default        # or allow-by-default
  userOverridable:
    - sources.*
    - pollIntervalMs
    - dashboard.port
    - destinations.local-dashboard.endpoint
```

Anything else (corp endpoint, API key, disclosure, redact,
`orgs.include`) is fixed by IT. `observer config show --provenance`
annotates each line with where it came from. The `.pkg` installer
drops the managed config + sets perms; a `.mobileconfig` profile
delivers the secrets via system keychain. Reuses the same
`SecureStore` interface as Phase 1 — only the keychain *scope* changes
(system vs user).

Not yet implemented; documented as the enterprise target.

---

## 6. Local dashboard

The default mode for individual developers. Run:

```bash
observer dashboard            # foreground; opens browser
observer dashboard --no-browser
observer dashboard start      # install as background service
observer dashboard stop
```

The dashboard binds to `127.0.0.1:3457` by default. Use
`--bind 0.0.0.0` to expose on the LAN (no auth — be aware of who's on
the network). The data dir is `~/.observer/traces/normalized` unless
`OBSERVER_DATA_DIR` overrides.

The static export is embedded in the binary; on first run, the binary
extracts the tarball to a cache dir (versioned by content hash) and
serves from there. No internet access is required to use the
dashboard.

**Pages:**

- `/` — Overview. Stats, activity timeline, project × time heatmap,
  tools/models/projects/sessions tables, git stats.
- `/stumbles` — repeated-loop leaderboard.
- `/dark-spend` — tokens-per-LoC ranking (LoC > 0).
- `/zero-code` — zero-LoC sessions ranked by tokens.
- `/session?id=X` — drill-in: tool history, token series, sparkline,
  linked commits, sibling sessions.
- `/commit?sha=X` — drill-in: file diff stats, sibling commits in the
  same session.
- `/tool?name=X`, `/model?name=X`, `/project?name=X` — per-entity
  detail.

**Filters** are URL-driven (`days`, `project`, `agent`, `tool`,
`granularity`). The top-nav appbar surfaces project, agent, and tool
selectors on every page that uses them. The tool selector groups MCP
tools and offers an `*mcp` wildcard that matches both `mcp:` and
`mcp__` naming conventions in one shot.

---

## 7. CI/CD

### 7.1 CI (`.github/workflows/ci.yml`)

**Triggers:** push to `master` or PR, when `packages/**` or
`.github/workflows/ci.yml` changes.

**Jobs (parallel):**

| Job | What it runs |
|-----|--------------|
| `agent-tests` | typecheck + tests for `packages/agent/` |
| `dashboard-build` | typecheck + lint + `bun run build` (next + bundle-static) for `packages/dashboard/` |
| `compile-smoke` | `bun build --compile` for `linux-x64`; smoke-runs the binary |
| `dashboard-e2e` | seeds fixture, runs Playwright suite |
| `api-tests` | typecheck + tests for `packages/api/` |

**Runtime:** Ubuntu, Bun 1.2.21.

### 7.2 Release (`.github/workflows/release.yml`)

**Triggers:** push tag `v*` or manual `workflow_dispatch`.

OS-independent gates run first (lint, typecheck, agent/api/dashboard
tests, e2e). The build matrix only runs after all gates pass.

**Build matrix:**

| Target | Runner | Bun target |
|--------|--------|------------|
| `darwin-arm64` | `macos-latest` | `bun-darwin-arm64` |
| `linux-x64` | `ubuntu-latest` | `bun-linux-x64` |
| `windows-x64` | `windows-latest` | `bun-windows-x64` |

(macOS Intel `darwin-x64` is disabled — the `macos-13` runner pool is
slow to allocate. Re-enable when Intel usage justifies the wait.)

Each matrix leg:

1. Checkout + install Bun
2. `bun install`
3. `bun run build` in `packages/dashboard/` (produces `dist/out.tar`
   and `dist/build-info.json`)
4. `bun build --compile --target=$TARGET src/cli.ts` in
   `packages/agent/` — produces a self-contained binary with the
   dashboard tarball embedded
5. Smoke-runs `--version` and `dashboard --help`
6. Generates SHA-256 checksum
7. Uploads artifact

The release job (after all builds) downloads artifacts, creates a
GitHub Release `v{VERSION}`, and attaches binaries + checksums.

### 7.3 Install

```bash
curl -fsSL https://observer.dev/install.sh | bash
```

The script:

1. Detects platform (darwin/linux/windows) and architecture
2. Fetches the latest `v*` release tag from the GitHub API
3. Downloads the matching binary from GitHub Releases
4. Verifies SHA-256 checksum
5. Installs to `~/.local/bin/observer`
6. Prints PATH guidance and next steps

`OBSERVER_VERSION` and `OBSERVER_DIR` env vars override.

### 7.4 Build (local)

```bash
# Dashboard static export + tarball (run before agent compile)
cd packages/dashboard && bun run build

# Agent binary (embeds dashboard tarball)
cd ../agent && bun build --compile src/cli.ts --outfile dist/observer
```

Output: ~50–80 MB self-contained binary, Bun runtime embedded, zero
external dependencies. Includes the dashboard.

### 7.5 Update

The agent checks for updates on startup (once per day):

```
GET https://observer.dev/api/latest-version
→ { "version": "0.1.13", "url": "...", "checksum": "sha256:..." }
```

If newer, logs a notice. `observer update` downloads, verifies
checksum, replaces the binary in place, restarts the service.

For enterprise deployments, set `update.enabled: false` and let MDM
manage versions.

---

## 8. API server (ingestor) deployment

The API server is a stateless HTTP service that receives signed batches
from agents, deduplicates them, and writes to a Hive-partitioned
storage layout. It has no database, no caches, and no in-memory state
that survives a restart — every instance is interchangeable.

### 8.1 Service description

| Property | Value |
|----------|-------|
| Process | `bun src/server.ts` (or compiled JS via `dist/server.js`) |
| Default port | `19900` |
| Default data dir | `$HOME/.observer/lakehouse` |
| Endpoints | `GET /health`, `POST /api/ingest` |
| Auth | Bearer API key OR Ed25519 signature (either is sufficient) |
| Body limit | 8 MiB (configurable via `maxBodyBytes`) |
| Persistence | Append-only filesystem; no DB |
| State | None (writes go directly to storage; dedup log is on disk) |
| Scaling | Horizontal — every instance writes to a shared FS / S3 |

### 8.2 Build artifact

Today the ingestor distributes as TypeScript compiled to JavaScript:

```
packages/api/
├── package.json     # bin: { "observer-api": "dist/server.js" }
├── src/
│   ├── server.ts
│   ├── store.ts
│   └── main.ts
└── dist/            # output of `bun run build` (tsc)
```

Run with `bun src/main.ts` in development, or
`bun dist/main.js` after a build. A self-contained
`bun build --compile` binary is planned but not yet shipped — the same
runtime story as the agent will apply when it lands.

For container deployments, the recommended Dockerfile shape is a
two-stage build: build with `oven/bun`, copy `dist/` and
`node_modules` into a `gcr.io/distroless/base` image, expose 19900,
run as non-root.

### 8.3 Configuration

**CLI flags** (also accepted via `main.ts`):

| Flag | Default | Notes |
|------|---------|-------|
| `--port N` | `19900` | TCP port |
| `--data-dir PATH` | `$HOME/.observer/lakehouse` | Storage root. Must be writable. |

**Environment variables:**

| Variable | Required | Behavior |
|----------|----------|----------|
| `OBSERVER_API_KEYS` | yes (in production) | Comma-separated list of accepted Bearer keys. Empty + `NODE_ENV != "development"` → startup fails with a clear error. Dev fallback: hardcoded `key_local_dev` with a prominent warning. |
| `NODE_ENV` | no | `development` enables the dev API key fallback. Anything else (including unset) requires `OBSERVER_API_KEYS`. |

**Config object** (for programmatic embedding):

```typescript
interface IngestorConfig {
  port: number;
  dataDir: string;
  trustedKeys?: Record<string, string>; // fingerprint → PEM public key
  apiKeys?: string[];                   // accepted Bearer keys
  maxBodyBytes?: number;                // default 8 * 1024 * 1024
}
```

`trustedKeys` is the per-machine Ed25519 pubkey registry — see auth
below.

### 8.4 Authentication setup

Two methods. Either is sufficient. Both are off if neither is
configured (don't deploy this way in production).

**Bearer API key:**

- Set `OBSERVER_API_KEYS=key_a,key_b,key_c` at startup.
- Agents send `Authorization: Bearer <key>`.
- Rotation: deploy a new instance with both old and new keys, migrate
  agents, then remove the old keys. There is no key TTL — rotation is
  operator-driven.

**Ed25519 signature:**

- Each agent generates a keypair on first `observer init` (or `observer auth init`).
  Public key in `~/.observer/observer.pub` (SPKI PEM); private in
  `observer.key` (PKCS#8, mode 0600).
- Public-key fingerprint is `SHA-256(PEM)`, hex-encoded.
- Operator pre-registers the fingerprint → PEM mapping in the
  ingestor's `trustedKeys` config. There is **no self-service
  registration endpoint** — registration is manual / out of band
  (e.g., MDM ships the keypair; the operator collects fingerprints
  via a side channel and reloads the ingestor).
- Agents send `X-Observer-Signature` (base64) and
  `X-Observer-Key-Fingerprint` headers. The ingestor looks up the
  fingerprint and verifies the signature against the request body.

For organizations integrating an IdP (Okta / Azure AD / Google), the
recommended pattern is:

1. Use OAuth device flow at install time to authenticate the
   developer (`observer auth login`).
2. The IdP's identity claim is bound to the registered public key
   fingerprint at registration time.
3. The Ed25519 signature on every batch proves the same machine
   signed this exact payload — independent of network TLS, and
   independent of any session token TTL.

JWT-bearing tokens at the request level are *not* part of the current
implementation; sign-with-Ed25519 is the durable identity. See
Section 9.4 for the long-form auth target.

### 8.5 Storage

The ingestor writes to a local filesystem path (`--data-dir`). For
production, mount that path on durable storage:

| Backend | How to mount | Notes |
|---------|--------------|-------|
| **Local disk** | direct | Dev / single-machine deployments only |
| **EBS / GP3** | mount as block device | Single-AZ; not recommended for production |
| **S3 (read+write)** | s3fs, goofys, or rclone mount | Production default. Use a bucket with default encryption + versioning enabled. |
| **EFS / FSx for Lustre** | NFS mount | Multi-AZ; works but more expensive than S3 |

The ingestor performs **append-only** writes plus immutable batch
files. With S3 you get the right semantics: every batch is a new
object key. The `dedup.log` is the only file that's appended to;
filesystem-locking semantics (S3 Express One Zone or local FS with
flock) keep it consistent under concurrent writes — for non-Express
S3, run a single-writer pattern (sticky load balancer or partition
the dev hash space across instances).

**Per-developer IAM:**

```
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::observer-lake/raw/*/dev=${dev_hash}/*"
}
```

This isolates developers at the storage layer — even with a
mis-configured app, dev A cannot overwrite dev B's batches.

**Retention:** there's no built-in deletion. Use S3 Lifecycle
policies (e.g., transition to Glacier after 90 days, expire after 2
years) per-partition.

**GDPR deletion:** `aws s3 rm --recursive s3://observer-lake/raw/ --exclude "*" --include "**/dev=${hash}/**"`
removes everything for one developer across all dates.

### 8.6 Deployment topologies

Pick one based on scale:

| Topology | Throughput | Setup |
|----------|-----------|-------|
| **Single instance** | < 100 batches / sec | Single VM or container behind a TLS terminator. Suitable for small teams (≤ 50 developers). |
| **Horizontally scaled** | thousands / sec | N stateless containers behind an ALB/NLB. Stick on `dev=` hash to avoid dedup-log contention, OR use a single shared `dedup.log` per partition with FS locking. |
| **Multi-region** | global | One ingestor per region writing to a per-region bucket. Replicate to a central bucket via S3 cross-region replication for analytics. |

**Networking:**

- TLS terminates at the LB (or at the instance for small deployments).
  TLS does NOT replace the Ed25519 signature — the signature is
  end-to-end from the agent and proves the message wasn't modified
  even by an MITM that owns the TLS cert.
- Ingestor itself is HTTP-only; the LB or a sidecar (caddy/envoy)
  handles TLS.
- No outbound traffic from the ingestor — it only writes to its
  storage backend.

### 8.7 Observability

**Health check:** `GET /health` → `{"status": "ok"}` (200, no auth).
Use as the LB health probe.

**Logs:** stdout/stderr, JSON-structured. Each request logs
`{timestamp, method, path, status, durationMs, batchId, devHashPrefix, agent}`.

**Metrics (recommended):** Prometheus-compatible exporter at the
sidecar level. The metrics that matter:

- `observer_ingest_batches_total{status}` — `ok`, `duplicate`, `4xx`, `5xx`
- `observer_ingest_entries_total{agent}` — entry count per agent
- `observer_ingest_bytes_total` — body bytes accepted
- `observer_ingest_duration_seconds` — request latency histogram
- `observer_storage_write_errors_total` — backend write failures

**Alerts:**

- 5xx rate > 1% over 5 min → page
- Storage write errors > 0 over 5 min → page
- Health-check failures → restart by orchestrator

### 8.8 Capacity planning

Per-batch budget:

- Average batch size after compression: 50–500 KB
- Default body cap: 8 MiB (rejects egregiously large batches)
- A single instance handles ~100 batches/sec on modest hardware
  (2 vCPU, 4 GB RAM)

Per-developer budget (planning):

- Active developer ships ~5–20 MB / day at `moderate` disclosure
- ~50–200 MB / day at `sensitive`
- Plan ~100 MB / day / developer for storage growth budgeting

**Scaling triggers:**

- p99 ingest latency > 500 ms → add instances
- p99 storage write latency > 200 ms → check S3 IAM / network
- Body cap hits → investigate (likely an agent shipping unredacted content)

### 8.9 Upgrade procedure

Stateless service, no schema migrations. Standard rolling restart:

1. Deploy new image / binary to one instance
2. Health-check passes
3. LB drains old instance, replaces with new
4. Repeat across the fleet
5. Verify error rates stay flat

Compatibility guarantees:

- The ingest endpoint is versioned by URL path (`/api/ingest`). New
  shapes ship at new paths.
- Old agent versions continue to work indefinitely against new
  ingestors (the request body is JSON and the schema is
  forward-compatible — new fields are added, never required).
- New agent versions degrade gracefully if a field they want is
  rejected (the ingestor returns 400; the agent retries with the
  field stripped).

### 8.10 Disaster recovery

- Storage is the source of truth. A wiped ingestor instance loses no
  data because the only state is on disk / S3.
- S3 versioning + cross-region replication is the recommended primary
  DR strategy.
- Backup test: monthly, restore one developer's partition to a
  scratch bucket and verify the dashboard's local pipeline can ingest
  it (the same parser + DB build that the local dashboard uses works
  on lakehouse data).

---

## 9. Security considerations

### 9.1 Threat model

Observer processes the most sensitive data a developer produces:
prompts containing business logic, tool outputs containing query
results and file contents, reasoning traces revealing decision
processes, and credentials that appear in agent context.

**Attacker goals:** exfiltrate secrets, impersonate developers,
tamper with shipped data, access traces from other developers.

### 9.2 Secret redaction

Three-layer defense before data leaves the machine:

| Layer | What it catches | Mechanism |
|-------|-----------------|-----------|
| **Regex patterns** | AWS keys, DB URLs with passwords, GitHub tokens, JWTs, generic API keys, OpenAI keys, etc. | 11 compiled regex patterns in `security/scanner.ts` |
| **Entry-type filtering** | Secrets in reasoning tokens, context compaction | Exclude entry types that frequently contain reflected secrets |
| **Project exclusions** | Repos with legitimate key material | `privacy.excludeProjects` paths skipped entirely |

**Validated coverage:** ~99% true positive, ~5% false positive on
236K lines of real agent traces. Detection counts and patterns are
reported as part of the redaction record (the pattern *name* leaves;
the *secret* never does).

### 9.3 Disclosure policy enforcement

Disclosure is enforced at serialization time on the agent, before the
HTTP request is constructed. The ingestor never sees fields above the
configured tier — this is **client-side enforcement**, the server
cannot request higher disclosure than the client allows.

HIGH_RISK fields **never travel over the network** regardless of
disclosure level. The `full` disclosure level is only legal for the
local disk shipper writing into `~/.observer/traces/normalized/`.

### 9.4 Authentication target

**Currently implemented:**

| Method | What it proves | Header / source |
|--------|----------------|-----------------|
| API key | Caller possesses a shared secret | `Authorization: Bearer key_xyz`. Resolved per destination via keychain → env → literal (§ 5.9). |
| Ed25519 signature | This specific machine signed this exact payload | `X-Observer-Signature` + `X-Observer-Key-Fingerprint`. Private key from keychain when configured (`keypairKeychain`), else `~/.observer/observer.key`. |

**Target (enterprise, planned):**

| Layer | Purpose | Mechanism |
|-------|---------|-----------|
| OAuth 2.0 device flow | User identity via corporate IdP | `observer auth login` → browser SSO → JWT (1h TTL, auto-refreshed) |
| Ed25519 signature | Machine identity + payload integrity | Local keypair, registered on first OAuth auth |
| JWKS validation | Stateless JWT verification in ingestor | IdP's `/.well-known/jwks.json` |
| Device registration | Known-device enforcement | `POST /api/devices/register` (public key + fingerprint, IdP-authenticated) |

Developer identity comes from the JWT (verified by IdP), not from the
self-reported batch body. This prevents impersonation. Until the OAuth
layer ships, operators bind identity to the registered Ed25519
fingerprint manually.

### 9.5 Transport security

All HTTP communication to the ingestor uses TLS. The Ed25519
signature provides end-to-end integrity verification independent of
TLS — a hostile load-balancer cannot forge a valid signature.

### 9.6 Storage isolation

- Lakehouse partitioned by `dev=SHA256(email)` — developers cannot
  read or overwrite each other's partitions.
- In S3 deployments, per-developer IAM policies restrict write access
  to `raw/**/dev={hash}/**`.
- GDPR deletion: `rm -rf raw/**/dev={hash}/` removes all data for one
  developer across all time partitions.

### 9.7 Local security

- `~/.observer/observer.key`: file mode `0600`.
- `~/.observer/auth.json`: file mode `0600`.
- Agent trace files are read-only — Observer never modifies source
  traces.
- The daemon and dashboard run as the current user, no elevated
  privileges.
- The dashboard binds to `127.0.0.1` by default. `--bind 0.0.0.0`
  exposes on the LAN with no auth — explicit opt-in only.
- The daemon has no network listeners (HTTP client only).

### 9.8 Scope filtering

The default shipping scope is **empty** — nothing is shipped until
`include_orgs` is configured. Traces from repositories outside
whitelisted GitHub organizations are silently skipped.

The repo-resolver extracts the GitHub organization from the git
remote URL of the project associated with each trace file. Projects
without a git remote fall back to path-based matching
(`include_paths`). `exclude_orgs` overrides all includes as a safety
net.

---

## Appendix A: CLI reference

```
observer                       Default — opens the dashboard (or runs init wizard if first run)
observer init                  Interactive setup wizard
observer scan                  One-shot scan + ship
observer scan --dry-run        Discover and count without shipping
observer scan --disclosure X   Override disclosure level (basic|moderate|sensitive|full)
observer scan --no-git         Skip git event collection
observer scan --local-output   Write normalized traces to a local dir (for debugging)
observer status                Show agent sources, shipper state, daemon health
observer daemon                Foreground daemon (for service managers)
observer start                 Install and start daemon as a background service
observer stop                  Stop and uninstall the daemon service
observer dashboard             Run the dashboard in foreground (default subcommand: run)
observer dashboard run         Same as above; flags: --port, --bind, --no-browser, --log-level
observer dashboard start       Install dashboard as a background service
observer dashboard stop        Stop and uninstall the dashboard service
observer logs                  Tail recent daemon logs
observer cursor-usage          Fetch real Cursor token usage from Cursor's API
observer keychain set <svc>    Store a secret in the OS keychain (reads stdin; refuses TTY input)
observer keychain get <svc>    Print a stored secret to stdout
observer keychain delete <svc> Remove a stored secret
observer update                Download and install the latest version
observer uninstall             Stop services, remove ~/.observer/, delete the binary
```

## Appendix B: Supported agents

| Agent | Trace location | Format | Parser |
|-------|----------------|--------|--------|
| Claude Code | `~/.claude/projects/{path}/` | JSONL | `parsers/claude.ts` |
| Codex (OpenAI) | `~/.codex/sessions/YYYY/MM/DD/` | JSONL | `parsers/codex.ts` |
| Cursor | `~/.cursor/` (macOS: `~/Library/Application Support/Cursor`) | SQLite `.vscdb` + sidecar API token usage | `parsers/cursor.ts` |

## Appendix C: Secret scanner patterns

| Pattern | Example | Severity |
|---------|---------|----------|
| AWS Access Key | `AKIA...` (20 chars) | HIGH |
| AWS Secret Key | 40-char base64 after `aws_secret` | HIGH |
| Database URL | `postgres://user:pass@host/db` | HIGH |
| GitHub Token | `ghp_*`, `ghs_*`, `github_pat_*` | HIGH |
| Generic API Key | `key=`, `api_key=`, `apikey=` patterns | MEDIUM |
| JWT | `eyJ...` (3 base64 segments) | MEDIUM |
| OpenAI Key | `sk-...` (48+ chars) | MEDIUM |
| UUID API Key | UUID after `key`/`token` context | MEDIUM |
| Base64 Long Secret | 40+ char base64 in sensitive context | LOW |

## Appendix D: Ingest API reference

### `GET /health`

No auth. Returns `{"status": "ok"}` with HTTP 200. Use as the LB
health probe.

### `POST /api/ingest`

Auth: Bearer key OR Ed25519 signature. Either is sufficient if both
are configured; both are required to be present per-request only if
the operator chose a stricter posture.

**Headers:**

```
Authorization: Bearer <key>                          # API key path
X-Observer-Signature: <base64>                       # Ed25519 path
X-Observer-Key-Fingerprint: <sha256-hex>             # Ed25519 path
Content-Type: application/json
```

**Body** (JSON, ≤ 8 MiB):

```json
{
  "batchId": "optional; auto-generated if absent",
  "developer": "hashed developer id",
  "machine": "hostname",
  "agent": "claude_code | codex | cursor",
  "project": "owner/repo or path",
  "sourceFile": "absolute path of trace file at the source",
  "shippedAt": "ISO-8601 timestamp",
  "entries": ["<json string>", "<json string>", ...]
}
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{"status":"ok","entryCount":N}` | New batch accepted |
| 200 | `{"status":"ok","duplicate":true,"entryCount":0}` | Already seen — agent can advance its cursor safely |
| 400 | `{"error":"..."}` | Malformed body |
| 401 | `{"error":"unauthorized"}` | No valid auth |
| 413 | `{"error":"body too large"}` | > `maxBodyBytes` |
| 5xx | `{"error":"..."}` | Storage / signature verification failure |

**Idempotency:** the agent computes `batchId =
SHA-256(sourceFile + offset + size)` deterministically. Re-shipping
the same window produces the same batchId, and the ingestor returns a
duplicate response. This is what lets the agent retry safely without
re-counting entries on the analytics side.
