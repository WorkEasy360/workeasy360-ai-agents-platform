# One complete WorkEasy360 Agents environment. envs/staging and envs/prod call this with different sizes.
#
#   Internet -> [CloudFront + WAF (optional)] -> ALB (public subnets)
#     /api/*  -> api service (Express :4000)
#     default -> web service (Next.js :3000)
#   web -> api internally via Cloud Map: http://api.<env>.we360.internal:4000 (API_INTERNAL_URL)
#   worker (BullMQ), no load balancer
#   api/worker -> RDS PostgreSQL 16, ElastiCache Valkey (TLS), S3 (SSE-KMS), KMS, SES; internet via NAT

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name    = "${var.project}-${var.environment}"
  app_url = "https://${var.domain_name}"
  tags    = merge({ Project = var.project, Environment = var.environment, ManagedBy = "terraform" }, var.tags)

  # Secret containers (values set by hand). DATABASE_URL_OWNER is intentionally absent: migrations build it at
  # runtime from the RDS-managed master secret, which RDS rotates (a copied URL would go stale).
  required_secrets = ["BETTER_AUTH_SECRET", "API_KEY_PEPPER", "DATABASE_URL", "DATABASE_URL_ADMIN", "SMTP_USER", "SMTP_PASSWORD"]
  optional_secrets = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
  # ECS refuses to start a task whose secret has no value, so only inject optional secrets that are set.
  injected_secrets = concat(local.required_secrets, [for s in var.optional_secrets_enabled : s if contains(local.optional_secrets, s)])

  api_image = "${module.ecr.repository_urls["we360-agents-api"]}:${var.image_tag}"
  web_image = "${module.ecr.repository_urls["we360-agents-web"]}:${var.image_tag}"

  discovery_namespace = "${var.environment}.we360.internal"
  api_internal_url    = "http://api.${local.discovery_namespace}:4000"

  ses_identity_arn = "arn:${data.aws_partition.current.partition}:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${var.ses_domain}"

  backend_env = merge(
    {
      NODE_ENV             = "production"
      APP_URL              = local.app_url
      API_PORT             = "4000"
      AWS_REGION           = var.aws_region
      S3_BUCKET            = module.s3.bucket_name
      KMS_KEY_ID           = module.kms.key_arn
      REDIS_URL            = module.redis.url
      EMAIL_FROM           = var.email_from
      SMTP_HOST            = "email-smtp.${var.aws_region}.amazonaws.com"
      SMTP_PORT            = "587"
      ADMIN_REQUIRE_2FA    = "true"
      ALLOW_PRIVATE_EGRESS = "false"
      LOG_LEVEL            = "info"
      # Proxies that append to X-Forwarded-For: ALB, plus CloudFront when enabled (the ALB then only
      # accepts CloudFront, so the extra hop can't be spoofed). Wrong values break per-IP rate limits.
      TRUST_PROXY_HOPS = var.enable_cloudfront ? "2" : "1"
    },
    var.extra_backend_environment,
  )

  web_env = merge(
    {
      NODE_ENV         = "production"
      APP_URL          = local.app_url
      API_INTERNAL_URL = local.api_internal_url
    },
    var.extra_web_environment,
  )

  backend_secrets = { for s in local.injected_secrets : s => module.secrets.arns[s] }

  service_names = {
    web    = "${local.name}-web"
    api    = "${local.name}-api"
    worker = "${local.name}-worker"
  }
}

# ---------------------------------------------------------------- foundation

module "network" {
  source             = "../network"
  name               = local.name
  create_vpc         = var.create_vpc
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  vpc_id             = var.vpc_id
  private_subnet_ids = var.private_subnet_ids
  public_subnet_ids  = var.public_subnet_ids
  tags               = local.tags
}

module "kms" {
  source                  = "../kms"
  name                    = local.name
  deletion_window_in_days = var.kms_deletion_window_days
  tags                    = local.tags
}

