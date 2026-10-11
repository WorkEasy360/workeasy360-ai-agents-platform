# Optional CloudFront in front of the ALB. Nothing is cached except Next.js hashed static assets.
# All viewer headers (incl. Host and cookies) are forwarded, so the ALB certificate must cover the app
# domain (CloudFront validates the origin cert against the forwarded Host).
# SSE: origin_read_timeout is the max gap between bytes; keep stream heartbeats under it.

locals {
  # AWS managed policy IDs (stable, documented by AWS).
  caching_disabled_policy_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  caching_optimized_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  all_viewer_request_policy   = "216adef6-5c7f-47e4-b989-5492eafa07d3"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = var.name
  aliases         = var.aliases
  price_class     = var.price_class
  web_acl_id      = var.web_acl_arn
  http_version    = "http2and3"

  origin {
    origin_id   = "alb"
    domain_name = var.alb_dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = var.origin_read_timeout
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = local.all_viewer_request_policy
  }

  ordered_cache_behavior {
    path_pattern             = "/_next/static/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = local.caching_optimized_policy_id
    origin_request_policy_id = local.all_viewer_request_policy
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn_us_east_1
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}
