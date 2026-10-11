output "execution_app_role_arn" {
  value = aws_iam_role.execution_app.arn
}

output "execution_migrate_role_arn" {
  value = aws_iam_role.execution_migrate.arn
}

output "task_role_arns" {
  description = "Map web/api/worker/migrate => task role ARN"
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}
