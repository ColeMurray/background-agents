output "worker_name" {
  description = "Name of the deployed worker"
  value       = var.worker_name
}

output "wrangler_config_path" {
  description = "Path to generated wrangler.jsonc"
  value       = local_file.wrangler_config.filename
}
