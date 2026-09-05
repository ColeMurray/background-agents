# Terraform state for the AWS environments, in S3 with native state locking.
#
# The Cloudflare environment keeps its R2 backend; these do not share it. The
# whole point of this deployment is that it needs no Cloudflare account, and a
# state file that lives on Cloudflare would put one back.
#
# Prerequisites, once per account:
#   aws s3api create-bucket --bucket open-inspect-terraform-state-<account> ...
#   aws s3api put-bucket-versioning --bucket ... --versioning-configuration Status=Enabled
#
# Then, with a backend.tfvars naming the bucket and region:
#   terraform init -backend-config=backend.tfvars

terraform {
  backend "s3" {
    key = "aws-production/terraform.tfstate"

    # bucket and region come from -backend-config: the bucket name has to be
    # globally unique, so it cannot be committed.

    encrypt = true
    # S3-native locking, so there is no DynamoDB table to create or pay for.
    use_lockfile = true
  }
}
