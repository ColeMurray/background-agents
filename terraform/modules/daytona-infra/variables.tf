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

variable "deploy_path" {
  description = "Path to packages/daytona-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
