# Observer on Kubernetes — OCI Helm chart

A hardened, GitOps-ready Helm chart for the Observer **ingestor** (the
telemetry API). It is published as a **versioned OCI artifact** and consumed
from a **separate, private config repo** via Flux or Argo CD. This keeps the
reusable, generic deployment logic here (public, maintained centrally) and all
site-specific values out of this repo entirely.

## Why this shape (vs. forking)

The chart is the product's deployment contract; your environment is config.
Splitting them means:

- **You never edit a file we maintain.** No rebase conflicts when you pull our
  security fixes — you only pin a newer chart version.
- **Secrets and topology never enter this repo.** Registries, hostnames,
  CIDRs, role ARNs, and secret references live in your config repo (or, for
  secrets, only in your secret store — never git).
- **One artifact, any GitOps tool.** The same signed chart is driven by Flux
  (`HelmRelease`) or Argo CD (`Application`) — that choice is yours and lives
  on your side. Nothing tool-specific is shipped here.

```
┌─ public: github.com/<org>/observer ──────────────┐   ┌─ your private config repo ─────────┐
│ packages/**          product code                │   │ helmrelease.yaml / application.yaml │
│ deploy/eks/chart/**  this chart (secure defaults) │   │   image digest, hostnames, CIDRs,   │
│ .github/workflows    build · sign · scan · publish│   │   IRSA ARN, secret-store refs       │
└──────────────┬────────────────────────────────────┘   └──────────────┬──────────────────────┘
               │ publish: OCI chart + signed image                       │ GitOps reconcile
               ▼                                                         ▼
        oci://<registry>/charts/observer-ingestor  ◀── pinned by ──  Flux / Argo CD ──▶ EKS
                                                                          │
                                                       secret values ◀────┘ External Secrets → AWS Secrets Manager
```

## Override contract

Secure-by-default and **fail-closed**: the chart refuses to render until you
supply the required values. CI proves this (a render with empty defaults must
error).

**Required** (set in your overlay):

| Value | What |
| --- | --- |
| `image.repository` + `image.digest` (or `image.tag`) | Image from a trusted registry; pin by digest. |
| `config.s3Bucket`, `config.s3Region` | Lakehouse bucket (when `config.storage: s3`). |
| `secret.existingSecret` **or** `externalSecret.*` | Source of `OBSERVER_API_KEYS`. Never set the key in values. |
| `serviceAccount.annotations` (IRSA role ARN) | Scoped, short-lived AWS creds — no static keys. |

**Hardened defaults** (override only with reason): non-root + `RuntimeDefault`
seccomp + read-only rootfs + all caps dropped; default-deny `NetworkPolicy`
with an explicit egress allowlist; resource requests/limits; PDB; 2 replicas.

**Edge controls are the platform's:** TLS termination, WAF, the identity-aware
proxy / SSO that fronts user-facing paths, and IP-allowlisting of the ingest
API are configured on the operator's ingress (pass annotations via
`ingress.annotations`). This chart does not run its own edge.

## Consume it

**New to this? Follow [`CONSUMER.md`](./CONSUMER.md)** — the step-by-step
onboarding runbook (AWS prerequisites with IAM policy JSON, ESO + secret setup,
the apply sequence for Flux/Argo, and verification).

See `examples/`:

- `flux-helmrelease.yaml` — `OCIRepository` + `HelmRelease` (with optional
  cosign verification).
- `argocd-application.yaml` — the Argo CD equivalent.
- `clustersecretstore-aws.yaml` — example ESO store backed by AWS Secrets
  Manager (auth via IRSA).

Copy one into your private config repo and replace every `<placeholder>`.

## Publish it (maintainers)

`helm push` to an OCI registry, then cosign-sign the pushed artifact. CI does
this on a `chart-v*` tag (`.github/workflows/chart.yml`); manually it is:

```bash
helm package deploy/eks/chart --destination dist
helm push dist/observer-ingestor-<version>.tgz oci://<registry>/charts
cosign sign <registry>/charts/observer-ingestor@<digest>
```

The chart version in `Chart.yaml` is what consumers pin — bump it on every
chart change.

## Validate locally

```bash
helm lint deploy/eks/chart -f deploy/eks/chart/ci/test-values.yaml
helm template t deploy/eks/chart -f deploy/eks/chart/ci/test-values.yaml | less
```

A throwaway `kind`/`k3d` cluster (or a dev EKS in your own account) is enough
to smoke-test a real install before touching any operator environment.

## Image

The signed image this chart references is built and published by
`.github/workflows/image.yml`: PRs build + Trivy-scan (fail on HIGH/CRITICAL) +
SBOM; a `v*` tag builds multi-arch, pushes to the registry
(`ghcr.io/<owner>/observer-ingestor` by default, or the `IMAGE_REPO` repo
variable), cosign-signs by digest, and uploads a CycloneDX SBOM. Pin
`image.digest` in your overlay to that published digest.

## Scope / not yet here

- **Ingestor API only.** Central dashboard hosting needs its own container
  image and is a follow-up.
- **Dashboard SSO/identity-header validation** and other product changes
  tracked in `docs/enterprise-deployment.md` are separate work items.