module "s3" {
  source                             = "../s3"
  bucket_name                        = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"
  kms_key_arn                        = module.kms.key_arn
  noncurrent_version_expiration_days = var.s3_noncurrent_version_days
  tags                               = local.tags
}

module "secrets" {
  source                  = "../secrets"
  prefix                  = "${var.project}/${var.environment}"
  names                   = concat(local.required_secrets, local.optional_secrets)
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.tags
}

module "ecr" {
  source = "../ecr"
  create = var.create_ecr_repositories
  tags   = local.tags
}

# ---------------------------------------------------------------- security groups

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "web tasks"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-web" })
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "api tasks"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-api" })
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "worker tasks and one-off tasks (migrate, dbadmin)"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-worker" })
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

resource "aws_vpc_security_group_ingress_rule" "api_from_web" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

# Tasks need outbound internet (LLM providers, customer APIs, ECR, Secrets Manager) through NAT.
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = { web = aws_security_group.web.id, api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------- data stores

module "rds" {
  source                     = "../rds"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  instance_class             = var.db_instance_class
  db_name                    = var.db_name
  master_username            = var.db_master_username
  allocated_storage          = var.db_allocated_storage
  max_allocated_storage      = var.db_max_allocated_storage
  multi_az                   = var.db_multi_az
  backup_retention_days      = var.db_backup_retention_days
  deletion_protection        = var.db_deletion_protection
  kms_key_arn                = module.kms.key_arn
  tags                       = local.tags
}

module "redis" {
  source                     = "../redis"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_num_cache_clusters
  snapshot_retention_days    = var.redis_snapshot_retention_days
  kms_key_arn                = module.kms.key_arn
  tags                       = local.tags
}

# ---------------------------------------------------------------- IAM

module "iam" {
  source                 = "../iam"
  name                   = local.name
  app_secret_arns        = [for s in local.injected_secrets : module.secrets.arns[s]]
  db_master_secret_arn   = module.rds.master_user_secret_arn
  documents_bucket_arn   = module.s3.bucket_arn
  kms_key_arn            = module.kms.key_arn
  ses_identity_arns      = [local.ses_identity_arn]
  enable_execute_command = var.enable_execute_command
  tags                   = local.tags
}

# ---------------------------------------------------------------- load balancer and edge

module "alb" {
  source                 = "../alb"
  name                   = local.name
  vpc_id                 = module.network.vpc_id
  vpc_cidr_block         = module.network.vpc_cidr_block
  public_subnet_ids      = module.network.public_subnet_ids
  certificate_arn        = var.alb_certificate_arn
  idle_timeout           = var.alb_idle_timeout
  restrict_to_cloudfront = var.enable_cloudfront
  deletion_protection    = var.alb_deletion_protection
  tags                   = local.tags
}

module "waf_regional" {
  count                  = var.enable_waf && !var.enable_cloudfront ? 1 : 0
  source                 = "../waf"
  name                   = local.name
  scope                  = "REGIONAL"
  rate_limit_per_5min    = var.waf_rate_limit_per_5min
  admin_allowed_cidrs    = var.admin_allowed_cidrs
  associate_resource_arn = module.alb.arn
  tags                   = local.tags
}

module "waf_cloudfront" {
  count               = var.enable_waf && var.enable_cloudfront ? 1 : 0
  source              = "../waf"
  providers           = { aws = aws.us_east_1 }
  name                = "${local.name}-cf"
  scope               = "CLOUDFRONT"
  rate_limit_per_5min = var.waf_rate_limit_per_5min
  admin_allowed_cidrs = var.admin_allowed_cidrs
  tags                = local.tags
}

module "cdn" {
  count                     = var.enable_cloudfront ? 1 : 0
  source                    = "../cdn"
  name                      = local.name
  aliases                   = [var.domain_name]
  certificate_arn_us_east_1 = var.cloudfront_certificate_arn
  alb_dns_name              = module.alb.dns_name
  web_acl_arn               = var.enable_waf ? module.waf_cloudfront[0].web_acl_arn : null
  tags                      = local.tags
}

resource "aws_route53_record" "app" {
  count   = var.route53_zone_id == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = var.enable_cloudfront ? module.cdn[0].domain_name : module.alb.dns_name
    zone_id                = var.enable_cloudfront ? module.cdn[0].hosted_zone_id : module.alb.zone_id
    evaluate_target_health = !var.enable_cloudfront
  }
}

