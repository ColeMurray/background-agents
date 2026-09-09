# =============================================================================
# Open-Inspect - AWS staging
# =============================================================================
# One EC2 instance running the control plane, with no Cloudflare account
# anywhere in it. Sized down and stopped overnight, so the bill is mostly the
# volumes.
#
#   terraform init -backend-config=backend.tfvars
#   terraform apply
#
# The stack does not boot until the SecureString parameters this creates hold
# real values; `terraform output secret_parameter_names` lists them. See
# docs/AWS_BRING_UP.md.

locals {
  environment = "staging"
}

module "control_plane" {
  source = "../../modules/aws-control-plane"

  name     = "open-inspect-staging"
  hostname = var.hostname

  instance_type           = "t4g.small"
  data_volume_size_gb     = 50
  control_plane_image_tag = var.control_plane_image_tag
  data_volume_snapshot_id = var.data_volume_snapshot_id

  # Off outside working hours. Staging holds nothing that has to answer at
  # 03:00, and a stopped instance bills only its volumes.
  out_of_hours_stop = {
    stop_cron  = "cron(0 20 ? * MON-FRI *)"
    start_cron = "cron(0 7 ? * MON-FRI *)"
    timezone   = "America/Los_Angeles"
  }

  # Shorter than production's: staging logs are for the last few days.
  log_retention_days       = 7
  snapshot_retention_count = 7

  # Staging is meant to be torn down and stood back up. The data volume is
  # still protected by the module's `prevent_destroy`.
  force_destroy_storage = true

  route53_zone_id = var.route53_zone_id
  secret_names    = var.secret_names
  alarm_topic_arn = var.alarm_topic_arn

  config = merge({
    APP_NAME               = "Open-Inspect Staging"
    LOG_LEVEL              = "debug"
    SANDBOX_PROVIDER       = "modal"
    UNSAFE_ALLOW_ALL_USERS = "false"
  }, var.config)

  tags = { Environment = local.environment }
}
