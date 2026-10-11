output "repository_urls" {
  value = { for k, r in local.repos : k => r.url }
}

output "repository_arns" {
  value = { for k, r in local.repos : k => r.arn }
}
