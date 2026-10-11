# Repositories are shared by all environments in one account (staging builds, prod promotes the same tag).
# Set create = false in the second environment to look them up instead.

resource "aws_ecr_repository" "this" {
  for_each             = var.create ? toset(var.repository_names) : toset([])
  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }

  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last ${var.keep_last} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.keep_last
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_ecr_repository" "existing" {
  for_each = var.create ? toset([]) : toset(var.repository_names)
  name     = each.value
}

locals {
  repos = var.create ? { for k, r in aws_ecr_repository.this : k => { url = r.repository_url, arn = r.arn } } : { for k, r in data.aws_ecr_repository.existing : k => { url = r.repository_url, arn = r.arn } }
}
