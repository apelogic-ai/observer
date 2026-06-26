# Deploying Observer as a production service on enterprise EKS

This is the generic readiness guide for running Observer inside an enterprise
Kubernetes platform that enforces a production-service security policy. It maps
the controls such policies typically require to Observer's current state and the
work needed to close the gaps. It is intentionally vendor-neutral — substitute
your platform operator's specifics (registry, IdP, SIEM, IP ranges) via the
private config overlay described in `deploy/eks/README.md`.

## Deployment model

- **Shared EKS via GitOps.** The platform operator runs the cluster; Observer
  is deployed by a GitOps controller (Flux or Argo CD) reconciling a private
  config repo that pins our **OCI Helm chart** (`deploy/eks/chart`) and a
  signed image from a trusted registry.
- **Edge is the operator's.** TLS, WAF, the identity-aware proxy / SSO that
  fronts user-facing paths, and IP-allowlisting of the ingest API live on the
  operator's ingress. Observer integrates; it does not run its own edge.
- **Infra security is the operator's; we integrate.** WAF, vulnerability
  scanning, the central SIEM, account-level threat detection (e.g.
  GuardDuty/Security Hub/Config), backups, cluster API-server restriction, and
  node patching are operated centrally. Our job is to plug in and hand over the
  artifacts they need (clean log formats, scan targets, named owners,
  manifests).

## Why Observer classifies as "production"

Observer is internet-exposed, processes confidential company data (AI-agent
traces containing source code, prompts, and developer identity), and is fronted
by corporate SSO. It also **stores** prompts and tool-call telemetry, so
AI-specific data controls apply to the stored data and the MCP surface even
though Observer does not proxy live LLM traffic. Treat it as a production
service requiring a security assessment and an AI-security review before
rollout.

## Control mapping (current state → gap → owner)

Legend — **Us** = Observer change; **Op** = platform operator; **Shared**.

### Deployment & supply chain
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| GitOps deploy (Flux/Argo) | Helm chart published as OCI artifact (`deploy/eks/chart`) | Done for the ingestor; dashboard hosting is a follow-up | Us |
| Image from trusted registry | Multi-arch image built, pushed, scanned (Trivy), SBOM'd in CI (`.github/workflows/image.yml`) | Point `IMAGE_REPO` at the operator's registry; provide creds | Us + Op (registry creds) |
| Signed & verified artifacts | Binaries, chart, and **container image** all cosign-signed (keyless) | Enable verification policy (Flux/Kyverno) where supported | Us |
| Ingress via WAF + identity-aware proxy | Chart exposes `Ingress` (annotations operator-supplied) | Operator fronts it; we pass annotations | Op / Us (manifest) |
| Ingest API IP-allowlisted | Separate ingress path supported | Operator attaches the allowlisted, WAF'd ALB | Op / Us |

### Infrastructure security
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| Named owners + inventory | Not documented | Assign business/technical/security owners; register in the operator's inventory | Us |
| No public DB/storage | S3 has Block Public Access + SSE + versioning | Carry into deploy; no public PVC/bucket | Us |
| Threat detection (GuardDuty/Config/etc.) | None of ours | Operator enables at account level | Op |
| S3 object-lock + retention | BPA + versioning present; no object-lock | Add object-lock/retention + data classification for the lakehouse | Us |
| Least-priv IAM | Bucket-RW only, no delete | Use **IRSA** per-pod scoped to the one bucket | Us |
| RBAC least privilege | n/a | Minimal namespace Role/RoleBinding; never cluster-admin | Us |
| NetworkPolicy (pod-to-pod) | Chart ships default-deny + egress allowlist | Operator supplies their CIDRs/selectors | Us + Op |
| Restrict workload egress | Chart egress allowlist (DNS + S3/STS) | Same — mandatory for this workload | Us |
| Image scanning | None in CI | Add Trivy (fail on High/Critical); pull only from trusted registry | Us |
| Resource quotas/limits | Chart sets requests/limits + PDB | Operator may add namespace `ResourceQuota` | Us + Op |
| Node/add-on patching, API-server restriction | n/a | Operator-owned | Op |

