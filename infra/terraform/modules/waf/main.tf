# WAF web ACL: AWS common + known-bad-inputs managed rules, per-IP rate limit, optional admin IP allowlist.
# scope = REGIONAL (attached to the ALB) or CLOUDFRONT (provider must be us-east-1; pass the ARN to CloudFront).

locals {
  admin_allowlist = length(var.admin_allowed_cidrs) > 0
}

resource "aws_wafv2_ip_set" "admin" {
  count              = local.admin_allowlist ? 1 : 0
  name               = "${var.name}-admin-allow"
  scope              = var.scope
  ip_address_version = "IPV4"
  addresses          = var.admin_allowed_cidrs
  tags               = var.tags
}

resource "aws_wafv2_web_acl" "this" {
  name  = var.name
  scope = var.scope
  tags  = var.tags

  default_action {
    allow {}
  }

  # Super admin UI and API only from office/VPN IPs (blueprint §0.6). Off when the list is empty.
  dynamic "rule" {
    for_each = local.admin_allowlist ? [1] : []
    content {
      name     = "admin-ip-allowlist"
      priority = 0
      action {
        block {}
      }
      statement {
        and_statement {
          statement {
            or_statement {
              statement {
                byte_match_statement {
                  search_string         = "/api/admin/"
                  positional_constraint = "STARTS_WITH"
                  field_to_match {
                    uri_path {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "LOWERCASE"
                  }
                }
              }
              statement {
                byte_match_statement {
                  search_string         = "/admin"
                  positional_constraint = "STARTS_WITH"
                  field_to_match {
                    uri_path {}
                  }
                  text_transformation {
                    priority = 0
                    type     = "LOWERCASE"
                  }
                }
              }
            }
          }
          statement {
            not_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.admin[0].arn
                }
              }
            }
          }
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-admin-allowlist"
        sampled_requests_enabled   = true
      }
    }
  }

  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        # Document uploads and long agent instructions exceed the 8 KB body limit; count instead of block.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.rate_limit_per_5min
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count        = var.associate_resource_arn == null ? 0 : 1
  resource_arn = var.associate_resource_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