# ---------------------------------------------------------------- SES (domain identity + DKIM)

resource "aws_sesv2_email_identity" "domain" {
  count          = var.create_ses_identity ? 1 : 0
  email_identity = var.ses_domain
  tags           = local.tags
}

resource "aws_route53_record" "ses_dkim" {
  count   = var.create_ses_identity && var.route53_zone_id != "" ? 3 : 0
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.ses_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# ---------------------------------------------------------------- ECS

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = local.discovery_namespace
  description = "Internal service names for ${local.name}"
  vpc         = module.network.vpc_id
  tags        = local.tags
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
  tags = local.tags
}

module "web" {
  source             = "../ecs-service"
  name               = local.service_names.web
  container_name     = "web"
  cluster_arn        = aws_ecs_cluster.this.arn
  cluster_name       = aws_ecs_cluster.this.name
  region             = var.aws_region
  image              = local.web_image
  container_port     = 3000
  cpu                = var.web_cpu
  memory             = var.web_memory
  environment        = local.web_env
  execution_role_arn = module.iam.execution_app_role_arn
  task_role_arn      = module.iam.task_role_arns["web"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.web.id]
  target_group_arn   = module.alb.web_target_group_arn
  min_count          = var.web_min_count
  max_count          = var.web_max_count
  cpu_target_percent = var.cpu_target_percent
  log_retention_days = var.log_retention_days
  tags               = local.tags
}

module "api" {
  source                 = "../ecs-service"
  name                   = local.service_names.api
  container_name         = "api"
  cluster_arn            = aws_ecs_cluster.this.arn
  cluster_name           = aws_ecs_cluster.this.name
  region                 = var.aws_region
  image                  = local.api_image
  command                = ["node", "dist/server.js"]
  container_port         = 4000
  cpu                    = var.api_cpu
  memory                 = var.api_memory
  environment            = local.backend_env
  secrets                = local.backend_secrets
  execution_role_arn     = module.iam.execution_app_role_arn
  task_role_arn          = module.iam.task_role_arns["api"]
  subnet_ids             = module.network.private_subnet_ids
  security_group_ids     = [aws_security_group.api.id]
  target_group_arn       = module.alb.api_target_group_arn
  service_discovery_arn  = aws_service_discovery_service.api.arn
  min_count              = var.api_min_count
  max_count              = var.api_max_count
  cpu_target_percent     = var.cpu_target_percent
  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days
  tags                   = local.tags
}

module "worker" {
  source                 = "../ecs-service"
  name                   = local.service_names.worker
  container_name         = "worker"
  cluster_arn            = aws_ecs_cluster.this.arn
  cluster_name           = aws_ecs_cluster.this.name
  region                 = var.aws_region
  image                  = local.api_image
  command                = ["node", "dist/worker.js"]
  cpu                    = var.worker_cpu
  memory                 = var.worker_memory
  environment            = local.backend_env
  secrets                = local.backend_secrets
  execution_role_arn     = module.iam.execution_app_role_arn
  task_role_arn          = module.iam.task_role_arns["worker"]
  subnet_ids             = module.network.private_subnet_ids
  security_group_ids     = [aws_security_group.worker.id]
  min_count              = max(1, var.worker_min_count)
  max_count              = var.worker_max_count
  cpu_target_percent     = var.cpu_target_percent
  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days
  tags                   = local.tags
}

