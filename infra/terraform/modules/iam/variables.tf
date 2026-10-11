variable "name" {
  type = string
}

variable "app_secret_arns" {
  description = "Secrets the app execution role may read (injected into web/api/worker)."
  type        = list(string)
}

variable "db_master_secret_arn" {
  type = string
}

variable "documents_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "ses_identity_arns" {
  description = "SES identities the backend may send from (domain identity ARN)."
  type        = list(string)
}

variable "enable_execute_command" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
