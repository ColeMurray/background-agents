# Shared lookups and naming. The rest of the module is split by concern:
#
# - network.tf        VPC, public subnet, security group
# - iam.tf            Instance role and its policies, the DLM and scheduler roles
# - storage.tf        Data volume, snapshots, S3 buckets, ECR
# - config.tf         SSM parameters and the stack files the instance fetches
# - instance.tf       The EC2 instance, its Elastic IP and its user data
# - observability.tf  Log group and instance alarms
# - schedule.tf       Optional out-of-hours stop and start
# - dns.tf            Optional Route 53 record

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az = coalesce(var.availability_zone, data.aws_availability_zones.available.names[0])

  tags = merge(var.tags, {
    Name       = var.name
    ManagedBy  = "terraform"
    Deployment = var.name
  })

  # Where the instance reads its `.env` from. One path, read whole.
  ssm_env_prefix = "/${var.name}/env"

  # The keys a deployment holds as SecureString parameters. Each is created with
  # a self-describing placeholder that the instance refuses to write into `.env`,
  # so a key nobody set is absent rather than a working credential everyone can
  # read in this repository.
  default_secret_names = [
    "ANTHROPIC_API_KEY",
    "BROWSER_AUTH_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "IMAGE_CALLBACK_TOKEN_PEPPER",
    "MODAL_API_SECRET",
    "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
    "REPO_SECRETS_ENCRYPTION_KEY",
    "SERVICE_AUTH_SECRET_GITHUB_BOT",
    "SERVICE_AUTH_SECRET_LINEAR_BOT",
    "SERVICE_AUTH_SECRET_SLACK_BOT",
    "SERVICE_AUTH_SECRET_WEB",
    "TOKEN_ENCRYPTION_KEY",
  ]

  # Null from a root module means "use the inventory above".
  secret_names = toset(coalesce(var.secret_names, local.default_secret_names))

  image = coalesce(var.control_plane_image, "${aws_ecr_repository.control_plane.repository_url}:${var.control_plane_image_tag}")
}