### Vulnerability management
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| Central scanning of prod assets | Not enrolled | Operator scans; we register endpoints as targets, provide auth-scan creds | Op + Us |
| Named remediation owner + SLA tracking | None | Assign owner; track findings with severity SLAs | Us |

Adopt the stricter of the policy's remediation SLAs: **Critical 7d, High 30d,
Medium 60d, Low 90d / best-effort**. Exceptions require documented approval +
compensating controls.

### Logging & monitoring
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| Centralized collection → SIEM or cloud logs | API logs JSON to stdout; dashboard to a local rotating file | Ship container stdout to the central SIEM / cloud logs (operator runs the collector; we emit clean JSON) | Op / Us (format) |
| Auth/authz/admin/audit events | Request access log + dedicated audit events for authn success/failure, authz failure, and rate-limit blocks (hashed identities, `audit:true`) | Add data-access/MCP-tool-call audit events | Us |
| Retention: 3mo general / 1yr audit | Local rotation only | Set retention in the central store; declare which logs are "audit" | Op + Us |

### Secrets management
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| No secrets in source/CI/plaintext config | API keys came from a host `.env` in the legacy VM deploy | Chart sources `OBSERVER_API_KEYS` only from a Secret (existing or via External Secrets → secret manager); never values/git | Us |
| Encrypted at rest + in transit | K8s Secret base64 unless KMS-backed | Operator enables cluster secrets KMS envelope encryption | Op + Us |
| Least privilege + auditable | n/a | IRSA per-pod; secret-store access logged centrally | Us |
| Rotation; prod≠dev creds; minimize static | Static keys, manual rotation | Document rotation; per-developer keys; prefer OIDC short-lived creds in CI | Us |

### Application security / Secure SDLC
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| Peer review before merge | Enforced (branch→PR→review) | Confirm branch protection on GitHub | Us |
| Secret detection in CI | Agent-side redaction exists; no CI gate | Add gitleaks (blocking) | Us |
| SAST | ESLint only | Add CodeQL/Semgrep | Us |
| Dependency scanning | CVE pins exist; no recurring scan | Add `bun audit`/OSV + Dependabot + Trivy fs | Us |
| DAST | None | OWASP ZAP baseline against a staged deploy | Us |
| SBOM | None | Generate CycloneDX for binary + image; attach to releases | Us |
| Build provenance/traceability | cosign ties artifact↔workflow | Add SLSA provenance linking commit→image→scan→release | Us |
| Security assessment for internet-facing | Not requested | Request from the operator's product-security team | Us |

### AI-specific controls (stored telemetry + MCP surface)
| Control | Current state | Gap | Owner |
| --- | --- | --- | --- |
| AI-security review before rollout | Not done | **Gating** — schedule with the operator's AI-security function | Us + Op |
| Guardrails enforced in code | Agent-side redaction **+ server-side redaction at ingest + server-side disclosure floor** (ingestor clamps every entry to a configured max level regardless of client config — `OBSERVER_MAX_DISCLOSURE`/per-device, defends against a root user raising disclosure in `config.yaml`) | Keep redaction patterns + disclosure tiers in sync with the agent | Us |
| Least-privilege tool/data access | API auth tenant-bound | Carry into IRSA + RBAC | Us |
| Full audit of data access / tool calls / prompts; GDPR retention | Auth/authz/rate audit events present | Add per-trace-read + MCP-tool-call audit events; define GDPR retention/erasure | Us |
| Rate limits, per-principal budget caps, anomaly detection | **Per-principal rate limiting** at ingest (120/min default) | Add token/tool-call budget caps + anomaly alerting | Us |
| Egress allow-listing | Chart egress allowlist | Done at the chart layer; keep tight | Us |
| Untrusted MCP input sanitized | MCP server present | Sanitize/validate external MCP input before storage/LLM | Us |

## Repo & config topology

- **Public repo (this one):** product code, the OCI Helm chart with secure
  defaults, and the CI that builds/signs/scans/publishes artifacts. No operator
  specifics, ever.
