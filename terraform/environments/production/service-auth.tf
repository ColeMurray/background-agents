# Per-service sig1 signing secrets.
#
# One secret per first-party service, generated in Terraform state — no
# operator-supplied variables. The control plane binds all five verification
# keys as SERVICE_AUTH_SECRET_<SERVICE>; each sender binds exactly its own as
# SERVICE_AUTH_SECRET (a sender signs as itself, so naming its own service in
# its env var adds nothing).

resource "random_password" "service_auth_secret_web" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_slack_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_github_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_linear_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_modal" {
  length  = 64
  special = false
}

# Dedicated pepper for image-build callback token hashes.
resource "random_password" "image_callback_token_pepper" {
  length  = 64
  special = false
}
