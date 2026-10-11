# 10. Deployment Architecture

```mermaid
flowchart TB
  GH[GitHub Actions] --> ECR[ECR images] --> ECS
  subgraph Region ap-south-1 (TBC)
    WAF[WAF] --> CFD[CloudFront] --> ALB[ALB - public subnets]
    subgraph ECS[ECS Fargate - private subnets]
      WEB[web] ; API[api] ; WRK[worker] ; ADM[admin - internal ALB]
    end
    ALB --> WEB & API
    API & WRK --> RDS[(RDS Postgres Multi-AZ)]
    API & WRK --> REDIS[(ElastiCache)]
    WRK --> S3[(S3)]
    WRK & API --> NAT[Egress proxy / NAT] --> NET((Internet: LLMs, APIs))
    API --> KMS[KMS] ; API --> SM[Secrets Manager]
  end
  CFD --> S3W[(S3 widget assets)]
```

