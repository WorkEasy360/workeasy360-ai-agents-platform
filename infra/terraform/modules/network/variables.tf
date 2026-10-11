variable "name" {
  type = string
}

variable "create_vpc" {
  description = "true: create a new VPC. false: use vpc_id / private_subnet_ids / public_subnet_ids."
  type        = bool
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  description = "AZs for a new VPC. RDS and the ALB need at least 2."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper, staging) vs one per AZ (prod)."
  type        = bool
  default     = true
}

variable "vpc_id" {
  type    = string
  default = ""
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "public_subnet_ids" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
