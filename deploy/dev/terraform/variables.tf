variable "aws_region" {
  description = "AWS region for the dev deployment"
  type        = string
  default     = "us-west-2"
}

variable "name_prefix" {
  description = "Prefix for resource names (security group, IAM role, etc.)"
  type        = string
  default     = "observer-dev"
}

variable "bucket_name" {
  description = "S3 bucket name for the lakehouse. Must be globally unique."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. Use t4g.* for ARM (cheaper)."
  type        = string
  default     = "t4g.medium"
}

variable "domain_name" {
  description = "Hostname Caddy will request a certificate for (e.g. api.dev.observer.apelogic.ai). Set the A record at your DNS provider after `terraform apply`."
  type        = string
}
