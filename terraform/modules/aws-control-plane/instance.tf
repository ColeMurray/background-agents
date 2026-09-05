# One instance, Graviton, with a public address it keeps across replacements.
# Amazon Linux 2023's arm64 AMI. Looked up with DescribeImages rather than
# through the public `/aws/service/ami-al2023` SSM parameter: plenty of accounts
# deny the `/aws/` namespace to their operators, and this needs no such grant.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name = "name"
    # Excludes al2023-ami-minimal-*, which has no package set to speak of.
    values = ["al2023-ami-2023.*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  availability_zone      = local.az
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.ssh_key_name

  user_data_base64            = data.cloudinit_config.this.rendered
  user_data_replace_on_change = false

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2
    http_endpoint = "enabled"
    # Two, not one. Everything that reaches AWS here runs in a container on
    # Docker's bridge network, which is one hop further from the metadata
    # service than the instance itself. At a limit of 1 the app and Litestream
    # both fail with "no valid providers in chain", which reads like a missing
    # credential rather than an unreachable one.
    http_put_response_hop_limit = 2
  }

  monitoring = true

  tags = merge(local.tags, { Name = var.name })

  lifecycle {
    # This instance is stateful in practice even though its state is on the
    # attached volume: replacing it drops every in-flight session. AWS moves
    # the AL2023 parameter whenever it publishes an image, and user data
    # changes whenever the module does, so leaving either live would let a
    # routine plan propose a replacement. Rolling the instance is deliberate:
    #
    #   terraform apply -replace=module.control_plane.aws_instance.this
    ignore_changes = [ami, user_data_base64]
  }
}

data "cloudinit_config" "this" {
  gzip          = true
  base64_encode = true

  part {
    content_type = "text/x-shellscript"
    filename     = "open-inspect-bootstrap.sh"
    content = templatefile("${path.module}/templates/user-data.sh.tftpl", {
      region                = data.aws_region.current.region
      log_group             = aws_cloudwatch_log_group.containers.name
      config_bucket         = aws_s3_bucket.backups.id
      ssm_env_prefix        = local.ssm_env_prefix
      control_plane_image   = local.image
      data_volume_id_nodash = replace(aws_ebs_volume.data.id, "-", "")
      compose_version       = var.compose_plugin_version
    })
  }
}

# The address survives the instance, so replacing the instance is not a DNS
# change and the operator's record can be a plain A record they set once.
resource "aws_eip" "this" {
  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = merge(local.tags, { Name = var.name })

  depends_on = [aws_internet_gateway.this]
}
