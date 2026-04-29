output "public_ip" {
  description = "Elastic IP of the ingestor host. Set an A record at your DNS provider pointing the domain at this IP."
  value       = aws_eip.ingestor.public_ip
}

output "ssh_command" {
  description = "Connect to the host."
  value       = "ssh -i ~/.ssh/${var.ssh_key_name}.pem ec2-user@${aws_eip.ingestor.public_ip}"
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

      2. Copy the compose stack onto the host:
         scp -r -i ~/.ssh/${var.ssh_key_name}.pem deploy/dev/compose ec2-user@${aws_eip.ingestor.public_ip}:~/

      3. Create your real .env on the host (substitute strong API keys):
         ssh -i ~/.ssh/${var.ssh_key_name}.pem ec2-user@${aws_eip.ingestor.public_ip}
         cd compose
         cp .env.example .env
         vi .env   # set OBSERVER_API_KEYS, DOMAIN, OBSERVER_S3_BUCKET=${aws_s3_bucket.lake.bucket}, OBSERVER_S3_REGION=${var.aws_region}

      4. Build the api image and bring up the stack:
         (compose builds from the source tree on the host — ship the repo,
         or rely on a pre-built image you push to a registry.)
         docker compose up -d --build

      5. Verify:
         curl -fsSL https://${var.domain_name}/health   →   {"status":"ok"}
  EOT
}
