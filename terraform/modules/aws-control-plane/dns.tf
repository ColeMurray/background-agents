# Optional, and off by default. The module publishes an address; pointing a
# name at it is the operator's, on whatever they already run. Route 53 is here
# because it is the AWS-native option and adds no third party -- not because
# this module needs a DNS provider. It does not have one.
resource "aws_route53_record" "this" {
  count = var.route53_zone_id == null ? 0 : 1

  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = "A"
  ttl     = 60
  records = [aws_eip.this.public_ip]
}
