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
