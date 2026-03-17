variable "modal_token_id" {
  description = "Modal API token ID"
  type        = string
  sensitive   = true
}

variable "modal_token_secret" {
  description = "Modal API token secret"
  type        = string
  sensitive   = true
}

variable "app_name" {
  description = "Name of the Modal app"
  type        = string
}

variable "workspace" {
  description = "Modal workspace name (used in endpoint URLs)"
  type        = string
}

variable "deploy_path" {
  description = "Path to the Modal app source code"
  type        = string
}

variable "deploy_module" {
  description = "Python module to deploy (e.g., 'deploy' or 'src')"
  type        = string
  default     = "deploy"
}

variable "source_hash" {
  description = "Hash of source files to trigger redeployment on changes"
  type        = string
  default     = ""
}

variable "secrets" {
  description = "List of Modal secrets to create"
  type = list(object({
    name   = string
    values = map(string)
  }))
  default   = []
  sensitive = true
}

variable "volume_name" {
  description = "Name of the Modal volume to create"
  type        = string
  default     = null
}

variable "fetch_app_info" {
  description = "Whether to fetch app info after deployment"
  type        = bool
  default     = false
}

variable "modal_cmd" {
  description = "Full path to the modal CLI (optional). Set when modal is not on PATH during Terraform local-exec (e.g. pipx install)."
  type        = string
  default     = null
}
