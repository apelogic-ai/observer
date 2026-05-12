# DORA in Observer: Design & Implementation Plan

**Status:** Proposed
**Date:** 2026-05-11
**Author(s):** TBD

---

## TL;DR

DORA measures delivery performance — code's journey from commit to production. Observer measures agent productivity — intent to commit. The two adjoin at the commit boundary; together they answer a question no off-the-shelf tool can: **is AI-assisted work net-positive on delivery performance?**

This plan stages observer's evolution from agent observability into a full DORA tool, with **commit attribution carried through every metric** so every chart can be split by agent-authored vs human-authored. We can ship Deployment Frequency and a reasonable Lead-Time-to-Merge proxy from existing data in days; we need one new ingest path (deploy + incident events) to compute the full DORA four.

---

## 1. Why DORA, and why observer is uniquely positioned

DORA's four key metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, MTTR) have been the de-facto delivery-performance standard since the 2014 *State of DevOps* report and continue to underpin the *Accelerate* benchmarks. Every engineering org we sell to either tracks them or wishes they did. The market is crowded — LinearB, Sleuth, Swarmia, GitLab Value Stream, Apollo — and they share one blind spot: **none of them know which commits an AI produced**.

Observer already has that signal (`GitEvent.agentAuthored` / `agentName`) and links each commit back to the trace session that authored it. That makes observer the only place where:

- *Deployment frequency by attribution* — how often does AI-assisted work reach prod, broken out by which agent?
- *Lead time by attribution* — does AI cut lead time in half, or do reviews and rework absorb the savings?
- *Change failure rate by attribution* — is AI-shipped code reverted more often, or less?
- *MTTR by attribution* — when an agent-introduced incident occurs, who recovers faster — humans or another agent?

The deliverable for this work is not "another DORA dashboard." It's "the first DORA dashboard that disaggregates AI-driven work from human-driven work."

---

## 2. DORA refresher

Brief, so the doc is self-contained. Definitions taken from the 2023 *Accelerate State of DevOps Report*.

| Metric | Definition | Elite threshold |
|---|---|---|
| **Deployment Frequency (DF)** | How often the org successfully releases to production | On demand (multiple per day) |
| **Lead Time for Changes (LT)** | Time from code committed to code running in production | < 1 hour |
| **Change Failure Rate (CFR)** | % of deploys that cause degraded service, requiring rollback / hotfix / patch | 0–15% |
| **Mean Time to Restore (MTTR)** | Time from production incident open to resolved | < 1 hour |

DORA splits these into two axes:
- **Throughput** = DF + LT (how fast you ship)
- **Stability** = CFR + MTTR (how reliably you ship)

The 2023 report adds **Reliability** as a fifth metric — operational/perceived availability — but it's softer and survey-derived. We treat it as future scope.

---

## 3. Inventory: what observer has today

### Entities

- **`TraceEntry`** — one row per agent turn (token usage, tool calls, project, agent kind, session ID).
- **`Session`** — derived from trace entries: `started`, `ended`, `agent`, `project`, `entries`, token totals, `activeMs`, `locDelta`, `commits`, `userTurns`, `firstActionMs`, `validatedAfterEdit`, `stuckLoops`.
- **`GitEvent`** — one row per commit, PR open, PR merge, or PR close. Fields include `commitSha`, `parentShas`, `branch`, `author`, `agentAuthored`, `agentName`, `sessionId`, `prNumber`, `prState`, `filesChanged`, `insertions`, `deletions`.

### Surfaces

- 12 dashboard routes (overview, project, tool, model, productivity, dark-spend, stumbles, security, autonomy, validation, skills, efficiency, commit, session).
- Commit attribution UI ties each commit back to its originating session.
- No deploy concept. No incident concept. No release tags surfaced. No rollback detection.

### What's missing for DORA

