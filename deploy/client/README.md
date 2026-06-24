# Observer client bundle — MDM distribution

Templates for distributing the Observer **agent** (the per-laptop collector)
to a managed fleet via **[Iru](https://www.iru.com/) (formerly Kandji)** or any
MDM that installs a signed `.pkg`. Same doctrine as the EKS chart: the reusable,
generic mechanism lives here (public, maintained centrally); every
site-specific value stays out of this repo.

> **Deploying this as a client?** Follow the step-by-step runbook in
> [`CONSUMER.md`](CONSUMER.md) (for IT/security). Why PKG and not DMG:
> [`packaging-format.md`](packaging-format.md).

```
┌─ public: github.com/<org>/observer ───────────────┐   ┌─ your private config repo ───────────┐
│ packages/agent/**     product code (the binary)    │   │ config.yaml   ingestor URL, filters  │
│ deploy/client/**      this scaffold (templates)    │   │ blueprints/   Iru Assignment Maps,   │
│ .github/workflows/client.yml  build·sign·notarize  │   │   ring group names, promotion gates  │
└───────────────┬─────────────────────────────────────┘  └───────────────┬──────────────────────┘
                │ publish: signed .pkg → Iru Custom App                    │ Iru ring rollout
                ▼                                                          ▼
        ┌─ Iru / secret manager ─────────────────────────────────────────────────┐
        │ signed pkg + Custom App assignments · enrollment tokens / device certs   │
        │ (no shared API key — each device's Ed25519 identity is the credential)   │
        └─────────────────────────────────────────────────────────────────────────┘
```

## What goes where

| Lives in… | What |
| --- | --- |
| **Public (this repo)** | The binary; `client.yml` CI; `config.example.yaml`; the macOS pkg scaffold (`macos/`) — all with placeholders |
| **Private operator repo** | The real `config.yaml` (ingestor URL, org/project filters, retention); Iru Blueprint / Assignment-Map definitions; ring group names; the promotion workflow |
| **Iru / secret manager** | The signed `.pkg` + Custom-App assignments; enrollment tokens / device certs; any bearer key (avoid — prefer the per-device Ed25519 identity) |

**Rule of thumb:** mechanism → public · your-specific-world → private · leakable
credential → Iru/secret manager (ideally replaced entirely by the per-device key).

## Secrets: prefer Ed25519-only, ship nothing

The agent generates a per-install Ed25519 keypair on first run; the private key
never leaves the device (keychain-backed, Secure Enclave on Apple Silicon) and
each batch is signed. The ingestor trusts the **registered public key** — so the
fleet ships **no shared secret**, and revocation is per-device. `config.example.yaml`
uses `auth: none` for exactly this. The only bootstrap question is enrollment
(registering each device's public key); deliver any enrollment token
out-of-band (device cert / short-lived token), never baked into the bundle.

## Config delivery

The agent searches, in order (see `packages/agent/src/config.ts`):

1. `OBSERVER_CONFIG` — explicit file (pin it in the LaunchAgent env to make
   managed config authoritative)
2. `<OBSERVER_HOME or ~/.observer>/config.yaml` — per-user (`observer init`)
3. system path — `/Library/Application Support/Observer/config.yaml` (macOS),
   `/etc/observer/config.yaml` (Linux), `%PROGRAMDATA%\Observer\config.yaml`
4. defaults

MDM either drops the managed config at the system path (fallback default) or
pins it via `OBSERVER_CONFIG` (authoritative). Per-user state (keypair, cursors)
stays under `~/.observer` regardless.

## Build a pkg locally

```bash
# 1. Compile the binary (embeds the dashboard)
cd packages/dashboard && bun run build && cd ../..
cd packages/agent && bun build --compile src/cli.ts --outfile dist/observer && cd ../..

# 2. Assemble an unsigned pkg (what the PR gate does)
BINARY=packages/agent/dist/observer VERSION=0.0.0-dev \
  deploy/client/macos/build-pkg.sh

# 3. Signed + notarized (release): provide a Developer ID Installer identity
#    and a notarytool keychain profile
SIGN=1 INSTALLER_IDENTITY="Developer ID Installer: Acme (TEAMID)" \
  NOTARY_PROFILE=observer-notary \
  BINARY=packages/agent/dist/observer VERSION=1.2.3 \
  deploy/client/macos/build-pkg.sh
```

## CI → Iru (gated rollout)

`client.yml` builds + (on a `client-v*` tag) signs/notarizes the pkg and, when
`vars.IRU_PUBLISH` is set, uploads it to Iru as a Custom App version using
[`irupkg`](https://github.com/kandji-inc/irupkg) (formerly Kandji Packages /
KAPPA). Stage the rollout with **Iru Assignment Maps** (identity-group rings):
publish to a **Canary** Blueprint automatically; promote to **Broad** behind a
GitHub **Environment** with required reviewers (the human gate). The promotion
job calls the Iru API to extend the Assignment Map after the soak.

### Required CI secrets / vars (operator-supplied, never committed)

| Name | Kind | Purpose |
| --- | --- | --- |
| `APPLE_INSTALLER_CERT_P12` / `_PASSWORD` | secret | Developer ID Installer cert (base64 .p12) + password |
| `APPLE_NOTARY_KEY` / `_KEY_ID` / `_ISSUER` | secret | App Store Connect API key for notarytool |
| `IRU_API_TOKEN` | secret | Iru API token scoped to Custom Apps |
| `IRU_PUBLISH` | var | set to `1` to enable the publish step (off in forks) |

## Windows / Linux

Same model: deliver a signed MSI (Windows) or `.deb`/`.rpm` (Linux) and the
managed config at the platform system path. Scaffolds welcome — open a PR.
