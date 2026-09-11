#!/usr/bin/env bash
# Teste ponta a ponta do ingress multi-tenant da Meta (/webhook/app/:appId).
#
# Sobe Postgres descartavel + app + um sink HTTP numa rede docker --internal
# (nada publicado no host, nada sai para a internet), roda test.js e derruba
# tudo. Nao toca na pg-central nem no container de producao.
#
#   npm install && test/meta-e2e/run.sh
#
# O repositorio tem de estar sob /home: o docker do servidor e snap e monta
# caminhos de /tmp vazios, sem erro. Pelo mesmo motivo os scripts entram nos
# containers por stdin, e nao por bind mount.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)
HERE=test/meta-e2e
NET=wr-meta-test

# O app grava logs/ no diretorio de trabalho; so apaga se fomos nos que criamos.
LOGS_EXISTED=0
[ -e logs ] && LOGS_EXISTED=1

remove_containers() {
  docker rm -f wr-meta-app wr-meta-sink wr-meta-test-db >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup() {
  remove_containers
  if [ "$LOGS_EXISTED" = 0 ]; then rm -rf "$REPO/logs"; fi
}
trap cleanup EXIT

remove_containers
npx tsc

docker network create --internal "$NET" >/dev/null
docker run -d --rm --name wr-meta-test-db --network "$NET" --memory 256m \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=test -e POSTGRES_DB=webhook \
  postgres:15-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec wr-meta-test-db pg_isready -U app -d webhook >/dev/null 2>&1 && break
  sleep 1
done

docker run -d --name wr-meta-sink --network "$NET" --memory 128m node:20-alpine sleep infinity >/dev/null
docker exec -i wr-meta-sink sh -c 'cat > /sink.js' < "$HERE/sink.js"
docker exec -d wr-meta-sink node /sink.js

docker run -d --name wr-meta-app --network "$NET" --memory 256m -v "$REPO":/app -w /app \
  -e PORT=3005 -e DB_HOST=wr-meta-test-db -e DB_PORT=5432 -e DB_USER=app -e DB_PASSWORD=test \
  -e DB_NAME=webhook -e VERIFY_TOKEN=test-verify-token -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=admin -e SESSION_SECRET=test-session \
  node:20-alpine node dist/server.js >/dev/null

if ! docker run --rm -i --network "$NET" --memory 128m node:20-alpine \
     sh -c 'cat > /test.js && node /test.js' < "$HERE/test.js"; then
  echo '--- log do app'
  docker logs wr-meta-app 2>&1 | tail -40
  exit 1
fi
