variable "name" {
  type = string
}

variable "create_oidc_provider" {
  description = "The GitHub OIDC provider exists once per AWS account."
  type        = bool
}

variable "github_repository" {
  description = "owner/repo"
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment name the workflow job uses (staging or prod)."
  type        = string
}

variable "ecr_repository_arns" {
  type = list(string)
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_names" {
  type = list(string)
}

variable "migrate_task_family" {
  type = string
}

variable "pass_role_arns" {
  description = "Execution and task roles referenced by the task definitions."
  type        = list(string)
}

variable "log_group_names" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
