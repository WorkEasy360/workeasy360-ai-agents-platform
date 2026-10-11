output "role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable on the matching GitHub Environment."
  value       = aws_iam_role.deploy.arn
}
