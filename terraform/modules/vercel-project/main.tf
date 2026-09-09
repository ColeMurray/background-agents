# Vercel Project Module
# Creates and configures Vercel projects with environment variables

resource "vercel_project" "this" {
  name      = var.project_name
  team_id   = var.team_id
  framework = var.framework

  git_repository = var.git_repository != null ? {
    type              = var.git_repository.type
    repo              = var.git_repository.repo
    production_branch = var.git_repository.production_branch
  } : null

  root_directory             = var.root_directory
  build_command              = var.build_command
  output_directory           = var.output_directory
  install_command            = var.install_command
  ignore_command             = var.ignore_command
  serverless_function_region = var.serverless_region

  # Enable automatic deployments
  auto_assign_custom_domains = var.auto_assign_custom_domains
}

# Environment variables - use count instead of for_each to avoid sensitive value issues
resource "vercel_project_environment_variable" "env" {
  count = length(var.environment_variables)

  project_id = vercel_project.this.id
  team_id    = var.team_id
  key        = var.environment_variables[count.index].key
  value      = var.environment_variables[count.index].value
  target     = var.environment_variables[count.index].targets
  sensitive  = true
}

# Custom domain (optional)
resource "vercel_project_domain" "this" {
  count = var.custom_domain != null ? 1 : 0

  project_id = vercel_project.this.id
  team_id    = var.team_id
  domain     = var.custom_domain
}
