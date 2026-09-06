output "hostname" {
  description = "Public FQDN the control plane answers on."
  value       = module.control_plane.hostname
}

output "public_ip" {
  description = "Elastic IP to point DNS at."
  value       = module.control_plane.public_ip
}

output "instance_id" {
  description = "Target for `aws ssm start-session`."
  value       = module.control_plane.instance_id
}

output "log_group_name" {
  description = "Target for `aws logs tail`."
  value       = module.control_plane.log_group_name
}

output "ecr_repository_url" {
  description = "Where CI pushes the control-plane image."
  value       = module.control_plane.ecr_repository_url
}

output "ssm_env_prefix" {
  description = "SSM path the instance builds `.env` from."
  value       = module.control_plane.ssm_env_prefix
}

output "secret_parameter_names" {
  description = "SecureString parameters that need real values before the stack boots."
  value       = module.control_plane.secret_parameter_names
}
