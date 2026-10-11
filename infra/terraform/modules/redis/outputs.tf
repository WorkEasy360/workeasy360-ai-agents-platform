output "primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "url" {
  description = "TLS connection URL for ioredis/BullMQ."
  value       = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
}

output "replication_group_id" {
  value = aws_elasticache_replication_group.this.id
}

output "security_group_id" {
  value = aws_security_group.redis.id
}