- **Private config repo (operator-side):** GitOps controller manifests
  (Flux/Argo), the values overlay (image digest, hostnames, CIDRs, IRSA ARN,
  secret-store refs), and references to secrets. Secret *values* live only in
  the secret manager.

This split lets operators pull our security fixes by bumping a pinned chart
version, with no merge conflicts and no leakage of their topology into public
git. See `deploy/eks/README.md` for the override contract and consumer examples.

## Client bundle distribution (MDM / Iru)

The EKS chart deploys the **server** (ingestor). The **client** — the per-laptop
agent that collects, redacts, signs, and ships traces — is distributed to a
managed fleet via MDM, today [Iru](https://www.iru.com/) (formerly Kandji). Same
topology doctrine, one tier down: generic mechanism is public, operator
specifics are private, credentials live in the MDM/secret manager.

- **Public repo:** the binary; `deploy/client/` packaging scaffold (macOS pkg
  builder, LaunchAgent, postinstall, `config.example.yaml`); and the
  `client.yml` CI that compiles → signs/notarizes → SBOMs → publishes to Iru.
- **Private operator repo:** the real `config.yaml` (ingestor URL, org/project
  filters, retention); Iru Blueprint / Assignment-Map definitions and ring group
  names; the promotion workflow.
- **Iru / secret manager:** the signed `.pkg` + Custom-App assignments;
  enrollment tokens / device certs; any bearer key.

**Secrets — ship none.** The agent generates a per-install Ed25519 keypair on
first run; the private key never leaves the device (keychain-backed, Secure
Enclave on Apple Silicon) and signs every batch. The ingestor trusts the
registered **public key**, so the fleet distributes no shared secret and
revocation is per-device (`config.example.yaml` uses `auth: none`). The only
bootstrap is enrollment (registering each public key) — deliver any token
out-of-band, never baked into the bundle. An MDM config profile is readable
on-device, so a static shared API key in a profile is an anti-pattern.

**Config delivery.** The agent searches `OBSERVER_CONFIG` → per-user
`config.yaml` → system path (`/Library/Application Support/Observer`,
`/etc/observer`, `%PROGRAMDATA%\Observer`) → defaults. MDM either drops a managed
default at the system path or pins it authoritatively via `OBSERVER_CONFIG` in
the LaunchAgent env; per-user state (keypair, cursors) stays under `~/.observer`.

**Gated rollout.** `client.yml` auto-publishes a `client-v*` build to a **Canary**
Iru Blueprint (an Assignment-Map rule scoped to a small identity group);
promotion to the **Broad** Blueprint runs behind a GitHub **Environment** with
required reviewers (the human gate), which calls the Iru API to extend the
Assignment Map after a soak. See `deploy/client/README.md` for the full
contract, required CI secrets/vars, and the local build recipe.

## Phased plan

1. **Process/gating (now):** assign owners; register in inventory; request
   security + AI-security reviews; confirm branch protection.
2. **Deploy artifacts:** OCI Helm chart ✓; image build→push→sign→scan→SBOM ✓;
   IRSA/External Secrets/NetworkPolicies/RBAC expressed in the chart ✓ (operator
   supplies values).
3. **Product changes:** server-side redaction ✓; per-principal rate limiting ✓;
   auth/authz audit logging ✓. Remaining: SSO/identity-header validation;
   token/tool-call budget caps + anomaly detection; data-access/MCP audit
   events; S3 object-lock + retention; GDPR erasure.
4. **CI/SDLC:** SAST, dependency scan, secret scan, SBOM, SLSA provenance, DAST.
5. **Logging/monitoring:** SIEM/cloud-log forwarding + retention; register scan
   targets.
6. **Client distribution (MDM):** agent config search path ✓; macOS pkg
   scaffold + `client.yml` build→sign→notarize→SBOM ✓. Remaining: wire the Iru
   Custom-App publish + Assignment-Map rings; per-device Ed25519 enrollment flow
   at the ingestor; Windows/Linux packaging.

Each engineering item follows the repo's TDD + branch→PR workflow
(`AGENTS.md`).
