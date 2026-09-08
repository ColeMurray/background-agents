# ---------------------------------------------------------------------------
# Data volume
# ---------------------------------------------------------------------------
# This volume is the deployment. It carries Docker's data root, so the global
# store, every session database, the host alarm index and the container images
# all live on it; the instance in front of it is replaceable and the volume is
# not. `prevent_destroy` says so: releasing it is a deliberate
# `terraform state rm`, documented in the bring-up runbook, not something a
# mistyped `terraform destroy` can do.

resource "aws_ebs_volume" "data" {
  availability_zone = local.az
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  snapshot_id       = var.data_volume_snapshot_id

  tags = merge(local.tags, {
    Name = "${var.name}-data"
  })

  lifecycle {
    prevent_destroy = true

    # Restoring from a snapshot is a one-time act. Leaving it live would make
    # the next apply after a restore propose replacing the volume with a fresh
    # copy of that same snapshot, discarding everything written since.
    ignore_changes = [snapshot_id]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id

  # Detaching a mounted filesystem from a running instance corrupts it. A
  # destroy stops the instance first, which releases the volume cleanly.
  stop_instance_before_detaching = true
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "${var.name} daily data volume snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    # Scoped to this deployment. DLM selects across the whole account and
    # region, so a tag that names the schedule rather than the owner is shared
    # by every environment, and each policy then snapshots the others' volumes
    # under its own retention.
    target_tags = { Deployment = var.name }

    schedule {
      name = "daily"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_schedule_utc]
      }

      retain_rule {
        count = var.snapshot_retention_count
      }

      # The snapshot is taken while the filesystem is live, so it is
      # crash-consistent rather than quiesced. SQLite recovers from that the
      # way it recovers from a power cut; I-5 rehearses the restore.
      copy_tags = true
    }
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Buckets
# ---------------------------------------------------------------------------
# Media is what the control plane stores for users. Backups is Litestream's
# replica of the global store, and also holds the stack files the instance
# fetches at boot. Both are private, versioned and encrypted.

resource "aws_s3_bucket" "media" {
  # Bucket names are global, so a second installation of this module would
  # collide with the first on its first apply. The account id is the smallest
  # thing that makes them unique, and renaming once data exists is a migration.
  bucket        = "${var.name}-media-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy_storage

  tags = merge(local.tags, { Name = "${var.name}-media" })
}

resource "aws_s3_bucket" "backups" {
  bucket        = "${var.name}-backups-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy_storage

  tags = merge(local.tags, { Name = "${var.name}-backups" })
}

locals {
  buckets = {
    media   = aws_s3_bucket.media.id
    backups = aws_s3_bucket.backups.id
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = local.buckets

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets

  bucket = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets

  bucket = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning without expiry grows without bound, and Litestream rewrites its
# replica constantly. Noncurrent versions are the safety net for an overwrite,
# not an archive.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = local.buckets

  bucket = each.value

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# ---------------------------------------------------------------------------
# Image registry
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "control_plane" {
  name                 = "${var.name}-control-plane"
  image_tag_mutability = "MUTABLE" # the deployed tag moves; digests are immutable
  # A repository holding images refuses to be deleted, so without this a
  # destroy fails the moment anything has been pushed.
  force_delete = var.force_destroy_storage

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.tags, { Name = "${var.name}-control-plane" })
}

resource "aws_ecr_lifecycle_policy" "control_plane" {
  repository = aws_ecr_repository.control_plane.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
