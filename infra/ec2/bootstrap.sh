#!/usr/bin/env bash
# Installs what deploy.sh needs: Docker, the Compose plugin, jq and the AWS CLI. Safe to re-run; it does
# nothing when everything is present. Supports Amazon Linux 2023 and Ubuntu. Run as root (SSM does).
set -euo pipefail

COMPOSE_VERSION=v2.39.1
log() { echo "[bootstrap] $*"; }
. /etc/os-release

if ! command -v docker > /dev/null; then
  log "Installing Docker"
  case "$ID" in
    amzn) dnf install -y docker ;;
    ubuntu | debian) apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io ;;
    *) echo "Unsupported OS: $ID (use Amazon Linux 2023 or Ubuntu)"; exit 1 ;;
  esac
  systemctl enable --now docker
fi

# docker-compose.yml uses env_file "format: raw" (Compose 2.30+), so older versions are replaced too.
current="$(docker compose version --short 2>/dev/null || echo 0)"
if [ "$(printf '%s\n' 2.30.0 "${current#v}" | sort -V | head -1)" != "2.30.0" ]; then
  log "Installing Docker Compose $COMPOSE_VERSION"
  arch="$(uname -m)"; [ "$arch" = "arm64" ] && arch=aarch64
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

for tool in jq curl unzip; do
  if ! command -v "$tool" > /dev/null; then
    log "Installing $tool"
    case "$ID" in
      amzn) dnf install -y "$tool" ;;
      *) apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y "$tool" ;;
    esac
  fi
done

if ! command -v aws > /dev/null; then
  log "Installing AWS CLI v2"
  tmp="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscliv2.zip"
  unzip -q "$tmp/awscliv2.zip" -d "$tmp" && "$tmp/aws/install" && rm -rf "$tmp"
fi

# Small instances: add 2 GB of swap so a memory spike slows things down instead of killing a container.
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 8000000 ]; then
  log "Adding 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile > /dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Ready: $(docker --version), $(docker compose version --short)"
