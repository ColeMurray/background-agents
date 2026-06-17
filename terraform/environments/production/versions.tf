terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # Pin below 5.20.0: that release regressed cloudflare_worker observability
      # to emit observability.traces.propagation_policy, which fails with
      # "propagation_policy requires the trace propagation feature to be enabled"
      # (403, code 100342) on accounts without that feature.
      # See cloudflare/terraform-provider-cloudflare#7177.
      version = ">= 5.16, < 5.20.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 2.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# NOTE: The Vercel provider validates api_token on init even when web_platform = "cloudflare"
# and no Vercel resources are created. The default value is a dummy 24-character lowercase hex
# token that satisfies provider format validation. Do not set vercel_api_token to "" in tfvars
# when using Cloudflare.
provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.web_platform == "vercel" ? var.vercel_team_id : null
}
