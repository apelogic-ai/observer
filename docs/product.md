# Observer: Product Description

**Version:** 0.1.0
**Date:** 2026-04-13

---

## 1. What is Observer

Observer is a standalone daemon that collects, redacts, and ships structured
traces from AI coding agents (Claude Code, Codex, Cursor) to a centralized
lakehouse. It enables organizations to gain visibility into how AI tools are
used across their engineering teams — cost, adoption, security posture,
knowledge patterns, and developer experience — without exposing sensitive
content.

Observer runs on every developer's machine, watches agent trace directories,
applies three layers of secret filtering, enforces per-field disclosure
policies, and ships redacted data to an HTTP ingestor. The ingestor stores
batches in an immutable, Hive-partitioned lakehouse ready for downstream
analytics, security scanning, knowledge mining, and DX diagnostics.

Observer is a **standalone product** — it has its own binary, install flow,
and identity. It is a standalone product with no external dependencies.

---

## 2. Design Goals

1. **Organizational AI observability.** Answer: "How much are we spending
   on AI? Is it worth it? Who's using it? Are we exposed?"

2. **Zero-trust data pipeline.** Secrets never leave the machine. Content
   exposure is controlled by a progressive disclosure slider (basic →
   moderate → sensitive). HIGH_RISK data (query results, file contents)
   is always stripped.

3. **Cross-agent unification.** Claude Code, Codex, and Cursor emit
   different formats (JSONL, SQLite). Observer normalizes all three into a
   unified `TraceEntry` schema so downstream consumers don't care which
   agent produced the data.

4. **Idempotent, fault-tolerant shipping.** Cursor-based tracking ensures
   entries are shipped exactly once. Deterministic batch IDs enable safe
   retries. The ingestor deduplicates at the API level.

5. **Opt-in by default.** Nothing watches, nothing ships, until the
   developer explicitly configures it. Each agent source is individually
   enabled. Only traces from whitelisted GitHub organizations are shipped.

6. **Enterprise-grade auth.** Dual-layer authentication: OAuth 2.0 device
   flow (user identity via corporate IdP) + Ed25519 signatures (machine
   identity + payload integrity).

7. **Single binary, zero dependencies.** Compiled with `bun build --compile`
   into a self-contained ~50-80 MB executable. No runtime required.

---

## 3. Design Principles

**Privacy as architecture, not policy.** Disclosure levels are enforced
by the type system — every field in every agent's trace format is classified
into one of four sensitivity tiers (SAFE, MODERATE, SENSITIVE, HIGH_RISK).
The shipper strips fields based on the configured tier before serialization.
There is no "trust the server" path.

**Deterministic over agentic.** Secret scanning, field classification,
retry detection, and correction extraction are all regex/pattern-based.
No LLM is needed for the core pipeline. This makes the system fast,
reproducible, auditable, and free of inference costs.

**Immutable storage.** Every batch is write-once. Dedup logs are
append-only. No file is ever updated in place. This eliminates corruption
from concurrent writes and simplifies GDPR deletion (remove the partition).

**Developer as partition key.** Storage is partitioned by hashed developer
ID. This enables per-developer S3 IAM policies, GDPR deletion via
`rm -rf dev=HASH/`, and write isolation between developers.

**Ship date, not entry date.** Batches are partitioned by the date they
were shipped, not the dates of individual entries. This keeps writes
atomic (no splitting a session across partitions). The downstream Parquet
normalization job re-partitions by entry timestamp for accurate queries.

**Graceful degradation.** Auth methods are alternatives — either API key
OR Ed25519 is sufficient. If the OAuth IdP is down, Ed25519 still works.
If a parser encounters unknown entry types, they are skipped (not errored).

---

## 4. Architecture

