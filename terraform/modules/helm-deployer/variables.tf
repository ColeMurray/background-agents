variable "helm_api_url" {
  description = "Base URL of the Helm deployer API service"
  type        = string
}

variable "helm_api_secret" {
  description = "Shared secret for authenticating with the Helm deployer API"
  type        = string
  sensitive   = true
}

variable "helm_namespace" {
  description = "Kubernetes namespace for sandbox pods"
  type        = string
  default     = "open-inspect"
}

variable "cloudflare_tunnel_token" {
  description = "Cloudflare tunnel token for sandbox connectivity"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key passed to sandbox environments"
  type        = string
  sensitive   = true
}

variable "github_app_id" {
  description = "GitHub App ID for generating installation tokens"
  type        = string
}

variable "github_app_private_key" {
  description = "GitHub App private key (PKCS#8 format)"
  type        = string
  sensitive   = true
}

variable "github_app_installation_id" {
  description = "GitHub App installation ID"
  type        = string
}

variable "internal_callback_secret" {
  description = "Shared secret for internal service communication"
  type        = string
  sensitive   = true
}

variable "control_plane_url" {
  description = "URL of the control plane for sandbox callbacks"
  type        = string
}
