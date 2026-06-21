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
  description = "Modal workspace name"
  type        = string
}

variable "modal_environment" {
  description = "Modal environment name used by the Modal CLI"
  type        = string
  default     = "main"

  validation {
    condition     = length(trimspace(var.modal_environment)) > 0 && can(regex("^[^:/\\\\]+$", var.modal_environment))
    error_message = "modal_environment must be non-empty and must not contain colons, slashes, or backslashes."
  }
}

variable "modal_environment_web_suffix" {
  description = "Modal environment web suffix used in endpoint URLs. Use lowercase letters, digits, and dashes, or leave empty for the environment with no web suffix."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^$|^[a-z0-9-]+$", var.modal_environment_web_suffix))
    error_message = "modal_environment_web_suffix must be empty or contain only lowercase letters, digits, and dashes."
  }
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

variable "fetch_app_info" {
  description = "Whether to fetch app info after deployment"
  type        = bool
  default     = false
}
