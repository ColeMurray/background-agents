# =============================================================================
# Documentation Site — Vercel (when docs_site_enabled = true)
# =============================================================================
# The public docs site at packages/docs. Separate from the web app project so a
# docs publish never touches the product deployment.

module "docs_site" {
  count  = var.docs_site_enabled ? 1 : 0
  source = "../../modules/vercel-project"

  project_name = "${local.name_prefix}-docs-${local.name_suffix}"
  team_id      = var.vercel_team_id
  framework    = "nextjs"

  # No git_repository, so a push to main does not deploy. The Deploy Docs
  # workflow publishes on demand, which is the gate documented in
  # packages/docs/README.md.
  #
  # The Node.js runtime comes from `engines.node` in packages/docs/package.json
  # (the repository's own floor), which overrides the project setting and
  # resolves to the newest supported major; vercel/vercel 2.x cannot set 24.x.
  root_directory  = "packages/docs"
  install_command = "cd ../.. && npm install"
  build_command   = "next build"

  custom_domain = local.docs_custom_domain

  # The site reads no deployment state: every URL it renders is a constant in
  # packages/docs/src/lib/site.ts.
  environment_variables = []
}
