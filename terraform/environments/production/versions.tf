terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
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
# and no Vercel resources are created. The default value "unused" satisfies the provider's
# non-empty check. Do not set vercel_api_token to "" in tfvars when using Cloudflare.
provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.web_platform == "vercel" ? var.vercel_team_id : null
}
