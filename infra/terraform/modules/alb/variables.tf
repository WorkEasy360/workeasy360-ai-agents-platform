variable "name" {
  description = "Max 26 chars (target group names append -web/-api and are capped at 32)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr_block" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate in the ALB's region covering the app domain."
  type        = string
}

variable "ssl_policy" {
  type    = string
  default = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "idle_timeout" {
  description = "Seconds. Must exceed the longest gap between SSE events (streaming runs)."
  type        = number
  default     = 300
  validation {
    condition     = var.idle_timeout >= 120
    error_message = "idle_timeout must be at least 120 seconds for SSE streaming."
  }
}

variable "web_health_check_path" {
  type    = string
  default = "/"
}

variable "restrict_to_cloudfront" {
  description = "Only accept HTTPS from CloudFront's origin-facing prefix list (when CloudFront fronts the ALB)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
