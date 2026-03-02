output "api_url" {
  description = "Helm deployer API URL"
  value       = var.helm_api_url
}

output "namespace" {
  description = "Kubernetes namespace for sandbox pods"
  value       = var.helm_namespace
}

output "health_url" {
  description = "Helm deployer health check URL"
  value       = "${var.helm_api_url}/health"
}