```
Developer Machine                          Centralized Infrastructure
─────────────────                          ────────────────────────────

Agent trace dirs                           Ingestor (HTTP, stateless)
  ~/.claude/projects/                        POST /api/ingest
  ~/.codex/sessions/                           │
  ~/.cursor/ (SQLite)                          │ authenticate
        │                                      │ deduplicate
        ▼                                      │ store
  ┌───────────────────┐                        ▼
  │  observer daemon     │                  ┌──────────────────┐
  │                   │    HTTP POST     │  Lakehouse (S3)  │
  │  discover         │ ──────────────►  │                  │
  │  parse            │  + Auth header   │  Raw zone        │
  │  classify fields  │  + Ed25519 sig   │  (JSONL, Hive)   │
  │  scan secrets     │                  │                  │
  │  enforce disclosure                  │  Normalized zone │
  │  ship (idempotent)│                  │  (Parquet)       │
  └───────────────────┘                  └────────┬─────────┘
                                                  │
                                    ┌─────────────┼─────────────┐
                                    ▼             ▼             ▼
                              Knowledge      Analytics     Security
                              extractor      engine        scanner
                                │             │             │
                                ▼             ▼             ▼
                           Corp vault     Dashboards     Alerts
                            (git)        (Grafana)      (Slack)
```

### Data flow

1. **Discover** — scan `~/.claude/`, `~/.codex/`, `~/.cursor/` for trace files
2. **Parse** — per-agent parsers convert raw formats into `TraceEntry[]`
3. **Classify** — each field is tagged with its sensitivity tier
4. **Scan** — deterministic regex scanner finds secrets, replaces with `[REDACTED:pattern]`
5. **Filter** — disclosure policy strips fields above the configured tier
6. **Scope** — repo-resolver checks git remote against `include_orgs`; non-matching projects are skipped
7. **Ship** — HTTP POST to ingestor with auth headers; cursor advances only on 200 OK
8. **Store** — ingestor deduplicates by batch ID, writes to Hive-partitioned raw zone

---

## 5. Components

### 5.1 Observer Agent (`packages/agent/`)

The local daemon. TypeScript on Bun runtime. Compiles to a standalone binary.

| Module | File | Purpose |
|--------|------|---------|
| **CLI** | `src/cli.ts` | Commands: `init`, `scan`, `status`, `watch`, `ship`, `daemon`, `start`, `stop`, `logs`, `auth`, `skills`, `config`, `uninstall` |
| **Daemon** | `src/daemon.ts` | Continuous poll loop: discover → parse → scan → ship. Configurable interval (default 5 min). |
| **Discovery** | `src/discover.ts` | Scans standard agent directories. Returns list of trace file paths grouped by agent type. |
| **Parsers** | `src/parsers/claude.ts` | Claude Code JSONL → `TraceEntry[]`. Handles message, tool_use, tool_result, thinking entries. |
| | `src/parsers/codex.ts` | Codex JSONL → `TraceEntry[]`. Maps function_call/function_call_output, task_complete summaries. |
| | `src/parsers/cursor.ts` | Cursor SQLite `.vscdb` → `TraceEntry[]`. Reads `cursorDiskKV` table (composerData + bubbleId keys). |
| **Type system** | `src/types.ts` | `TraceEntry` — unified schema with per-field sensitivity classification. Per-vendor raw entry types. |
| **Secret scanner** | `src/security/scanner.ts` | 11 regex patterns (AWS AKIA, DB URLs, GitHub tokens, JWTs, etc.). Three-layer filtering: regex + entry-type + project exclusions. ~99% true positive, ~5% false positive on 236K real lines. |
| **Shipper** | `src/shipper.ts` | Cursor-based idempotent shipping. Tracks byte offset per file in `shipper-cursors.json`. Deterministic batch ID = SHA-256(file + offset + size). Only advances cursor on successful delivery. |
| **HTTP shipper** | `src/http-shipper.ts` | POSTs batches to ingestor. Attaches `Authorization` (Bearer key) and/or `X-Observer-Signature` + `X-Observer-Key-Fingerprint` (Ed25519). |
| **Identity** | `src/identity.ts` | Ed25519 keypair generation, signing, verification, fingerprinting. Keys stored at `~/.observer/observer.key`. |
| **Repo resolver** | `src/repo-resolver.ts` | Maps trace file paths to git repos. Extracts org/repo from remote URL for scope filtering. |
| **Config** | `src/config.ts` | YAML config loader (`~/.observer/config.yaml`). Merges defaults with user overrides. |
| **Init wizard** | `src/init.ts` | Interactive setup: detect agents, configure identity, set org scope, generate keypair, install service. |
| **Service** | `src/service.ts` | Platform-native service management: launchd (macOS), systemd (Linux). Install, start, stop, uninstall. |

**Dependencies:** `better-sqlite3` (Cursor parsing), `commander` (CLI), `yaml` (config).

**Test suite:** ~25 tests covering parsers, shipper idempotency, security scanner, config, identity, repo-resolver, discovery, CLI, daemon, and service management.

