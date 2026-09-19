variable "api_key" {
  description = "Daytona REST API key"
  type        = string
  sensitive   = true
}

variable "api_url" {
  description = "Daytona REST API base URL"
  type        = string
}

variable "target" {
  description = "Optional Daytona target name"
  type        = string
  default     = ""
}

variable "snapshot_name" {
  description = "Name of the Daytona snapshot to create/update"
  type        = string
}

variable "memory_gib" {
  description = "Memory in GiB reserved by sandboxes created from the snapshot"
  type        = number

  validation {
    condition     = var.memory_gib >= 1 && var.memory_gib == floor(var.memory_gib)
    error_message = "memory_gib must be a positive integer."
  }
}

variable "deploy_path" {
  description = "Path to packages/daytona-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
