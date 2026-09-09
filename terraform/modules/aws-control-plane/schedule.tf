# An instance that is off costs nothing but its volumes, which is most of why
# staging is cheap. StopInstances is an ACPI shutdown, so systemd stops the
# unit and `docker compose down` drains the host on its usual budget; this is
# not a power cut.

locals {
  scheduled = var.out_of_hours_stop != null
}

data "aws_iam_policy_document" "scheduler_assume" {
  count = local.scheduled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count = local.scheduled ? 1 : 0

  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy" "scheduler" {
  count = local.scheduled ? 1 : 0

  name = "${var.name}-scheduler"
  role = aws_iam_role.scheduler[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ec2:StartInstances", "ec2:StopInstances"]
      Resource = "arn:aws:ec2:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.this.id}"
    }]
  })
}

resource "aws_scheduler_schedule" "stop" {
  count = local.scheduled ? 1 : 0

  name                         = "${var.name}-stop"
  schedule_expression          = var.out_of_hours_stop.stop_cron
  schedule_expression_timezone = var.out_of_hours_stop.timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:stopInstances"
    role_arn = aws_iam_role.scheduler[0].arn
    input    = jsonencode({ InstanceIds = [aws_instance.this.id] })
  }
}

resource "aws_scheduler_schedule" "start" {
  count = local.scheduled ? 1 : 0

  name                         = "${var.name}-start"
  schedule_expression          = var.out_of_hours_stop.start_cron
  schedule_expression_timezone = var.out_of_hours_stop.timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:startInstances"
    role_arn = aws_iam_role.scheduler[0].arn
    input    = jsonencode({ InstanceIds = [aws_instance.this.id] })
  }
}
