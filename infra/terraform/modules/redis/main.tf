# Valkey (Redis-compatible) for BullMQ, rate limits and quota counters.
# One node in staging; primary + replica with automatic failover in prod. TLS in transit (rediss://).
# No AUTH token: setting one here would store it in Terraform state. Access is limited by security group.

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Valkey for ${var.name}"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each                     = var.allowed_security_group_ids
  security_group_id            = aws_security_group.redis.id
  description                  = "Valkey from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

# BullMQ requires noeviction: evicting queue keys silently loses jobs.
resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-valkey8"
  family = "valkey8"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = var.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "${var.name} queues and counters"
  engine               = "valkey"
  engine_version       = var.engine_version
  node_type            = var.node_type
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.this.name

  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.num_cache_clusters > 1
  multi_az_enabled           = var.num_cache_clusters > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true

  snapshot_retention_limit   = var.snapshot_retention_days
  snapshot_window            = "19:00-20:00"
  maintenance_window         = "sun:22:30-sun:23:30"
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately

  tags = var.tags
}
