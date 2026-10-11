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
    tags = { Project = "we360-agents", Environment = "prod", ManagedBy = "terraform" }
  }
}

# CloudFront certificates and CLOUDFRONT-scope WAF must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "we360-agents", Environment = "prod", ManagedBy = "terraform" }
  }
}

module "platform" {
  source = "../../modules/platform"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment = "prod"
  aws_region  = var.aws_region

  domain_name         = var.domain_name
  alb_certificate_arn = var.alb_certificate_arn
  route53_zone_id     = var.route53_zone_id

  create_vpc         = var.create_vpc
  vpc_cidr           = var.vpc_cidr
  single_nat_gateway = false # one NAT per AZ: an AZ outage doesn't cut egress
  vpc_id             = var.vpc_id
  private_subnet_ids = var.private_subnet_ids
  public_subnet_ids  = var.public_subnet_ids

  create_ecr_repositories = var.create_ecr_repositories

  web_cpu            = 1024
  web_memory         = 2048
  api_cpu            = 1024
  api_memory         = 2048
  worker_cpu         = 1024
  worker_memory      = 2048
  web_min_count      = var.web_min_count
  web_max_count      = var.web_max_count
  api_min_count      = var.api_min_count
  api_max_count      = var.api_max_count
  worker_min_count   = 2
  worker_max_count   = var.worker_max_count
  container_insights = "enabled"

  db_instance_class        = var.db_instance_class
  db_allocated_storage     = 100
  db_max_allocated_storage = 500
  db_multi_az              = true
  db_backup_retention_days = 14
  db_deletion_protection   = true

  redis_node_type               = var.redis_node_type
  redis_num_cache_clusters      = 2
  redis_snapshot_retention_days = 7

  kms_deletion_window_days    = 30
  secret_recovery_window_days = 30
  optional_secrets_enabled    = var.optional_secrets_enabled

  alb_deletion_protection = true

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
