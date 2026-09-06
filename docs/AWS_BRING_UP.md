# Bringing Up the Control Plane on AWS

This stands the Open-Inspect control plane up on AWS, from an empty account to `/healthz` answering
over HTTPS at a hostname you choose. **No Cloudflare account is involved at any point.** TLS is a
Let's Encrypt certificate that Caddy obtains on the instance; DNS is whatever you already run.

What you get is one EC2 instance running the same `docker compose` stack CI boots on every pull
request, with a persistent EBS volume under it, S3 for media and backups, and its logs in
CloudWatch.

Two environments are defined: `terraform/environments/aws-staging` (a `t4g.small`, stopped outside
working hours) and `terraform/environments/aws-production` (a `t4g.large`, always on). They are the
same module with different sizes.

## Before you start

- An AWS account and credentials with permission to create VPC, EC2, EBS, S3, ECR, IAM, SSM,
  CloudWatch and EventBridge Scheduler resources.
- Terraform >= 1.14, the AWS CLI v2, and the Session Manager plugin (`session-manager-plugin`).
- A hostname you control the DNS for.
- A GitHub App for the control plane, as on any other deployment.

## 1. A state bucket

Once per account. The bucket name has to be globally unique, so it is not in the repository.

```bash
REGION=us-west-2   # must match the `region` variable in terraform.tfvars

aws s3api create-bucket --bucket open-inspect-terraform-state-$ACCOUNT_ID \
  --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-bucket-versioning --bucket open-inspect-terraform-state-$ACCOUNT_ID \
  --versioning-configuration Status=Enabled
```

```bash
cd terraform/environments/aws-staging
cp backend.tfvars.example backend.tfvars      # fill in bucket and region
cp terraform.tfvars.example terraform.tfvars  # fill in hostname
terraform init -backend-config=backend.tfvars
```

Both files are gitignored.

## 2. First apply

```bash
terraform apply
```

This creates everything but a working stack: the instance boots, mounts its volume, fetches the
compose files, builds `.env` from SSM — and then fails to start, because the image does not exist
yet and the secrets are placeholders. That is expected. Take the outputs:

```bash
terraform output public_ip      # point DNS here
terraform output ecr_repository_url
terraform output secret_parameter_names
```

## 3. DNS

Create an **A record** for your hostname pointing at `public_ip`, on whatever DNS you run. Nothing
in this module needs access to it.

Caddy's certificate comes from an ACME HTTP-01 challenge, so Let's Encrypt has to reach port 80 at
that name. If your DNS provider offers a proxying or "cloud" mode, the record must be a **plain A
record, not proxied** — a proxy terminates TLS itself, which is the thing this deployment exists to
avoid.

If you would rather Terraform created the record, set `route53_zone_id` and re-apply.

## 4. Secrets

The module creates one SecureString parameter per key, each holding a `CHANGE_ME_` placeholder, and
never reads the value back — the value is write-only, so Terraform owns the inventory and the state
file never contains a secret. Setting one is entirely out of band.

A parameter still holding its placeholder is **left out of `.env` rather than written through**.
That matters most for the four `SERVICE_AUTH_SECRET_*` keys: they are HMAC signing keys used exactly
as given, with no length or format check, so a placeholder — a value published in this repository —
would be a working credential for anyone who read it. Unset, they are a `500` instead. The instance
logs every key it skipped for this reason.

List what is still unset:

```bash
PREFIX=$(terraform output -raw ssm_env_prefix)
aws ssm get-parameters-by-path --path "$PREFIX" --recursive --with-decryption \
  --query 'Parameters[?starts_with(Value, `CHANGE_ME_`)].Name' --output table
```

Values reach `put-parameter` through a file rather than the command line, so they stay out of shell
history and out of `ps` while the call runs:

```bash
put() { # value on stdin
  umask 077
  local request; request="$(mktemp)"
  python3 -c 'import json,sys; json.dump(
      {"Name": sys.argv[1], "Value": sys.stdin.read().rstrip("\n"),
       "Type": "SecureString", "Overwrite": True}, open(sys.argv[2], "w"))' \
    "$PREFIX/$1" "$request"
  local status=0
  aws ssm put-parameter --cli-input-json "file://$request" >/dev/null || status=$?
  rm -f "$request"
  if [ "$status" -ne 0 ]; then
    echo "FAILED to set $1" >&2
    return "$status"
  fi
  echo "set $1"
}
```

### The whole inventory

Sixteen keys. The first five are the only ones the host refuses to start without; the rest disable a
feature when unset rather than blocking a boot.

