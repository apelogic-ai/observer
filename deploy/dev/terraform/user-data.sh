#!/bin/bash
# cloud-init for the ingestor host. Bare minimum to land on a host with
# docker + docker compose available; the actual stack is brought up by
# the operator following the steps in outputs.next_steps.
set -euo pipefail

dnf update -y
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

# docker compose + buildx plugins. The buildx that ships in the AL2023
# docker package is too old for compose-with-build (compose v2 requires
# buildx ≥ 0.17). Install both as cli-plugins from GitHub releases so we
# get a current pair.
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/v0.18.0/buildx-v0.18.0.linux-arm64" \
  -o /usr/libexec/docker/cli-plugins/docker-buildx
chmod +x /usr/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-buildx

# git is convenient for shipping the repo onto the host (alternative to scp).
dnf install -y git