### 5.2 Observer API (`packages/api/`)

Stateless HTTP server. Receives trace batches, authenticates, deduplicates, stores.

| Module | File | Purpose |
|--------|------|---------|
| **Server** | `src/server.ts` | HTTP endpoints: `GET /health`, `POST /api/ingest`. Dual auth (API key OR Ed25519). Batch-level dedup. |
| **Store** | `src/store.ts` | Immutable batch persistence. Hive-style partitioning: `raw/year=YYYY/month=MM/day=DD/agent=X/dev=HASH/{batchId}.jsonl`. Append-only dedup log. Per-developer isolation. |
| **Main** | `src/main.ts` | Server startup. CLI flags: `--port`, `--data-dir`. |

**Dependencies:** None (pure Bun/Node HTTP + filesystem).

**Test suite:** ~5 tests covering E2E flow (agent → HTTP → store), signature verification, dedup.

### 5.3 Storage Layout

```
~/.observer/                          # Agent state (local)
├── config.yaml                    # User configuration
├── config.local.yaml              # Local overrides (IT-managed deployments)
├── observer.key                      # Ed25519 private key
├── observer.pub                      # Ed25519 public key
├── shipper-cursors.json           # Per-file shipping progress
├── observer.log                      # Activity log
└── auth.json                      # OAuth tokens (enterprise)

{lakehouse}/                       # Ingestor storage (S3 in production)
└── raw/
    └── year=2026/
        └── month=04/
            └── day=08/
                └── agent=claude_code/
                    └── dev=a1b2c3d4/          # SHA-256 prefix of developer email
                        ├── {batchId}.jsonl    # Immutable, write-once
                        └── {batchId}.meta.json # Batch metadata
```

### 5.4 Disclosure Policy

Every field in agent traces is classified into one of four sensitivity tiers:

| Tier | Contains | Examples |
|------|----------|---------|
| **SAFE** | Metadata only | Timestamps, model name, token counts, session ID, role, stop reason |
| **MODERATE** | Behavioral data | Tool names, file paths, commands, git metadata, task summaries |
| **SENSITIVE** | Content | User prompts, assistant responses, thinking/reasoning traces |
| **HIGH_RISK** | Raw data | Tool results (stdout, file contents, query data rows, diffs) |

The developer (or IT policy) selects a disclosure level:

| Level | Ships | Strips | Use case |
|-------|-------|--------|----------|
| `basic` (default) | SAFE only | Everything else | Cost + adoption analytics, zero content risk |
| `moderate` | SAFE + MODERATE | SENSITIVE + HIGH_RISK | Behavioral analytics, DX diagnostics |
| `sensitive` | SAFE + MODERATE + SENSITIVE | HIGH_RISK only | Full knowledge mining (with consent) |

HIGH_RISK data **never ships** regardless of disclosure level.

**Anonymous mode** (`anonymize: true`): replaces developer identity with
a deterministic one-way hash. Cross-correlation still works; de-anonymization
requires a separate mapping held by the org.

### 5.5 Downstream Pipelines (Planned)

| Pipeline | Input | Output | Schedule |
|----------|-------|--------|----------|
| **Knowledge extractor** | Normalized Parquet | Proposed org-level artifacts → curator → corp vault (git) | Daily |
| **Analytics engine** | Normalized Parquet | Dashboards: tool usage, token costs, adoption curves, sessions/dev | Hourly |
| **Security scanner** | Normalized Parquet | Alerts: secrets that survived local redaction, policy violations | On ingest |
| **DX diagnostics** | Normalized Parquet | Reports: doc gaps, broken DX, flaky tests, onboarding friction | Weekly |

---

## 6. CI/CD Pipeline

### 6.1 Continuous Integration (`.github/workflows/ci.yml`)

**Triggers:** Push to `main` or PR, when `packages/**` changes.

**Jobs (parallel):**

| Job | What it does | Timeout |
|-----|-------------|---------|
| `agent-tests` | `bun install` → `tsc --noEmit` → `vitest run` | 10 min |
| `ingestor-tests` | `bun install` → `tsc --noEmit` → `vitest run` | 10 min |
| `skills-tests` | `bun install` → `tsc --noEmit` → `vitest run` | 5 min |

**Runtime:** Ubuntu latest, Bun (latest).

