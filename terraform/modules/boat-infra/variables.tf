variable "api_key" {
  description = "Boat build API key"
  type        = string
  sensitive   = true
}

variable "api_url" {
  description = "Boat v1 API base URL"
  type        = string
  default     = "https://boat.dev/api/v1"
}

variable "org" {
  description = "Optional Boat organization billing scope"
  type        = string
  default     = ""
}

variable "snapshot_name" {
  description = "Immutable verified named snapshot to build"
  type        = string
}

variable "snapshot_prefix" {
  description = "Deployment-owned named-snapshot prefix"
  type        = string
}

variable "protected_snapshot" {
  description = "Currently deployed snapshot that must not be pruned during the build"
  type        = string
  default     = ""
}

variable "sandbox_type" {
  description = "Boat machine type used to build and verify the template"
  type        = string
  default     = "default"
}

variable "deploy_path" {
  description = "Path to packages/boat-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of all template inputs"
  type        = string
}
