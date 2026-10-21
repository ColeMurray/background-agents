variable "api_key" {
  description = "Boat REST API key. Authenticates the snapshot build and the verification deploy."
  type        = string
  sensitive   = true
}

variable "api_url" {
  description = "Boat REST API base URL (e.g. https://boat.dev/api/v1)"
  type        = string
  default     = "https://boat.dev/api/v1"
}

variable "org" {
  description = "Optional Boat organization the build sandboxes and the named snapshot are billed to"
  type        = string
  default     = ""
}

variable "snapshot_name_prefix" {
  description = "Prefix for the immutable Boat named snapshot (lowercase letters, digits, dashes)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,45}$", var.snapshot_name_prefix))
    error_message = "snapshot_name_prefix must be 1-46 lowercase letters, digits or dashes, starting with a letter or digit."
  }
}

variable "build_sandbox_type" {
  description = "Boat machine type the image is installed on; the saved disk is the same whatever the size"
  type        = string
  default     = "default"

  validation {
    condition     = contains(["small", "default", "large", "xlarge"], var.build_sandbox_type)
    error_message = "build_sandbox_type must be 'small', 'default', 'large', or 'xlarge'."
  }
}

variable "deploy_path" {
  description = "Path to packages/boat-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
