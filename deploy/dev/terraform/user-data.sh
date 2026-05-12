#!/bin/bash
# cloud-init for the ingestor host. Bare minimum to land on a host with
# docker + docker compose available; the actual stack is brought up by
# the operator following the steps in outputs.next_steps.
set -euo pipefail

dnf update -y

# docker + docker-compose-plugin from the AL2023 distro package set.
# The previous version curl'd both plugins from GitHub Releases with
# `releases/latest` as the version and no checksum verification — a
# GitHub-release replacement or TLS interception would land RCE on the
# ingestor host at boot. AL2023 ships current versions of both plugins
# in dnf, signed and integrity-checked by the package manager. Closes
# OBS-012 from the 2026-05 review.
dnf install -y docker docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ec2-user

# git is convenient for shipping the repo onto the host (alternative to scp).
dnf install -y git