### 6.2 Release (`.github/workflows/release.yml`)

**Triggers:** Push tag `observer-v*` or manual `workflow_dispatch` with version input.

**Build job** — matrix strategy, runs in parallel:

| Target | Runner | Bun target |
|--------|--------|------------|
| `darwin-arm64` | `macos-latest` | `bun-darwin-arm64` |
| `darwin-x64` | `macos-13` | `bun-darwin-x64` |
| `linux-x64` | `ubuntu-latest` | `bun-linux-x64` |

Each matrix leg:
1. Checkout + install Bun
2. `bun install` (agent dependencies)
3. `bun run test` (gate — tests must pass)
4. `bun build --compile --target=$TARGET src/cli.ts --outfile observer-$TARGET`
5. Verify binary runs (`./observer-$TARGET --version`)
6. Generate SHA-256 checksum
7. Upload artifact

**Release job** (after all builds pass):
1. Download all build artifacts
2. Create GitHub Release (`observer-v{VERSION}`)
3. Attach binaries + checksums as release assets

### 6.3 Build

```bash
# Local build (current platform)
cd packages/agent
bun install
bun build --compile src/cli.ts --outfile dist/observer

# Cross-compile (CI)
bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile observer-darwin-arm64
bun build --compile --target=bun-linux-x64 src/cli.ts --outfile observer-linux-x64
```

Output: single binary, ~50-80 MB, Bun runtime embedded, zero external dependencies.

### 6.4 Ship

**Install script** (`install.sh`):

```bash
curl -fsSL https://observer.dev/install.sh | bash
```

The script:
1. Detects platform (darwin/linux) and architecture (arm64/x64)
2. Fetches latest `observer-v*` release tag from GitHub API
3. Downloads the correct binary from GitHub Releases
4. Verifies SHA-256 checksum
5. Installs to `~/.local/bin/observer`
6. Prints PATH guidance and next steps

Supports `OBSERVER_VERSION` and `OBSERVER_DIR` environment variables for pinning.

### 6.5 Deploy (Ingestor)

The ingestor is a stateless HTTP server. Deployment is standard for any
stateless service:

- **Development:** `bun src/server.ts --port 19900 --data-dir ~/.observer/lakehouse`
- **Production:** Container or VM running the ingestor binary with S3-backed storage
- **Configuration:** `--port`, `--data-dir` (local filesystem or S3 mount)
- **Health check:** `GET /health`
- **Scaling:** Horizontally scalable (stateless, S3 storage). Each instance
  writes to a different partition prefix.

### 6.6 Update

The observer daemon checks for updates on startup (once per day):

```
GET https://observer.dev/api/latest-version
→ { "version": "0.2.0", "url": "...", "checksum": "sha256:..." }
```

If newer, logs a notice. `observer update` downloads, verifies checksum,
replaces the binary in place. Service manager restarts automatically.

**Enterprise:** MDM-managed deployments can pin versions and push updates
through the existing MDM pipeline instead of self-update.

### 6.7 Enterprise Fork Model

Organizations that need full control over the build, signing, distribution,
and update pipeline can fork the open-source repository and run their own
CI/CD. This is the recommended path for enterprises with existing MDM
infrastructure (Jamf, Intune, Munki, SCCM) or strict compliance
requirements around software provenance.

#### Why fork

| Concern | How the fork addresses it |
|---------|--------------------------|
| **Binary provenance** | Builds run on org-controlled runners; no trust in upstream release artifacts |
| **Code audit** | Security team reviews changes before merging upstream into the fork |
| **Custom patches** | Org can add internal parsers, custom disclosure tiers, or hardcoded ingestor endpoints |
| **Signing** | Binaries are code-signed with the org's Apple Developer ID / GPG key, required by MDM |
| **Distribution** | Artifacts publish to internal artifact registry (Artifactory, S3, pkg repo), not GitHub Releases |
| **Update cadence** | Org controls when upstream changes are adopted — no surprise updates on developer machines |
| **Compliance** | Audit trail from source commit → build → signed artifact → MDM deployment → device |

#### Repository setup

```
github.com/observer-oss/observer             (upstream, public)
        │
        │  git remote add upstream
        ▼
github.com/acme-corp/observer             (fork, private)
        │
        ├── .github/workflows/          (org CI/CD, replaces upstream workflows)
        ├── config/                     (org defaults: ingestor URL, include_orgs, disclosure)
        └── patches/                    (org-specific changes, if any)
```

