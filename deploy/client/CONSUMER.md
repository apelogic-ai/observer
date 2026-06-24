# Observer client — deployment runbook (MDM / Iru)

**Audience:** the client's **IT** and **security** teams rolling the Observer
agent out to a managed Mac fleet.

**Mental model:** you maintain a **private fork** of this repo. Your fork's
GitHub Actions build, **sign, and notarize** the macOS `.pkg` with *your* Apple
Developer ID, then publish it to *your* **[Iru](https://www.iru.com/)** tenant
as a Custom App. You pull our product + security fixes by syncing upstream — so
keep your changes additive (CI secrets/vars and *new* files), and don't edit
files we maintain. See `README.md` for the why and the public/private split;
this file is the step-by-step *how*. Packaging-format rationale (why PKG, not
DMG) is in `packaging-format.md`.

Everything below is done once, then repeated only when you cut a new release.

---

## 0. Prerequisites

**Apple (signing + notarization)**
- A **Developer ID Installer** certificate (Apple Developer Program / Apple
  Business Manager), exported as a base64 `.p12` + its password.
- An **App Store Connect API key** (Issuer ID, Key ID, `.p8`) for `notarytool`.
- The signing **identity string**, e.g. `Developer ID Installer: Acme (TEAMID)`.

**Iru**
- An Iru tenant with an **API token** scoped to Custom Apps.
- One or more **device groups** wired to your IdP (Okta/Entra/Google) to use as
  rollout rings — at minimum a small **Canary** group and a **Broad** group.

**Observer ingestor (server side)**
- A reachable ingestor URL (see `deploy/eks/CONSUMER.md`).
- An **enrollment path** to register each device's Ed25519 **public key**
  (see step 5). No shared API key is distributed to the fleet.

---

## 1. Keep your fork in sync (fork hygiene)

- Track this repo as `upstream` and merge it for fixes:
  ```bash
  git remote add upstream https://github.com/apelogic-ai/observer.git
  git fetch upstream && git merge upstream/master
  ```
- **Do not edit files we maintain** (`packages/**`, `deploy/client/macos/**`,
  `.github/workflows/client.yml`). Put your customizations where upstream won't
  touch them:
  - secrets/vars → **GitHub repo settings** (step 2), not files;
  - your real config + Iru definitions → **new files** (step 3, 6);
  - your publish command → a **new workflow** in your fork (step 4), leaving
    ours as the unsigned/dry-run default.

This keeps `git merge upstream/master` conflict-free.

---

## 2. Set CI secrets and variables (in your fork)

`Settings → Secrets and variables → Actions`:

| Name | Kind | Value |
| --- | --- | --- |
| `APPLE_INSTALLER_CERT_P12` | secret | base64 of the Developer ID Installer `.p12` |
| `APPLE_INSTALLER_CERT_PASSWORD` | secret | the `.p12` password |
| `APPLE_NOTARY_KEY` | secret | base64 of the App Store Connect `.p8` |
| `APPLE_NOTARY_KEY_ID` | secret | the key ID |
| `APPLE_NOTARY_ISSUER` | secret | the issuer ID |
| `APPLE_INSTALLER_IDENTITY` | **var** | `Developer ID Installer: Acme (TEAMID)` |
| `IRU_API_TOKEN` | secret | Iru API token (Custom Apps) |
| `IRU_PUBLISH` | **var** | `1` to enable the publish step |

With these set, `client.yml`'s `publish` job signs + notarizes on a `client-v*`
tag (it falls back to an *unsigned* artifact if the cert secret is absent, so
forks don't hard-fail).

---

## 3. Author your managed config

Copy the template and fill in your environment — **non-secret only**:

```bash
cp deploy/client/config.example.yaml deploy/client/operator-config.yaml   # new file, your fork
```

Set the destination `endpoint` (your ingestor URL), the `disclosure` floor
(keep `basic` for fleet shipping), `redactSecrets: true`, and any
`orgs`/`projects`/`privacy.excludeProjects` filters your policy requires. Leave
`auth: none` (Ed25519-only — see step 5). **Nothing secret goes in this file**;
it is world-readable on-device.

Deliver it one of two ways:
- **Authoritative:** uncomment `OBSERVER_CONFIG` in the LaunchAgent (we ship the
  managed config to a fixed path and pin it), or
- **Fallback default:** push the file to the system path via an Iru **Custom
  Profile** / script — `/Library/Application Support/Observer/config.yaml`.

The agent's search order is `OBSERVER_CONFIG` → per-user `~/.observer` → system
path → defaults. Per-user state (the keypair) always stays under `~/.observer`.

---

## 4. Wire the Iru publish (your fork)

Our `client.yml` publish step is a **dry-run scaffold** (it logs what it would
upload) so no customer specifics live upstream. In your fork, add a **new**
workflow (e.g. `.github/workflows/client-publish.yml`) triggered on the same
`client-v*` tag that downloads the signed pkg artifact and runs Iru's
[`irupkg`](https://github.com/kandji-inc/irupkg) (formerly Kandji Packages):

```bash
pipx run irupkg upload \
  --token "$IRU_API_TOKEN" \
  --name "Observer Agent" --version "$VERSION" --file "$PKG" \
  --blueprint "$IRU_CANARY_BLUEPRINT"
```

Adding a new file (instead of editing ours) keeps upstream syncs clean.

---

## 5. Enrollment & trust (the only "secret" step)

The agent generates a per-install **Ed25519** keypair on first run; the private
key never leaves the device. The ingestor authorizes a device by trusting its
**public key** — so the fleet ships **no shared secret**, and you revoke one
device without rotating anything else.

Choose an enrollment path and document it for your fleet:
- device fetches a **short-lived enrollment token** from your secret manager
  using its **Iru-issued device identity / SCEP cert**, then registers its
  public key; **or**
- an admin **approves** new public keys within an enrollment window.

Deliver any token **out-of-band** (Iru profile / cert) — never bake it into the
bundle or the config file.

---

## 6. Configure Iru (Custom App + rings)

1. **Custom App** — created/updated by step 4 (or upload the pkg manually). Set
   enforcement to **Install & continuously enforce**.
2. **Audit script** (recommended) — Iru reinstalls when it exits non-zero. Use
   it to assert the agent is present, on the expected version, and the daemon is
   loaded, e.g.:
   ```bash
   /bin/launchctl print "gui/$(id -u)/com.observer.agent" >/dev/null 2>&1 || exit 1
   "/usr/local/observer/observer" --version | grep -q "$EXPECTED_VERSION" || exit 1
   ```
3. **Managed config** — deliver `operator-config.yaml` via a Custom Profile or
   pkg/script to the path from step 3.
4. **Blueprints + Assignment Maps** — put the Custom App in a **Canary**
   Blueprint scoped (via an Assignment-Map rule) to your Canary IdP group, and a
   **Broad** Blueprint for the rest. Promotion is step 7.

---

## 7. Gated rollout (Canary → Broad)

- A `client-v*` tag auto-publishes to **Canary** (step 4/6).
- Soak. Then promote to **Broad** behind a **GitHub Environment with required
  reviewers** — the human gate. The approval triggers the job that calls the Iru
  API to extend the Assignment Map to the Broad group. (Configure the
  environment + reviewers under `Settings → Environments` in your fork.)

This gives auditable approval on the GitHub side and staged enforcement on the
Iru side.

---

## 8. Verify on a test device (in the Canary group)

```bash
# Managed config present (whichever path you chose)
ls -l "/Library/Application Support/Observer/config.yaml"

# Daemon loaded for the logged-in user
launchctl print "gui/$(id -u)/com.observer.agent" | head

# Per-user identity generated; private key stayed local
ls -l ~/.observer/observer.key ~/.observer/observer.pub

# Agent health + that data reaches your ingestor
/usr/local/observer/observer status
```

Confirm in Iru that the Custom App shows **Installed/Pass** and that the
ingestor logs an authenticated batch from the device's registered key.

---

## Responsibilities

| You (client IT/security) | Us (maintainers) |
| --- | --- |
| Apple Developer ID + notary creds; sign/notarize in your fork | The binary, pkg scaffold, and `client.yml` mechanism |
| Real `config.yaml` values, filters, retention | `config.example.yaml` template + secure defaults |
| Iru tenant, Blueprints, Assignment Maps, rings, audit script | The LaunchAgent + postinstall behavior |
| Enrollment path + public-key registration; revocation | Per-install Ed25519 identity + signing |
| GitHub Environment approvals; promotion | Fail-safe guards so forks build green |
| Syncing upstream for fixes | Publishing fixes upstream |

---

## Security notes

- **No shared secret on the fleet** — per-device Ed25519 identity; revoke one
  device in isolation. Avoid static API keys in profiles (profiles are readable
  on-device).
- **Disclosure floor** — `basic` for shipped data; `redactSecrets: true`;
  `privacy.excludeProjects` is a hard global exclusion before per-destination
  filters.
- **Supply chain** — pkg is signed (Developer ID Installer) and **notarized +
  stapled**; the build emits a **CycloneDX SBOM** (`client.yml`).
- **Least privilege** — the LaunchAgent runs as the *user* (it reads per-user
  trace dirs), not as root; the daemon ships outbound HTTPS to your ingestor
  only.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `client.yml` produced an **unsigned** pkg | `APPLE_INSTALLER_CERT_P12` not set, or set in the wrong fork/environment. |
| Notarization fails | Wrong `APPLE_NOTARY_*` (issuer/key-id/key), or the installer identity doesn't match the cert. |
| Agent installed but not running | LaunchAgent not bootstrapped — device was at the login window during install; it loads at next login (`RunAtLoad`). Re-check `launchctl print`. |
| Agent runs but ships nothing | Wrong `endpoint`, or the device's public key isn't registered/authorized at the ingestor (step 5). |
| Wrong config in effect | Search-order precedence — an `OBSERVER_CONFIG` pin or a per-user `~/.observer/config.yaml` overrides the system path. |
| Iru keeps reinstalling | Audit script exits non-zero — check the version/launchctl assertions in step 6. |
| Merge conflicts syncing upstream | You edited a file we maintain — move that change to a new file / CI var (step 1). |

---

See `docs/enterprise-deployment.md` for the full control mapping and the
ownership split, and `packaging-format.md` for why we ship PKG rather than DMG.
