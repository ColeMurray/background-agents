# =============================================================================
# Infrastructure Outputs
# =============================================================================

# Cloudflare KV Namespaces
output "session_index_kv_id" {
  description = "Session index KV namespace ID"
  value       = module.session_index_kv.namespace_id
}

output "slack_kv_id" {
  description = "Slack KV namespace ID"
  value       = var.enable_slack_bot ? module.slack_kv[0].namespace_id : null
}

# Cloudflare D1 Database
output "d1_database_id" {
  description = "The ID of the D1 database"
  value       = cloudflare_d1_database.main.id
}

# Cloudflare Workers
output "control_plane_url" {
  description = "Control plane worker URL"
  value       = module.control_plane_worker.worker_url
}

output "control_plane_worker_name" {
  description = "Control plane worker name"
  value       = module.control_plane_worker.worker_name
}

output "slack_bot_worker_name" {
  description = "Slack bot worker name"
  value       = var.enable_slack_bot ? module.slack_bot_worker[0].worker_name : null
}

output "linear_kv_id" {
  description = "Linear KV namespace ID"
  value       = var.enable_linear_bot ? module.linear_kv[0].namespace_id : null
}

output "linear_bot_worker_name" {
  description = "Linear bot worker name"
  value       = var.enable_linear_bot ? module.linear_bot_worker[0].worker_name : null
}

output "linear_bot_webhook_url" {
  description = "Linear bot webhook URL (set in Linear OAuth Application webhook config)"
  value       = var.enable_linear_bot ? "${module.linear_bot_worker[0].worker_url}/webhook" : null
}

output "linear_bot_oauth_authorize_url" {
  description = "Visit this URL to install the Linear agent in your workspace (requires admin)"
  value       = var.enable_linear_bot ? "${module.linear_bot_worker[0].worker_url}/oauth/authorize" : null
}

output "github_bot_worker_name" {
  description = "GitHub bot worker name"
  value       = var.enable_github_bot ? module.github_bot_worker[0].worker_name : null
}

# Vercel Web App
output "web_app_url" {
  description = "Vercel web app URL"
  value       = module.web_app.production_url
}

output "web_app_project_id" {
  description = "Vercel project ID"
  value       = module.web_app.project_id
}

# Modal
output "modal_app_name" {
  description = "Modal app name"
  value       = module.modal_app.app_name
}

output "modal_health_url" {
  description = "Modal health check endpoint"
  value       = module.modal_app.api_health_url
}

# =============================================================================
# Verification Commands
# =============================================================================

output "verification_commands" {
  description = "Commands to verify the deployment"
  value       = <<-EOF

    # 1. Health check control plane
    curl ${module.control_plane_worker.worker_url}/health

    # 2. Health check Modal
    curl ${module.modal_app.api_health_url}

    # 3. Verify Vercel deployment
    curl ${module.web_app.production_url}

    # 4. Test authenticated endpoint (should return 401)
    curl ${module.control_plane_worker.worker_url}/sessions

  EOF
}
