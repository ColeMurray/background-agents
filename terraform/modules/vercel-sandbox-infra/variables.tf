variable "token" {
  description = "Vercel Sandbox API token"
  type        = string
  sensitive   = true
}

variable "project_id" {
  description = "Vercel project ID used to scope Sandbox API calls"
  type        = string
}

variable "team_id" {
  description = "Optional Vercel team ID used to scope Sandbox API calls"
  type        = string
  default     = ""
}

variable "runtime" {
  description = "Vercel Sandbox runtime identifier"
  type        = string
  default     = "node24"
}

variable "api_base_url" {
  description = "Optional Vercel Sandbox API base URL override"
  type        = string
  default     = ""
}

variable "manual_snapshot_id" {
  description = "Optional manual Vercel base snapshot ID. When set, Terraform skips managed snapshot builds."
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
