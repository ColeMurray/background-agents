variable "region" {
  description = "AWS region this environment lives in."
  type        = string
  default     = "us-west-2"
}

variable "hostname" {
  description = "Public FQDN the control plane answers on. Point it at the module's Elastic IP before expecting HTTPS: Caddy's certificate comes from an ACME HTTP-01 challenge, which needs the name to resolve here."
  type        = string
}

variable "control_plane_image_tag" {
  description = "Tag in this environment's ECR repository to run."
  type        = string
  default     = "latest"
}

variable "route53_zone_id" {
  description = "Optional Route 53 zone to create the A record in. Leave null and point your own DNS at the Elastic IP; nothing here needs a DNS provider."
  type        = string
  default     = null
}

variable "alarm_topic_arn" {
  description = "Optional SNS topic the instance status alarms notify."
  type        = string
  default     = null
}

variable "config" {
  description = "Extra non-secret `.env` entries, or overrides of what the module derives. Secrets belong in SSM, not here: everything in this map lands in the state file."
  type        = map(string)
  default     = {}
}

variable "data_volume_snapshot_id" {
  description = "Snapshot to build the data volume from, for a restore. Null creates an empty volume. The module ignores later changes to it, so setting it is a one-time act rather than a standing instruction to re-restore."
  type        = string
  default     = null
}
