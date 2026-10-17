terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # Match the production ceiling until cloudflare/terraform-provider-cloudflare#7177
      # no longer breaks Worker observability on accounts without trace propagation.
      version = ">= 5.16, < 5.20.0"
    }
  }
}
