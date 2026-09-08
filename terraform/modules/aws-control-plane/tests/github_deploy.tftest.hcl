# The deploy role is optional, and "optional" is the case nothing else covers.
# `terraform validate` does not evaluate locals, so until these runs existed
# nothing in CI planned this module at all -- an environment that left
# `github_deploy` null found out on someone's first apply.
#
# Three shapes, against a mocked provider: off, on-and-creating the account's
# OIDC provider, and on-and-reusing one. The third is the one with teeth: the
# provider is an account-wide singleton, so a second environment that created
# its own would fail the apply with EntityAlreadyExists.
#
# The last two runs cover the subject the trust policy pins, which is the string
# that decides whether a deploy can authenticate at all. A wrong one is not a
# failed plan; it is a role nothing can assume.

mock_provider "aws" {}
mock_provider "cloudinit" {}

variables {
  name     = "open-inspect-test"
  hostname = "control-plane.example.com"
}

# Mocked data sources return generated values, and two of them are read in ways
# that need a real shape: an empty architecture list fails the arm64
# precondition, and an empty zone list fails the `names[0]` lookup.
override_data {
  target = data.aws_ec2_instance_type.this
  values = {
    supported_architectures = ["arm64"]
  }
}

override_data {
  target = data.aws_availability_zones.available
  values = {
    names = ["us-west-2a", "us-west-2b"]
  }
}

override_data {
  target = data.aws_iam_policy_document.ec2_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
}

override_data {
  target = data.aws_iam_policy_document.dlm_assume
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
}

override_data {
  target = data.aws_iam_policy_document.instance
  values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
}

run "no_github_deploy_by_default" {
  command = plan

  assert {
    condition     = length(aws_iam_role.github_deploy) == 0
    error_message = "A deployment that does not opt in must get no deploy role."
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "A deployment that does not opt in must not create the account's OIDC provider."
  }

  assert {
    condition     = local.oidc_provider_arn == null
    error_message = "The provider ARN must resolve to null rather than failing when the feature is off."
  }
}

run "creates_the_provider_when_not_given_one" {
  command = plan

  override_data {
    target = data.aws_iam_policy_document.github_assume[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
  }

  variables {
    github_deploy = {
      repository  = "example-org/example-repo"
      environment = "aws-staging"
    }
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1
    error_message = "The first environment in an account has to create the provider."
  }

  assert {
    condition     = length(aws_iam_role.github_deploy) == 1
    error_message = "Opting in must create the deploy role."
  }
}

run "reuses_a_provider_when_given_one" {
  command = plan

  override_data {
    target = data.aws_iam_policy_document.github_assume[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
  }

  variables {
    github_deploy = {
      repository        = "example-org/example-repo"
      environment       = "aws-production"
      oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  # The provider is an account-wide singleton: a second environment that tried
  # to create its own would fail the apply with EntityAlreadyExists.
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "Given a provider ARN, the module must not create a second provider."
  }

  assert {
    condition     = length(aws_iam_role.github_deploy) == 1
    error_message = "Reusing a provider must still create the deploy role."
  }
}

run "escapes_a_colon_in_the_environment_name" {
  command = plan

  override_data {
    target = data.aws_iam_policy_document.github_assume[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
  }

  variables {
    github_deploy = {
      repository  = "example-org/example-repo"
      environment = "aws:staging"
    }
  }

  # GitHub percent-encodes a colon inside a claim's context value. Comparing
  # against the raw name would pin a subject no token ever carries.
  assert {
    condition     = local.github_deploy_subject == "repo:example-org/example-repo:environment:aws%3Astaging"
    error_message = "A colon in the environment name must reach the trust policy percent-encoded."
  }
}

run "accepts_an_immutable_subject_repository" {
  command = plan

  override_data {
    target = data.aws_iam_policy_document.github_assume[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy[0]
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"*\"}]}" }
  }

  # Every repository created after 2026-07-15, and any that opts in, gets a
  # `sub` whose repository segment carries the owner and repository ids. The
  # module takes that form as-is rather than assembling it, so an operator on
  # such a repository configures the subject GitHub actually sends.
  variables {
    github_deploy = {
      repository  = "example-org@1234/example-repo@5678"
      environment = "aws-staging"
    }
  }

  assert {
    condition     = local.github_deploy_subject == "repo:example-org@1234/example-repo@5678:environment:aws-staging"
    error_message = "An immutable-subject repository must reach the trust policy unchanged."
  }
}
