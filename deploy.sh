#!/usr/bin/env bash
# Sync source to the deploy host, rebuild + restart the stack there, health check.
#   ./deploy.sh            # deploy the working tree
#   ./deploy.sh --pull     # also pull a newer cloudflared image
#
# Settings come from .deploy.env (gitignored, see deploy.env.example).
# The server keeps its own .env (secrets) next to docker-compose.yml; it is never synced.
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .deploy.env ]] || { echo "missing .deploy.env (copy deploy.env.example)" >&2; exit 1; }
# shellcheck disable=SC1091
source .deploy.env
: "${DEPLOY_HOST:?set in .deploy.env}" "${DEPLOY_DIR:?set in .deploy.env}" "${DEPLOY_URL:?set in .deploy.env}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "warning: uncommitted changes will be deployed:"
  git status --short
fi

echo "==> typecheck + tests"
npm run --silent typecheck
npm test --silent

echo "==> sync to $DEPLOY_HOST:$DEPLOY_DIR"
rsync -az --delete \
  --include .env.example --exclude .env --exclude '.env.*' --exclude .deploy.env \
  --exclude node_modules --exclude dist --exclude .git --exclude art \
  ./ "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "==> build + restart on $DEPLOY_HOST"
pull=""
[[ "${1:-}" == "--pull" ]] && pull="docker compose pull cloudflared &&"
ssh "$DEPLOY_HOST" "cd $DEPLOY_DIR && $pull docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null && docker builder prune -f --filter until=72h >/dev/null"

echo "==> health check"
for _ in $(seq 1 20); do
  if curl -fsS -m 5 "$DEPLOY_URL/health" >/dev/null 2>&1; then
    echo "ok: deployed $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 3
done
echo "health check failed; recent logs:" >&2
ssh "$DEPLOY_HOST" "cd $DEPLOY_DIR && docker compose logs --tail 30" >&2
exit 1
