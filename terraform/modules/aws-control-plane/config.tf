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
    DEPLOYMENT_NAME     = var.name
    WORKER_URL          = "https://${var.hostname}"
    CADDY_DOMAIN        = var.hostname
    OBJECT_STORE_BUCKET = aws_s3_bucket.media.bucket
    OBJECT_STORE_REGION = data.aws_region.current.region
    LITESTREAM_BUCKET   = aws_s3_bucket.backups.bucket
    DATA_DIR            = "/data"
    MIGRATIONS_DIR      = "" # the image sets its own
    APP_BIND_ADDRESS    = "127.0.0.1"

    # docker-compose.yml refuses to start without this one, and Compose
    # interpolates the base file whether or not MinIO is among the services the
    # AWS overlay leaves running. Nothing reads it here.
    MINIO_ROOT_PASSWORD = "unused-on-aws"
  }

  # The keys have to be known at plan time, so everything here is: the bucket
  # names are the ones this module sets rather than the computed `id`, and the
  # only values filtered out are var.config's, which the caller supplies.
  # MIGRATIONS_DIR is absent on purpose -- the image sets its own -- and so are
  # the endpoint and credential variables, per the comment above.
  env_config = {
    for key, value in merge(local.derived_config, var.config) : key => value if value != ""
  }
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
  for_each = var.secret_names

  name  = "${local.ssm_env_prefix}/${each.value}"
  type  = "SecureString"
  value = "CHANGE_ME_${each.value}"
  tags  = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}
