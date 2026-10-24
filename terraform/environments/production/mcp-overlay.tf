# optional extension layer: personal MCP OAuth connection deployment.
# Kept separate from the upstream-compatible production variables.

variable "mcp_connection_foundation_enabled" {
  description = "Provision and retain the personal MCP connection Durable Object foundation"
  type        = bool
  default     = false
}

variable "mcp_connection_binding_enabled" {
  description = "Keep the migrated McpConnectionDO binding available for revocation and callback cleanup independently of feature admission"
  type        = bool
  default     = false
}

variable "mcp_connections_enabled" {
  description = "Enable creation, authorization, callback, and use of personal MCP connections"
  type        = bool
  default     = false

  validation {
    condition     = !var.mcp_connections_enabled || (var.mcp_connection_foundation_enabled && var.mcp_connection_binding_enabled)
    error_message = "mcp_connections_enabled requires the staged MCP connection foundation and live Durable Object binding."
  }
}

variable "mcp_oauth_encryption_key" {
  description = "AES-256 key for personal MCP OAuth state and credentials (generate with: openssl rand -base64 32)"
  type        = string
  sensitive   = true
  nullable    = false
  default     = ""

  validation {
    condition = (
      trimspace(var.mcp_oauth_encryption_key) == "" ||
      can(regex("^[A-Za-z0-9+/]{43}=$", trimspace(var.mcp_oauth_encryption_key)))
    )
    error_message = "mcp_oauth_encryption_key must be blank or a Base64-encoded 32-byte key."
  }

  validation {
    condition     = !var.mcp_connection_foundation_enabled || trimspace(var.mcp_oauth_encryption_key) != ""
    error_message = "mcp_oauth_encryption_key must be configured before provisioning the personal MCP connection foundation."
  }
}
