# CONTROL_PLANE_IMAGE has its own resource, at the same SSM name, because CI owns
# its value after the first deploy. An entry in `var.config` would be a second
# resource writing that name -- an apply that fails on ParameterAlreadyExists, or
# one that quietly puts the deployed version back. The only thing standing
# between an operator and that is a variable validation, so it is worth a test.

mock_provider "aws" {}
mock_provider "cloudinit" {}

variables {
  name     = "open-inspect-test"
  hostname = "control-plane.example.com"
}

# The same stand-ins tests/github_deploy.tftest.hcl needs: a mocked provider
# generates values, and a plan of this module reads several of them in ways that
# require a real shape before it gets as far as reporting a variable's own error.
override_data {
  target = data.aws_ec2_instance_type.this
  values = { supported_architectures = ["arm64"] }
}

override_data {
  target = data.aws_availability_zones.available
  values = { names = ["us-west-2a", "us-west-2b"] }
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

run "rejects_control_plane_image_in_config" {
  command = plan

  variables {
    config = {
      CONTROL_PLANE_IMAGE = "example.invalid/control-plane:pinned"
    }
  }

  expect_failures = [var.config]
}
