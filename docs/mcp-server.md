# Observer MCP Server

Design document for a unified MCP server exposing Observer (raw trace queries) and Dreamer (knowledge layer) to AI agents.

## Motivation

Observer collects and normalizes agent traces into `~/.observer/traces/normalized/`. The dashboard queries this data via DuckDB. Dreamer processes the same traces into summaries, wiki pages, and procedural skills stored in `~/.dreamer/`.

An MCP server makes both layers queryable by any agent — an agent can ask "what tools did I use most this week?" (Observer) or "what did I learn about the auth system?" (Dreamer) without leaving context.

## Data Roots

```
~/.observer/traces/normalized/     # Observer writes, both read
    YYYY-MM-DD/{agent}/*.jsonl     # TraceEntry JSONL

~/.dreamer/                        # Dreamer owns
    sessions/YYYY-MM-DD/*.md       # Session summaries
    workspaces/{ws}/wiki/*.md      # Compiled wiki pages
    workspaces/{ws}/skills/*.md    # Extracted procedural skills
```

## Tool Surface

### Query Tools (Observer — instant, DuckDB)

These query the normalized trace JSONL directly via DuckDB. All accept optional filters: `days`, `project`, `model`, `agent`.

| Tool | Parameters | Returns |
|------|-----------|---------|
| `observer_stats` | filters | Aggregate counts: entries, sessions, projects, days, token breakdown (input, output, cache_read, cache_creation) |
| `observer_activity` | filters, granularity (day/week/month) | Timeline rows: `{date, agent, count}[]` |
| `observer_tokens` | filters, granularity | Timeline rows: `{date, input_tokens, output_tokens, cache_read, cache_creation}[]` |
| `observer_tools` | filters, limit? | Top tools: `{tool_name, count, primary_agent, agents[]}[]` |
| `observer_projects` | filters | Projects: `{project, entries, sessions, output_tokens}[]` |
| `observer_models` | filters | Models: `{model, count, total_tokens}[]` |
| `observer_sessions` | filters, limit? | Recent sessions: `{session_id, agent, project, started, ended, entries, output_tokens}[]` |
| `observer_sql` | sql (string) | Raw DuckDB query against the `traces` view. Power tool — agent can ask anything. |

`observer_sql` is the escape hatch. The typed tools cover common queries; SQL handles everything else. The `traces` view schema matches `TraceEntry` (see `packages/agent/src/types.ts`).

### Knowledge Tools (Dreamer — reads from ~/.dreamer/)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `dreamer_ask` | question, workspace?, project?, days? | Answer synthesized from session summaries + wiki + skills. Calls Dreamer's LLM-backed `ask` function. |
| `dreamer_status` | — | Pipeline status: last processed date per phase, cursor positions, workspace list |
| `dreamer_wiki` | workspace, path? | Read wiki page(s). Without path: list available pages. With path: return page content. |
| `dreamer_skills` | workspace, path? | Read skill document(s). Same list/read pattern as wiki. |
| `dreamer_sessions` | date?, workspace? | Read session summaries for a date or range. |

### Excluded from MCP

| Function | Why excluded |
|----------|-------------|
| `dreamer dream` | Expensive LLM batch job (summarizes all sessions for a date). Run via CLI. |
| `dreamer compile` | Expensive LLM batch job (rewrites wiki pages). Run via CLI. |
| `dreamer extract-skills` | Expensive LLM batch job (extracts skill documents). Run via CLI. |
| Observer scan/ship | Side-effectful daemon operations. Run via CLI/service. |

These are batch pipeline operations, not interactive tool calls. They belong in the CLI or scheduled jobs. The MCP server exposes their *outputs*, not the operations themselves.

## Architecture

```
                          MCP Server (stdio)
                         ┌─────────────────────┐
                         │                     │
  Agent ←── stdio ──►    │  observer_* tools   │──► DuckDB (in-memory)
                         │                     │      └── traces view over JSONL glob
                         │  dreamer_* tools    │──► ~/.dreamer/ filesystem
                         │    (reads)          │
                         │  dreamer_ask        │──► Dreamer ask() (LLM call)
                         │                     │
                         └─────────────────────┘
```

