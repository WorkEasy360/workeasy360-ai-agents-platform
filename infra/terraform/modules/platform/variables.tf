# ---------------------------------------------------------------- identity

variable "project" {
  type    = string
  default = "we360-agents"
}

variable "environment" {
  description = "staging or prod. Also the GitHub Environment name used by the deploy workflow."
  type        = string
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------- domain / TLS

variable "domain_name" {
  description = "App domain, e.g. agents.workeasy360.com (APP_URL = https://<domain_name>)."
  type        = string
}

variable "alb_certificate_arn" {
  description = "ACM certificate in aws_region covering domain_name."
  type        = string
}

variable "route53_zone_id" {
  description = "If set, Terraform creates the app A-alias record (and SES DKIM records). Empty = manage DNS yourself."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------- network

variable "create_vpc" {
  type = bool
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "vpc_id" {
  type    = string
  default = ""
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "public_subnet_ids" {
  type    = list(string)
  default = []
}

# ---------------------------------------------------------------- images

variable "create_ecr_repositories" {
  description = "true in the first environment of an AWS account; false in the second (it looks them up)."
  type        = bool
}

variable "image_tag" {
  description = "Tag used only when Terraform registers task definitions. The deploy workflow sets the real tag (git SHA)."
  type        = string
  default     = "bootstrap"
}

# ---------------------------------------------------------------- compute sizing

variable "web_cpu" {
  type = number
}

variable "web_memory" {
  type = number
}

variable "api_cpu" {
  type = number
}

variable "api_memory" {
  type = number
}

variable "worker_cpu" {
  type = number
}

variable "worker_memory" {
  type = number
}

variable "web_min_count" {
  type = number
}

variable "web_max_count" {
  type = number
}

variable "api_min_count" {
  type = number
}

variable "api_max_count" {
  type = number
}

variable "worker_min_count" {
  description = "Always at least 1."
  type        = number
  default     = 1
}

variable "worker_max_count" {
  type = number
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "container_insights" {
  description = "enabled | enhanced | disabled"
  type        = string
  default     = "disabled"
}

variable "enable_execute_command" {
  description = "ECS Exec into api/worker tasks (used for create-admin)."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# ---------------------------------------------------------------- database

variable "db_instance_class" {
  type = string
}

variable "db_name" {
  type    = string
  default = "we360_agents"
}

variable "db_master_username" {
  type    = string
  default = "we360_owner"
}

variable "db_allocated_storage" {
  type = number
}

variable "db_max_allocated_storage" {
  type = number
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "db_deletion_protection" {
  type = bool
}

variable "db_sslmode" {
  description = <<-EOT
    sslmode for the migration connection string. The API image trusts the RDS CA bundle
    (NODE_EXTRA_CA_CERTS), so "verify-full" checks the server certificate. Never use "no-verify" in production.
  EOT
  type        = string
  default     = "verify-full"
}

# ---------------------------------------------------------------- redis

variable "redis_node_type" {
  type = string
}

variable "redis_num_cache_clusters" {
  type = number
}

variable "redis_snapshot_retention_days" {
  type    = number
  default = 1
}

# ---------------------------------------------------------------- storage / keys / secrets

variable "s3_noncurrent_version_days" {
  type    = number
  default = 30
}

variable "kms_deletion_window_days" {
  type    = number
  default = 30
}

variable "secret_recovery_window_days" {
  type    = number
  default = 7
}

variable "optional_secrets_enabled" {
  description = <<-EOT
    Optional secrets injected into api/worker. ECS fails to start a task if an injected secret has no value,
    so list only the ones you have set. Choices: OPENAI_API_KEY, ANTHROPIC_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
  EOT
  type        = list(string)
  default     = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
}

# ---------------------------------------------------------------- app config

variable "email_from" {
  description = "Must be on the verified SES domain."
  type        = string
}

variable "ses_domain" {
  description = "SES sending domain (identity). Usually the root domain, e.g. workeasy360.com."
  type        = string
}

variable "create_ses_identity" {
  description = "SES identities are per account+region: create it in one environment only."
  type        = bool
  default     = false
}

variable "extra_backend_environment" {
  description = "Extra non-secret env vars for api/worker (e.g. INGEST_CONCURRENCY, DB_POOL_MAX)."
  type        = map(string)
  default     = {}
  validation {
    condition = length(setintersection(
      toset([for k in keys(var.extra_backend_environment) : upper(k)]),
      toset(["MOCK_LLM", "LOCAL_MASTER_KEY", "S3_ENDPOINT", "S3_FORCE_PATH_STYLE", "ALLOW_PRIVATE_EGRESS"])
    )) == 0
    error_message = "MOCK_LLM, LOCAL_MASTER_KEY, S3_ENDPOINT, S3_FORCE_PATH_STYLE and ALLOW_PRIVATE_EGRESS are local-only and must never be set in AWS."
  }
}

variable "extra_web_environment" {
  type    = map(string)
  default = {}
  validation {
    condition     = !contains([for k in keys(var.extra_web_environment) : upper(k)], "MOCK_LLM")
    error_message = "MOCK_LLM must never be set in AWS."
  }
}

# ---------------------------------------------------------------- load balancer / edge

variable "alb_idle_timeout" {
  type    = number
  default = 300
}

variable "alb_deletion_protection" {
  type    = bool
  default = false
}

variable "enable_waf" {
  type    = bool
  default = false
}

variable "enable_cloudfront" {
  type    = bool
  default = false
}

variable "cloudfront_certificate_arn" {
  description = "ACM certificate in us-east-1 (only when enable_cloudfront)."
  type        = string
  default     = ""
}

variable "waf_rate_limit_per_5min" {
  type    = number
  default = 2000
}

variable "admin_allowed_cidrs" {
  description = "If set (and WAF enabled), /admin and /api/admin/ are reachable only from these CIDRs."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------- alerts / CI

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "github_repository" {
  description = "owner/repo for the deploy role's OIDC trust. Empty = don't create the role."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = "The GitHub OIDC provider exists once per AWS account."
  type        = bool
  default     = false
}
