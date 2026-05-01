# Observer

Single-binary toolkit for AI-coding-agent observability. One install delivers both:

- **A local dashboard** that reads your own trace history (`localhost:3457`). Token costs, project mix, session drill-down, git-event attribution, and detectors for repeated-loop "stumbles" / dark-spend / zero-code sessions — all without sending any data off the machine.
- **A centralized lakehouse pipeline** for organizations. The same binary runs as a daemon that watches Claude Code, Codex, and Cursor trace dirs, redacts secrets, enforces per-destination disclosure policy, and ships to a self-hosted ingestor backed by S3.

Both are independent. Most developers run only the local dashboard; orgs adding centralized analytics deploy the ingestor separately. See [`docs/product.md`](docs/product.md) for the full description.

## Quick start

```bash
# Install
curl -fsSL https://observer.dev/install.sh | bash

# Configure (interactive — picks per-destination disclosure, asks where to
# store the API key: keychain / env / literal / Ed25519-only)
observer init

# Open the dashboard (foreground)
observer dashboard

# Or run as a background service
observer start
```

## Packages

| Package | Description |
|---------|-------------|
| [`@observer/agent`](packages/agent) | Local daemon — scans traces, redacts secrets, ships to N independent destinations (disk + HTTP) |
| [`@observer/dashboard`](packages/dashboard) | Next.js static export + Bun server, embedded in the agent binary. Pages: Overview, Stumbles, Dark spend, Zero code, session/commit drill-in |
| [`@observer/api`](packages/api) | HTTP ingestor — receives signed batches, dedups, writes to local FS or S3 |

## Development

```bash
# Install dependencies
bun install

# Run all tests
bun run test

# Typecheck + lint
bun run typecheck
bun run lint
```

## Build

```bash
# Build the dashboard's static export and tarball
cd packages/dashboard && bun run build

# Compile the agent binary (embeds the dashboard)
cd ../agent && bun build --compile src/cli.ts --outfile dist/observer
```

## Dev deployment

Reference deployment for the API server (Terraform + docker-compose, S3-backed, Caddy + Let's Encrypt) lives at [`deploy/dev/`](deploy/dev/).

## CLI

```
observer init              Interactive setup wizard
observer scan              One-shot scan + ship (use --dry-run to count without shipping)
observer status            Show agent sources, shipper state, daemon health
observer daemon            Foreground daemon (for service managers)
observer start             Install and start as a background service
observer stop              Stop and uninstall the service
observer dashboard         Run the dashboard (foreground; open browser)
observer dashboard start   Install dashboard as a background service
observer dashboard stop    Stop and uninstall the dashboard service
observer logs              Tail recent daemon logs
observer cursor-usage      Fetch real Cursor token usage from Cursor's API
observer keychain set      Store a secret in the OS keychain (stdin-only)
observer keychain get      Print a stored secret
observer keychain delete   Remove a stored secret
observer update            Download and install the latest version
observer uninstall         Stop services, remove ~/.observer/, delete the binary
```

See [`docs/product.md`](docs/product.md) Appendix A for a richer breakdown.

## License

MIT