The fork tracks upstream as a remote. An automated PR (or Renovate/Dependabot
job) proposes upstream merges on a schedule (e.g., weekly). The security
team reviews the diff before merging into the fork's `main`.

#### CI/CD pipeline (org-controlled)

The fork replaces the upstream GitHub Actions workflows with org-specific
pipelines. The build steps are identical — only the triggers, artifact
destination, and signing steps change.

**Build stage:**

```yaml
# Example: org pipeline (GitHub Actions, GitLab CI, Jenkins — any runner)
steps:
  - checkout
  - setup bun
  - bun install
  - bun run typecheck
  - bun run test                     # gate: tests must pass
  - bun build --compile --target=$TARGET src/cli.ts --outfile observer-$TARGET
  - ./observer-$TARGET --version        # smoke test
  - sha256sum observer-$TARGET > observer-$TARGET.sha256
```

**Sign stage:**

| Platform | Signing tool | What it produces |
|----------|-------------|-----------------|
| macOS | `codesign` + Apple Developer ID | Signed binary, passes Gatekeeper |
| macOS | `pkgbuild` + `productsign` | Signed `.pkg` installer for MDM |
| Linux | GPG detached signature | `.sig` file for package manager verification |
| Windows | `signtool` + code-signing cert | Signed `.exe`, passes SmartScreen |

```bash
# macOS example
codesign --sign "Developer ID Application: Acme Corp" \
  --options runtime --timestamp observer-darwin-arm64

# Package for MDM
pkgbuild --root ./stage --identifier com.acme.observer \
  --version $VERSION --install-location /usr/local/bin \
  observer-$VERSION.pkg
productsign --sign "Developer ID Installer: Acme Corp" \
  observer-$VERSION.pkg observer-$VERSION-signed.pkg
```

**Publish stage:**

Artifacts are pushed to the org's internal distribution point, not
GitHub Releases:

| Destination | Use case |
|-------------|----------|
| Internal S3 / Artifactory | Generic artifact store; install script points here |
| Jamf Pro (macOS) | `.pkg` uploaded as a package, scoped to engineering policy |
| Intune (Windows) | `.exe` or `.intunewin` uploaded to Win32 app catalog |
| Munki (macOS) | `.pkg` + `pkginfo` in Munki repo |
| APT/YUM repo (Linux) | `.deb`/`.rpm` in internal package repository |

**Config bake-in (optional):**

The org can bake default configuration into the binary at build time
or ship a managed `config.yaml` alongside the binary:

```yaml
# config/managed-defaults.yaml — shipped with the binary via MDM
ship:
  endpoint: https://observer.internal.acme.com/api/ingest
  disclosure: moderate
scope:
  include_orgs: [acme-corp, acme-platform]
privacy:
  excludeProjects: []
```

When `observer init` detects a pre-existing managed config, it skips
org-level questions and only asks developer-specific preferences
(which agents to monitor).

#### MDM deployment flow

```
Org fork (private repo)
    │
    │  CI/CD trigger (tag, merge to main, or manual)
    ▼
Build matrix (macOS arm64/x64, Linux, Windows)
    │
    │  typecheck + test + compile + sign
    ▼
Artifact registry (S3 / Artifactory)
    │
    │  MDM picks up new version
    ▼
MDM (Jamf / Intune / Munki / SCCM)
    │
    │  policy: push to engineering group
    ▼
Developer machines
    │
    │  install: /usr/local/bin/observer + /etc/observer/config.yaml
    │  service: launchd / systemd auto-registered
    ▼
Daemon starts → ships to org ingestor
```

**Version pinning:** MDM policies can enforce a minimum version.
The daemon's self-update mechanism (`observer update`) should be disabled
in managed deployments — set `update.enabled: false` in the managed
config or point `update.endpoint` to the org's internal version API.

**Rollback:** MDM maintains the previous version. If the new version
has issues, the MDM policy reverts to the prior package.

#### Upstream sync strategy

| Strategy | Cadence | Risk | Recommended for |
|----------|---------|------|-----------------|
| **Track upstream main** | Weekly automated PR | Medium — may include breaking changes | Orgs with active security review capacity |
| **Track upstream tags** | On each `observer-v*` release | Low — releases are tested | Most enterprises |
| **Cherry-pick** | As needed | Lowest — manual selection | Highly regulated environments |

