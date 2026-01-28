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
  value       = module.slack_kv.namespace_id
}

# Cloudflare Workers
output "control_plane_url" {
  description = "Control plane worker URL"
  value       = local.control_plane_url
}

output "control_plane_worker_name" {
  description = "Control plane worker name (Modal backend only)"
  value       = local.use_modal_backend ? module.control_plane_worker[0].worker_name : "deployed-via-wrangler"
}

output "slack_bot_worker_name" {
  description = "Slack bot worker name"
  value       = module.slack_bot_worker.worker_name
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

# Modal (only when using Modal backend)
output "modal_app_name" {
  description = "Modal app name (Modal backend only)"
  value       = local.use_modal_backend ? module.modal_app[0].app_name : "n/a"
}

output "modal_health_url" {
  description = "Modal health check endpoint (Modal backend only)"
  value       = local.use_modal_backend ? module.modal_app[0].api_health_url : "n/a"
}

# Sandbox backend info
output "sandbox_backend" {
  description = "Active sandbox backend"
  value       = var.sandbox_backend
}

# =============================================================================
# Verification Commands
# =============================================================================

output "verification_commands" {
  description = "Commands to verify the deployment"
  value       = <<-EOF

    # 1. Health check control plane
    curl ${local.control_plane_url}/health

    # 2. Verify Vercel deployment
    curl ${module.web_app.production_url}

    # 3. Test authenticated endpoint (should return 401)
    curl ${local.control_plane_url}/sessions

    ${local.use_modal_backend ? "# 4. Health check Modal\n    curl ${module.modal_app[0].api_health_url}" : "# 4. Sandbox backend: Cloudflare (no separate health check)"}

  EOF
}
