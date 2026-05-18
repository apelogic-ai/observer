# Ansible deployment

Automates the host-side deployment that the top-level `README.md` walks
through manually: git clone, `.env` rendering, `docker compose up --build`,
and a health check. Terraform still provisions the infrastructure; ansible
takes over from "instance is running" to "stack is serving traffic."

Connection goes through **AWS SSM** — no SSH key, no port 22.

## Operator prerequisites

- Python 3 + `boto3`
- `ansible` >= 2.16
- AWS CLI configured with a profile that can:
  - `ssm:StartSession` on the target instance
  - `s3:PutObject`/`GetObject` on the SSM transfer bucket (the lakehouse
    bucket is fine — see `group_vars/all.yml`)
- `session-manager-plugin` installed locally
- Ansible collections:

  ```bash
  ansible-galaxy collection install community.aws community.docker
  ```

## One-time setup per environment

1. `terraform apply` and read off the outputs:

   ```bash
   cd ../terraform && terraform output
   ```

   You need `instance_id`, `bucket_name`, and the domain you used (e.g.
   `<eip>.nip.io`).

2. Fill in non-secret values:

   ```bash
   $EDITOR group_vars/all.yml
   ```

3. Drop in secrets:

   ```bash
   cp group_vars/secrets.yml.example group_vars/secrets.yml
   $EDITOR group_vars/secrets.yml      # generate keys with `openssl rand -hex 32`
   ```

   `secrets.yml` is gitignored.

## Deploy

```bash
export AWS_PROFILE=<the-profile-for-this-env>
# macOS only — Apple's fork-safety check kills ansible workers without this.
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
ansible-playbook playbook.yml
```

Idempotent — re-run anytime. To roll forward a code change, bump
`observer_repo_ref` (a tag or commit SHA) and re-run.

## Verify

From your laptop:

```bash
curl -fsSL https://<domain>/health
# {"status":"ok"}
```

## Notes

- The play installs the Docker apt repo packages on the host. Ubuntu
  user-data already does this on boot; the apt task is a safety net for
  rebuilt boxes.
- Compose builds from the cloned repo on the host — same model as the
  manual flow. Switching to ECR-published images is the right next step
  if build time on the box becomes painful.
- A change to `.env` triggers a restart of `observer-api` only (via the
  handler). Image rebuilds still apply across the whole stack.
