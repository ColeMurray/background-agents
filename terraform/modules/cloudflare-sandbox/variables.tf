variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "worker_name" {
  description = "Name of the control-plane worker"
  type        = string
}

variable "control_plane_path" {
  description = "Path to packages/control-plane directory"
  type        = string
}

variable "sandbox_dockerfile_path" {
  description = "Relative path from control-plane to sandbox Dockerfile"
  type        = string
  default     = "../sandbox/Dockerfile"
}

variable "durable_objects" {
  description = "List of Durable Object bindings (excluding Sandbox, which is added automatically)"
  type = list(object({
    name       = string
    class_name = string
  }))
  default = []
}

variable "kv_namespaces" {
  description = "List of KV namespace bindings"
  type = list(object({
    binding = string
    id      = string
  }))
  default = []
}

variable "environment_variables" {
  description = "Environment variables (non-secret)"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables"
  type = list(object({
    name  = string
    value = string
  }))
  default   = []
  sensitive = true
}

variable "source_hash" {
  description = "Hash of source files for change detection"
  type        = string
}

variable "max_sandbox_instances" {
  description = "Maximum number of sandbox container instances"
  type        = number
  default     = 10
}

variable "sandbox_instance_type" {
  description = "Instance type for sandbox containers"
  type        = string
  default     = "standard-2"
}

variable "compatibility_date" {
  description = "Wrangler compatibility date"
  type        = string
  default     = "2024-12-01"
}

variable "compatibility_flags" {
  description = "Wrangler compatibility flags"
  type        = list(string)
  default     = ["nodejs_compat"]
}
