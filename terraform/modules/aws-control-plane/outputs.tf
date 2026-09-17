output "hostname" {
  description = "Public FQDN the control plane answers on. WORKER_URL is https://<this>."
  value       = var.hostname
}

output "public_ip" {
  description = "Elastic IP the DNS record for `hostname` must point at. Stable across instance replacement."
  value       = aws_eip.this.public_ip
}

output "instance_id" {
  description = "EC2 instance id, for `aws ssm start-session --target <this>`."
  value       = aws_instance.this.id
}

output "data_volume_id" {
  description = "EBS volume holding Docker's data root, and so the databases. Snapshots of it are the deployment's backup."
  value       = aws_ebs_volume.data.id
}

output "log_group_name" {
  description = "CloudWatch log group the containers write to: `aws logs tail <this> --follow`."
  value       = aws_cloudwatch_log_group.containers.name
}

output "ecr_repository_url" {
  description = "Registry CI pushes the control-plane image to."
  value       = aws_ecr_repository.control_plane.repository_url
}

output "control_plane_image" {
  description = "Image reference the instance runs."
  value       = local.image
}

output "media_bucket" {
  description = "S3 bucket backing the object store."
  value       = aws_s3_bucket.media.id
}

output "backups_bucket" {
  description = "S3 bucket holding the Litestream replica of the global store and the stack files the instance fetches."
  value       = aws_s3_bucket.backups.id
}

output "ssm_env_prefix" {
  description = "SSM path `.env` is built from. `aws ssm get-parameters-by-path --path <this> --recursive` lists what still needs a value."
  value       = local.ssm_env_prefix
}

output "secret_parameter_names" {
  description = "SecureString parameters the operator owns. Each starts as a CHANGE_ME_ placeholder."
  value       = sort([for parameter in aws_ssm_parameter.secret : parameter.name])
}

output "region" {
  description = "Region everything here lives in. CI needs it for `configure-aws-credentials`."
  value       = data.aws_region.current.region
}

output "deployed_image_parameter" {
  description = "SSM parameter holding the image the instance actually runs. Terraform sets it once and then leaves it to whoever deploys; this, not `control_plane_image`, is what a deploy moves and a rollback restores."
  value       = aws_ssm_parameter.deployed_image.name
}

output "github_deploy_role_arn" {
  description = "Role a GitHub Actions job assumes over OIDC to deploy. Null unless `github_deploy` is set."
  value       = one(aws_iam_role.github_deploy[*].arn)
}

output "github_oidc_provider_arn" {
  description = "The account's GitHub OIDC provider, when this module created it. Pass it as `github_deploy.oidc_provider_arn` in any other environment in the same account: the provider is an account-wide singleton and a second one cannot be created."
  value       = one(aws_iam_openid_connect_provider.github[*].arn)
}
