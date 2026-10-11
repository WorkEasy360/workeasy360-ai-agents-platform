variable "name" {
  type = string
}

variable "scope" {
  type = string
  validation {
    condition     = contains(["REGIONAL", "CLOUDFRONT"], var.scope)
    error_message = "scope must be REGIONAL or CLOUDFRONT."
  }
}

variable "rate_limit_per_5min" {
  description = "Requests per IP per 5 minutes before blocking."
  type        = number
  default     = 2000
}

variable "admin_allowed_cidrs" {
  description = "If non-empty, /admin and /api/admin/ are only reachable from these IPv4 CIDRs."
  type        = list(string)
  default     = []
}

variable "associate_resource_arn" {
  description = "ALB ARN for REGIONAL scope. null for CLOUDFRONT (set web_acl_id on the distribution)."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
