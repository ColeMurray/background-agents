# =============================================================================
# Open-Inspect - AWS control plane
# =============================================================================
# One EC2 instance running the compose stack from docker-compose.yml plus the
# docker-compose.aws.yml overlay, with a persistent EBS volume for its data,
# S3 for media and backups, and Caddy terminating TLS on the instance itself.
#
# Nothing here depends on Cloudflare. DNS is the operator's: the module
# publishes an Elastic IP and a hostname and, unless given a Route 53 zone,
# creates no records at all.

variable "name" {
  description = "Prefix for every resource this module creates, e.g. \"open-inspect-staging\". Also the SSM parameter path segment."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$", var.name))
    error_message = "name must be 3-40 lowercase alphanumeric or hyphen characters and may not start or end with a hyphen."
  }
}

variable "hostname" {
  description = "Public FQDN this control plane answers on. Caddy obtains a Let's Encrypt certificate for it over ACME HTTP-01, so it must resolve to the module's Elastic IP before the stack is expected to serve HTTPS."
  type        = string
}

# ---------------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------------

variable "instance_type" {
  description = "EC2 instance type. Graviton (t4g.*) only: the control-plane image is built for arm64."
  type        = string
  default     = "t4g.small"

  validation {
    condition     = startswith(var.instance_type, "t4g.") || startswith(var.instance_type, "m7g.") || startswith(var.instance_type, "c7g.")
    error_message = "instance_type must be a Graviton (arm64) type: the control-plane image has no amd64 build."
  }
}

variable "control_plane_image" {
  description = "Image the instance runs, including its tag. Defaults to the module's own ECR repository at the tag in control_plane_image_tag."
  type        = string
  default     = null
}

variable "control_plane_image_tag" {
  description = "Tag in the module's ECR repository to run, when control_plane_image is not set."
  type        = string
  default     = "latest"
}

variable "ssh_key_name" {
  description = "EC2 key pair to attach, for the rare case a console session is needed. Shell access is over SSM Session Manager, and the security group admits no inbound SSH either way."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the VPC this module creates."
  type        = string
  default     = "10.20.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR for the single public subnet the instance sits in. There is no private subnet and no NAT gateway: a NAT gateway costs more per month than everything else here together, and the instance reaches AWS over its public address."
  type        = string
  default     = "10.20.1.0/24"
}

variable "availability_zone" {
  description = "AZ for the subnet and the data volume. Null picks the region's first. The volume and the instance must share it, so changing this after the volume holds data means a snapshot restore."
  type        = string
  default     = null
}

variable "ingress_cidrs" {
  description = "Who may reach ports 80 and 443. Port 80 must stay open to the internet for the ACME HTTP-01 challenge; narrowing this list will stop certificate issuance and renewal."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---------------------------------------------------------------------------
# Data volume
# ---------------------------------------------------------------------------

variable "data_volume_size_gb" {
  description = "Size of the EBS data volume. It holds Docker's data root, so it carries the images and every named volume as well as the databases."
  type        = number
  default     = 50
}

variable "data_volume_snapshot_id" {
  description = "Snapshot to create the data volume from, for a restore. Null creates an empty volume."
  type        = string
  default     = null
}

variable "snapshot_retention_count" {
  description = "Daily data-volume snapshots kept by Data Lifecycle Manager."
  type        = number
  default     = 14
}

variable "snapshot_schedule_utc" {
  description = "Time of day the daily snapshot runs, HH:MM in UTC."
  type        = string
  default     = "07:00"
}

# ---------------------------------------------------------------------------
# Storage and configuration
# ---------------------------------------------------------------------------

variable "config" {
  description = "Non-secret `.env` entries Terraform owns, written to SSM as String parameters. Merged over the values the module derives from its own resources, so an entry here wins. Empty values are dropped: the host reads a missing variable and an empty one the same way."
  type        = map(string)
  default     = {}
}

variable "secret_names" {
  description = "`.env` keys held as SecureString parameters. The module creates each one with a placeholder and then ignores its value, so the inventory is Terraform's and the values are not: set them with `aws ssm put-parameter --overwrite`. A key still holding its placeholder fails at boot rather than silently."
  type        = set(string)
  default = [
    "ANTHROPIC_API_KEY",
    "BROWSER_AUTH_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "IMAGE_CALLBACK_TOKEN_PEPPER",
    "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
    "REPO_SECRETS_ENCRYPTION_KEY",
    "SERVICE_AUTH_SECRET_GITHUB_BOT",
    "SERVICE_AUTH_SECRET_LINEAR_BOT",
    "SERVICE_AUTH_SECRET_SLACK_BOT",
    "SERVICE_AUTH_SECRET_WEB",
    "TOKEN_ENCRYPTION_KEY",
  ]
}

variable "force_destroy_storage" {
  description = "Allow `terraform destroy` to empty the media and backup buckets and the image registry. False keeps a destroy from taking the backups with it -- and also makes a destroy fail outright once CI has pushed an image, which is the right answer for production and the wrong one for an environment meant to be torn down and stood back up."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Observability and schedules
# ---------------------------------------------------------------------------

variable "log_retention_days" {
  description = "Retention on the CloudWatch log group the containers write to."
  type        = number
  default     = 30
}

variable "alarm_topic_arn" {
  description = "SNS topic the instance status-check alarms notify. Null creates the alarms with no action, so they are visible in the console but page no one."
  type        = string
  default     = null
}

variable "out_of_hours_stop" {
  description = "Cron expressions stopping and starting the instance on a schedule, in the timezone below. Null leaves it running. Staging is the case for this; the stop is a clean ACPI shutdown, so the stack drains the way it does on a deploy."
  type = object({
    stop_cron  = string
    start_cron = string
    timezone   = optional(string, "UTC")
  })
  default = null
}

# ---------------------------------------------------------------------------
# DNS (optional; the module creates no records without a zone)
# ---------------------------------------------------------------------------

variable "route53_zone_id" {
  description = "Route 53 hosted zone to create an A record for `hostname` in. Null means the operator points their own DNS at the Elastic IP; the module needs no DNS provider and no credential for one."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "repository_root" {
  description = "Checkout the stack files are uploaded from. The default reaches the repository root from the module's own directory; moving this module means changing it."
  type        = string
  default     = null
}

variable "compose_plugin_version" {
  description = "Docker Compose plugin release the instance falls back to when the distribution has no package for it. Needs to be at least 2.24, where the `!reset` and `!override` tags docker-compose.aws.yml uses were introduced."
  type        = string
  default     = "2.31.0"
}
