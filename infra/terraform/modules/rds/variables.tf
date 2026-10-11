variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  description = "Map of label => security group ID allowed to connect on 5432."
  type        = map(string)
}

variable "engine_version" {
  description = "Major version prefix; minor versions auto-upgrade in the maintenance window."
  type        = string
  default     = "16"
}

variable "instance_class" {
  type = string
}

variable "db_name" {
  type    = string
  default = "we360_agents"
}

variable "master_username" {
  description = "Migration owner (RDS master user)."
  type        = string
  default     = "we360_owner"
}

variable "allocated_storage" {
  type = number
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling (GB)."
  type        = number
}

variable "multi_az" {
  type = bool
}

variable "backup_retention_days" {
  type = number
  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "Keep at least 7 days of automated backups."
  }
}

variable "deletion_protection" {
  description = "Also controls whether a final snapshot is taken on destroy."
  type        = bool
}

variable "kms_key_arn" {
  type = string
}

variable "apply_immediately" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