```bash
# Required at boot. 32 bytes each, rejected at any other length. Generate once
# and keep them: rotating one invalidates everything it encrypted.
openssl rand -base64 32 | put TOKEN_ENCRYPTION_KEY
openssl rand -base64 32 | put PROVIDER_ACCOUNTS_ENCRYPTION_KEY
openssl rand -base64 32 | put REPO_SECRETS_ENCRYPTION_KEY
openssl rand -base64 32 | put BROWSER_AUTH_SECRET
openssl rand -base64 32 | put IMAGE_CALLBACK_TOKEN_PEPPER

# Service-to-service signing keys, one per caller. Set the ones you run; the
# others stay unset, which is a refusal rather than a weak key. The web app's
# own SERVICE_AUTH_SECRET must equal SERVICE_AUTH_SECRET_WEB.
openssl rand -base64 32 | put SERVICE_AUTH_SECRET_WEB
openssl rand -base64 32 | put SERVICE_AUTH_SECRET_SLACK_BOT
openssl rand -base64 32 | put SERVICE_AUTH_SECRET_GITHUB_BOT
openssl rand -base64 32 | put SERVICE_AUTH_SECRET_LINEAR_BOT

# The sandbox provider. Both environments select Modal, and this is the shared
# HMAC secret between the control plane and the Modal deployment; without it the
# stack answers /healthz and cannot spawn a session. Another provider's key
# replaces this entry through the `secret_names` variable.
openssl rand -hex 32 | put MODAL_API_SECRET

# GitHub App, for repository access and git operations.
printf '123456'   | put GITHUB_APP_ID
printf '12345678' | put GITHUB_APP_INSTALLATION_ID
printf 'Iv1....'  | put GITHUB_CLIENT_ID
printf '....'     | put GITHUB_CLIENT_SECRET

# Models.
printf 'sk-ant-....' | put ANTHROPIC_API_KEY
```

**The GitHub App private key has to be on one line.** `.env` is one assignment per line, so a PEM
with real newlines would truncate at the first one and take the rest of the file with it. The
instance refuses to write a multi-line value rather than doing that silently. Convert it first:

```bash
awk '{printf "%s\\n", $0}' key-pkcs8.pem | put GITHUB_APP_PRIVATE_KEY
```

The key must be PKCS#8, as on Cloudflare:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
```

A value may not contain a single quote. `.env` is read twice by Compose — to interpolate the compose
files, and as the app's environment — and both readers expand `$VAR` and strip a trailing `#`
comment from an unquoted value, so every value is written single-quoted, which is the one form that
cannot contain its own quote. The instance rejects such a value rather than corrupting it.

Non-secret values — access-control lists, `WEB_APP_URL`, the sandbox provider's non-secret settings
— go in the `config` map in `terraform.tfvars`, not here. **Anything in that map lands in the state
file**, so nothing secret belongs in it.

Adding a key the module does not know about — another provider's token — means adding it to the
`secret_names` variable, which replaces the inventory rather than extending it. Removing a name from
that set deletes the parameter, and the operator's value with it.

## 5. Push an image

The instance runs an image, not a build; it has no checkout. Build for **arm64** — the instance is
Graviton, and there is no amd64 fallback.

```bash
REGISTRY=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REGISTRY%%/*}"

docker buildx build --platform linux/arm64 \
  -f packages/control-plane/Dockerfile \
  -t "$REGISTRY:latest" --push .
```

Once I-3 lands this is CI's job, and the deploy is a tag push plus step 6.

## 6. Start it

Every restart re-fetches the compose files from S3, rebuilds `.env` from SSM and re-pulls the image,
so this is also how a deploy and a configuration change take effect. It is never a new instance.

```bash
INSTANCE=$(terraform output -raw instance_id)
aws ssm start-session --target "$INSTANCE"

# on the instance
sudo systemctl restart open-inspect
sudo systemctl status open-inspect
```

Then, from anywhere:

```bash
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://<your-hostname>/healthz
# 200 0
```

## Watching it

Container logs go from the Docker daemon to CloudWatch, one stream per service. Docker also keeps a
local cache, so `docker compose logs` on the instance generally still answers; CloudWatch is the one
that survives the instance being replaced, and it is what the runbook uses:

```bash
aws logs tail "$(terraform output -raw log_group_name)" --follow
```

### A first boot logs one certificate error

