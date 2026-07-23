variable "api_url" {
  description = "OpenComputer REST API base URL used to build the managed base snapshot"
  type        = string
}

variable "api_key" {
  description = "OpenComputer API key used to build the managed base snapshot"
  type        = string
  sensitive   = true
}

variable "manual_snapshot_id" {
  description = "Optional manual OpenComputer template/snapshot name. When set, Terraform skips the managed snapshot build."
  type        = string
  default     = ""
}

variable "project_root" {
  description = "Path to the repository root"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files that should trigger a managed base snapshot rebuild"
  type        = string
}