# One-off migration task (run by the deploy pipeline before services update).
# DATABASE_URL_OWNER is assembled from the RDS-managed master secret at start, URL-encoding the password.
module "migrate" {
  source         = "../ecs-service"
  create_service = false
  name           = "${local.name}-migrate"
  container_name = "migrate"
  region         = var.aws_region
  image          = local.api_image
  command = [
    "sh", "-c",
    "export DATABASE_URL_OWNER=\"$(node -e 'const e=process.env;process.stdout.write(\"postgres://\"+encodeURIComponent(e.DB_OWNER_USER)+\":\"+encodeURIComponent(e.DB_OWNER_PASSWORD)+\"@\"+e.DB_HOST+\":\"+e.DB_PORT+\"/\"+e.DB_NAME+\"?sslmode=\"+e.DB_SSLMODE)')\" && exec node dist/scripts/migrate.js",
  ]
  cpu    = 256
  memory = 512
  environment = {
    NODE_ENV       = "production"
    MIGRATIONS_DIR = "./migrations"
    DB_HOST        = module.rds.address
    DB_PORT        = tostring(module.rds.port)
    DB_NAME        = module.rds.db_name
    DB_SSLMODE     = var.db_sslmode
  }
  secrets = {
    DB_OWNER_USER     = "${module.rds.master_user_secret_arn}:username::"
    DB_OWNER_PASSWORD = "${module.rds.master_user_secret_arn}:password::"
  }
  execution_role_arn = module.iam.execution_migrate_role_arn
  task_role_arn      = module.iam.task_role_arns["migrate"]
  log_retention_days = var.log_retention_days
  tags               = local.tags
}

# One-off psql task for DB administration (create roles, restore checks). Start it with
# `aws ecs run-task --enable-execute-command` and connect with `aws ecs execute-command ... --command psql`.
module "dbadmin" {
  source         = "../ecs-service"
  create_service = false
  name           = "${local.name}-dbadmin"
  container_name = "psql"
  region         = var.aws_region
  image          = "public.ecr.aws/docker/library/postgres:16-alpine"
  command        = ["sleep", "3600"]
  cpu            = 256
  memory         = 512
  environment = {
    PGHOST     = module.rds.address
    PGPORT     = tostring(module.rds.port)
    PGDATABASE = module.rds.db_name
    PGSSLMODE  = "require"
  }
  secrets = {
    PGUSER     = "${module.rds.master_user_secret_arn}:username::"
    PGPASSWORD = "${module.rds.master_user_secret_arn}:password::"
  }
  execution_role_arn = module.iam.execution_migrate_role_arn
  task_role_arn      = module.iam.task_role_arns["dbadmin"]
  log_retention_days = var.log_retention_days
  tags               = local.tags
}

# ---------------------------------------------------------------- monitoring

module "monitoring" {
  source         = "../monitoring"
  name           = local.name
  alarm_emails   = var.alarm_emails
  alb_arn_suffix = module.alb.arn_suffix
  target_group_arn_suffixes = {
    web = module.alb.web_target_group_arn_suffix
    api = module.alb.api_target_group_arn_suffix
  }
  db_instance_id             = module.rds.instance_id
  redis_replication_group_id = module.redis.replication_group_id
  ecs_cluster_name           = aws_ecs_cluster.this.name
  ecs_service_names          = values(local.service_names)
  depends_on                 = [module.web, module.api, module.worker]
  tags                       = local.tags
}

# ---------------------------------------------------------------- CI/CD role

module "github_oidc" {
  count                = var.github_repository == "" ? 0 : 1
  source               = "../github-oidc"
  name                 = local.name
  create_oidc_provider = var.create_github_oidc_provider
  github_repository    = var.github_repository
  github_environment   = var.environment
  ecr_repository_arns  = values(module.ecr.repository_arns)
  ecs_cluster_name     = aws_ecs_cluster.this.name
  ecs_service_names    = values(local.service_names)
  migrate_task_family  = module.migrate.task_definition_family
  pass_role_arns = [
    module.iam.execution_app_role_arn,
    module.iam.execution_migrate_role_arn,
    module.iam.task_role_arns["web"],
    module.iam.task_role_arns["api"],
    module.iam.task_role_arns["worker"],
    module.iam.task_role_arns["migrate"],
  ]
  log_group_names = [module.migrate.log_group_name]
  tags            = local.tags
}