The first ACME attempt commonly fails with
`HTTP 404 ... urn:ietf:params:acme:error:malformed - Certificate not found`, _after_ the
authorization has already gone `valid`. Caddy retries about a minute later and succeeds. A healthy
first boot therefore logs one alarming certificate error; wait for the retry before treating it as a
failure.

If it is still failing after a few minutes, the causes in order of likelihood are: DNS not yet
resolving to the Elastic IP, the record proxied rather than plain, or port 80 unreachable — check
`ingress_cidrs`, which must admit the internet for the challenge to work.

## Changing things

| What changed                         | What to do                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| A secret in SSM                      | `systemctl restart open-inspect`                                  |
| A `config` entry, or a compose file  | `terraform apply`, then `systemctl restart open-inspect`          |
| The image                            | Push the tag, then `systemctl restart open-inspect`               |
| The instance's user data, or the AMI | `terraform apply -replace=module.control_plane.aws_instance.this` |

The instance ignores changes to `ami` and `user_data` on purpose. AWS moves the Amazon Linux 2023
parameter whenever it publishes an image, and replacing this instance drops every in-flight session,
so it is something you ask for rather than something a routine plan proposes.

## Backups and restore

Two layers, and they cover different things.

**The data volume** is the deployment. Docker's data root sits on it, so the global store, every
session database, the host alarm index and the images are all on it. Data Lifecycle Manager
snapshots it daily, scoped to this deployment's volume, and keeps `snapshot_retention_count` of
them.

Restoring into a fresh environment is just `data_volume_snapshot_id` plus an apply. Restoring an
existing one in place needs the current volume released first, because `prevent_destroy` and
`ignore_changes` together mean Terraform will neither replace it nor notice the new snapshot id:

```bash
terraform state rm module.control_plane.aws_ebs_volume.data
# then set data_volume_snapshot_id in terraform.tfvars
terraform apply
```

The attachment is replaced along with the volume, which stops the instance and starts it again; the
filesystem is found by its label rather than by volume id, so the instance itself does not need
replacing. The released volume is left unmanaged — keep it until the restore is verified, then
delete it with `aws ec2 delete-volume`. The module ignores later changes to
`data_volume_snapshot_id`, so a restore does not become a standing instruction to re-restore.

**The Litestream replica** in the backups bucket covers the global store alone, continuously.
Session files and the host alarm index are not in it. Restoring from it brings back users, settings
and the session index but not the sessions' own state; the image's entrypoint does this
automatically when it finds an empty volume.

Two things deliberately make `terraform destroy` fail rather than quietly taking data with it. The
volume carries `prevent_destroy`. And with `force_destroy_storage = false`, which is production's
setting, a non-empty bucket or a registry holding images refuses to be deleted as well. Staging sets
it true, because staging is meant to be stood back up.

Releasing the volume is deliberate:

```bash
terraform state rm module.control_plane.aws_ebs_volume.data
terraform destroy
# the volume is now unmanaged; reattach it or delete it explicitly
```

## What it costs

Rough monthly figures, `us-west-2`, on-demand, excluding data transfer and whatever the sandbox
provider bills.

|                          | Staging                                     | Production                 |
| ------------------------ | ------------------------------------------- | -------------------------- |
| Instance                 | t4g.small, stopped nights and weekends ≈ $5 | t4g.large, always on ≈ $49 |
| Root volume (20 GB gp3)  | ≈ $1.60                                     | ≈ $1.60                    |
| Data volume              | 50 GB ≈ $4                                  | 200 GB ≈ $16               |
| Snapshots                | ≈ $1                                        | ≈ $5                       |
| S3, ECR, CloudWatch, SSM | ≈ $1                                        | ≈ $3                       |
| **Total**                | **≈ $13**                                   | **≈ $75**                  |

There is no load balancer and no NAT gateway, which is most of why these numbers are what they are:
an ALB is about $25/month before traffic and a NAT gateway about $33/month before egress — either
would be among the largest lines above. Caddy on the instance does the ALB's job here. An ALB stays
worth revisiting for connection draining and a WAF attach point, but as a later AWS-flavoured
variation rather than a requirement.

## Not here yet

- **CI apply.** These environments are applied from a laptop today. I-3 moves them into the
  pipeline.
- **Alarms beyond the instance's status checks.** Disk and memory need the CloudWatch agent, and the
  alarms that describe the control plane itself need metrics the host does not publish yet; both are
  H-8.
- **The bots.** The Slack, GitHub and Linear bots remain Cloudflare Workers. A deployment with no
  Cloudflare account runs the control plane and the web app, and does without them, until that
  transport lands.
