# Pi Code Mode executes model-authored JavaScript in this dedicated Worker.
# It intentionally has no public endpoint, credentials, application storage,
# service bindings, or control-plane authority.
module "pi_codemode_sandbox_worker" {
  source = "../../modules/cloudflare-worker"

  account_id       = var.cloudflare_account_id
  worker_name      = "open-inspect-pi-codemode-sandbox-${local.name_suffix}"
  worker_subdomain = var.cloudflare_worker_subdomain
  script_path      = local.pi_codemode_sandbox_script_path

  additional_modules = {
    "index.js.map" = {
      content_type = "application/source-map"
      content_file = local.pi_codemode_sandbox_map_path
    }
    "quickjs.wasm" = {
      content_type = "application/wasm"
      content_file = local.pi_codemode_sandbox_wasm_path
    }
  }

  # Keep this migration-only: provider issue #6852 reports failures around
  # Durable Object migrations plus WASM and newly-created self-bindings. Local
  # plans cannot establish live provider behavior, so paid admission separately
  # requires the disposable-account canary. The control plane's external
  # binding lands only after this deployment; this Worker has zero self-bindings.
  emit_durable_object_migration = !var.pi_codemode_sandbox_migration_applied
  migration_tag                 = "v1"
  new_sqlite_classes            = ["CodemodeSandbox"]

  workers_dev_enabled  = false
  preview_urls_enabled = false
  cpu_ms               = var.pi_codemode_sandbox_cpu_ms

  compatibility_date = "2026-10-18"
}
