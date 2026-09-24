#!/usr/bin/env bash
# Cadastra no redirector um app da Meta que JA esta configurado num Connect,
# lendo App ID e App Secret da propria instalacao do Chatwoot (installation_configs).
#
# A credencial nao passa por lugar nenhum além deste processo: le do banco e
# manda para a API do redirector, no mesmo host.
#
#   scripts/registrar-app-meta.sh instagram connect_test "App IG Synapsea"
#   scripts/registrar-app-meta.sh whatsapp  connect_test "App WhatsApp Synapsea" <CONFIGURATION_ID>
#
# Produto: instagram | facebook | whatsapp
# Base:    nome da base do Connect na pg-central (eletrofast, xpertion, connect_test)
set -euo pipefail

PRODUTO=${1:?produto: instagram | facebook | whatsapp}
BASE_DB=${2:?base do Connect: eletrofast | xpertion | connect_test}
NOME=${3:-"App Meta ($PRODUTO)"}
CONFIG_ID=${4:-}

REDIRECTOR=${REDIRECTOR:-http://localhost:3005}
ENV_FILE=${ENV_FILE:-/home/synapsea/webhook-redirector/.env}
PG=${PG:-pg-central}

case "$PRODUTO" in
  instagram) K_ID=INSTAGRAM_APP_ID; K_SECRET=INSTAGRAM_APP_SECRET ;;
  facebook)  K_ID=FB_APP_ID;        K_SECRET=FB_APP_SECRET ;;
  whatsapp)  K_ID=WHATSAPP_APP_ID;  K_SECRET=WHATSAPP_APP_SECRET ;;
  *) echo "produto invalido: $PRODUTO"; exit 1 ;;
esac

# O valor fica serializado em YAML dentro de serialized_value; o sed tira as aspas.
ler_config() {
  docker exec -i "$PG" psql -U postgres -d "$BASE_DB" -At -c \
    "select serialized_value from installation_configs where name = '$1'" \
    | sed -e "s/^--- //" -e "s/^'//" -e "s/'$//" -e "s/^\"//" -e "s/\"$//" | tr -d '\n'
}

APP_ID=$(ler_config "$K_ID")
APP_SECRET=$(ler_config "$K_SECRET")

if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
  echo "ERRO: $K_ID ou $K_SECRET estao vazios na base $BASE_DB."
  echo "Configure primeiro no Super Admin do Connect, ou passe outro banco."
  exit 1
fi
echo "App ID lido de $BASE_DB: $APP_ID (secret com ${#APP_SECRET} caracteres)"

ADMIN_USER=$(grep -E '^ADMIN_USERNAME=' "$ENV_FILE" | cut -d= -f2-)
ADMIN_PASS=$(grep -E '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT

curl -fsS -c "$COOKIE" -X POST "$REDIRECTOR/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$ADMIN_PASS")" >/dev/null
echo "Login no redirector: ok"

BODY=$(APP_ID="$APP_ID" APP_SECRET="$APP_SECRET" NOME="$NOME" CONFIG_ID="$CONFIG_ID" python3 -c '
import json, os
body = {"name": os.environ["NOME"], "app_id": os.environ["APP_ID"], "app_secret": os.environ["APP_SECRET"]}
if os.environ.get("CONFIG_ID"):
    body["config_id"] = os.environ["CONFIG_ID"]
print(json.dumps(body))')

RESP=$(curl -fsS -b "$COOKIE" -X POST "$REDIRECTOR/api/meta/apps" \
  -H 'Content-Type: application/json' -d "$BODY")

python3 - "$RESP" <<'PY'
import json, sys
app = json.loads(sys.argv[1])
print()
print("App cadastrado no redirector:")
print(f"  id interno .......... {app['id']}")
print(f"  app_id .............. {app['app_id']}")
print(f"  versao da Graph ..... {app['graph_api_version']}")
print()
print("Cole isto no painel da Meta (Webhooks do app):")
print(f"  Callback URL ........ https://webhook-redirector.synapsea.com.br{app['webhook_path']}")
print(f"  Verify token ........ {app['verify_token']}")
print()
print("Para Instagram e Messenger, esta URL vale para o app inteiro.")
print("Para WhatsApp, o override por WABA e feito pelo onboarding, nao aqui.")
PY
