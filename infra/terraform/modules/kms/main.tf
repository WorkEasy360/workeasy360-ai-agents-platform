# Customer-managed key used for: envelope encryption of tenant secrets (app calls GenerateDataKey/Decrypt),
# S3 documents (SSE-KMS), RDS storage and ElastiCache at rest.
# Access is granted through IAM (the key policy delegates to the account); see docs/runbooks/incident.md.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountAdministersKeyViaIAM"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "${var.name} platform key (envelope encryption, S3, RDS, ElastiCache)"
  deletion_window_in_days = var.deletion_window_in_days
  enable_key_rotation     = true
  rotation_period_in_days = 365
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = var.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}