Each upstream merge PR goes through the org's standard code review,
with additional scrutiny on:
- Changes to `security/scanner.ts` (redaction patterns)
- Changes to `shipper.ts` or `http-shipper.ts` (data egress)
- New dependencies in `package.json`
- Changes to disclosure tier logic in `types.ts`

#### Ingestor deployment (enterprise)

The ingestor is also built from the fork and deployed to org
infrastructure:

| Deployment model | Details |
|-----------------|---------|
| **Container** | Dockerfile in the fork; image pushed to org container registry; deployed to ECS/EKS/GKE |
| **VM** | Binary deployed via Ansible/Terraform to an EC2/GCE instance |
| **Serverless** | Bun-compatible serverless (e.g., behind API Gateway + Lambda adapter) |

Storage backend: S3 bucket with per-developer IAM write isolation.
The ingestor has no persistent state — horizontal scaling is trivial.

---

## 7. Deployment Configuration

### 7.1 Developer Machine

```yaml
# ~/.observer/config.yaml
developer: jane@acme.com               # identity (from git config)

sources:
  claude_code: true                     # watch ~/.claude/projects/
  codex: true                           # watch ~/.codex/sessions/
  cursor: false                         # opt-in per agent

scope:
  include_orgs:                         # whitelist: only these GitHub orgs
    - acme-corp
    - acme-platform
  exclude_orgs: []                      # blocklist: override includes

ship:
  enabled: true
  endpoint: https://observer.acme.com/api/ingest
  api_key_env: OBSERVER_API_KEY            # or use Ed25519 signing
  schedule: hourly                      # hourly | daily | realtime
  redactSecrets: true
  disclosure: basic                     # basic | moderate | sensitive
  anonymize: false

privacy:
  excludeProjects: []                   # paths to skip entirely

pollIntervalMs: 300000                  # 5 minutes
```

### 7.2 Service Configuration

| Platform | Service manager | Config file | Log |
|----------|----------------|-------------|-----|
| macOS | launchd | `~/Library/LaunchAgents/com.observer.agent.plist` | `~/.observer/observer.log` |
| Linux | systemd (user) | `~/.config/systemd/user/observer.service` | `~/.observer/observer.log` |
| Windows | Task Scheduler | `observer` scheduled task | `~/.observer/observer.log` |

The service runs `observer daemon` which polls, scans, and ships continuously.
`KeepAlive: true` (launchd) / `Restart=on-failure` (systemd) ensures the
daemon recovers from crashes.

### 7.3 Enterprise (MDM)

Pre-deploy `config.yaml` with corporate settings via Jamf/Intune:
- `include_orgs`, `ship.endpoint`, auth configuration are IT-managed (read-only)
- Developer runs `observer init` which detects the pre-existing config and
  only asks for agent-specific preferences
- Local overrides in `~/.observer/config.local.yaml` (non-shipping settings only)

---

## 8. Security Considerations

### 8.1 Threat Model

Observer processes the most sensitive data a developer produces: prompts
containing business logic, tool outputs containing query results and
file contents, reasoning traces revealing decision processes, and
credentials that appear in agent context.

**Attacker goals:** exfiltrate secrets, impersonate developers, tamper
with shipped data, access traces from other developers.

### 8.2 Secret Redaction

Three-layer defense before data leaves the machine:

| Layer | What it catches | Mechanism |
|-------|----------------|-----------|
| **Regex patterns** | AWS keys (`AKIA...`), DB URLs with passwords, GitHub tokens (`ghp_`/`ghs_`), JWTs, generic API keys, OpenAI keys | 11 compiled regex patterns in `security/scanner.ts` |
| **Entry-type filtering** | Secrets in reasoning tokens, context compaction | Exclude entry types that frequently contain reflected secrets |
| **Project exclusions** | Repos with legitimate key material (infra, secrets management) | `privacy.excludeProjects` paths are skipped entirely |

**Validated coverage:** ~99% true positive, ~5% false positive rate on
236,000 lines of real agent traces. 44 high-severity credential exposures
detected across 2 months of single-developer usage.

Redaction replaces matches with `[REDACTED:pattern_name]` — the pattern
name is preserved for security analytics (which types of secrets leak
most frequently).

### 8.3 Disclosure Policy Enforcement

