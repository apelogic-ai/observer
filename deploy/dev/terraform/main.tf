/**
 * Observer API — dev deployment on AWS.
 *
 * Resources:
 *   - S3 bucket for the lakehouse (versioned, server-side-encrypted, blocked
 *     from public access).
 *   - EC2 t4g.medium (ARM, Amazon Linux 2023) running docker + docker compose.
 *   - IAM role attached to the instance granting r/w on the bucket only.
 *   - Security group: 22 from `var.ssh_cidr`, 80 + 443 from anywhere.
 *   - Elastic IP (so the DNS A record can be set once and stay valid across
 *     instance restarts).
 *
 * The compose stack (caddy + observer-api) is *not* started by user-data —
 * deploy it via the workflow in deploy/dev/README.md after `terraform apply`.
 *
 * Local state is intentional. State drift is fine for one-developer dev
 * environments and avoids the chicken-and-egg of needing an S3 bucket
 * before you can store state in S3.
 */

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── S3 bucket: the lakehouse ───────────────────────────────────────

resource "aws_s3_bucket" "lake" {
  bucket = var.bucket_name
  tags = {
    Name        = var.bucket_name
    Environment = "dev"
    Project     = "observer"
  }
}

resource "aws_s3_bucket_versioning" "lake" {
  bucket = aws_s3_bucket.lake.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lake" {
  bucket = aws_s3_bucket.lake.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket                  = aws_s3_bucket.lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── IAM: instance role with bucket-only access ─────────────────────

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingestor" {
  name               = "${var.name_prefix}-ingestor"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

data "aws_iam_policy_document" "bucket_rw" {
  # Runtime write/read for the ingestor — DeleteObject intentionally
  # excluded. The ingestor only writes; deletion is a separate,
  # auditable workflow (GDPR removal via an operator-assumed role,
  # S3 Lifecycle for retention runs under S3's own service
  # principal). A code-execution bug or compromised dependency in
  # the ingestor must NOT be able to erase another developer's
  # partition. Closes OBS-010 from the 2026-05 review.
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.lake.arn,
      "${aws_s3_bucket.lake.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "ingestor_bucket_rw" {
  name   = "bucket-rw"
  role   = aws_iam_role.ingestor.id
  policy = data.aws_iam_policy_document.bucket_rw.json
}

# Enables Session Manager (`aws ssm start-session --target ...`) — no
# SSH port, no key pair management, all sessions logged via CloudTrail.
resource "aws_iam_role_policy_attachment" "ingestor_ssm" {
  role       = aws_iam_role.ingestor.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ingestor" {
  name = "${var.name_prefix}-ingestor"
  role = aws_iam_role.ingestor.name
}

# ── EC2: the ingestor host ─────────────────────────────────────────

# Default VPC + a default subnet — fine for a single-instance dev box.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "ingestor" {
  name        = "${var.name_prefix}-ingestor"
  description = "observer ingestor: https/http from world (no ssh; access is via SSM)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "http (caddy ACME challenge + redirect)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "https (api.dev.observer.apelogic.ai)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "all outbound (S3, package mirrors, ACME, SSM)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Latest Ubuntu 24.04 LTS (Noble) ARM64 AMI from Canonical.
data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_instance" "ingestor" {
  ami                    = data.aws_ami.ubuntu_arm64.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.ingestor.id]
  iam_instance_profile   = aws_iam_instance_profile.ingestor.name

  user_data = file("${path.module}/user-data.sh")

  # Require IMDSv2 (token-authenticated metadata calls) and refuse the
  # legacy IMDSv1 GET-without-PUT flow. An SSRF or an in-instance
  # software flaw can no longer enumerate IAM-role short-term creds
  # via http://169.254.169.254/ without first PUTting for a token.
  #
  # hop_limit=2 is required because the observer-api container runs on
  # the docker bridge network and the bridge counts as one hop — at
  # hop_limit=1 the SDK in the container can't fetch instance-role
  # credentials and we'd have to inject static AWS keys via .env, which
  # is strictly worse than what OBS-024 was trying to prevent. The
  # observer-api workload IS the legitimate consumer of these creds;
  # there are no untrusted containers on this host.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 50
    encrypted   = true
  }

  tags = {
    Name        = "${var.name_prefix}-ingestor"
    Environment = "dev"
    Project     = "observer"
  }
}

resource "aws_eip" "ingestor" {
  domain   = "vpc"
  instance = aws_instance.ingestor.id
  tags = {
    Name = "${var.name_prefix}-ingestor"
  }
}
