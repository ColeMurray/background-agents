mock_provider "cloudflare" {}

variables {
  account_id       = "test-account"
  worker_name      = "test-worker"
  worker_subdomain = "test-account"
  script_path      = "tests/fixtures/index.js"
}

run "existing_worker_defaults_are_preserved" {
  command = plan

  assert {
    condition     = cloudflare_worker.this.subdomain.enabled && var.preview_urls_enabled == null
    error_message = "Existing Workers must keep workers.dev enabled without taking ownership of their preview URL setting."
  }

  assert {
    condition = length([
      for module in cloudflare_worker_version.this.modules : module
      if module.name == "index.js"
    ]) == 1 && length(cloudflare_worker_version.this.modules) == 1
    error_message = "Existing Workers must keep their single index.js module by default."
  }
}

run "private_worker_uploads_wasm_and_binds_an_external_object" {
  command = plan

  variables {
    workers_dev_enabled  = false
    preview_urls_enabled = false
    additional_modules = {
      "runtime.wasm" = {
        content_type = "application/wasm"
        content_file = "tests/fixtures/runtime.wasm"
      }
    }
    external_durable_objects = {
      CODEMODE_SANDBOX = {
        class_name  = "CodemodeSandbox"
        script_name = "pi-codemode-sandbox"
      }
    }
  }

  assert {
    condition     = !cloudflare_worker.this.subdomain.enabled && !cloudflare_worker.this.subdomain.previews_enabled
    error_message = "A private Worker must disable workers.dev and preview URLs."
  }

  assert {
    condition = length([
      for module in cloudflare_worker_version.this.modules : module
      if module.name == "runtime.wasm" && module.content_type == "application/wasm"
    ]) == 1
    error_message = "The WASM file must be uploaded as an application/wasm Worker module."
  }

  assert {
    condition = length([
      for binding in cloudflare_worker_version.this.bindings : binding
      if binding.name == "CODEMODE_SANDBOX" && binding.class_name == "CodemodeSandbox" && binding.script_name == "pi-codemode-sandbox"
    ]) == 1
    error_message = "External Durable Objects must include their owning script name."
  }

  assert {
    condition     = cloudflare_worker_version.this.migrations == null
    error_message = "External Durable Object bindings must never create caller-side migrations."
  }
}

run "local_migrations_exclude_external_classes" {
  command = plan

  variables {
    durable_objects = {
      LOCAL = { class_name = "LocalObject" }
    }
    external_durable_objects = {
      REMOTE = {
        class_name  = "RemoteObject"
        script_name = "remote-worker"
      }
    }
    enable_durable_object_bindings = false
  }

  assert {
    condition     = cloudflare_worker_version.this.migrations.new_sqlite_classes == tolist(["LocalObject"])
    error_message = "Only locally owned Durable Object classes belong in this Worker's migration."
  }
}

run "incremental_migration_retains_existing_local_bindings" {
  command = plan

  variables {
    durable_objects = {
      EXISTING = { class_name = "ExistingObject" }
      NEW      = { class_name = "NewObject" }
    }
    enable_durable_object_bindings = false
    new_sqlite_classes             = ["NewObject"]
  }

  assert {
    condition = length([
      for binding in cloudflare_worker_version.this.bindings : binding
      if binding.name == "EXISTING" && binding.class_name == "ExistingObject"
    ]) == 1 && length(cloudflare_worker_version.this.bindings) == 1
    error_message = "Phase one must retain existing local bindings while withholding only the new class."
  }
}

run "migration_only_class_needs_no_self_binding" {
  command = plan

  variables {
    emit_durable_object_migration = true
    new_sqlite_classes            = ["CodemodeSandbox"]
  }

  assert {
    condition     = cloudflare_worker_version.this.migrations.new_sqlite_classes == tolist(["CodemodeSandbox"])
    error_message = "A Worker must be able to migrate an exported class without receiving an unused namespace binding."
  }

  assert {
    condition     = length(cloudflare_worker_version.this.bindings) == 0
    error_message = "A migration-only class must not create a self-binding."
  }
}

run "rejects_traversal_module_names" {
  command = plan

  variables {
    additional_modules = {
      "../runtime.wasm" = {
        content_type = "application/wasm"
        content_file = "tests/fixtures/runtime.wasm"
      }
    }
  }

  expect_failures = [var.additional_modules]
}
