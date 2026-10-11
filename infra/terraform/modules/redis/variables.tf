variable "name" {
  description = "Replication group ID (max 40 chars)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  type = map(string)
}

variable "node_type" {
  type = string
}

variable "num_cache_clusters" {
  description = "1 = single node (staging). 2+ = primary + replicas with automatic failover (prod)."
  type        = number
  default     = 1
}

variable "engine_version" {
  type    = string
  default = "8.0"
}

variable "snapshot_retention_days" {
  type    = number
  default = 1
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
