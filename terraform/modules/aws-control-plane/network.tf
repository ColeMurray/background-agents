# One VPC with a single public subnet. The instance holds a public address and
# talks to AWS over it; there is no private subnet, because reaching S3, SSM,
# ECR and CloudWatch from one would mean either a NAT gateway (~$33/month plus
# egress, more than the instance) or four interface endpoints (~$7/month each).

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.subnet_cidr
  availability_zone       = local.az
  map_public_ip_on_launch = false # the instance carries an Elastic IP instead

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# S3 traffic leaves through the gateway endpoint rather than the internet
# gateway: media and Litestream's continuous replication are the bulk of this
# instance's egress, and a gateway endpoint costs nothing.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = merge(local.tags, { Name = "${var.name}-s3" })
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "Open-Inspect control plane: HTTP and HTTPS in, everything out"
  vpc_id      = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name}-instance" })

  lifecycle {
    create_before_destroy = true
  }
}

# Port 80 is not only a redirect to 443: Caddy answers the ACME HTTP-01
# challenge on it, so closing it stops issuance and, later, renewal.
resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.instance.id
  description       = "HTTP, for the ACME HTTP-01 challenge and the redirect to HTTPS"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.instance.id
  description       = "HTTPS"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# No inbound SSH. Shell access is `aws ssm start-session`, which the instance
# opens outbound.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.instance.id
  description       = "All outbound"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
