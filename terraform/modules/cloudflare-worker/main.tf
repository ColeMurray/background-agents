# Cloudflare Worker Module (Native Terraform)
# Uses the recommended 3-resource pattern: cloudflare_worker + cloudflare_worker_version + cloudflare_workers_deployment

locals {
  # The provider takes every binding as one list; map iteration is key-ordered,
  # so the projection is stable across plans.
  bindings = concat(
    # KV namespace bindings
    [for binding_name, binding in var.kv_namespaces : {
      type         = "kv_namespace"
      name         = binding_name
      namespace_id = binding.namespace_id
    }],
    # Service bindings (only when enabled - disable if target workers don't exist yet)
    var.enable_service_bindings ? [for binding_name, binding in var.service_bindings : {
      type    = "service"
      name    = binding_name
      service = binding.service_name
    }] : [],
    # D1 database bindings
    [for binding_name, binding in var.d1_databases : {
      type = "d1"
      name = binding_name
      id   = binding.database_id
    }],
    # R2 bucket bindings
    [for binding_name, binding in var.r2_buckets : {
      type        = "r2_bucket"
      name        = binding_name
      bucket_name = binding.bucket_name
    }],
    # Queue producer bindings
    [for binding_name, binding in var.queue_bindings : {
      type       = "queue"
      name       = binding_name
      queue_name = binding.queue_name
    }],
    # Plain text bindings (environment variables)
    [for binding_name, binding in var.plain_text_bindings : {
      type = "plain_text"
      name = binding_name
      text = binding.value
    }],
    # Secret text bindings
    [for binding_name, binding in var.secrets : {
      type = "secret_text"
      name = binding_name
      text = binding.value
    }],
    # During an incremental class-creation migration, preserve bindings for
    # existing classes while withholding only the classes being introduced.
    var.enable_durable_object_bindings ? [for binding_name, binding in var.durable_objects : {
      type       = "durable_object_namespace"
      name       = binding_name
      class_name = binding.class_name
      }] : length(var.new_sqlite_classes) > 0 ? [for binding_name, binding in var.durable_objects : {
      type       = "durable_object_namespace"
      name       = binding_name
      class_name = binding.class_name
      } if !contains(var.new_sqlite_classes, binding.class_name)
    ] : [],
    # Durable Objects owned by another Worker never participate in this
    # Worker's class migrations.
    [for binding_name, binding in var.external_durable_objects : {
      type        = "durable_object_namespace"
      name        = binding_name
      class_name  = binding.class_name
      script_name = binding.script_name
      environment = binding.environment
    }]
  )

  binding_names = [for binding in local.bindings : binding.name]

  migration_new_sqlite_classes = length(var.new_sqlite_classes) > 0 ? var.new_sqlite_classes : (
    length(var.deleted_classes) > 0 ? [] : [for binding in var.durable_objects : binding.class_name]
  )
  emit_durable_object_migration = var.emit_durable_object_migration != null ? var.emit_durable_object_migration : (
    !var.enable_durable_object_bindings || length(var.deleted_classes) > 0
  )
}

# =============================================================================
# 1. Create the Worker
# =============================================================================

resource "cloudflare_worker" "this" {
  account_id = var.account_id
  name       = var.worker_name

  subdomain = {
    enabled          = var.workers_dev_enabled
    previews_enabled = var.preview_urls_enabled
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

  modules = concat(
    [{
      name         = "index.js"
      content_type = "application/javascript+module"
      content_file = var.script_path
    }],
    [for name in sort(keys(var.additional_modules)) : {
      name         = name
      content_type = var.additional_modules[name].content_type
      content_file = var.additional_modules[name].content_file
    }]
  )

  bindings = local.bindings

  limits = var.cpu_ms == null ? null : {
    cpu_ms = var.cpu_ms
  }

  # Durable Object migrations
  # Initial class creation normally uses bindings disabled for phase 1. A
  # migration-only Worker can override emission without creating a self-binding.
  # Class deletion emits a migration with surviving bindings still enabled.
  # Note: Free plans require new_sqlite_classes instead of new_classes
  # When new_sqlite_classes is set, only those classes are declared as new (incremental migration).
  # When empty, all DO classes are declared as new (fresh deployment).
  migrations = (length(local.migration_new_sqlite_classes) > 0 || length(var.deleted_classes) > 0) && local.emit_durable_object_migration ? {
    old_tag            = var.migration_old_tag
    new_tag            = var.migration_tag
    new_sqlite_classes = local.migration_new_sqlite_classes
    deleted_classes    = var.deleted_classes
  } : null

  lifecycle {
    # Deletion emits its migration with bindings enabled, but nothing in the
    # expression above enforces that. With bindings disabled, local.bindings
    # drops every surviving Durable Object binding, so this version would
    # retire the deleted class and ship a control plane with no SESSION
    # binding. Fail at plan time instead of deploying that.
    precondition {
      condition     = length(var.deleted_classes) == 0 || (var.enable_durable_object_bindings && local.emit_durable_object_migration)
      error_message = "Durable Object class deletion requires bindings and migration emission to remain enabled."
    }

    precondition {
      condition     = length(local.binding_names) == length(toset(local.binding_names))
      error_message = "Worker binding names must be unique across every binding type."
    }
  }
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

# =============================================================================
# Optional: Cron Triggers
# =============================================================================

resource "cloudflare_workers_cron_trigger" "this" {
  count = length(var.cron_triggers) > 0 ? 1 : 0

  account_id  = var.account_id
  script_name = cloudflare_worker.this.name
  schedules   = [for expr in var.cron_triggers : { cron = expr }]

  depends_on = [cloudflare_workers_deployment.this]
}
