# Observer API — dev deployment

A single-instance dev environment for the API server (ingestor) on AWS,
backed by S3 storage. Caddy fronts it with HTTPS via Let's Encrypt.
Host access is via **AWS Session Manager** (SSM) — no SSH port, no
key pair management.

```
internet
    │
    ▼ DNS A record
api.dev.observer.apelogic.ai
    │
    ▼ ports 80/443
┌──────────────────────────┐
│ EC2 t4g.medium           │
│ ┌──────┐  ┌────────────┐ │      ┌───────────────────┐
│ │caddy │→ │observer-api│─┼────▶ │ S3 (versioned,    │
│ └──────┘  └────────────┘ │      │ encrypted, blocked│
│  TLS      stores in S3   │      │ from public)      │
└──────────────────────────┘      └───────────────────┘
```

## Layout

- `terraform/` — AWS resources (S3 bucket, EC2 + EIP, IAM with SSM +
  bucket-only RW, security group). Local state.
- `compose/` — Caddy + the api as a docker compose stack.

The terraform stand creates **infrastructure**. It does not bring up
the application stack — that's a manual step on the host so you can
iterate on the compose file without re-applying terraform.

## Prerequisites

- AWS account with an IAM user/role permissioned to create EC2 + S3 + IAM.
- AWS CLI configured (e.g., `aws configure --profile projectn`).
- `terraform >= 1.6`.
- AWS CLI **session-manager-plugin** installed locally:
  ```
  brew install --cask session-manager-plugin   # macOS
  # or follow https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
  ```
- Access to a DNS provider for `apelogic.ai` (NameCheap, etc.).
- A globally-unique S3 bucket name (e.g. `observer-dev-yourname`).

## Bootstrap

### 1. Configure terraform

```bash
cd deploy/dev/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars     # set bucket_name, domain_name
```

### 2. Apply

```bash
export AWS_PROFILE=projectn       # or whichever profile owns the dev account
terraform init
terraform apply
```

The output prints:
- `public_ip` — Elastic IP of the host
- `instance_id` — EC2 instance ID (SSM target)
- `ssm_command` — copy-paste shell command
- `bucket_name` — the S3 bucket terraform created
- `next_steps` — the manual remainder

### 3. DNS

At your DNS provider (NameCheap for `apelogic.ai`):

| Type | Host | Value |
|------|------|-------|
| A | `api.dev.observer` | `<public_ip from step 2>` |

Wait for propagation (`dig api.dev.observer.apelogic.ai +short` should
return the EIP).

### 4. Open a shell on the host

No SSH, no .pem file. Open a session via SSM:

```bash
aws ssm start-session --target <instance_id>
```

You land as the `ssm-user`. Drop to `ec2-user` for the workflow:

```bash
sudo -u ec2-user -i
```

### 5. Clone the repo on the host

The compose stack builds from source, so the host needs the repo:

```bash
git clone https://github.com/apelogic-ai/observer.git
cd observer/deploy/dev/compose
```

### 6. Configure the stack

```bash
cp .env.example .env
vi .env
```

Set:
- `DOMAIN=api.dev.observer.apelogic.ai`
- `OBSERVER_API_KEYS=` (generate with `openssl rand -hex 32`)
- `OBSERVER_S3_BUCKET=` (from terraform output)
- `OBSERVER_S3_REGION=` (matches `aws_region` from terraform.tfvars)

**Don't set `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`** —
credentials come from the EC2 instance role attached by terraform.
The container uses the SDK's standard credential chain, which picks
up instance metadata automatically.

### 7. Bring it up

```bash
docker compose up -d --build
docker compose logs -f
```

Watch for `Listening on http://localhost:19900` from the api container.
Caddy provisions the cert on its first inbound 80 hit (a few seconds).

### 8. Verify

From your laptop:

```bash
curl -fsSL https://api.dev.observer.apelogic.ai/health
# {"status":"ok"}

curl -X POST https://api.dev.observer.apelogic.ai/api/ingest \
  -H "Authorization: Bearer <one of your OBSERVER_API_KEYS>" \
  -H "Content-Type: application/json" \
  -d '{"developer":"you@example.com","machine":"laptop","agent":"claude_code","project":"smoke","sourceFile":"/x","shippedAt":"2026-04-29T00:00:00Z","entries":["{\"a\":1}"]}'
# {"status":"ok","entryCount":1}
```

Check the bucket:

```bash
aws s3 ls s3://observer-dev-yourname/raw/ --recursive
```

You should see one `.jsonl`, one `.meta.json`, and one `dedup/` marker.

## Operating

| Action | Command |
|--------|---------|
| Open shell | `aws ssm start-session --target <instance_id>` |
| Tail logs | `docker compose logs -f observer-api` (on host) |
| Restart | `docker compose restart observer-api` (on host) |
| Update binary (after `git pull`) | `git pull && docker compose up -d --build` (on host) |
| Rotate keys | edit `.env`, then `docker compose up -d` (on host) |
| Tear down stack only | `docker compose down` (on host) |
| Tear down everything | `terraform destroy` (delete bucket contents first if it has objects, or set `force_destroy = true` on the bucket and re-apply) |

## Cost (rough)

| Resource | Monthly |
|----------|---------|
| t4g.medium | ~$25 |
| 50 GB gp3 EBS | ~$4 |
| EIP (attached) | $0 |
| S3 (1 GB stored, low req) | ~$0.10 |
| Data egress | usage-dependent |
| **Total** | **~$30/mo** |

## Promoting to non-dev

Things that need attention before this is anything but "dev":

1. **Remote terraform state** (S3 + DynamoDB lock table) instead of
   local `.tfstate`. Keep one workspace per environment.
2. **Multi-AZ + auto-scaling** — current setup is single-instance.
3. **Backups for state.** The bucket has versioning; add a lifecycle
   policy and cross-region replication.
4. **Real OAuth for the agent flow.** Bearer keys are fine for testing
   but won't survive an audit.
5. **Image registry.** Building from source on the host is simple but
   slow. Push images to ECR and pull instead.

This stack is intentionally minimal. The non-dev shape is documented
in `docs/product.md § 8`.