### Runtime

- **Language**: TypeScript, Bun runtime
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **DuckDB**: `duckdb-async` (same dependency as the dashboard server)
- **Dreamer integration**: Import `@dreamer/core` stores for wiki/skill/session reads. Shell out to `dreamer ask` for LLM-backed Q&A (keeps the LLM runner config in Dreamer's domain).

### Package Location

`packages/mcp/` in the Observer monorepo. Depends on:
- `duckdb-async` — trace queries
- `@modelcontextprotocol/sdk` — MCP protocol
- Reads `~/.dreamer/` directly for wiki/skill/session files (filesystem, no import dependency on Dreamer packages)

The Dreamer store format is simple markdown files with YAML frontmatter. Reading them doesn't require importing Dreamer code — just `fs.readFile` + frontmatter parsing.

For `dreamer_ask`, shell out to `bun packages/cli/src/cli.ts ask` (or the compiled binary) since it requires LLM runner configuration that lives in Dreamer's config.

### Configuration

```yaml
# ~/.observer/config.yaml (extend existing)
mcp:
  tracesDir: ~/.observer/traces/normalized    # default
  dreamerDir: ~/.dreamer                       # default, null to disable dreamer tools
```

Or via environment variables:
```
OBSERVER_TRACES_DIR=~/.observer/traces/normalized
DREAMER_DIR=~/.dreamer
DREAMER_CLI=dreamer    # path to dreamer binary for ask()
```

### MCP Client Configuration

```json
{
  "mcpServers": {
    "observer": {
      "command": "observer",
      "args": ["mcp"]
    }
  }
}
```

Or during development:
```json
{
  "mcpServers": {
    "observer": {
      "command": "bun",
      "args": ["run", "/path/to/observer/packages/mcp/src/index.ts"]
    }
  }
}
```

## Traces View Schema

The DuckDB `traces` view has these columns (from `TraceEntry`):

```sql
id              VARCHAR
timestamp       TIMESTAMP
agent           VARCHAR      -- claude_code, codex, cursor
sessionId       VARCHAR
developer       VARCHAR
machine         VARCHAR
project         VARCHAR
entryType       VARCHAR      -- message, tool_call, tool_result, reasoning, task_summary
role            VARCHAR      -- user, assistant, system, tool
model           VARCHAR
tokenUsage      STRUCT(input BIGINT, output BIGINT, cacheRead BIGINT, cacheCreation BIGINT, reasoning BIGINT)
toolName        VARCHAR
toolCallId      VARCHAR
filePath        VARCHAR
command         VARCHAR
taskSummary     VARCHAR
gitRepo         VARCHAR
gitBranch       VARCHAR
gitCommit       VARCHAR
userPrompt      VARCHAR      -- requires sensitive disclosure
assistantText   VARCHAR      -- requires sensitive disclosure
thinking        VARCHAR      -- requires sensitive disclosure
reasoning       VARCHAR      -- requires sensitive disclosure
systemPrompt    VARCHAR      -- requires sensitive disclosure
-- HIGH_RISK fields are always null in normalized output
```

This schema is documented in the MCP server's tool descriptions so the agent knows what columns are available for `observer_sql`.

## Implementation Plan

1. **Scaffold `packages/mcp/`** — package.json, tsconfig, basic MCP server with stdio transport
2. **DuckDB layer** — Reuse `server/db.ts` init logic. Create `traces` view on startup.
3. **Observer tools** — Register typed query tools + `observer_sql`. Reuse query functions from `server/queries.ts` or inline simplified versions.
4. **Dreamer read tools** — `dreamer_status`, `dreamer_wiki`, `dreamer_skills`, `dreamer_sessions`. Pure filesystem reads with frontmatter parsing.
5. **Dreamer ask** — Shell out to `dreamer ask` CLI. Stream stdout back as tool result.
6. **CLI integration** — Add `observer mcp` subcommand that starts the MCP server on stdio.
7. **Tests** — Unit tests for each tool with fixture JSONL data and mock dreamer directory.
