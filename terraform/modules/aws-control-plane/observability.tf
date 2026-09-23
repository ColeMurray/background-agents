# Container stdout, straight from the Docker daemon's awslogs driver. One
# group, one stream per container, and it outlives the instance.
resource "aws_cloudwatch_log_group" "containers" {
  name              = "/open-inspect/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# `treat_missing_data` follows the schedule: an instance stopped every evening
# publishes no status checks, and "breaching" would page at the stop and again
# at the start, every day.
#
# The two alarms that need nothing installed on the instance. Disk and memory
# need the CloudWatch agent, and the alarms that actually describe the control
# plane -- queue depth, spawn failures -- need metrics the host does not
# publish yet; both belong to H-8.
resource "aws_cloudwatch_metric_alarm" "instance_status" {
  alarm_name          = "${var.name}-instance-status-check"
  alarm_description   = "The instance failed its own status check; it is not reachable or not healthy."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = local.scheduled ? "notBreaching" : "breaching"
  dimensions          = { InstanceId = aws_instance.this.id }

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions    = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "system_status" {
  alarm_name          = "${var.name}-system-status-check"
  alarm_description   = "The underlying host failed its status check; recovery needs a stop and start."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = local.scheduled ? "notBreaching" : "breaching"
  dimensions          = { InstanceId = aws_instance.this.id }

  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  ok_actions    = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]

  tags = local.tags
}
