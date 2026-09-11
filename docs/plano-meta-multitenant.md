# Multi-tenant Meta no webhook-redirector

Plano e registro da integração de apps da Meta (WhatsApp Cloud API, Instagram,
Messenger) direto no redirector, em vez de um hub separado.

## Decisão

Módulo dentro do redirector, não projeto novo. Motivos:

- `webhook_configs` já é o lugar onde um destino mora. O fim do onboarding é
  sempre criar ou apontar um endpoint; num hub separado esse acoplamento
  continuaria existindo, só que atrás de uma chamada HTTP.
- Sessão, login, dashboard, Postgres (`pg-central`), fila com retry e tradutor
  UAZAPI já existem aqui. Um hub novo duplicaria tudo isso.
- Um container a menos num servidor que já vive perto do swap.
- O `oauth-hub-zdg` é AGPL v3: fazer fork dele e servir para clientes obriga a
  abrir o fonte. Ele serve como referência de fluxo, não como base de código.

## O que a mudança exige de verdade

Com Embedded Signup a Meta manda **todos os clientes de um app para uma única
URL de callback**. O dono do evento sai do payload, não da URL:

| Produto   | `object`                    | Identifica o tenant                                   |
|-----------|-----------------------------|-------------------------------------------------------|
| WhatsApp  | `whatsapp_business_account` | `entry[].id` (WABA) + `changes[].value.metadata.phone_number_id` |
| Instagram | `instagram`                 | `entry[].id` (IG user id)                             |
| Messenger | `page`                      | `entry[].id` (Page id)                                |

## Situação medida em 11/09/2026

- 7 dias: 18.411 eventos, **todos** no `/webhook` legado, **um só número**
  (Eletrofast, WABA `1605484530829321`, phone_number_id `841801725692939`).
  Nenhum payload com mais de uma `entry` ou mais de um `change`.
- Esse número vai para 3 destinos (Chatwoot Eletrofast, PHP da Xpertion, n8n da
  pesquisa de satisfação). O fan-out é intencional, então o modelo precisa de
  **1 canal → N endpoints**.
- As URLs de Chatwoot são por telefone (`/webhooks/whatsapp/+554184811513`), por
  isso no WhatsApp o canal tem granularidade de **número**, não de WABA.

## Fase 1 — ingress multi-tenant (branch `feat/meta-multitenant`)

Não depende de nada da Meta além de App ID e App Secret; dá para usar já com o
app que existe hoje.

### Modelo

- `meta_apps` — um App da Meta: `app_id`, `app_secret` (HMAC), `verify_token`
  (handshake). Callback: `/webhook/app/<app_id>`.
- `meta_channels` — um número de WhatsApp, conta de Instagram ou página:
  `product`, `external_id` (WABA / IG / Page id), `phone_number_id` opcional.
  Único por `(app, product, external_id, phone_number_id)`, com `COALESCE` para o
  NULL não furar a unicidade.
- `webhook_configs.meta_channel_id` — endpoint pendurado num canal. Vários
  endpoints no mesmo canal = fan-out. Remover o canal desvincula, não apaga o
  endpoint.

Tudo criado pelo `initDb` no boot, idempotente. O `app_webhook` é dono da base e
das tabelas na `pg-central` (conferido), então não precisa de ajuste de permissão.

### Ingress `/webhook/app/:appId`

- `GET`: handshake com o `verify_token` do app.
- `POST`: valida `X-Hub-Signature-256` sobre o **corpo cru** (o `express.json`
  agora guarda `rawBody`). Assinatura inválida → 401. A Meta reenvia com
  frequência decrescente, então um secret errado atrasa os eventos em vez de
  perdê-los de imediato — mas a janela de reenvio é finita: corrigir rápido.
- Responde 200 antes de despachar, igual ao `/webhook/:slug`.
- Grava o payload original **uma vez** em `received_webhooks` com
  `slug = meta-app-<app_id>`.
- Resolve e entrega cada parte pelo mesmo `routeToTarget` do fluxo por slug:
  fila persistente com retry, tradutor e worker do Chatwoot sem alteração.

### Regras de roteamento (`services/metaResolver.ts`)

- Cada endpoint recebe um payload no formato original da Meta contendo **só**
  as entries (e, no WhatsApp, só os changes) que são dele. Quando nada precisa
  ser separado, sai estruturalmente igual ao que chegou.
- WhatsApp: canal do número tem precedência; canal do WABA inteiro
  (`phone_number_id` nulo) é o fallback para números sem canal próprio.
- Eventos sem número (status de template, `account_update`) vão para todos os
  canais do WABA.
- Canal inativo, endpoint inativo ou conta desconhecida: nada é entregue e o
  app loga `sem canal ou endpoint ativo para ...`.

### API de cadastro (sessão do dashboard)

    GET|POST          /api/meta/apps
    PUT|DELETE        /api/meta/apps/:id
    GET|POST          /api/meta/channels[?meta_app_id=]
    PUT|DELETE        /api/meta/channels/:id
    POST|PUT          /api/webhook-configs[/:id]   (campo novo: meta_channel_id)

