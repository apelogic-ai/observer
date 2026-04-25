#!/bin/bash
# Observer install script — downloads the latest binary for your platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/apelogic-ai/observer/master/install.sh | bash
#
# Environment variables:
#   OBSERVER_VERSION  — specific version (default: latest)
#   OBSERVER_DIR      — install directory (default: ~/.local/bin)
#   OBSERVER_REPO     — owner/repo override (default: apelogic-ai/observer)

set -euo pipefail

REPO="${OBSERVER_REPO:-apelogic-ai/observer}"
INSTALL_DIR="${OBSERVER_DIR:-$HOME/.local/bin}"
BINARY_NAME="observer"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

info() { echo -e "${GREEN}$1${RESET}"; }
dim() { echo -e "${DIM}$1${RESET}"; }
error() { echo -e "${RED}Error: $1${RESET}" >&2; exit 1; }

# Detect platform
detect_platform() {
  local os arch target

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *)      error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *)             error "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# Get latest version from GitHub
get_latest_version() {
  local version
  version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
    | grep -o '"tag_name": "v[^"]*"' \
    | head -1 \
    | grep -o 'v[0-9.]*' \
    | head -1)

  if [ -z "$version" ]; then
    error "Could not determine latest version. Set OBSERVER_VERSION manually."
  fi
  echo "$version"
}

main() {
  echo ""
  info "Observer — AI agent trace collection"
  echo ""

  # Detect platform
  local target
  target=$(detect_platform)
  dim "Platform: $target"

  # Determine version
  local version
  if [ -n "${OBSERVER_VERSION:-}" ]; then
    version="$OBSERVER_VERSION"
    dim "Version: $version (from OBSERVER_VERSION)"
  else
    dim "Checking latest version..."
    version=$(get_latest_version)
    dim "Version: $version"
  fi

  local dest="${INSTALL_DIR}/${BINARY_NAME}"

  # Skip download if the installed binary is already at the target version.
  # `--version` prints just the bare semver (e.g. "0.1.2").
  if [ -x "$dest" ]; then
    local installed
    installed=$("$dest" --version 2>/dev/null | head -1 | tr -d 'v ' || true)
    local target_v
    target_v=$(echo "$version" | tr -d 'v ')
    if [ -n "$installed" ] && [ "$installed" = "$target_v" ]; then
      info "Already at v${target_v} — nothing to download."
      echo ""
      if [ -f "${HOME}/.observer/config.yaml" ]; then
        echo "Useful commands:"
        echo "  observer dashboard run   — open the dashboard"
        echo "  observer status          — show what's being collected"
        echo "  observer start / stop    — manage the background daemon"
        echo ""
      fi
      exit 0
    fi
    dim "Upgrading: v${installed:-?} → ${version}"
  fi

  # Download URL
  local url="https://github.com/${REPO}/releases/download/${version}/observer-${target}"
  local checksum_url="${url}.sha256"

  dim "Downloading observer-${target}..."

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download binary
  local tmp_file
  tmp_file=$(mktemp)
  if ! curl -fsSL "$url" -o "$tmp_file"; then
    rm -f "$tmp_file"
    error "Download failed. Check https://github.com/${REPO}/releases for available versions."
  fi

  # Verify checksum
  local tmp_checksum
  tmp_checksum=$(mktemp)
  if curl -fsSL "$checksum_url" -o "$tmp_checksum" 2>/dev/null; then
    local expected actual
    expected=$(awk '{print $1}' "$tmp_checksum")
    if command -v sha256sum &>/dev/null; then
      actual=$(sha256sum "$tmp_file" | awk '{print $1}')
    else
      actual=$(shasum -a 256 "$tmp_file" | awk '{print $1}')
    fi
    if [ "$expected" != "$actual" ]; then
      rm -f "$tmp_file" "$tmp_checksum"
      error "Checksum mismatch! Expected $expected, got $actual"
    fi
    dim "Checksum verified"
  fi
  rm -f "$tmp_checksum"

  # Install (dest declared at top for early-exit version check)
  mv "$tmp_file" "$dest"
  chmod +x "$dest"

  info "Installed to ${dest}"

  # Check PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -q "^${INSTALL_DIR}$"; then
    echo ""
    echo "Add to your shell profile:"
    echo ""
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
  fi

  echo ""

  # We don't auto-launch `observer init` from this script. Bun's readline
  # behavior is subtly different from Node's when stdin is reattached
  # to /dev/tty inside a curl-piped bash, and the wizard exits silently
  # after the first prompt. The init wizard works reliably in the user's
  # own shell where stdin is naturally an interactive tty.
  if [ -f "${HOME}/.observer/config.yaml" ]; then
    info "Upgraded to ${version} — existing ~/.observer/config.yaml preserved."
    echo ""
    echo "Useful commands:"
    echo "  observer dashboard run   — open the dashboard"
    echo "  observer status          — show what's being collected"
    echo "  observer start / stop    — manage the background daemon"
    echo ""
  else
    info "Next: run 'observer init' to set up"
    echo ""
    echo "  observer init            — interactive setup wizard"
    echo "  observer dashboard run   — open the dashboard once configured"
    echo ""
  fi
}

main
