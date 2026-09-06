# How CI reaches this deployment, and nothing else.
#
# GitHub Actions authenticates with an OIDC token rather than an access key, so
# there is no long-lived AWS credential in the repository. The token's `sub`
# claim names the repository *and the GitHub environment the job requested*, and
# the trust policy pins both -- which is what makes a GitHub environment's
# approval gate an AWS access gate too, rather than a UI convention a workflow
# edit can route around.
#
# Null `github_deploy` creates none of this, and the environment is deployed by
# hand. That is the default: an installation with no GitHub Actions has no
# reason to carry a federated role.

locals {
  github_deploy_enabled = var.github_deploy != null

  # Read once, through `try`, so the null case is stated here rather than
  # repeated as a guard at every use. tests/github_deploy.tftest.hcl plans the
  # module with this unset, because nothing else would: `terraform validate`
  # does not evaluate locals.
  provided_oidc_arn = try(var.github_deploy.oidc_provider_arn, null)

  # Create the provider unless handed one. It is an account-wide singleton, so
  # a second environment in the same account must be given the first's ARN --
  # `terraform output github_oidc_provider_arn`.
  create_oidc_provider = local.github_deploy_enabled && local.provided_oidc_arn == null

  oidc_provider_arn = local.create_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : local.provided_oidc_arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS verifies GitHub's certificate against its own trust store for this
  # provider, so the thumbprint is no longer the security boundary it once was.
  # It remains a required field.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.tags
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_deploy_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Pinned to one repository and one GitHub environment. A workflow in a fork,
    # on another branch, or naming a different environment gets a token whose
    # `sub` does not match and cannot assume this role.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_deploy.repository}:environment:${var.github_deploy.environment}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
  tags               = local.tags
}

data "aws_iam_policy_document" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  # Not scopable to a repository: the token is account-wide by design.
  statement {
    sid       = "AuthenticateToRegistry"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      # Read as well as write: buildx reads back the layers it can skip, and the
      # deploy resolves the tag it just pushed to a digest.
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.control_plane.arn]
  }

  # One parameter, not the prefix. A deploy moves the deployed version and
  # rolls it back; it has no business reading the secrets next to it, and this
  # role is reachable from a pull-request workflow in a way the instance is not.
  statement {
    sid     = "MoveDeployedImage"
    actions = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${aws_ssm_parameter.deployed_image.name}",
    ]
  }

  # Scoped to this one instance and to the stock shell document. SendCommand
  # authorizes against both the targets and the document, so both are named.
  statement {
    sid     = "RestartTheStack"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.this.arn,
      "arn:aws:ssm:${data.aws_region.current.region}::document/AWS-RunShellScript",
    ]
  }

  # Reading a command's result takes no resource-level permission: the command
  # id is not known until SendCommand returns it.
  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = local.github_deploy_enabled ? 1 : 0

  name   = "${var.name}-github-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
