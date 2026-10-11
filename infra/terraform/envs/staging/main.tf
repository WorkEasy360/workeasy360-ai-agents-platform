terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "we360-agents", Environment = "staging", ManagedBy = "terraform" }
  }
}

# CloudFront certificates and CLOUDFRONT-scope WAF must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "we360-agents", Environment = "staging", ManagedBy = "terraform" }
  }
}

module "platform" {
  source = "../../modules/platform"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment = "staging"
  aws_region  = var.aws_region

  domain_name         = var.domain_name
  alb_certificate_arn = var.alb_certificate_arn
  route53_zone_id     = var.route53_zone_id

  create_vpc         = var.create_vpc
  vpc_cidr           = var.vpc_cidr
  single_nat_gateway = true
  vpc_id             = var.vpc_id
  private_subnet_ids = var.private_subnet_ids
  public_subnet_ids  = var.public_subnet_ids

  create_ecr_repositories = var.create_ecr_repositories

  # Small: one task each. Fargate CPU units / MiB.
  web_cpu            = 512
  web_memory         = 1024
  api_cpu            = 512
  api_memory         = 1024
  worker_cpu         = 512
  worker_memory      = 1024
  web_min_count      = var.web_min_count
  web_max_count      = var.web_max_count
  api_min_count      = var.api_min_count
  api_max_count      = var.api_max_count
  worker_min_count   = 1
  worker_max_count   = var.worker_max_count
  container_insights = "disabled"

  db_instance_class        = var.db_instance_class
  db_allocated_storage     = 20
  db_max_allocated_storage = 100
  db_multi_az              = false
  db_backup_retention_days = 7
  db_deletion_protection   = false

  redis_node_type          = var.redis_node_type
  redis_num_cache_clusters = 1

  kms_deletion_window_days    = 7
  secret_recovery_window_days = 7
  optional_secrets_enabled    = var.optional_secrets_enabled

  email_from          = var.email_from
  ses_domain          = var.ses_domain
  create_ses_identity = var.create_ses_identity

  enable_waf                 = var.enable_waf
  enable_cloudfront          = var.enable_cloudfront
  cloudfront_certificate_arn = var.cloudfront_certificate_arn
  admin_allowed_cidrs        = var.admin_allowed_cidrs

  alarm_emails                = var.alarm_emails
  github_repository           = var.github_repository
  create_github_oidc_provider = var.create_github_oidc_provider
}
