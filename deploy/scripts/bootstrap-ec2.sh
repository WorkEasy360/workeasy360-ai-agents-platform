#!/usr/bin/env bash
# One-time host setup for a fresh EC2 instance: Docker Engine + Compose plugin, the
# login user in the docker group, and 2 GB of swap on small instances.
# Supports Ubuntu (22.04+) and Amazon Linux 2023. Idempotent.
#
#   sudo bash deploy/scripts/bootstrap-ec2.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-${TARGET_USER:-}}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  if id ubuntu >/dev/null 2>&1; then TARGET_USER=ubuntu; else TARGET_USER=ec2-user; fi
fi

. /etc/os-release
echo "==> Detected $PRETTY_NAME; docker group user: $TARGET_USER"

case "$ID" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    # A fresh instance runs unattended-upgrades on first boot; wait for its apt lock.
    for _ in $(seq 1 120); do
      fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
      echo "==> waiting for another apt process (unattended-upgrades) to finish..."
      sleep 10
    done
    apt-get update -y
    apt-get install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.asc ]; then
      curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ;;
  amzn)
    dnf install -y docker
    if ! docker compose version >/dev/null 2>&1; then
      arch="$(uname -m)"
      mkdir -p /usr/local/lib/docker/cli-plugins
      curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
    ;;
  *)
    echo "Unsupported distribution: $ID (use Ubuntu or Amazon Linux 2023)" >&2
    exit 1
    ;;
esac

systemctl enable --now docker
usermod -aG docker "$TARGET_USER"

# Host firewall (in addition to the security group): SSH, HTTP and HTTPS only. Docker publishes only
# nginx's 80/443, so nothing else is reachable either way. SSH is allowed BEFORE enabling, so the
# current session isn't cut off.
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  echo "==> Firewall (ufw): $(ufw status | head -1)"
fi

# Swap: images are built on GitHub, never here, but a 2 GB instance still benefits from
# headroom during image pulls and container restarts.
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 4000000 ] && ! swapon --show | grep -q '/swapfile'; then
  echo "==> RAM < 4 GB: creating 2 GB swap at /swapfile"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

docker --version
docker compose version
echo
echo "==> Done. Log out and back in (or run: newgrp docker) so '$TARGET_USER' can use docker without sudo."
