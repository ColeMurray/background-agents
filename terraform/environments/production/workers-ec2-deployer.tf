# =============================================================================
# EC2 Deployer Cloudflare Worker
# =============================================================================

resource "null_resource" "ec2_deployer_build" {
  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command     = "npm run build"
    working_dir = "${var.project_root}/packages/ec2-deployer"
  }
}

module "ec2_deployer_worker" {
  source = "../../modules/cloudflare-worker"

  account_id  = var.cloudflare_account_id
  worker_name = "open-inspect-ec2-deployer-${local.name_suffix}"
  script_path = "${var.project_root}/packages/ec2-deployer/dist/index.js"

  plain_text_bindings = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "EC2_AMI_ID", value = var.ec2_ami_id },
    { name = "CLOUDFLARE_ACCOUNT_ID", value = var.cloudflare_account_id }
  ]

  secrets = [
    { name = "EC2_API_SECRET", value = var.ec2_api_secret },
    { name = "AWS_ACCESS_KEY_ID", value = var.aws_access_key_id },
    { name = "AWS_SECRET_ACCESS_KEY", value = var.aws_secret_access_key },
    { name = "CLOUDFLARE_API_TOKEN", value = var.cloudflare_api_token_ec2 },
    { name = "CLOUDFLARE_TUNNEL_SECRET", value = var.cloudflare_tunnel_secret_ec2 }
  ]

  durable_objects = [
    { binding_name = "EC2_INSTANCE", class_name = "EC2InstanceDO" }
  ]

  enable_durable_object_bindings = var.enable_durable_object_bindings
  compatibility_date             = "2024-09-23"
  compatibility_flags            = ["nodejs_compat"]
  migration_tag                  = "v1"

  depends_on = [null_resource.ec2_deployer_build]
}
