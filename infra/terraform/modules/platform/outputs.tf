output "app_url" {
  value = local.app_url
}

output "alb_dns_name" {
  description = "Point the app domain here (CNAME/alias) if Terraform doesn't manage DNS."
  value       = module.alb.dns_name
}

output "cloudfront_domain_name" {
  value = var.enable_cloudfront ? module.cdn[0].domain_name : null
}

output "nat_public_ips" {
  value = module.network.nat_public_ips
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_names" {
  value = local.service_names
}

output "migrate_task_family" {
  value = module.migrate.task_definition_family
}

output "dbadmin_task_family" {
  value = module.dbadmin.task_definition_family
}

output "task_security_group_id" {
  description = "Worker SG; also used for one-off tasks (migrate, dbadmin)."
  value       = aws_security_group.worker.id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "secret_arns" {
  value = module.secrets.arns
}

output "db_address" {
  value = module.rds.address
}

output "db_master_secret_arn" {
  value = module.rds.master_user_secret_arn
}

output "redis_url" {
  value = module.redis.url
}

output "documents_bucket" {
  value = module.s3.bucket_name
}

output "kms_key_arn" {
  value = module.kms.key_arn
}

output "alerts_topic_arn" {
  value = module.monitoring.sns_topic_arn
}

output "github_deploy_role_arn" {
  value = var.github_repository == "" ? null : module.github_oidc[0].role_arn
}

output "ses_dkim_tokens" {
  description = "Create CNAMEs <token>._domainkey.<ses_domain> -> <token>.dkim.amazonses.com if DNS is not in Route 53."
  value       = var.create_ses_identity ? aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens : []
}
