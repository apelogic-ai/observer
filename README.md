# Observer

AI agent trace collection and organizational observability.

Observer is a daemon that watches AI coding agent trace directories (Claude Code, Codex, Cursor), redacts secrets, enforces disclosure policies, and ships data to a centralized lakehouse for analytics, security scanning, and knowledge extraction.

## Quick start

```bash
# Install
curl -fsSL https://observer.dev/install.sh | bash

# Configure
observer init

# Run
observer start
```

## Packages

| Package | Description |
|---------|-------------|
| [`@observer/agent`](packages/agent) | Local daemon — scans traces, redacts secrets, ships to API |
| [`@observer/api`](packages/api) | HTTP server — receives batches, authenticates, stores to lakehouse |

## Development

```bash
# Install dependencies
bun install

# Run all tests
bun run test

# Typecheck
bun run typecheck

# Local testing (two terminals)
./run-local.sh api      # Terminal 1: start API on :19900
./run-local.sh agent    # Terminal 2: one-shot scan + ship
./run-local.sh status   # Terminal 3: inspect lakehouse
```

## Build

```bash
# Compile agent to standalone binary
cd packages/agent
bun build --compile src/cli.ts --outfile dist/observer
```

## CLI

```
observer init           Interactive setup wizard
observer scan           One-shot scan + ship
observer scan --dry-run Discover and count without shipping
observer daemon         Foreground daemon (for service managers)
observer start          Install and start background service
observer stop           Stop background service
observer status         Show agent sources, shipper state, daemon health
observer logs           Tail recent activity log
observer config         Open config in $EDITOR
observer update         Download and install latest version
observer uninstall      Remove daemon, config (keeps traces)
```

## License

MIT
