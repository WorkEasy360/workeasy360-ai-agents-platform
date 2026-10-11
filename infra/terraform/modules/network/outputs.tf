output "vpc_id" {
  value = var.create_vpc ? aws_vpc.this[0].id : var.vpc_id
}

output "vpc_cidr_block" {
  value = var.create_vpc ? aws_vpc.this[0].cidr_block : data.aws_vpc.existing[0].cidr_block
}

output "private_subnet_ids" {
  value = var.create_vpc ? aws_subnet.private[*].id : var.private_subnet_ids
}

output "public_subnet_ids" {
  value = var.create_vpc ? aws_subnet.public[*].id : var.public_subnet_ids
}

output "nat_public_ips" {
  description = "Egress IPs (customers may allowlist these for API tools). Empty for an existing VPC."
  value       = aws_eip.nat[*].public_ip
}
