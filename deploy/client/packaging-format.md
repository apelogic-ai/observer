# Client packaging format: PKG vs DMG

**Status:** decided — ship the managed (enforced) install as a **signed,
notarized `.pkg`**. (2026-06)

## Context

The Observer client is not a GUI app. The artifact is a CLI binary
(`/usr/local/observer/observer`) **plus** a LaunchAgent in
`/Library/LaunchAgents` **plus** a `postinstall` that bootstraps the daemon into
the user's GUI session and can drop managed config. Distribution is via Iru
(formerly Kandji) MDM, whose Custom App library item accepts `PKG`, `DMG`, or
`ZIP`. The client IT team asked whether we could ship a `.dmg` instead.

## Decision

Use **PKG**. Iru treats the formats differently:

- **PKG** → Iru runs the installer, which **executes our pre/postinstall
  scripts** and places files anywhere on disk. This is what
  `macos/build-pkg.sh` produces.
- **DMG** → Iru requires the image to **contain only a `.app`** and merely
  **copies it to `/Applications`** — no scripts run, nothing lands in
  `/Library/LaunchAgents`. Iru's own guidance is that a DMG containing a PKG
  should be unwrapped and the PKG uploaded instead.

Our payload needs install logic, so DMG doesn't fit without re-architecting the
agent into a `.app` that self-installs its LaunchAgent on first launch — more
moving parts and worse for zero-touch enforcement (something has to launch it).

## Trade-offs

| | PKG (chosen) | DMG |
| --- | --- | --- |
| Runs install scripts (LaunchAgent, daemon bootstrap, config) | ✅ | ❌ copy-only |
| Files outside `/Applications` | ✅ | ❌ |
| Fits a CLI/daemon payload | ✅ native | ❌ needs a `.app` wrapper |
| Notarize + staple | ✅ | ✅ (not a differentiator) |
| Signing cert | Developer ID **Installer** (`productsign`) | Developer ID **Application** (`codesign`) |
| Zero-touch enforcement | ✅ install-and-runs | ⚠️ needs first launch / login item |
| IT familiarity / self-service feel | neutral | ✅ |

## Consequences

- Releases sign with a **Developer ID Installer** certificate and notarize via
  `notarytool` (see `macos/build-pkg.sh`, `../../.github/workflows/client.yml`).
- **When DMG would be revisited:** an *optional / Self-Service* path where users
  opt in rather than zero-touch enforcement. That is additive — a `.app` + DMG
  alongside the PKG, not a replacement — and is out of scope until requested.
