variable "api_url" {
  description = "Superserve control-plane API URL used to build the managed template"
  type        = string
}

variable "api_key" {
  description = "Superserve API key used to build the managed template"
  type        = string
  sensitive   = true
}

variable "manual_template" {
  description = "Optional existing Superserve template name. When set, Terraform skips the managed build."
  type        = string
  default     = ""
}

variable "project_root" {
  description = "Path to the Open-Inspect repository root"
  type        = string
}

variable "source_hash" {
  description = "Hash of files that should trigger a managed template rebuild"
  type        = string
}
