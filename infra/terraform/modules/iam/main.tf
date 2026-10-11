# ECS roles, least privilege:
# - app execution role: pull images, write logs, read the app secrets (injected at task start).
# - migrate execution role: same, but reads only the RDS-managed master secret.
# - api / worker task roles: S3 objects in the documents bucket, KMS data keys, SES send.
# - web / migrate task roles: nothing. dbadmin (psql one-off task): ECS Exec only.
# - migrate execution role also starts the dbadmin task (both read only the RDS master secret).

data "aws_partition" "current" {}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------- execution roles ----------

resource "aws_iam_role" "execution_app" {
  name               = "${var.name}-exec-app"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = var.tags
}

resource "aws_iam_role" "execution_migrate" {
  name               = "${var.name}-exec-migrate"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_app_managed" {
  role       = aws_iam_role.execution_app.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "execution_migrate_managed" {
  role       = aws_iam_role.execution_migrate.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_app_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.app_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_app_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.execution_app.id
  policy = data.aws_iam_policy_document.execution_app_secrets.json
}

data "aws_iam_policy_document" "execution_migrate_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_master_secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_migrate_secrets" {
  name   = "read-db-master-secret"
  role   = aws_iam_role.execution_migrate.id
  policy = data.aws_iam_policy_document.execution_migrate_secrets.json
}

# ---------- task roles ----------

resource "aws_iam_role" "task" {
  for_each           = toset(["web", "api", "worker", "migrate", "dbadmin"])
  name               = "${var.name}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "backend" {
  statement {
    sid       = "DocumentsObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.documents_bucket_arn}/*"]
  }

  statement {
    sid       = "DocumentsList"
    actions   = ["s3:ListBucket"]
    resources = [var.documents_bucket_arn]
  }

  statement {
    sid       = "EnvelopeEncryption"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
  }

  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = var.ses_identity_arns
  }
}

resource "aws_iam_role_policy" "backend" {
  for_each = toset(["api", "worker"])
  name     = "backend"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.backend.json
}

# ECS Exec (used for one-off admin commands such as create-admin).
data "aws_iam_policy_document" "ecs_exec" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_exec" {
  for_each = toset(concat(["dbadmin"], var.enable_execute_command ? ["api", "worker"] : []))
  name     = "ecs-exec"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.ecs_exec.json
}
