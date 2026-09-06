# What the instance reads at every start: the stack files from S3, and `.env`
# built from one SSM path. Both are fetched by the systemd unit's ExecStartPre,
# so changing either is `terraform apply` plus a restart -- not a new instance.

locals {
  # `path.module` cannot appear in a variable default, so the fallback lives here.
  repository_root = coalesce(var.repository_root, abspath("${path.module}/../../.."))

  # The stack the instance runs is the repository's, byte for byte, uploaded
  # rather than transcribed. `docker-compose.aws.yml` is the only difference
  # from what the compose smoke boots in CI.
  stack_files = {
    "docker-compose.yml"                           = "${local.repository_root}/docker-compose.yml"
    "docker-compose.aws.yml"                       = "${local.repository_root}/docker-compose.aws.yml"
    "packages/control-plane/docker/Caddyfile"      = "${local.repository_root}/packages/control-plane/docker/Caddyfile"
    "packages/control-plane/docker/litestream.yml" = "${local.repository_root}/packages/control-plane/docker/litestream.yml"
  }

  # Everything the infrastructure itself decides. An entry in var.config wins,
  # so an operator can override any of it without editing the module.
  #
  # The variables this deliberately leaves out are as load-bearing as the ones
  # it sets. OBJECT_STORE_ENDPOINT and LITESTREAM_ENDPOINT unset mean AWS S3
  # rather than MinIO; the four credential variables unset mean the SDK finds
  # the instance role. An SSM parameter cannot hold an empty string, so "unset"
  # here is "no parameter", which is exactly how the host reads it.
  derived_config = {
    DEPLOYMENT_NAME = var.name

    # One of the five keys the host requires before it will listen. The
    # placeholder is the same one .env.example ships and for the same reason:
    # it only attributes and filters the bot's own activity, so it boots a
    # staging stack, and a deployment with a real GitHub App overrides it
    # through var.config.
    GITHUB_BOT_USERNAME = "open-inspect[bot]"

    WORKER_URL          = "https://${var.hostname}"
    CADDY_DOMAIN        = var.hostname
    OBJECT_STORE_BUCKET = aws_s3_bucket.media.bucket
    OBJECT_STORE_REGION = data.aws_region.current.region
    LITESTREAM_BUCKET   = aws_s3_bucket.backups.bucket
    DATA_DIR            = "/data"
    APP_BIND_ADDRESS    = "127.0.0.1"

    # docker-compose.yml refuses to start without this one, and Compose
    # interpolates the base file whether or not MinIO is among the services the
    # AWS overlay leaves running. Nothing reads it here.
    MINIO_ROOT_PASSWORD = "unused-on-aws"
  }

  # `for_each` needs its keys known at plan time, and filtering on a value makes
  # the keys depend on it. Only var.config is filtered, because only its values
  # are known then; the derived map holds computed ones -- the image reference,
  # the bucket names -- and every key in it is deliberately non-empty. An
  # operator therefore cannot blank a derived value by setting it to "".
  #
  # MIGRATIONS_DIR is absent on purpose (the image sets its own), as are the
  # endpoint and credential variables, per the comment above. CONTROL_PLANE_IMAGE
  # is absent because it is its own resource below, owned differently.
  env_config = merge(
    local.derived_config,
    { for key, value in var.config : key => value if value != "" },
  )
}

resource "aws_s3_object" "stack" {
  for_each = local.stack_files

  bucket = aws_s3_bucket.backups.id
  key    = "stack/${each.key}"
  source = each.value
  etag   = filemd5(each.value)

  tags = local.tags
}

resource "aws_ssm_parameter" "config" {
  for_each = local.env_config

  name  = "${local.ssm_env_prefix}/${each.key}"
  type  = "String"
  value = each.value
  tags  = local.tags
}

# The inventory is Terraform's; the values are not. Each starts as a
# self-describing placeholder that fails loudly if it reaches a boot, and
# `ignore_changes` then leaves whatever the operator puts there alone:
#
#   aws ssm put-parameter --overwrite --type SecureString \
#     --name /<name>/env/TOKEN_ENCRYPTION_KEY --value "$(openssl rand -base64 32)"
resource "aws_ssm_parameter" "secret" {
  for_each = local.secret_names

  name = "${local.ssm_env_prefix}/${each.value}"
  type = "SecureString"

  # Write-only. `ignore_changes` on `value` suppresses the diff but not the
  # refresh, so the first plan after an operator sets a real secret would read
  # it back with decryption and write the plaintext into the state file. A
  # write-only value is sent on create and never read back, which is the
  # boundary this module claims: the inventory is Terraform's, the values are
  # not. The version is fixed, so the placeholder is re-sent only if it is
  # bumped and an operator's `put-parameter` is left alone.
  value_wo         = "CHANGE_ME_${each.value}"
  value_wo_version = 1

  tags = local.tags
}

# The deployed version, and the one parameter here whose value Terraform sets
# once and then stops owning.
#
# It is an ordinary `.env` entry -- docker-compose.aws.yml reads it, and
# `open-inspect-fetch-config` materializes it from SSM on every start -- which
# is what makes a deploy a parameter write plus a restart rather than a new
# instance. But a deploy has to be able to move it, and roll it back, without a
# `terraform apply`: CI knows the digest it just pushed and Terraform does not.
# So the module creates it at `control_plane_image_tag` for the first boot and
# `ignore_changes` leaves every later value alone. Same boundary as the secrets
# above, for the same reason.
#
# The consequence worth knowing: after the first deploy, `control_plane_image`
# and `control_plane_image_tag` no longer describe what is running.
# `terraform output deployed_image_parameter` names where that lives.
resource "aws_ssm_parameter" "deployed_image" {
  name  = "${local.ssm_env_prefix}/CONTROL_PLANE_IMAGE"
  type  = "String"
  value = local.image
  tags  = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}
