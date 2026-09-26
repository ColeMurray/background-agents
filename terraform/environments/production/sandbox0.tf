variable "sandbox0_api_key" {
  description = "Sandbox0 API key (stored as a control-plane secret)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = var.sandbox_provider != "sandbox0" || length(trimspace(var.sandbox0_api_key)) > 0
    error_message = "sandbox0_api_key is required when sandbox_provider = 'sandbox0'."
  }
}

variable "sandbox0_api_url" {
  description = "Sandbox0 global or self-hosted regional HTTPS endpoint"
  type        = string
  default     = "https://api.sandbox0.ai"
}

variable "sandbox0_template_id" {
  description = "Verified template reference returned by sandbox:images build --provider sandbox0"
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_provider != "sandbox0" || length(trimspace(var.sandbox0_template_id)) > 0
    error_message = "Build and verify a runtime template before selecting sandbox_provider = 'sandbox0'."
  }
}
