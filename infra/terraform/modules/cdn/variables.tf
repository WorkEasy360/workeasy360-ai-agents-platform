variable "name" {
  type = string
}

variable "aliases" {
  description = "Viewer domain names, e.g. [\"agents.workeasy360.com\"]."
  type        = list(string)
}

variable "certificate_arn_us_east_1" {
  description = "ACM certificate in us-east-1 covering the aliases (CloudFront requirement)."
  type        = string
}

variable "alb_dns_name" {
  type = string
}

variable "web_acl_arn" {
  description = "WAFv2 web ACL ARN (CLOUDFRONT scope) or null."
  type        = string
  default     = null
}

variable "price_class" {
  description = "PriceClass_200 includes India edge locations."
  type        = string
  default     = "PriceClass_200"
}

variable "origin_read_timeout" {
  description = "Seconds (max 60 without a quota increase)."
  type        = number
  default     = 60
}

variable "tags" {
  type    = map(string)
  default = {}
}
