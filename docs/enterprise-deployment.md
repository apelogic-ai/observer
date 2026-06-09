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
| Image from trusted registry | API has a non-root `Dockerfile`; no image pipeline yet | Build multi-arch image → push to the operator's registry → cosign-sign → scan | Us + Op (registry creds) |
| Signed & verified artifacts | Binaries cosign-signed; chart signing wired in CI | Sign the **container image**; enable verification policy where supported | Us |
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
| Auth/authz/admin/audit events | Has request logs; missing dedicated authn/authz/audit events | Add the missing event types | Us |
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
| Guardrails enforced in code | Agent-side redaction | Add **server-side** redaction at ingest (defence in depth) | Us |
| Least-privilege tool/data access | API auth tenant-bound | Carry into IRSA + RBAC | Us |
| Full audit of data access / tool calls / prompts; GDPR retention | Request logs only | Add per-trace-read + MCP-tool-call audit events; define GDPR retention/erasure | Us |
| Rate limits, per-principal budget caps, anomaly detection | None | Per-API-key limits + ingest volume caps + token/tool-call anomaly alerts | Us |
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

## Phased plan

1. **Process/gating (now):** assign owners; register in inventory; request
   security + AI-security reviews; confirm branch protection.
2. **Deploy artifacts (this PR + follow-ups):** OCI Helm chart ✓; image
   build→push→sign→scan; IRSA; External Secrets; NetworkPolicies; least-priv
   RBAC.
3. **Product changes:** SSO/identity-header validation; audit logging; rate
   limits + budget caps + anomaly detection; server-side redaction; S3
   object-lock + retention; GDPR erasure.
4. **CI/SDLC:** SAST, dependency scan, secret scan, SBOM, SLSA provenance, DAST.
5. **Logging/monitoring:** SIEM/cloud-log forwarding + retention; register scan
   targets.

Each engineering item follows the repo's TDD + branch→PR workflow
(`AGENTS.md`).
