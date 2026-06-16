# Observer ingestor — consumer onboarding runbook

**Audience:** the platform/operations team deploying the Observer ingestor into
a shared EKS cluster via GitOps.

**Mental model:** you do **not** fork this repo. You keep a small **private
config repo** that points at our published, signed **OCI Helm chart** by version
and supplies your environment's values. You pull our security fixes by bumping
the pinned chart version — no rebases, no edits to files we maintain. See
`README.md` for the why; this file is the step-by-step *how*.

Everything below is done once per environment. Items marked **(prereq)** are
infrastructure you stand up in your own account/cluster before the chart can
reconcile.

---

## 0. Prerequisites

- An EKS cluster with an **IAM OIDC provider** enabled (for IRSA).
- **External Secrets Operator (ESO)** installed in the cluster *(step 4)*.
- A **GitOps controller** already running: Flux **or** Argo CD.
- An **identity-aware proxy + WAF** in front of user-facing paths, and an
  **IP-allowlisted ALB** for the ingest API *(step 6 — your platform's edge)*.
- Tooling locally: `aws`, `kubectl`, `helm` ≥ 3.14 (OCI support), and
  optionally `cosign` to verify signatures.
- Decide two names you'll reuse throughout:
  - **namespace** — e.g. `observer`
  - **release/app name** — pin `fullnameOverride: observer-ingestor` so the
    ServiceAccount name is deterministic (the IRSA trust policy in step 2
    references it). With this, the ServiceAccount is
    `observer-ingestor` in namespace `observer`.

---

## 1. (prereq) Create the S3 lakehouse bucket

The ingestor writes trace batches to one S3 bucket. Create it with public
access blocked, encryption, and versioning. Add Object Lock/retention if your
data-classification policy requires write-once.

```bash
AWS_REGION=<region>
BUCKET=<your-lakehouse-bucket>

aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
```

> Or create the equivalent in your own Terraform/IaC. The chart never creates
> AWS resources.

---

## 2. (prereq) Create the IRSA role (scoped S3 access — no static keys)

The pod gets short-lived AWS credentials from an IAM role assumed via the
cluster's OIDC provider. The role needs read/write on **only** the lakehouse
bucket — **no `s3:DeleteObject`** (deletion is a separate, audited workflow).

**Permissions policy** (`observer-ingestor-s3.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LakehouseRW",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::<your-lakehouse-bucket>",
        "arn:aws:s3:::<your-lakehouse-bucket>/*"
      ]
    }
  ]
}
```

**Trust policy** (`observer-ingestor-trust.json`) — binds the role to the
ServiceAccount from step 0. Replace the OIDC provider and the
namespace/serviceaccount `sub`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<oidc-id>" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:aud": "sts.amazonaws.com",
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:sub": "system:serviceaccount:observer:observer-ingestor"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role --role-name observer-ingestor \
  --assume-role-policy-document file://observer-ingestor-trust.json
aws iam put-role-policy --role-name observer-ingestor \
  --policy-name lakehouse-rw --policy-document file://observer-ingestor-s3.json
# Note the role ARN — you set it as serviceAccount.annotations in step 7.
```

---

## 3. (prereq) Create the API-keys secret in AWS Secrets Manager

The ingestor authenticates clients with `OBSERVER_API_KEYS`. The value is a
comma-separated list of `<developer>:<key>` entries — the developer prefix
binds each key to one tenant identity. Generate strong keys:

```bash
KEY=$(openssl rand -hex 32)
aws secretsmanager create-secret \
  --name observer/ingestor/api-keys \
  --secret-string "alice@your-org.com:$KEY"
# Add more entries comma-separated: "alice@org:k1,bob@org:k2"
```

The secret value is the **plaintext key list** (no JSON wrapper) — the
ExternalSecret in step 7 maps it straight into the `OBSERVER_API_KEYS` key.
**Never** put this value in git or in chart values.

Rotate by updating the secret; ESO re-syncs on its `refreshInterval`.

---

## 4. (prereq) Install External Secrets Operator + a ClusterSecretStore

The chart's `ExternalSecret` assumes ESO's CRDs exist. Install ESO (Helm chart
`external-secrets/external-secrets`) if it isn't already, then create a
`ClusterSecretStore` pointing at Secrets Manager, authenticated via IRSA on
ESO's own ServiceAccount (give that role `secretsmanager:GetSecretValue` on
`observer/ingestor/*`).

Use `examples/clustersecretstore-aws.yaml` as the template — replace the store
name, region, and ESO ServiceAccount.

---

## 5. (prereq) Make the signed image reachable + get its digest

The image is built, scanned, cosign-signed, and published by our
`image.yml` workflow (`ghcr.io/<owner>/observer-ingestor` by default).

- If your policy requires images from your own registry, **mirror** the
  released tag into it and pull from there (`image.repository`).
- **Pin by digest**, not tag. Get it:

  ```bash
  cosign verify <registry>/observer-ingestor:<version> \
    --certificate-identity-regexp '^https://github\.com/<owner>/observer/' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
  # then read the digest:
  crane digest <registry>/observer-ingestor:<version>   # or: docker buildx imagetools inspect
  ```

You'll set `image.digest: sha256:<...>` in step 7.

---

## 6. (prereq) Edge: identity-aware proxy, WAF, IP-allowlist

This chart does **not** run its own TLS/edge. Your platform provides:

- **User-facing paths** behind the identity-aware proxy (SSO/MFA) + WAF.
- **Ingest API** behind an **IP-allowlisted** ALB + WAF (machine-to-machine;
  the API authenticates with the keys from step 3, so it isn't behind the SSO
  proxy).

You surface these by passing your ingress controller's annotations through
`ingress.annotations` and setting `ingress.className` / `ingress.hosts` in
step 7. TLS terminates at the ALB (ACM cert) — not in the pod.

---

## 7. Create the private config repo and fill values

In your **private** config repo, drop in one of our examples and replace every
`<placeholder>`:

- Flux → `examples/flux-helmrelease.yaml` (`OCIRepository` + `HelmRelease`)
- Argo CD → `examples/argocd-application.yaml` (`Application`)

Minimum values to set (the chart is **fail-closed** — it won't render until
these are present):

| Value | From | Example |
| --- | --- | --- |
| `fullnameOverride` | step 0 | `observer-ingestor` |
| `image.repository` + `image.digest` | step 5 | `<registry>/observer-ingestor`, `sha256:…` |
| `config.s3Bucket`, `config.s3Region` | step 1 | your bucket, your region |
| `serviceAccount.annotations` | step 2 | `eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/observer-ingestor` |
| `externalSecret.enabled: true` + `secretStoreRef.name` + `remoteKey` | steps 3–4 | store name, `observer/ingestor/api-keys` |
| `ingress.enabled` + `className` + `annotations` + `hosts` | step 6 | your ALB/proxy |
| `networkPolicy.egress.allowHttpsCidrs` | your VPC | CIDRs for S3/STS (or VPC-endpoint ranges) |
| `networkPolicy.ingressFrom` | your cluster | selector for the ingress-controller namespace |

`OBSERVER_API_KEYS` is **not** a value — it arrives via the ExternalSecret.
Deploy the namespace into the `observer` namespace so the IRSA `sub` matches.

---

## 8. Let GitOps reconcile

Commit the manifests to your config repo and point your controller at it:

- **Flux:** add a `GitRepository`/`Kustomization` (or include the files in an
  existing one). `flux reconcile kustomization <name>`.
- **Argo CD:** register the `Application` (app-of-apps or `argocd app create`),
  then `argocd app sync observer-ingestor`.

The controller pulls the pinned chart from OCI, renders it with your values,
ESO populates the Secret, and the Deployment rolls out.

---

## 9. Verify

```bash
NS=observer

# Pods healthy, IRSA + secret wired
kubectl -n $NS rollout status deploy/observer-ingestor
kubectl -n $NS get externalsecret,secret,sa,networkpolicy

# Health (in-cluster, or through your ingress host)
kubectl -n $NS port-forward deploy/observer-ingestor 19900:19900 &
curl -fsS http://localhost:19900/health        # {"status":"ok"}

# End-to-end ingest with a real key from step 3
curl -fsS -X POST http://localhost:19900/api/ingest \
  -H "Authorization: Bearer <the key half of one OBSERVER_API_KEYS entry>" \
  -H "Content-Type: application/json" \
  -d '{"developer":"<the developer half of the same entry>","machine":"smoke","agent":"claude_code","project":"smoke","sourceFile":"/x","shippedAt":"2026-01-01T00:00:00Z","entries":["{\"a\":1}"]}'
# {"accepted":true}

# Object landed in the lakehouse
aws s3 ls "s3://<your-lakehouse-bucket>/raw/" --recursive | head
```

Check the pod logs for the structured `audit` events (auth_success, etc.) and
confirm they reach your central SIEM (the operator's log pipeline).

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Helm render error: `image.repository is required` / `secret.existingSecret … must come from a Secret` | A required value (step 7) is missing — fail-closed by design. |
| Pod `CreateContainerConfigError` / Secret not found | ESO hasn't synced: check the `ExternalSecret` status, the `ClusterSecretStore`, and ESO's IRSA permission to read the secret. |
| Pod runs but S3 writes 403 / `AccessDenied` | IRSA trust `sub` doesn't match `system:serviceaccount:<ns>:<sa>` (step 2/0), or the permissions policy bucket ARN is wrong. |
| All ingest requests `401` | The `OBSERVER_API_KEYS` value isn't a valid `<developer>:<key>` list, or the client's `developer` field doesn't match the key's bound developer. |
| Ingest `429` | Per-principal rate limit (default 120/min). Tune via the `OBSERVER_RATE_LIMIT_RPM` env (set through the chart) if legitimately higher. |
| Pod can reach the internet broadly | Tighten `networkPolicy.egress.allowHttpsCidrs` — egress should be S3/STS + DNS only. |

---

See `docs/enterprise-deployment.md` for the full control-mapping and the
ownership split between your platform team and the Observer maintainers.
