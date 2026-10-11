variable "name" {
  type = string
}

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffixes" {
  description = "Map label => target group ARN suffix"
  type        = map(string)
}

variable "alb_5xx_threshold" {
  type    = number
  default = 10
}

variable "target_5xx_threshold" {
  type    = number
  default = 25
}

variable "db_instance_id" {
  type = string
}

variable "db_free_storage_threshold_gb" {
  type    = number
  default = 5
}

variable "redis_replication_group_id" {
  type = string
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_names" {
  type = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
