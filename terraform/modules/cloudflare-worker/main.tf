# Cloudflare Worker Module (Native Terraform)
# Uses the recommended 3-resource pattern: cloudflare_worker + cloudflare_worker_version + cloudflare_workers_deployment

locals {
  # Build bindings list from all binding types
  bindings = concat(
    # KV namespace bindings
    [for kv in var.kv_namespaces : {
      type         = "kv_namespace"
      name         = kv.binding_name
      namespace_id = kv.namespace_id
    }],
    # Service bindings (only when enabled - disable if target workers don't exist yet)
    var.enable_service_bindings ? [for svc in var.service_bindings : {
      type    = "service"
      name    = svc.binding_name
      service = svc.service_name
    }] : [],
    # D1 database bindings
    [for db in var.d1_databases : {
      type = "d1"
      name = db.binding_name
      id   = db.database_id
    }],
    # Plain text bindings (environment variables)
    [for pt in var.plain_text_bindings : {
      type = "plain_text"
      name = pt.name
      text = pt.value
    }],
    # Secret text bindings
    [for sec in var.secrets : {
      type = "secret_text"
      name = sec.name
      text = sec.value
    }],
    # Durable Object bindings (only when enabled - disable for initial deployment)
    var.enable_durable_object_bindings ? [for do in var.durable_objects : {
      type       = "durable_object_namespace"
      name       = do.binding_name
      class_name = do.class_name
    }] : []
  )
}

# =============================================================================
# 1. Create the Worker
# =============================================================================

resource "cloudflare_worker" "this" {
  account_id = var.account_id
  name       = var.worker_name

  # Enable workers.dev subdomain for direct access
  subdomain = {
    enabled = true
  }

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
    }
  }
}

# =============================================================================
# 2. Create a Worker Version with modules and bindings
# =============================================================================

resource "cloudflare_worker_version" "this" {
  account_id          = var.account_id
  worker_id           = cloudflare_worker.this.id
  compatibility_date  = var.compatibility_date
  compatibility_flags = var.compatibility_flags

  main_module = "index.js"

  modules = [
    {
      name         = "index.js"
      content_type = "application/javascript+module"
      content_file = var.script_path
    }
  ]

  bindings = local.bindings

  # Durable Object migrations
  # Phase 1 (enable_durable_object_bindings=false): Apply migrations WITHOUT bindings
  # Phase 2 (enable_durable_object_bindings=true): Add bindings WITHOUT migrations
  # Note: Free plans require new_sqlite_classes instead of new_classes
  migrations = length(var.durable_objects) > 0 && !var.enable_durable_object_bindings ? {
    new_tag            = var.migration_tag
    new_sqlite_classes = [for do in var.durable_objects : do.class_name]
  } : null
}

# =============================================================================
# 3. Deploy the Worker Version
# =============================================================================

resource "cloudflare_workers_deployment" "this" {
  account_id  = var.account_id
  script_name = cloudflare_worker.this.name
  strategy    = "percentage"

  versions = [
    {
      percentage = 100
      version_id = cloudflare_worker_version.this.id
    }
  ]
}

# =============================================================================
# Optional: Custom domain and routes
# =============================================================================

resource "cloudflare_workers_custom_domain" "this" {
  count = var.custom_domain != null ? 1 : 0

  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.custom_domain
  service    = cloudflare_worker.this.name
}

resource "cloudflare_workers_route" "this" {
  count = var.route_pattern != null ? 1 : 0

  zone_id = var.zone_id
  pattern = var.route_pattern
  script  = cloudflare_worker.this.name
}
