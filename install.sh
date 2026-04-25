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

  # If a config already exists, treat this as an upgrade — don't re-run
  # init (which would overwrite the user's settings via writeConfig force=true).
  # Fresh installs auto-launch init by reattaching stdin to /dev/tty
  # (rustup/brew pattern) since curl-piped stdin is the pipe.
  # Override with OBSERVER_NO_INIT=1.
  if [ -f "${HOME}/.observer/config.yaml" ]; then
    info "Upgraded to ${version} — existing ~/.observer/config.yaml preserved."
    echo ""
    echo "Useful commands:"
    echo "  observer dashboard run   — open the dashboard"
    echo "  observer status          — show what's being collected"
    echo "  observer start / stop    — manage the background daemon"
    echo ""
  elif [ "${OBSERVER_NO_INIT:-}" = "1" ]; then
    info "Next: run 'observer init' to configure"
    echo ""
  elif [ -t 1 ] && [ -r /dev/tty ]; then
    # stdout is a real terminal AND we can read /dev/tty for the
    # interactive prompts. This is the rustup/nvm pattern.
    info "Running 'observer init'..."
    echo ""
    # `exec </dev/tty` reattaches THIS shell's stdin to the terminal so
    # the spawned `observer init` inherits a real tty. A per-command
    # `</dev/tty` redirect isn't enough — node:readline still gets EOF
    # from the closed curl pipe and bails after the first question.
    exec </dev/tty
    "$dest" init
  else
    info "Next: run 'observer init' to configure"
    echo ""
  fi
}

main
