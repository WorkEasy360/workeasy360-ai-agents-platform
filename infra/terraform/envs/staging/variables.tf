variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "domain_name" {
  description = "e.g. staging.agents.workeasy360.com"
  type        = string
}

variable "alb_certificate_arn" {
  description = "ACM cert in ap-south-1 for domain_name."
  type        = string
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "create_vpc" {
  type    = bool
  default = true
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
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

variable "create_ecr_repositories" {
  type    = bool
  default = true
}

variable "web_min_count" {
  type    = number
  default = 1
}

variable "web_max_count" {
  type    = number
  default = 2
}

variable "api_min_count" {
  type    = number
  default = 1
}

variable "api_max_count" {
  type    = number
  default = 2
}

variable "worker_max_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "optional_secrets_enabled" {
  type    = list(string)
  default = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
}

variable "email_from" {
  type = string
}

variable "ses_domain" {
  type = string
}

variable "create_ses_identity" {
  type    = bool
  default = true
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
  type    = string
  default = ""
}

variable "admin_allowed_cidrs" {
  type    = list(string)
  default = []
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "github_repository" {
  description = "owner/repo"
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  type    = bool
  default = true
}
