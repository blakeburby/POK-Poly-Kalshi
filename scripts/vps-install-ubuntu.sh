#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/blakeburby/POK-Poly-Kalshi.git}"
APP_DIR="${APP_DIR:-/opt/pok-poly-kalshi}"
ENV_DIR="${ENV_DIR:-/etc/pok-poly-kalshi}"
SERVICE_FILE="/etc/systemd/system/pok-worker.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root on the VPS: sudo bash scripts/vps-install-ubuntu.sh" >&2
  exit 2
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id pok >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin pok
fi

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

chown -R pok:pok "$APP_DIR"

if [ ! -f "$ENV_DIR/worker.env" ]; then
  cp "$APP_DIR/deploy/vps/pok-worker.env.example" "$ENV_DIR/worker.env"
  chmod 600 "$ENV_DIR/worker.env"
  echo "Created $ENV_DIR/worker.env. Fill it with production secrets before starting the service."
fi

cd "$APP_DIR"
runuser -u pok -- npm ci
runuser -u pok -- npm run build:worker

cp "$APP_DIR/deploy/vps/pok-worker.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable pok-worker.service

echo "Install complete."
echo "Next steps:"
echo "1. Edit $ENV_DIR/worker.env and fill secrets. Keep ARB_LIVE_TRADING=false."
echo "2. Run: cd $APP_DIR && sudo -u pok bash scripts/vps-preflight.sh"
echo "3. Start: systemctl start pok-worker"
echo "4. Verify: DASHBOARD_API_TOKEN=<token> WORKER_API_BASE=http://127.0.0.1:8080 bash $APP_DIR/scripts/verify-live-readiness.sh"
