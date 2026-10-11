variable "create" {
  type = bool
}

variable "repository_names" {
  type    = list(string)
  default = ["we360-agents-api", "we360-agents-web"]
}

variable "keep_last" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
