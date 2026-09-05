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
aws s3api create-bucket --bucket open-inspect-terraform-state-$ACCOUNT_ID \
  --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2
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

The module creates one SSM parameter per key, each holding a `CHANGE_ME_` placeholder, and then
ignores the value — so Terraform owns the inventory and never the secrets. List what is still unset:

```bash
PREFIX=$(terraform output -raw ssm_env_prefix)
aws ssm get-parameters-by-path --path "$PREFIX" --recursive --with-decryption \
  --query 'Parameters[?starts_with(Value, `CHANGE_ME_`)].Name' --output table
```

Set each one:

```bash
put() { aws ssm put-parameter --overwrite --type SecureString --name "$PREFIX/$1" --value "$2"; }

put TOKEN_ENCRYPTION_KEY              "$(openssl rand -base64 32)"
put PROVIDER_ACCOUNTS_ENCRYPTION_KEY  "$(openssl rand -base64 32)"
put REPO_SECRETS_ENCRYPTION_KEY       "$(openssl rand -base64 32)"
put BROWSER_AUTH_SECRET               "$(openssl rand -base64 32)"
put IMAGE_CALLBACK_TOKEN_PEPPER       "$(openssl rand -base64 32)"
put GITHUB_APP_ID                     "123456"
put GITHUB_APP_INSTALLATION_ID        "12345678"
put GITHUB_CLIENT_ID                  "Iv1...."
put GITHUB_CLIENT_SECRET              "...."
put ANTHROPIC_API_KEY                 "sk-ant-...."
```

The three encryption keys are 32 bytes and are rejected at any other length. Generate them once and
keep them: rotating one invalidates everything it encrypted.

**The GitHub App private key has to be on one line.** `.env` is one assignment per line and Compose
does not unescape it, so a PEM with real newlines would truncate at the first one and take the rest
of the file with it. The instance refuses to write a multi-line value rather than doing that
silently. Convert it first:

```bash
put GITHUB_APP_PRIVATE_KEY "$(awk '{printf "%s\\n", $0}' key-pkcs8.pem)"
```

The key must be PKCS#8, as on Cloudflare:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
```

Non-secret values — access-control lists, `WEB_APP_URL`, the sandbox provider's settings — go in the
`config` map in `terraform.tfvars`, not here. Anything in that map lands in the state file, so
nothing secret belongs in it.

## 5. Push an image

The instance runs an image, not a build; it has no checkout. Build for **arm64** — the instance is
Graviton, and there is no amd64 fallback.

```bash
REGISTRY=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin "${REGISTRY%%/*}"

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

Container logs go straight from the Docker daemon to CloudWatch, so `docker compose logs` shows
nothing on the instance. The equivalent, which also keeps working after the instance is replaced:

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
snapshots it daily and keeps `snapshot_retention_count` of them. To restore, set
`data_volume_snapshot_id` and apply into an empty state — the module ignores later changes to it, so
a restore does not turn into a permanent instruction to re-restore.

**The Litestream replica** in the backups bucket covers the global store alone, continuously.
Session files and the host alarm index are not in it. Restoring from it brings back users, settings
and the session index but not the sessions' own state; the image's entrypoint does this
automatically when it finds an empty volume.

The volume carries `prevent_destroy`, so `terraform destroy` fails rather than taking the data with
it. Releasing it is deliberate:

```bash
terraform state rm module.control_plane.aws_ebs_volume.data
terraform destroy
# the volume is now unmanaged; reattach it or delete it explicitly
```

## What it costs

Rough monthly figures, us-west-2, on-demand, excluding data transfer and whatever the sandbox
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
