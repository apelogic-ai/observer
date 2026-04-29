#!/bin/bash
# cloud-init for the ingestor host. Bare minimum to land on a host with
# docker + docker compose available; the actual stack is brought up by
# the operator following the steps in outputs.next_steps.
set -euo pipefail

dnf update -y
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

# docker compose v2 plugin
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# git is convenient for shipping the repo onto the host (alternative to scp).
dnf install -y git
