output "github_deploy_role_arn" {
  description = "GitHub Environment variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "app_secret_id" {
  description = "GitHub Environment variable APP_SECRET_ID; put the app configuration JSON in this secret."
  value       = aws_secretsmanager_secret.app.name
}

output "kms_key_arn" {
  description = "KMS_KEY_ID in the app configuration."
  value       = module.kms.key_arn
}

output "documents_bucket" {
  description = "S3_BUCKET in the app configuration."
  value       = module.s3.bucket_name
}

output "attach_instance_profile_command" {
  description = "Run once if Terraform created the instance role."
  value = var.instance_role_name == "" ? (
    "aws ec2 associate-iam-instance-profile --region ${var.aws_region} --instance-id ${var.instance_id} --iam-instance-profile Name=${aws_iam_instance_profile.instance[0].name}"
  ) : "Not needed: policies were added to ${var.instance_role_name}."
}
