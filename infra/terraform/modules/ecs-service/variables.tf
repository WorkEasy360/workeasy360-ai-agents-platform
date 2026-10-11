variable "name" {
  description = "Service name, task definition family and log group suffix."
  type        = string
}

variable "container_name" {
  type = string
}

variable "create_service" {
  type    = bool
  default = true
}

variable "cluster_arn" {
  type    = string
  default = null
}

variable "cluster_name" {
  type    = string
  default = null
}

variable "region" {
  type = string
}

variable "image" {
  type = string
}

variable "command" {
  description = "Overrides the image CMD. null keeps the Dockerfile CMD."
  type        = list(string)
  default     = null
}

variable "container_port" {
  type    = number
  default = null
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "cpu_architecture" {
  description = "X86_64 matches images built on GitHub's ubuntu-latest runners."
  type        = string
  default     = "X86_64"
}

variable "environment" {
  description = "Plain (non-secret) environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of env var name => Secrets Manager ARN (optionally ARN:jsonKey::)."
  type        = map(string)
  default     = {}
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "service_discovery_arn" {
  type    = string
  default = null
}

variable "min_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 1
}

variable "cpu_target_percent" {
  type    = number
  default = 60
}

variable "enable_execute_command" {
  type    = bool
  default = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