| DORA need | Observer state | Gap |
|---|---|---|
| Deploy events | None | New entity required |
| Incident events | None | New entity required |
| Lead time anchor (commit → prod) | Commit timestamp only | Need a "deployed at" timestamp on each commit, or a join via release manifest |
| Failure attribution | None | Need revert detection + incident-to-deploy linkage |

---

## 4. Metric-by-metric design

Each metric below specifies: data sources, the SQL/derivation, the agent-vs-human split, and what fraction is achievable today.

### 4.1 Deployment Frequency

**Definition.** Count of successful production deploys per day (and per week, per quarter for the org benchmark).

**Canonical source.** `DeployEvent` (new entity, §5). Each deploy has `at`, `env`, `ref`, `commits[]`, `status`, `actor`, `source` (github_actions, manual, etc.).

**Today's proxy.** `COUNT(commits) WHERE branch IN ('main','master','release/*') GROUP BY day` — assumes one merge to default branch ≈ one deploy. Acceptable for trunk-based, misleading for environments with deploy gates.

**Agent split.** A deploy's `agentRatio` = `Σ(insertions+deletions of agent-authored commits in bundle) / Σ(all changes in bundle)`. Then bucket deploys into `agent-led` (≥70% agent), `human-led` (≤30% agent), `mixed` otherwise. Threshold configurable.

**Headline chart.** Stacked area chart over time, three colors (agent-led / mixed / human-led), with elite/high/medium/low threshold bands behind.

### 4.2 Lead Time for Changes

**Definition.** Time from first commit on a change → first time that change runs in production.

**Canonical source.** For each `DeployEvent`, walk back through `commits[]` and take `min(commit.timestamp)`. `leadTime = deploy.at - min(commit.timestamp)`.

**Today's proxies (in increasing fidelity):**

1. **Commit → merge to main.** Available now. `min(commit.timestamp) → max(commit.timestamp WHERE branch='main')` for each PR.
2. **PR open → PR merge.** Available now via `GitEvent` `pr_open`/`pr_merge` events.
3. **First commit → PR merge.** Joining session-level "first commit on branch" to the `pr_merge` event.

These all measure the *review* leg. The *deploy* leg requires `DeployEvent`. We surface (3) as "Lead time to merge" with an explicit footnote on what's not included.

**Agent split.** Per-commit attribution lives on `GitEvent`. A change's `leadTime` belongs to whichever bucket its commits fall in. Plot p50 and p90 — DORA cares about the distribution, not the mean.

### 4.3 Change Failure Rate

**Definition.** % of deploys that cause degraded service, requiring rollback, hotfix, or patch.

**Canonical source.** `IncidentEvent.deployRef` links an incident back to a deploy. CFR = `count(deploys with incident) / count(deploys)` over a rolling window.

**Today's proxy (heuristic — fallible).** Detect revert/hotfix commits, mark their parent deploy as failed:

- A commit is a *revert* if `message LIKE 'Revert "%"'` (git's default) **and** it has a Co-Authored-By or sibling commit referencing the original.
- A commit is a *hotfix* if it's pushed to `main` outside business hours **and** the previous commit is on `main` within < 4h **and** the message contains `fix:`, `hotfix:`, or `revert:`.

Both are noisy. Document them as proxies; they're useful for *trend direction*, not absolute compliance numbers.

**Agent split.** A failed deploy's failure is attributed by the `agentRatio` of the *original* commits, not the revert/hotfix. The interesting question is "what produced the breakage," not "who fixed it" — though we also plot the fixer attribution as a complementary view.

### 4.4 Mean Time to Restore

**Definition.** Mean time from incident open → incident resolved.

**Canonical source.** `IncidentEvent.openedAt` and `IncidentEvent.resolvedAt`. Each is one row; MTTR is the mean over a window.

**Today's proxy.** None — we have no incident signal. The revert-heuristic gives the *fix* event but no incident open time.

**Agent split.** Two complementary cuts:
- *Originator split* — when an agent-led deploy caused the incident, was MTTR lower? (Answers: does AI ship recoverable mistakes?)
- *Resolver split* — was the fix commit agent-authored? (Answers: do agents help with on-call?)

### 4.5 Reliability (future)

Skip in v1. Once `IncidentEvent` is flowing we can add a coarse availability proxy: `1 - (incident_minutes / window_minutes)`. Survey-derived perceived reliability is out of scope.

---

## 5. Data model extensions

### 5.1 New entity: `DeployEvent`

```typescript
interface DeployEvent {
  id: string;                  // sha256(source + externalId)[:16]
  at: string;                  // ISO 8601, when the deploy *succeeded*
  env: string;                 // "production", "staging", "preview", etc.
  ref: string;                 // git ref deployed (sha or tag)
  status: "succeeded" | "failed" | "rolled_back";
  source: "github_actions" | "github_release" | "manual" | "vercel" | "fly" | "render" | "argocd" | "other";
  externalId: string;          // upstream's run id / release id
  actor: string | null;        // who triggered: user login or system bot
  project: string;             // matches GitEvent.project
  repo: string;                // owner/repo
  // Resolved during ingest by walking from this.ref back to the previous
  // production deploy's ref. Computed once and stored to avoid expensive
  // per-query walks.
  commits: string[];           // commit SHAs included in this deploy
  durationMs: number | null;   // build+deploy wall time
}
```

Indexed by `(project, env, at)`. Stored in the same Hive-partitioned lakehouse as TraceEntry/GitEvent, partitioned `year=YYYY/month=MM/day=DD/event=deploy/...`.

### 5.2 New entity: `IncidentEvent`

```typescript
interface IncidentEvent {
  id: string;                  // sha256(source + externalId)[:16]
  source: "pagerduty" | "opsgenie" | "sentry" | "grafana" | "manual" | "other";
  externalId: string;
  project: string;             // may be derived from service mapping
  service: string | null;      // upstream's service identifier
  severity: "sev1" | "sev2" | "sev3" | "sev4" | null;
  openedAt: string;
  resolvedAt: string | null;
  // Linkage to deploys. Filled by ingestor via {service|project, openedAt}
  // joined back to the most-recent prior DeployEvent in same env.
  deployId: string | null;
  title: string | null;        // SENSITIVE — short summary
}
```

Storage parallel to DeployEvent.

### 5.3 Extension to `GitEvent`

Add three fields on existing GitEvent — populated by a new git scanner pass:

```typescript
revertsSha: string | null;   // populated when message LIKE 'Revert "..."' and we can resolve target
isHotfix: boolean;           // heuristic: pushed to main, follows recent merge, message marker
isMergeCommit: boolean;      // parentShas.length > 1
```

These are *derived* — recomputable from raw commit data. They live on `GitEvent` only for query efficiency.

### 5.4 Link table: `DeployCommits` (logical, not physical)

The `commits[]` array on `DeployEvent` is the canonical link. We don't materialize a separate table — DuckDB's `unnest()` is sufficient for joins.

---

## 6. Ingestion design

### 6.1 New API: `POST /api/events`

The existing `/api/ingest` accepts trace batches with a specific shape. Rather than overloading it, add a sibling endpoint with the same auth (Bearer key or Ed25519 signature) for *non-trace* event types.

```http
POST /api/events
Authorization: Bearer ...
Content-Type: application/json

{
  "events": [
    {
      "type": "deploy",
      "source": "github_actions",
      "externalId": "12345",
      "at": "2026-05-11T14:00:00Z",
      "env": "production",
      "ref": "abc123",
      "status": "succeeded",
      "project": "observer",
      "repo": "apelogic-ai/observer",
      "actor": "dependabot[bot]",
      "durationMs": 487000
    },
    {
      "type": "incident",
      "source": "pagerduty",
      ...
    }
  ]
}
```

Server-side: validate, dedup by `(source, externalId)`, resolve `commits[]` for deploy events by walking the git history if a local mirror or GitHub token is available (otherwise leave empty and surface a warning), persist to the lakehouse.

### 6.2 Webhook adapters

We don't ask consumers to hand-craft the JSON. Provide small adapter functions that translate vendor webhooks → observer events. Adapters live in a new package `@observer/webhooks` and ship as:

1. **GitHub Actions step** — `apelogic-ai/observer-deploy-event@v1`. One YAML line in the workflow:
   ```yaml
   - uses: apelogic-ai/observer-deploy-event@v1
     with:
       endpoint: ${{ secrets.OBSERVER_ENDPOINT }}
       api-key: ${{ secrets.OBSERVER_API_KEY }}
       env: production
   ```

2. **AWS Lambda handlers** — drop-in for PagerDuty / Sentry / Grafana webhooks. Terraform module in `deploy/integrations/`.

3. **Manual CLI** — `observer event deploy --env production --ref HEAD` for orgs that don't have CI deploy automation yet.

### 6.3 Pull-mode fallback

For orgs without webhook access, the observer agent can pull from the GitHub Releases API and Sentry/PagerDuty incident endpoints on the same cadence as git collection. Stored opt-in config in `~/.observer/config.yaml`:

```yaml
dora:
  github:
    repos: ["apelogic-ai/observer"]
    auth: keychain:github  # uses existing keychain backend
  sentry:
    org: "apelogic"
    auth: keychain:sentry
```

### 6.4 Backfill

A `observer dora backfill <since>` CLI: pulls historical deploys/incidents (where supported) and reconstructs `commits[]` from local git mirrors. Idempotent — keyed on `(source, externalId)`.

---

## 7. Dashboard surface

### 7.1 New top-level page: `/dora`

Single-screen overview with the four metric headline numbers plus their elite/high/medium/low bucket, alongside small sparklines. Every metric defaults to "all" but has a prominent toggle: **All / Agent-led / Mixed / Human-led**. The split is the differentiator; treat it as a first-class axis, not a filter.

### 7.2 Per-metric drill-down pages

- `/dora/frequency` — stacked area chart by attribution, with weekday/weekend breakdown and per-environment split.
- `/dora/lead-time` — p50/p90 distribution histograms with attribution split; click into a percentile to see the contributing PRs.
- `/dora/cfr` — failure rate with confidence intervals (small-sample-aware); list of failed deploys with their revert/hotfix detail.
- `/dora/mttr` — incident timeline with the originating-deploy link visible.

### 7.3 The "AI delta" page: `/dora/ai-impact`

The summary chart this whole project exists to produce. Side-by-side: human-only baseline (a quarter where AI usage was minimal, configurable as the calibration window) vs current. Four numbers, four deltas, with annotations for each metric's confidence interval.

### 7.4 Wiring with existing pages

- The `/commit` and `/session` pages gain a "Reached production at" line when a `DeployEvent` references their commit.
- The `/productivity` page's "productive" bucket can be reweighted: agent-shipped + reached-prod + no-incident-followup gets a bonus weighting.

---

## 8. Phasing

Ship in slices that each deliver something useful on their own. Order chosen so each slice unblocks the next without dead ends.

### Phase 0 — Foundation (week 1)

- Add `revertsSha`, `isHotfix`, `isMergeCommit` to `GitEvent`.
- Compute them in the git scanner pass.
- Ship `/dora/lead-time` using PR-open-to-merge as the canonical LT.
- Land the agent-vs-human attribution rollup function in `packages/dashboard/src/lib/queries.ts`.

**Value:** Lead-time analytics with attribution, today, with no new ingest.

### Phase 1 — Deploy events (weeks 2–3)

- New `DeployEvent` entity + `/api/events` endpoint.
- GitHub Actions step (`observer-deploy-event@v1`).
- `/dora/frequency` page.
- Backfill via GitHub Releases API.

**Value:** True DF, true LT once we have deploys. Closes one of two missing axes.

### Phase 2 — Incident events (weeks 4–5)

- `IncidentEvent` entity.
- PagerDuty + Sentry webhook adapters.
- Deploy ↔ incident linkage by service + time window.
- `/dora/cfr` and `/dora/mttr` pages.

**Value:** Full DORA four. Stability axis now answerable.

### Phase 3 — AI Impact summary (week 6)

- `/dora/ai-impact` page. Calibration-window picker. Confidence intervals.
- Marketing copy / case-study template.

**Value:** The headline story this work is meant to tell. Quantified.

### Phase 4 — Reliability + pull-mode (future)

- Reliability proxy from incident-minutes.
- Pull-mode for GitHub/Sentry as a fallback for non-webhook orgs.
- Per-team rollups (org chart integration).

---

## 9. Open questions and risks

1. **Revert detection precision.** The default `Revert "..."` message is unreliable across teams that squash. We may need a per-org regex setting or rely on GitHub's revert-commit API. **Mitigation:** ship the heuristic with a per-org override; expose a "tag this as a revert" UI on the commit page.

2. **Bundle ambiguity in DF.** When a deploy bundles ten commits, is that one deploy or ten? DORA says one. But the *agent-led* split inside one bundle is fractional. Decision: keep DF as a deploy count, but expose `agentRatio` on each deploy for drill-downs.

3. **Calibration window for AI Impact.** Many orgs adopted AI gradually — there's no clean "before/after." We may need a continuous regression rather than a step comparison. **Decision:** ship step-comparison v1; add regression view if customers ask.

4. **Privacy on incident titles.** Incident titles often contain sensitive product info. Treat as SENSITIVE disclosure tier (same as commit body), redact in centralized lakehouse below `sensitive` level.

5. **Multi-repo deploys.** A microservice deploy may pull commits from many repos. The `DeployEvent.commits[]` design supports this, but UI affordances need care so users don't think a deploy "belongs" to one repo.

6. **Pre-trunk environments.** Trunk-based shops are fine. Long-lived release branches break the "merge to main = deploy" proxy. **Decision:** require `env` on `DeployEvent` — never infer it from branch.

7. **Build vs deploy.** Some pipelines decouple "build a release artifact" from "deploy the artifact to env N." DORA cares about the deploy, not the build. **Decision:** the GitHub Actions step ships from the *deploy* job, not the build job. Document this clearly in the integration guide.

---

## 10. Success criteria

This work has shipped successfully when:

1. We can show a deploy frequency chart split by AI attribution on at least one customer's data and it matches their internal expectations within ±10%.
2. The `/dora/ai-impact` page produces a number — positive or negative — that customers cite in retrospectives.
3. At least three deploy sources (GitHub Actions, GitHub Releases, manual CLI) and two incident sources (PagerDuty, Sentry) have working adapters with docs.
4. No customer has had to write more than 10 lines of YAML / Terraform to wire the integration.
5. The "what would it take to get DORA on AI-assisted work" question has an off-the-shelf answer.

---

## Appendix A — Why we're not just rebranding existing tools

LinearB, Sleuth, Swarmia, Jellyfish, GitLab Value Stream, Apollo: all have polished DORA dashboards. None of them ingest agent traces, so none can split a commit into "agent-driven" or "human-driven." We can. The whole project is a thin wrapper around that one fact — observer's `agentAuthored` bit is the only differentiator that matters, and DORA is the language CTOs already speak.

## Appendix B — Out of scope (v1)

- Per-developer DORA (controversial and easily abused; org-level only).
- DORA for non-code work (design tickets, infrastructure changes outside git).
- Real-time deploy gating ("don't deploy if CFR is rising") — analytics only, not control.
- Multi-tenant SaaS — assumes the single-tenant ingestor.
