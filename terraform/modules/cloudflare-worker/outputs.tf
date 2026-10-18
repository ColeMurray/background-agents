output "worker_name" {
  description = "The name of the deployed worker"
  value       = cloudflare_worker.this.name
}

output "worker_id" {
  description = "The ID of the worker"
  value       = cloudflare_worker.this.id
}

output "version_id" {
  description = "The ID of the current worker version"
  value       = cloudflare_worker_version.this.id
}

output "deployment_id" {
  description = "The ID of the deployment"
  value       = cloudflare_workers_deployment.this.id
}

output "worker_url" {
  description = "The workers.dev URL for the worker, or null when workers.dev is disabled"
  value       = var.workers_dev_enabled ? "https://${cloudflare_worker.this.name}.${var.worker_subdomain}.workers.dev" : null
}

output "custom_domain" {
  description = "The custom domain for the worker (if configured)"
  value       = var.custom_domain != null ? cloudflare_workers_custom_domain.this[0].hostname : null
}

output "plain_text_binding_names" {
  description = "Names of configured plain-text bindings."
  value       = keys(var.plain_text_bindings)
}

output "plain_text_bindings" {
  description = "Configured plain-text bindings as a name => value map, so a configuration test can assert the value a binding actually carries."
  value       = { for name, binding in var.plain_text_bindings : name => binding.value }
}

output "secret_binding_names" {
  description = "Names of configured secret bindings; secret values are not exposed."
  value       = nonsensitive(keys(var.secrets))
}

output "binding_names" {
  description = "Names of all bindings enabled on the current Worker version."
  value       = sort(nonsensitive(local.binding_names))
}

output "external_durable_object_bindings" {
  description = "Configured external Durable Object identities, excluding runtime values and secrets."
  value = {
    for name, binding in var.external_durable_objects : name => {
      class_name  = binding.class_name
      script_name = binding.script_name
      environment = binding.environment
    }
  }
}
