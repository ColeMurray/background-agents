variable "api_key" {
  description = "Islo API key"
  type        = string
  sensitive   = true
}

variable "base_url" {
  description = "Optional Islo API base URL"
  type        = string
  default     = ""
}

variable "snapshot_name" {
  description = "Name of the Islo snapshot to create/update"
  type        = string
}

variable "deploy_path" {
  description = "Path to packages/islo-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
