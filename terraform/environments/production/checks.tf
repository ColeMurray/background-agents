# Verify the Vercel production URL matches our hardcoded pattern. If Vercel
# assigns a different domain (e.g., due to naming conflicts), NEXTAUTH_URL and
# cross-service references will silently break.
check "vercel_url_matches" {
  assert {
    condition = (
      var.web_platform != "vercel" ||
      length(module.web_app) == 0 ||
      module.web_app[0].production_url == local.web_app_url
    )
    error_message = "Vercel assigned URL '${var.web_platform == "vercel" && length(module.web_app) > 0 ? module.web_app[0].production_url : "n/a"}' but local.web_app_url is '${local.web_app_url}'. Update locals or set a custom domain."
  }
}

# Warn when a custom domain is set without a zone ID. The custom domain is then
# silently ignored and the app falls back to the workers.dev URL.
check "cloudflare_custom_domain_config" {
  assert {
    condition = (
      var.web_platform != "cloudflare" ||
      trimspace(coalesce(var.cloudflare_custom_domain, "")) == "" ||
      trimspace(coalesce(var.cloudflare_zone_id, "")) != ""
    )
    error_message = "cloudflare_custom_domain is set but cloudflare_zone_id is empty — the custom domain is ignored and the app falls back to the workers.dev URL."
  }
}

# Fail the plan when no access control is configured. Uses terraform_data with a
# precondition so this is a hard error, not an advisory check-block warning.
resource "terraform_data" "access_control_gate" {
  lifecycle {
    precondition {
      condition = (
        var.unsafe_allow_all_users ||
        length([for item in split(",", var.allowed_users) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_email_domains) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_emails) : trimspace(item) if trimspace(item) != ""]) > 0 ||
        length([for item in split(",", var.allowed_github_orgs) : trimspace(item) if trimspace(item) != ""]) > 0
      )
      error_message = "At least one access control allowlist must be configured. Set allowed_users, allowed_email_domains, allowed_emails, or allowed_github_orgs, or set unsafe_allow_all_users = true to explicitly allow all authenticated users."
    }
  }
}
