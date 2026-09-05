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

  image = coalesce(var.control_plane_image, "${aws_ecr_repository.control_plane.repository_url}:${var.control_plane_image_tag}")
}
