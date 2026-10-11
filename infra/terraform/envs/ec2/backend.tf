# Remote state. Create the bucket (versioned, encrypted) once, then replace the placeholder.
# Without it, delete this file and Terraform keeps state locally (keep that file safe; don't commit it).
terraform {
  backend "s3" {
    bucket       = "REPLACE_ME-terraform-state"
    key          = "we360-agents/ec2/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}
