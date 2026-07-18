variable "api_key" {
  description = "E2B runtime API key. Authenticates the template build (Template SDK) and pre-warms the freshly built template."
  type        = string
  sensitive   = true
}

variable "api_url" {
  description = "E2B REST API base URL (e.g. https://api.e2b.app)"
  type        = string
  default     = "https://api.e2b.app"
}

variable "template_id" {
  description = "E2B template name to create/rebuild (lowercase, letters/numbers/dashes/underscores)"
  type        = string
}

variable "template_cpu" {
  description = "vCPU count for the template"
  type        = number
  default     = 2
}

variable "template_memory_mb" {
  description = "Memory (MB, even number) for the template"
  type        = number
  default     = 1024
}

variable "deploy_path" {
  description = "Path to packages/e2b-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
