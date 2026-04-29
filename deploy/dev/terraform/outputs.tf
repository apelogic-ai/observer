output "public_ip" {
  description = "Elastic IP of the ingestor host. Set an A record at your DNS provider pointing the domain at this IP."
  value       = aws_eip.ingestor.public_ip
}

output "instance_id" {
  description = "EC2 instance ID. Use it as the SSM target."
  value       = aws_instance.ingestor.id
}

output "ssm_command" {
  description = "Open an interactive shell on the host. Requires the AWS CLI session-manager-plugin (one-time `brew install --cask session-manager-plugin`)."
  value       = "aws ssm start-session --target ${aws_instance.ingestor.id}"
}

output "bucket_name" {
  description = "Lakehouse S3 bucket."
  value       = aws_s3_bucket.lake.bucket
}

output "domain_name" {
  description = "Hostname the ingestor will be reachable at once DNS propagates and Caddy provisions the cert."
  value       = var.domain_name
}

output "next_steps" {
  description = "Manual steps to complete the deployment."
  value = <<-EOT

    Next steps:

      1. At your DNS provider, add an A record:
         ${var.domain_name} → ${aws_eip.ingestor.public_ip}
         Wait for propagation (usually < 5 min; verify with `dig ${var.domain_name}`).

      2. Open a shell on the host via SSM:
         aws ssm start-session --target ${aws_instance.ingestor.id}

      3. Inside the host, clone the repo and configure the stack:
         sudo -u ec2-user bash
         cd ~
         git clone https://github.com/apelogic-ai/observer.git
         cd observer/deploy/dev/compose
         cp .env.example .env
         vi .env
         # Set OBSERVER_API_KEYS (openssl rand -hex 32),
         # DOMAIN=${var.domain_name},
         # OBSERVER_S3_BUCKET=${aws_s3_bucket.lake.bucket},
         # OBSERVER_S3_REGION=${var.aws_region}

      4. Build and bring up the stack:
         docker compose up -d --build
         docker compose logs -f

      5. Verify:
         curl -fsSL https://${var.domain_name}/health   →   {"status":"ok"}
  EOT
}
