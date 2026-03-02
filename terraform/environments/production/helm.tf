# =============================================================================
# Helm Sandbox Infrastructure (alternative to Modal)
# =============================================================================
#
# Activated when sandbox_provider = "helm". Deploys sandboxes as Helm chart
# releases in a Kubernetes cluster instead of Modal sandboxes.

module "helm_deployer" {
  count  = var.sandbox_provider == "helm" ? 1 : 0
  source = "../../modules/helm-deployer"

  helm_api_url            = var.helm_api_url
  helm_api_secret         = var.helm_api_secret
  helm_namespace          = var.helm_namespace
  cloudflare_tunnel_token = var.cloudflare_tunnel_token

  anthropic_api_key          = var.anthropic_api_key
  github_app_id              = var.github_app_id
  github_app_private_key     = var.github_app_private_key
  github_app_installation_id = var.github_app_installation_id
  internal_callback_secret   = var.internal_callback_secret
  control_plane_url          = local.control_plane_url
}
