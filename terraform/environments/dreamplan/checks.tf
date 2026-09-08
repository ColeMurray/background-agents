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

# Fail the plan when no access control is configured. Uses terraform_data with a
# precondition so this is a hard error, not an advisory check-block warning.
resource "terraform_data" "access_control_gate" {
  lifecycle {
    precondition {
      condition     = local.admission_allowlist_enabled || var.unsafe_allow_all_users
      error_message = "At least one access control allowlist must be configured. Set allowed_users, allowed_email_domains, allowed_emails, or allowed_github_orgs, or set unsafe_allow_all_users = true to explicitly allow all authenticated users."
    }
  }
}

resource "terraform_data" "sign_in_provider_gate" {
  lifecycle {
    precondition {
      condition     = local.github_oauth_enabled || local.google_enabled
      error_message = "At least one complete OAuth sign-in provider pair must be configured."
    }

    precondition {
      condition = (
        !local.github_oauth_enabled ||
        local.github_admission_enabled ||
        local.provider_neutral_admission_enabled ||
        local.unsafe_allow_all_effective
      )
      error_message = "GitHub sign-in requires a GitHub-specific or provider-neutral admission rule, or effective unsafe allow-all."
    }

    precondition {
      condition = (
        !local.google_enabled ||
        local.provider_neutral_admission_enabled ||
        local.unsafe_allow_all_effective
      )
      error_message = "Google sign-in requires allowed_emails, allowed_email_domains, or effective unsafe allow-all; GitHub-specific admission rules cannot admit Google identities."
    }
  }
}
