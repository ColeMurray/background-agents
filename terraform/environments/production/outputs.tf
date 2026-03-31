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

output "github_kv_id" {
  description = "GitHub KV namespace ID"
  value       = var.enable_github_bot ? module.github_kv[0].namespace_id : null
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

output "github_bot_worker_name" {
  description = "GitHub bot worker name"
  value       = var.enable_github_bot ? module.github_bot_worker[0].worker_name : null
}

# Web App
output "web_app_url" {
  description = "Web app URL"
  value       = var.web_platform == "vercel" ? module.web_app[0].production_url : local.web_app_url
}

output "web_app_platform" {
  description = "Web app deployment platform"
  value       = var.web_platform
}

output "web_app_project_id" {
  description = "Vercel project ID (null when using Cloudflare)"
  value       = var.web_platform == "vercel" ? module.web_app[0].project_id : null
}

# =============================================================================
# Verification Commands
# =============================================================================

output "verification_commands" {
  description = "Commands to verify the deployment"
  value       = <<-EOF

    # 1. Health check control plane
    curl ${module.control_plane_worker.worker_url}/health

    # 2. Verify web app deployment
    curl ${local.web_app_url}

    # 3. Test authenticated endpoint (should return 401)
    curl ${module.control_plane_worker.worker_url}/sessions

  EOF
}