The disclosure policy is enforced at serialization time in the agent,
before the HTTP request is constructed. The ingestor never sees fields
above the configured tier. This is a **client-side enforcement** — the
server cannot request higher disclosure than the client allows.

HIGH_RISK fields (tool results, file contents, stdout, diffs) are **always
stripped** regardless of disclosure level. There is no configuration that
ships raw query results or file contents to the centralized lakehouse.

### 8.4 Authentication

**Current implementation:**

| Method | What it proves | Header |
|--------|---------------|--------|
| API key | Caller possesses a shared secret | `Authorization: Bearer key_xyz` |
| Ed25519 signature | This specific machine signed this exact payload (integrity + machine identity) | `X-Observer-Signature` + `X-Observer-Key-Fingerprint` |

Either method is sufficient. Both are optional (the ingestor can be
configured to require one or both).

**Target (enterprise):**

| Layer | Purpose | Mechanism |
|-------|---------|-----------|
| OAuth 2.0 device flow | User identity via corporate IdP (Okta, Azure AD, Google) | `observer auth login` → browser SSO → JWT (1h TTL, auto-refresh) |
| Ed25519 signature | Machine identity + payload integrity | Local keypair, registered on first OAuth auth |
| JWKS validation | Stateless JWT verification in ingestor | IdP's `/.well-known/jwks.json` |
| Device registration | Known-device enforcement | `POST /api/devices/register` (public key + fingerprint) |

Developer identity comes from the JWT (verified by IdP), not from the
self-reported batch body. This prevents impersonation.

**Token lifecycle:**
- Access token: 1h TTL, auto-refreshed
- Refresh token: 30 days, rotated on use
- Ed25519 keypair: permanent per installation
- Revocation: IdP deprovisions user → refresh token invalid → next ship fails

### 8.5 Transport Security

All HTTP communication to the ingestor uses TLS. The Ed25519 signature
over the request body provides end-to-end integrity verification
independent of TLS.

### 8.6 Storage Isolation

- Lakehouse partitioned by `dev=SHA256(email)` — developers cannot read
  or overwrite each other's partitions
- In S3 deployments, per-developer IAM policies can restrict write access
  to `raw/**/dev={hash}/**`
- GDPR data deletion: `rm -rf raw/**/dev={hash}/` removes all data for
  a developer across all time partitions

### 8.7 Local Security

- `~/.observer/observer.key` (Ed25519 private key): file permissions 0600
- `~/.observer/auth.json` (OAuth tokens): file permissions 0600
- Agent trace files are read-only — Observer never modifies source traces
- The daemon runs as the current user, with no elevated privileges
- No network listeners on the developer machine (the agent is an HTTP
  client only, not a server)

### 8.8 Scope Filtering

The default shipping scope is **empty** — nothing is shipped until
`include_orgs` is configured. Traces from repositories outside
whitelisted GitHub organizations are silently skipped. This prevents
personal project traces from accidentally reaching the corporate lakehouse.

The repo-resolver extracts the GitHub organization from the git remote
URL of the project associated with each trace file. Projects with no
git remote fall back to path-based matching (`include_paths`).
`exclude_orgs` overrides all includes as a safety net.

---

## Appendix A: CLI Reference

```
observer init              Interactive setup wizard
observer scan              One-shot scan + ship
observer scan --dry-run    Discover and count without shipping
observer daemon            Foreground daemon (for service managers)
observer start             Install and start background service
observer stop              Stop background service
observer status            Show agent sources, shipper state, daemon health
observer logs              Tail recent activity log
observer auth login        OAuth device flow (enterprise)
observer auth status       Show auth state
observer skills install    Detect agents, install skills
observer skills list       Show installed skills across agents
observer config            Open config in $EDITOR
observer config show       Print current config
observer update            Download and install latest version
observer uninstall         Remove daemon, config, skills (keeps traces)
```

## Appendix B: Supported Agents

| Agent | Trace location | Format | Parser |
|-------|---------------|--------|--------|
| Claude Code | `~/.claude/projects/{path}/` | JSONL | `parsers/claude.ts` |
| Codex (OpenAI) | `~/.codex/sessions/YYYY/MM/DD/` | JSONL | `parsers/codex.ts` |
| Cursor | `~/.cursor/` (macOS: `~/Library/Application Support/Cursor`) | SQLite `.vscdb` | `parsers/cursor.ts` |

## Appendix C: Secret Scanner Patterns

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
