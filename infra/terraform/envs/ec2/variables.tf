variable "aws_region" {
  description = "Region of the EC2 instance, ECR, KMS, S3 and the config secret."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "instance_id" {
  description = "The existing EC2 instance, e.g. i-0123456789abcdef0."
  type        = string
}

variable "instance_role_name" {
  description = "IAM role already attached to the instance. Leave empty to create one (then attach the instance profile; see the output)."
  type        = string
  default     = ""
}

variable "documents_bucket_name" {
  description = "Globally unique S3 bucket name for uploaded documents."
  type        = string
}

variable "create_ecr_repositories" {
  description = "false if the we360-agents-api/web repositories already exist in this account and region."
  type        = bool
  default     = true
}

variable "github_repository" {
  type    = string
  default = "WorkEasy360/workeasy360-ai-agents-platform"
}

variable "github_environment" {
  description = "GitHub Environment the deploy job runs in."
  type        = string
  default     = "production"
}

variable "create_oidc_provider" {
  description = "false if the account already has the token.actions.githubusercontent.com OIDC provider."
  type        = bool
  default     = true
}
