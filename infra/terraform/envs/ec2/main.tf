# Single-EC2 deployment (Mumbai) with an existing PostgreSQL database (RDS/Aurora) in another region.
# The instance itself and the database are not managed here. This creates what surrounds them:
#   - ECR repositories for the api and web images
#   - a KMS key (tenant secret envelope encryption, S3 documents) and the documents bucket
#   - the Secrets Manager secret that deploy.sh reads (its value is set by hand; see docs/runbooks/ec2-deploy.md)
#   - permissions for the instance (pull images, read the secret, use KMS and S3, be managed by SSM)
#   - the role GitHub Actions assumes through OIDC to push images and run deploy.sh through SSM
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "we360-agents", Environment = var.environment, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name    = "we360-agents-${var.environment}"
  arn     = "arn:${data.aws_partition.current.partition}"
  account = data.aws_caller_identity.current.account_id
}

module "ecr" {
  source = "../../modules/ecr"
  create = var.create_ecr_repositories
}

module "kms" {
  source = "../../modules/kms"
  name   = local.name
}

module "s3" {
  source      = "../../modules/s3"
  bucket_name = var.documents_bucket_name
  kms_key_arn = module.kms.key_arn
}

resource "aws_secretsmanager_secret" "app" {
  name        = "we360-agents/${var.environment}/app-env"
  description = "JSON object of environment variables for the EC2 deployment (read by infra/ec2/deploy.sh)."
}

# ---------------------------------------------------------------- instance permissions

data "aws_iam_policy_document" "instance_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# Used only when the instance has no role yet (instance_role_name = "").
resource "aws_iam_role" "instance" {
  count              = var.instance_role_name == "" ? 1 : 0
  name               = "${local.name}-ec2"
  assume_role_policy = data.aws_iam_policy_document.instance_trust.json
}

resource "aws_iam_instance_profile" "instance" {
  count = var.instance_role_name == "" ? 1 : 0
  name  = "${local.name}-ec2"
  role  = aws_iam_role.instance[0].name
}

locals {
  instance_role_name = var.instance_role_name != "" ? var.instance_role_name : aws_iam_role.instance[0].name
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = local.instance_role_name
  policy_arn = "${local.arn}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = values(module.ecr.repository_arns)
  }
  statement {
    sid       = "ReadAppConfig"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
  statement {
    sid       = "EnvelopeEncryption"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = [module.kms.key_arn]
  }
  statement {
    sid       = "DocumentsBucketList"
    actions   = ["s3:ListBucket"]
    resources = [module.s3.bucket_arn]
  }
  statement {
    sid       = "DocumentsBucketObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.s3.bucket_arn}/*"]
  }
}

resource "aws_iam_role_policy" "instance" {
  name   = "${local.name}-app"
  role   = local.instance_role_name
  policy = data.aws_iam_policy_document.instance.json
}

# ---------------------------------------------------------------- GitHub Actions (OIDC)

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "${local.arn}:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs in this repository's GitHub Environment can deploy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = values(module.ecr.repository_arns)
  }
  statement {
    sid     = "RunDeployScript"
    actions = ["ssm:SendCommand"]
    resources = [
      "${local.arn}:ec2:${var.aws_region}:${local.account}:instance/${var.instance_id}",
      "${local.arn}:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }
  statement {
    sid       = "ReadDeployResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
