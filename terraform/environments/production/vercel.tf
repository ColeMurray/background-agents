# =============================================================================
# Vercel Sandbox Infrastructure
# =============================================================================

# Calculate hash of Vercel base snapshot source files for change detection.
# Includes sandbox-runtime plus the Vercel bootstrap/builder code that is copied into the snapshot.
data "external" "vercel_source_hash" {
  count = local.use_vercel_backend ? 1 : 0

  program = ["bash", "-c", <<-EOF
    cd "${var.project_root}"
    paths=(
      packages/sandbox-runtime/pyproject.toml
      packages/sandbox-runtime/src
      packages/control-plane/scripts/build-vercel-base-snapshot.ts
      packages/control-plane/src/sandbox/providers/vercel/base-snapshot.ts
      packages/control-plane/src/sandbox/providers/vercel/bootstrap.ts
      packages/control-plane/src/sandbox/providers/vercel/client.ts
    )
    if command -v sha256sum &> /dev/null; then
      hash=$(find "$${paths[@]}" -type f \
        \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "pyproject.toml" \) \
        -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    else
      hash=$(find "$${paths[@]}" -type f \
        \( -name "*.py" -o -name "*.js" -o -name "*.ts" -o -name "pyproject.toml" \) \
        -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -d' ' -f1)
    fi
    echo "{\"hash\": \"$hash\"}"
  EOF
  ]
}

module "vercel_sandbox_infra" {
  count  = local.use_vercel_backend ? 1 : 0
  source = "../../modules/vercel-sandbox-infra"

  token              = var.vercel_sandbox_token
  project_id         = var.vercel_sandbox_project_id
  team_id            = var.vercel_sandbox_team_id
  runtime            = var.vercel_sandbox_runtime
  api_base_url       = var.vercel_sandbox_api_base_url
  manual_snapshot_id = var.vercel_base_snapshot_id
  project_root       = var.project_root
  source_hash        = data.external.vercel_source_hash[0].result.hash
}