O App Secret nunca volta nas respostas; PUT com secret vazio mantém o atual.
IDs da Meta são strings de dígitos (passam de 2^53); colar o telefone no lugar do
`phone_number_id` é recusado com 400.

### Correção que veio junto

O toggle ativar/desativar do dashboard manda só `{ is_active }`, e o PUT enchia o
resto com os defaults do create: **cada toggle apagava o `inbound_token` e o
`source_config` do endpoint**. O PUT agora só aplica as chaves que vieram. Sem
isso, desativar um endpoint também o desvincularia do canal.

### O que não muda

`/webhook` legado, `/webhook/:slug`, `configured_webhooks`, os workers, o
tradutor UAZAPI e a API `/api/chatwoot/*`.

## Testes

    npm install && test/meta-e2e/run.sh

Postgres descartável + app + sink HTTP numa rede docker `--internal`; não toca
na `pg-central` nem no container de produção. 61 cenários, todos passando em
11/09/2026:

- cadastro: secret nunca volta, `verify_token` gerado, duplicatas → 409,
  telefone no lugar de ID → 400, FK inexistente → 400;
- handshake certo / errado / app desconhecido;
- assinatura ausente, secret errado e corpo com unicode escapado (só passa se o
  HMAC usar os bytes crus);
- divisão de um POST com 3 números do mesmo WABA, fallback para o canal do WABA
  inteiro, status de template para todos os canais, Instagram, várias entries
  num POST, endpoint inativo e canal inativo recebendo zero;
- auditoria: uma linha por POST aceito, nenhuma por recusado;
- regressão do toggle (token, `source_config` e canal preservados);
- `/webhook` legado e `/webhook/:slug` intactos.

A comparação de payload ignora a ordem das chaves de propósito:
`webhook_jobs.payload` é `JSONB`, e o Postgres reordena as chaves ao gravar.
Então o repasse (o legado inclusive) nunca preservou a ordem original.

## Deploy da fase 1

    cd /home/synapsea/webhook-redirector
    git merge feat/meta-multitenant
    docker compose up -d --build api     # só o serviço api; não suba o "db" órfão

As tabelas nascem no boot. Rollback: voltar o commit e rebuildar; as tabelas e a
coluna nova são inertes para o código antigo.

## Migrar o Eletrofast para a rota nova (opcional, quando quiser)

1. Cadastrar o app (App ID + App Secret do app que hoje aponta para `/webhook`).
2. Cadastrar o canal: WABA `1605484530829321`, phone_number_id `841801725692939`.
3. Pendurar os destinos: os endpoints `legacy-4` (Chatwoot) e `legacy-5` (PHP)
   já existem em `webhook_configs`; o n8n da pesquisa (`configured_webhooks` 12)
   **não** existe lá e precisa ser criado.
4. Trocar a URL de callback no painel da Meta para
   `https://webhook-redirector.synapsea.com.br/webhook/app/<APP_ID>` com o
   `verify_token` do cadastro.
5. Não há entrega dupla na virada: a Meta manda para uma URL só. Deixar o
   `/webhook` legado ligado para o que estiver em retry.

## Fases seguintes

**Fase 2 — OAuth WhatsApp (Embedded Signup).** SDK do Facebook + `config_id` no
dashboard; troca do code no servidor; `POST /{waba}/subscribed_apps`; cria o
canal e, opcionalmente, o endpoint. Colunas novas: token e expiração no canal,
`graph_api_version` no app. O `state` do OAuth vai ser assinado com
`SESSION_SECRET`, que **hoje não está no `.env`** (o código cai no default
público `change_this_secret_in_env`): definir antes.

**Fase 3 — Instagram e Messenger.** Mesmo esqueleto, escopos diferentes. Token de
Instagram dura 60 dias: job de renovação na fila que já existe.

**Fase 4 — UI.** Aba "Apps Meta" no dashboard, botão de conectar, URLs prontas
para colar no painel da Meta, vínculo de endpoint no formulário existente.

## Pré-requisitos externos

- **Tech Provider na Meta** (verificação de negócio + App Review + Access
  Verification). É o que libera onboardar clientes terceiros pela fase 2 e
  demora; começar em paralelo.
- HTTPS público: já existe (`webhook-redirector.synapsea.com.br`, o nginx
  repassa qualquer path).

## Achados paralelos

- Slug `xpertion` sem tráfego desde 03/08/2026; `xpertion-comercial` nunca
  recebeu nada.
- O destino PHP da Xpertion devolveu 500 em 38 de ~18,4 mil jobs na semana
  (35 falhas definitivas).
- O `package-lock.json` está dessincronizado do `package.json` (`npm ci` recusa)
  e o build só passa com as versões travadas nele: um `npm install` sem lockfile
  puxa um `@types/express` que quebra 6 rotas existentes.
- Secrets (App Secret e tokens do Chatwoot) ficam em texto puro na base e,
  portanto, nos dumps do `backup-all.sh`.
