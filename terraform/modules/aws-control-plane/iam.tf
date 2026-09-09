# The instance carries no long-lived credentials. Everything it reaches -- S3,
# SSM, ECR, CloudWatch -- it reaches as this role, which is why `.env` leaves
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY empty and lets the SDK's default
# chain find it.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.tags
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = local.tags
}

# Session Manager, so the security group need admit no SSH.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  # GetParametersByPath is authorized against the path itself as well as what is
  # under it, so a grant on only `<prefix>/*` is denied.
  statement {
    sid     = "ReadStackConfiguration"
    actions = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_env_prefix}",
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_env_prefix}/*",
    ]
  }

  # No kms:Decrypt statement. The parameters are SecureString under the
  # AWS-managed aws/ssm key, whose own key policy admits account principals
  # through SSM, so nothing here is needed. An IAM statement would not help in
  # any case: KMS authorizes against key ARNs, and an alias ARN matches nothing.
  # A customer-managed key would need a real key ARN here and a grant on the key.

  # The stack files are fetched by root and executed on every start, so the
  # instance may read them and nothing more. Granting write there would let
  # anything that reaches the instance role -- which is every container, one hop
  # from the metadata service -- rewrite what root runs on the next restart.
  statement {
    sid       = "ReadStackFiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/stack/*"]
  }

  statement {
    sid     = "WriteMediaAndReplica"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = [
      "${aws_s3_bucket.media.arn}/*",
      "${aws_s3_bucket.backups.arn}/control-plane/*",
    ]
  }

  statement {
    sid       = "ListBuckets"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.media.arn, aws_s3_bucket.backups.arn]
  }

  statement {
    sid       = "PullImage"
    actions   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.control_plane.arn]
  }

  # Not scopable to a repository: the token is account-wide by design.
  statement {
    sid       = "AuthenticateToRegistry"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.containers.arn}:*"]
  }
}

resource "aws_iam_role_policy" "instance" {
  name   = "${var.name}-instance"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

# ---------------------------------------------------------------------------
# Data Lifecycle Manager
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}
