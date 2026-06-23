#!/usr/bin/env bash
# Assemble — and optionally sign + notarize — the Observer macOS client .pkg
# for MDM distribution (Iru/Kandji Custom App). Operator-agnostic: every
# identity/credential comes from the environment; nothing customer-specific is
# committed. Run from the repo root after compiling the binary.
#
# Required:
#   BINARY            path to the compiled `observer` binary
#   VERSION           package version, e.g. 1.2.3
#
# Optional:
#   PKG_ID            bundle identifier            (default: com.observer.agent)
#   OUT               output .pkg path             (default: dist/observer-macos-<VERSION>.pkg)
#   SIGN              1 = productsign + notarize    (default: 0 → unsigned, for PR gate)
#   INSTALLER_IDENTITY  "Developer ID Installer: Org (TEAMID)"  (required when SIGN=1)
#   NOTARY_PROFILE    notarytool keychain profile name          (required when SIGN=1)
#
# Layout installed on device:
#   /usr/local/observer/observer
#   /Library/LaunchAgents/com.observer.agent.plist
set -euo pipefail

: "${BINARY:?set BINARY to the compiled observer binary}"
: "${VERSION:?set VERSION (e.g. 1.2.3)}"
PKG_ID="${PKG_ID:-com.observer.agent}"
OUT="${OUT:-dist/observer-macos-${VERSION}.pkg}"
SIGN="${SIGN:-0}"

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

root="$work/root"
mkdir -p "$root/usr/local/observer" "$root/Library/LaunchAgents"
install -m 0755 "$BINARY" "$root/usr/local/observer/observer"
install -m 0644 "$here/com.observer.agent.plist" "$root/Library/LaunchAgents/com.observer.agent.plist"

mkdir -p "$(dirname "$OUT")"
unsigned="$work/component.pkg"
pkgbuild \
  --root "$root" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location "/" \
  --scripts "$here/scripts" \
  "$unsigned"

if [ "$SIGN" != "1" ]; then
  cp "$unsigned" "$OUT"
  echo "OK (unsigned): $OUT"
  exit 0
fi

: "${INSTALLER_IDENTITY:?SIGN=1 requires INSTALLER_IDENTITY}"
: "${NOTARY_PROFILE:?SIGN=1 requires NOTARY_PROFILE}"

productsign --sign "$INSTALLER_IDENTITY" "$unsigned" "$OUT"
xcrun notarytool submit "$OUT" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$OUT"
echo "OK (signed + notarized): $OUT"
