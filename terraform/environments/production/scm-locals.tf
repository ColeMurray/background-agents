locals {
  control_plane_scm_plain_text_bindings = [
    { name = "SCM_PROVIDER", value = var.scm_provider },
    { name = "GITHUB_CLIENT_ID", value = var.github_client_id },
    { name = "BITBUCKET_CLIENT_ID", value = var.bitbucket_client_id },
    { name = "BITBUCKET_WORKSPACE", value = var.bitbucket_workspace },
    { name = "BITBUCKET_BOT_USERNAME", value = var.bitbucket_bot_username },
  ]

  control_plane_scm_secret_bindings = [
    { name = "GITHUB_CLIENT_SECRET", value = var.github_client_secret },
    { name = "BITBUCKET_CLIENT_SECRET", value = var.bitbucket_client_secret },
    { name = "BITBUCKET_BOT_APP_PASSWORD", value = var.bitbucket_bot_app_password },
  ]

  vercel_scm_environment_variables = [
    {
      key       = "SCM_PROVIDER"
      value     = var.scm_provider
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "NEXT_PUBLIC_SCM_PROVIDER"
      value     = var.scm_provider
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "GITHUB_CLIENT_ID"
      value     = var.github_client_id
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "GITHUB_CLIENT_SECRET"
      value     = var.github_client_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
    {
      key       = "BITBUCKET_CLIENT_ID"
      value     = var.bitbucket_client_id
      targets   = ["production", "preview"]
      sensitive = false
    },
    {
      key       = "BITBUCKET_CLIENT_SECRET"
      value     = var.bitbucket_client_secret
      targets   = ["production", "preview"]
      sensitive = true
    },
  ]
}
