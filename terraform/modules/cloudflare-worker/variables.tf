variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID (required for routes and custom domains)"
  type        = string
  default     = null
}

variable "worker_name" {
  description = "Name of the worker"
  type        = string
}

variable "script_path" {
  description = "Path to the bundled JavaScript worker script file"
  type        = string
}

variable "kv_namespaces" {
  description = "List of KV namespace bindings"
  type = list(object({
    binding_name = string
    namespace_id = string
  }))
  default = []
}

variable "service_bindings" {
  description = "List of service bindings for worker-to-worker communication"
  type = list(object({
    binding_name = string
    service_name = string
  }))
  default = []
}

variable "d1_databases" {
  description = "List of D1 database bindings"
  type = list(object({
    binding_name = string
    database_id  = string
  }))
  default = []
}

variable "plain_text_bindings" {
  description = "List of plain text environment variable bindings"
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "secrets" {
  description = "List of secret bindings"
  type = list(object({
    name  = string
    value = string
  }))
  default   = []
  sensitive = true
}

variable "durable_objects" {
  description = "List of Durable Object bindings"
  type = list(object({
    binding_name = string
    class_name   = string
  }))
  default = []
}

variable "enable_durable_object_bindings" {
  description = "Enable DO bindings. Set false for initial deployment, true after first deployment succeeds."
  type        = bool
  default     = true
}

variable "enable_service_bindings" {
  description = "Enable service bindings. Set false if target workers don't exist yet."
  type        = bool
  default     = true
}

variable "migration_tag" {
  description = "Migration tag for Durable Objects (increment when adding new DO classes)"
  type        = string
  default     = "v1"
}

variable "compatibility_date" {
  description = "Compatibility date for the worker"
  type        = string
  default     = "2024-01-01"
}

variable "compatibility_flags" {
  description = "Compatibility flags for the worker (e.g., ['nodejs_compat'])"
  type        = list(string)
  default     = []
}

variable "custom_domain" {
  description = "Custom domain hostname for the worker"
  type        = string
  default     = null
}

variable "route_pattern" {
  description = "Route pattern for zone-based routing (e.g., 'example.com/*')"
  type        = string
  default     = null
}
