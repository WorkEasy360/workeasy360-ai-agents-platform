variable "bucket_name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "noncurrent_version_expiration_days" {
  type    = number
  default = 30
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket. Keep false outside throwaway envs."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
