# Typed conversion intentionally discards verification evidence and package inventories.
variable "releases" {
  description = "Selected full release records; only the runtime contract is exported."
  type = map(object({
    schemaVersion = number
    baseReleaseId = string
    artifact = object({
      provider  = string
      scope     = string
      reference = string
    })
    identity = object({
      recipeDigest    = string
      inventoryDigest = string
      target          = string
      runtimeVersion  = string
    })
  }))
}

locals {
  json    = jsonencode(var.releases)
  encoded = base64encode(local.json)
  bytes   = length(local.encoded) * 3 / 4 - (endswith(local.encoded, "==") ? 2 : endswith(local.encoded, "=") ? 1 : 0)
}

output "releases" {
  value = var.releases
}

output "json" {
  value = local.json
  precondition {
    condition     = local.bytes <= 5000
    error_message = "SANDBOX_BASE_RELEASES exceeds the Worker variable size limit (5000 UTF-8 bytes)."
  }
}
