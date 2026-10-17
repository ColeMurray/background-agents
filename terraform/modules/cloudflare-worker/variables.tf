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

variable "worker_subdomain" {
  description = "Cloudflare account workers.dev subdomain label, e.g. 'myaccount' (without '.workers.dev'). worker_url resolves to <worker_name>.<worker_subdomain>.workers.dev."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.worker_subdomain))
    error_message = "worker_subdomain must be a single workers.dev subdomain label (e.g. 'myaccount'): lowercase alphanumeric and hyphens only, no dots — do not include '.workers.dev'."
  }
}

variable "script_path" {
  description = "Path to the bundled JavaScript worker script file"
  type        = string
}

variable "additional_modules" {
  description = "Additional ES Worker modules keyed by their uploaded module name"
  type = map(object({
    content_type = string
    content_file = string
  }))
  default = {}

  validation {
    condition = alltrue([
      for name, module in var.additional_modules :
      trimspace(name) != "" &&
      name != "index.js" &&
      !startswith(name, "/") &&
      !strcontains(name, "\\") &&
      !strcontains(name, "../") &&
      !strcontains(name, "/..") &&
      alltrue([for segment in split("/", name) : segment != "" && segment != "." && segment != ".."]) &&
      trimspace(module.content_type) != "" &&
      trimspace(module.content_file) != ""
    ])
    error_message = "Additional modules need a safe relative name other than index.js, a content type, and a content file."
  }
}

variable "kv_namespaces" {
  description = "Map of KV namespace bindings keyed by binding name"
  type = map(object({
    namespace_id = string
  }))
  default = {}
}

variable "service_bindings" {
  description = "Map of service bindings keyed by binding name for worker-to-worker communication"
  type = map(object({
    service_name = string
  }))
  default = {}
}

variable "d1_databases" {
  description = "Map of D1 database bindings keyed by binding name"
  type = map(object({
    database_id = string
  }))
  default = {}
}

variable "r2_buckets" {
  description = "Map of R2 bucket bindings keyed by binding name"
  type = map(object({
    bucket_name = string
  }))
  default = {}
}

variable "queue_bindings" {
  description = "Map of Queue producer bindings keyed by binding name"
  type = map(object({
    queue_name = string
  }))
  default = {}
}

variable "plain_text_bindings" {
  description = "Map of plain text environment variable bindings keyed by binding name"
  type = map(object({
    value = string
  }))
  default = {}
}

variable "secrets" {
  description = "Map of secret bindings keyed by binding name"
  type = map(object({
    value = string
  }))
  default   = {}
  sensitive = true
}

variable "durable_objects" {
  description = "Map of locally owned Durable Object bindings keyed by binding name"
  type = map(object({
    class_name = string
  }))
  default = {}
}

variable "external_durable_objects" {
  description = "Map of Durable Object bindings whose classes are owned by another Worker"
  type = map(object({
    class_name  = string
    script_name = string
    environment = optional(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for binding in values(var.external_durable_objects) :
      trimspace(binding.class_name) != "" && trimspace(binding.script_name) != ""
    ])
    error_message = "External Durable Object bindings require non-empty class_name and script_name values."
  }
}

variable "enable_durable_object_bindings" {
  description = "Enable DO bindings. Set false for initial deployment, true after first deployment succeeds."
  type        = bool
  default     = true
}

variable "emit_durable_object_migration" {
  description = "Override whether this version emits its configured Durable Object migration; null preserves the binding-based rollout behavior"
  type        = bool
  default     = null
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

variable "migration_old_tag" {
  description = "Previous migration tag (for incremental DO migrations). Set when adding new DO classes to an existing worker."
  type        = string
  default     = null
}

variable "new_sqlite_classes" {
  description = "DO class names that are NEW in this migration step. Only these are declared as new_sqlite_classes in the migration (not all durable_objects). If empty, defaults to all durable_objects class names (for fresh deployments)."
  type        = list(string)
  default     = []
}

variable "deleted_classes" {
  description = "DO class names deleted in this migration step. Requires a new migration tag; surviving bindings remain enabled."
  type        = list(string)
  default     = []
}

variable "cron_triggers" {
  description = "List of cron expressions for the worker's scheduled() handler"
  type        = list(string)
  default     = []
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

variable "workers_dev_enabled" {
  description = "Expose the Worker on its workers.dev subdomain"
  type        = bool
  default     = true
}

variable "preview_urls_enabled" {
  description = "Enable version preview URLs for this Worker; null preserves the provider-managed setting"
  type        = bool
  default     = null
}

variable "cpu_ms" {
  description = "Optional CPU time limit per Worker invocation, in milliseconds"
  type        = number
  default     = null

  validation {
    condition     = var.cpu_ms == null || var.cpu_ms > 0
    error_message = "cpu_ms must be null or greater than zero."
  }
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
