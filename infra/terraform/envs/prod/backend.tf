# Remote state. Create the bucket (versioned, encrypted) and lock table once, then replace the placeholders.
# The lock table needs a string partition key named "LockID".
# (Terraform >= 1.10 can use `use_lockfile = true` instead of DynamoDB.)
terraform {
  backend "s3" {
    bucket         = "REPLACE_ME-terraform-state"
    key            = "we360-agents/prod/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "REPLACE_ME-terraform-locks"
    encrypt        = true
  }
}
