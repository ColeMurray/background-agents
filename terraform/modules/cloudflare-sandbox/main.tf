# Cloudflare Sandbox Module
# Deploys control-plane with Cloudflare container support via wrangler CLI
# (The Cloudflare Terraform provider doesn't support containers yet)

locals {
  # Generate wrangler.jsonc content
  wrangler_config = jsonencode({
    "$schema"           = "node_modules/wrangler/config-schema.json"
    name                = var.worker_name
    main                = "src/index.ts"
    compatibility_date  = var.compatibility_date
    compatibility_flags = var.compatibility_flags

    durable_objects = {
      bindings = concat(
        var.durable_objects,
        # Add Sandbox DO binding for containers
        [{ name = "Sandbox", class_name = "Sandbox" }]
      )
    }

    migrations = [
      { tag = "v1", new_sqlite_classes = [for do in var.durable_objects : do.class_name] },
      { tag = "v2", new_sqlite_classes = ["Sandbox"] }
    ]

    kv_namespaces = var.kv_namespaces

    containers = [
      {
        class_name    = "Sandbox"
        image         = var.sandbox_dockerfile_path
        max_instances = var.max_sandbox_instances
        instance_type = var.sandbox_instance_type
      }
    ]

    vars = var.environment_variables

    observability = { enabled = true }
  })
}

# Generate wrangler.jsonc file
resource "local_file" "wrangler_config" {
  content  = local.wrangler_config
  filename = "${var.control_plane_path}/wrangler.jsonc"
}

# Deploy via wrangler
resource "null_resource" "wrangler_deploy" {
  triggers = {
    # Re-deploy when config changes
    config_hash = sha256(local.wrangler_config)
    # Re-deploy when source files change
    source_hash = var.source_hash
  }

  provisioner "local-exec" {
    command     = "npm run build && npx wrangler deploy"
    working_dir = var.control_plane_path

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [local_file.wrangler_config]
}

# Set secrets via wrangler (secrets can't be in wrangler.jsonc)
resource "null_resource" "wrangler_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  triggers = {
    secrets_hash = sha256(jsonencode(var.secrets))
  }

  provisioner "local-exec" {
    command     = <<-EOF
      %{for secret in var.secrets~}
      echo "${secret.value}" | npx wrangler secret put ${secret.name} --name ${var.worker_name}
      %{endfor~}
    EOF
    working_dir = var.control_plane_path

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [null_resource.wrangler_deploy]
}
