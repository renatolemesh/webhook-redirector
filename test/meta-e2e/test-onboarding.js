/**
 * Fase 2: onboarding de canais da Meta, contra o duplo da Graph e do Connect.
 * Roda depois de test.js, na mesma base, usando ids proprios para nao colidir.
 */
const crypto = require('crypto');
const BASE = 'http://wr-meta-app:3005';
const SINK = 'http://wr-meta-sink:4000';
const APP_ID = '9999999999999999';
const SECRET = 'segredo-do-app-de-teste';
const WABA = '7730700792263050';
const PNID = '8418017256929390';
const IG_USER = '17841400000000001';

let failures = 0, passes = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); cond ? passes++ : failures++; };
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const dump = async () => (await fetch(SINK + '/dump')).json();
const control = (path, body) => fetch(SINK + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  console.log('--- cadastro do app com Embedded Signup');
  let r = await api('POST', '/api/meta/apps', { name: 'App onboarding', app_id: APP_ID, app_secret: SECRET, config_id: '1234567890', graph_api_version: 'v22.0' });
  ok(r.status === 201, `cria app (${r.status} ${r.status !== 201 ? r.text : ''})`);
  const app = r.json;
  ok(app && app.config_id === '1234567890', 'guarda o config_id do Embedded Signup');
  r = await api('POST', '/api/meta/apps', { name: 'versao invalida', app_id: '1111111111', app_secret: 'x', graph_api_version: '22' });
  ok(r.status === 400, `versao da Graph malformada -> 400 (${r.status})`);

  r = await api('GET', `/api/meta/apps/${app.id}/signup-config`);
  ok(r.status === 200 && r.json.callback_url === `https://wr-teste.local/webhook/app/${APP_ID}`, `signup-config traz o callback certo (${r.json && r.json.callback_url})`);
  ok(r.status === 200 && !r.text.includes(SECRET), 'signup-config nao vaza o app secret');

  console.log('--- guarda: code de outro app');
  await control('/control/debug-app', { app_id: '5555555555555555' });
  r = await api('POST', `/api/meta/apps/${app.id}/whatsapp/connect`, { code: 'CODE-DE-OUTRO', waba_id: WABA, phone_number_id: PNID });
  ok(r.status === 400 && /nao pertence a este app/.test(r.text), `code de outro app -> 400 (${r.status})`);
  await control('/control/debug-app', { app_id: null });

  console.log('--- conectar WhatsApp de ponta a ponta');
  r = await api('POST', `/api/meta/apps/${app.id}/whatsapp/connect`, {
    code: 'CODE-VALIDO', waba_id: WABA, phone_number_id: PNID, name: 'Loja Teste',
    chatwoot: { base_url: SINK, api_token: 'token-do-connect', account_id: 1 },
  });
  ok(r.status === 201, `connect -> 201 (${r.status} ${r.status !== 201 ? r.text : ''})`);
  const steps = (r.json && r.json.steps) || [];
  const stepOk = (name) => steps.some((s) => s.step.includes(name) && s.ok);
  ok(stepOk('troca do code'), 'passo: troca do code');
  ok(stepOk('confere o app'), 'passo: confere o app do token');
  ok(stepOk('consulta o numero'), 'passo: consulta o numero');
  ok(stepOk('inscreve o app no WABA'), 'passo: inscreve o app no WABA');
  ok(stepOk('aponta o callback'), 'passo: aponta o callback para o redirector');
  ok(stepOk('cria a inbox no Connect'), 'passo: cria a inbox no Connect');
  ok(stepOk('cria a rota'), 'passo: cria a rota de fan-out');
  ok(r.json && r.json.channel && r.json.channel.access_token === undefined, 'resposta nao devolve o token do cliente');
  const channelId = r.json && r.json.channel && r.json.channel.id;

  const d1 = await dump();
  const override = d1.graph.filter((g) => g.op === 'override').pop();
  ok(override && override.body.override_callback_uri === `https://wr-teste.local/webhook/app/${APP_ID}`,
    `override aponta para o redirector (${override && override.body.override_callback_uri})`);
  ok(override && Array.isArray(override.body.subscribed_fields) && override.body.subscribed_fields.includes('messages'),
    'override assina o campo messages');
  const subscribeBefore = d1.graph.findIndex((g) => g.op === 'subscribe') < d1.graph.findIndex((g) => g.op === 'override');
  ok(subscribeBefore, 'inscreve o app antes de tentar o override (exigencia da Meta)');

  const inbox = d1.inboxes[d1.inboxes.length - 1];
  ok(inbox && inbox.body.channel.provider === 'whatsapp_cloud', 'inbox criada como whatsapp_cloud');
  ok(inbox && inbox.body.channel.provider_config.source === 'embedded_signup',
    'inbox marcada com source=embedded_signup, senao o Connect rouba o callback');
  ok(inbox && inbox.body.channel.provider_config.business_account_id === WABA, 'inbox recebe o WABA');
  ok(inbox && inbox.token === 'token-do-connect', 'inbox criada com o token do Connect no header');

  console.log('--- o canal novo ja recebe webhook da Meta');
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '554199990000', phone_number_id: PNID }, messages: [{ from: '5541999999999', id: 'wamid.onb1', type: 'text', text: { body: 'oi' } }] } }] }],
  };
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const post = await fetch(`${BASE}/webhook/app/${APP_ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  ok(post.status === 200, `POST assinado no app novo -> 200 (${post.status})`);

  let delivered = null;
  for (let i = 0; i < 30; i++) {
    const d = await dump();
    delivered = d.deliveries.filter((x) => x.path === '/webhooks/whatsapp/+554199990000');
    if (delivered.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(delivered && delivered.length === 1, `mensagem entregue na rota criada pelo onboarding (${delivered ? delivered.length : 0})`);
  ok(delivered && delivered.length === 1 && delivered[0].body.entry[0].changes[0].value.messages[0].id === 'wamid.onb1', 'payload chegou inteiro');

  console.log('--- vigia do callback');
  r = await api('POST', `/api/meta/channels/${channelId}/check-callback`);
  ok(r.status === 200 && r.json.status === 'ok', `callback conferido como ok (${r.json && r.json.status})`);
  await control('/control/override', { override: 'https://connect.exemplo.com/webhooks/whatsapp/+554199990000' });
  r = await api('POST', `/api/meta/channels/${channelId}/check-callback`);
  ok(r.status === 200 && r.json.status === 'reaplicado', `roubo do callback detectado e reaplicado (${r.json && r.json.status})`);
  const d2 = await dump();
  ok(d2.state.override === `https://wr-teste.local/webhook/app/${APP_ID}`, 'override voltou para o redirector');
  r = await api('GET', '/api/meta/callback-status');
  const row = (r.json || []).find((x) => x.id === channelId);
  ok(row && row.callback_status === 'reaplicado' && row.callback_checked_at, 'status do callback fica gravado no canal');
  const byToken = await fetch(BASE + '/api/meta/callback-status', { headers: { 'X-API-Token': 'test-verify-token' } });
  ok(byToken.status === 200, `status do callback tambem responde por token, para o vigia-infra (${byToken.status})`);

  console.log('--- Instagram');
  r = await api('GET', `/api/meta/apps/${app.id}/instagram/start`);
  ok(r.status === 200 && r.json.authorize_url.includes(`client_id=${APP_ID}`) && r.json.authorize_url.includes('instagram_business_manage_messages'),
    'monta a URL de autorizacao do Instagram');
  const cb = await fetch(`${BASE}/api/meta/apps/${app.id}/instagram/callback?code=CODE-IG`, { headers: { Cookie: cookie }, redirect: 'manual' });
  ok(cb.status === 302, `callback do Instagram redireciona para o painel (${cb.status})`);
  r = await api('GET', `/api/meta/channels?meta_app_id=${app.id}`);
  const igChannel = (r.json || []).find((c) => c.product === 'instagram');
  ok(igChannel && igChannel.external_id === IG_USER, `canal de Instagram criado com o id da conta (${igChannel && igChannel.external_id})`);
  ok(igChannel && igChannel.token_expires_at, 'guarda o vencimento do token de 60 dias');

  r = await api('POST', `/api/meta/channels/${igChannel.id}/route-instagram`, { base_url: SINK });
  ok(r.status === 201 && r.json.target_config.url === `${SINK}/webhooks/instagram`, 'cria a rota do Instagram para o Connect');

  const igPayload = { object: 'instagram', entry: [{ id: IG_USER, time: 1, messaging: [{ sender: { id: '1' }, recipient: { id: IG_USER }, message: { mid: 'ig-onb', text: 'oi ig' } }] }] };
  const igRaw = JSON.stringify(igPayload);
  const igSig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(igRaw).digest('hex');
  const igPost = await fetch(`${BASE}/webhook/app/${APP_ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': igSig }, body: igRaw });
  ok(igPost.status === 200, `POST de Instagram assinado -> 200 (${igPost.status})`);
  let igDelivered = null;
  for (let i = 0; i < 30; i++) {
    const d = await dump();
    igDelivered = d.deliveries.filter((x) => x.path === '/webhooks/instagram');
    if (igDelivered.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(igDelivered && igDelivered.length === 1, `evento de Instagram roteado para o Connect certo (${igDelivered ? igDelivered.length : 0})`);

  console.log('--- endpoints existentes como destino do canal');
  const mkEndpoint = async (body) => (await api('POST', '/api/webhook-configs', body)).json;
  const shared = await mkEndpoint({ name: 'n8n compartilhado', slug: 'n8n-compartilhado', source_type: 'meta_cloud_api', target_type: 'raw_forward', target_config: { url: `${SINK}/n8n-compartilhado` } });
  const uaz = await mkEndpoint({ name: 'uazapi qualquer', slug: 'uazapi-qualquer', source_type: 'uazapi', target_type: 'raw_forward', target_config: { url: `${SINK}/uazapi` } });
  const cwEndpoint = await mkEndpoint({ name: 'Connect cadastrado', slug: 'connect-cadastrado', source_type: 'uazapi', target_type: 'chatwoot_api', target_config: { base_url: SINK, api_token: 'token-do-endpoint', account_id: 7, inbox_id: 1 } });
  ok(shared && shared.id && uaz && uaz.id && cwEndpoint && cwEndpoint.id, 'cria os endpoints de apoio');

  r = await api('POST', `/api/meta/channels/${channelId}/routes`, { endpoint_ids: [uaz.id] });
  ok(r.status === 400 && /formato da Meta/.test(r.text), `endpoint uazapi recusado como destino da Meta (${r.status})`);
  r = await api('POST', `/api/meta/channels/${channelId}/routes`, { endpoint_ids: [999999] });
  ok(r.status === 400, `endpoint inexistente -> 400 (${r.status})`);
  r = await api('POST', `/api/meta/channels/${channelId}/routes`, { endpoint_ids: [shared.id] });
  ok(r.status === 201, `liga endpoint existente ao canal (${r.status} ${r.status !== 201 ? r.text : ''})`);
  r = await api('POST', `/api/meta/channels/${channelId}/routes`, { endpoint_ids: [shared.id] });
  ok(r.status === 201, 'ligar de novo nao da erro');
  r = await api('GET', `/api/meta/channels?meta_app_id=${app.id}`);
  const waRow = (r.json || []).find((c) => c.id === channelId);
  const sharedHits = (waRow ? waRow.routes : []).filter((x) => x.id === shared.id);
  ok(sharedHits.length === 1 && sharedHits[0].linked === true, `endpoint aparece uma vez nas rotas do canal (${sharedHits.length})`);

  const sendWa = async (wamid) => {
    const p2 = JSON.parse(JSON.stringify(payload));
    p2.entry[0].changes[0].value.messages[0].id = wamid;
    const raw2 = JSON.stringify(p2);
    const sig2 = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw2).digest('hex');
    return fetch(`${BASE}/webhook/app/${APP_ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig2 }, body: raw2 });
  };
  const waitFor = async (pred) => {
    for (let i = 0; i < 30; i++) {
      const d = await dump();
      if (pred(d.deliveries)) return d.deliveries;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return (await dump()).deliveries;
  };
  const idOf = (x) => x.body && x.body.entry && x.body.entry[0].changes[0].value.messages[0].id;

  await sendWa('wamid.shared1');
  let dl = await waitFor((ds) => ds.some((x) => x.path === '/n8n-compartilhado' && idOf(x) === 'wamid.shared1')
    && ds.some((x) => x.path === '/webhooks/whatsapp/+554199990000' && idOf(x) === 'wamid.shared1'));
  ok(dl.filter((x) => x.path === '/n8n-compartilhado' && idOf(x) === 'wamid.shared1').length === 1, 'evento chega no endpoint ligado');
  ok(dl.filter((x) => x.path === '/webhooks/whatsapp/+554199990000' && idOf(x) === 'wamid.shared1').length === 1, 'e continua chegando na rota do onboarding');

  console.log('--- connect com credenciais de um endpoint Connect e endpoints na mesma chamada');
  const graphBefore = (await dump()).graph.filter((g) => g.op === 'exchange_code').length;
  r = await api('POST', `/api/meta/apps/${app.id}/whatsapp/connect`, { code: 'CODE-X', waba_id: WABA, phone_number_id: '8418017256929391', endpoint_ids: [uaz.id] });
  ok(r.status === 400, `endpoint invalido recusado antes da troca (${r.status})`);
  ok((await dump()).graph.filter((g) => g.op === 'exchange_code').length === graphBefore, 'o code nao foi gasto');
  r = await api('POST', `/api/meta/apps/${app.id}/whatsapp/connect`, { code: 'CODE-X', waba_id: WABA, phone_number_id: '8418017256929391', chatwoot_endpoint_id: shared.id });
  ok(r.status === 400 && /chatwoot_api/.test(r.text), `chatwoot_endpoint_id que nao e Connect -> 400 (${r.status})`);
  r = await api('POST', `/api/meta/apps/${app.id}/whatsapp/connect`, {
    code: 'CODE-VALIDO-2', waba_id: WABA, phone_number_id: '8418017256929391', name: 'Loja Dois',
    chatwoot_endpoint_id: cwEndpoint.id, endpoint_ids: [shared.id],
  });
  ok(r.status === 201, `connect com endpoint Connect -> 201 (${r.status} ${r.status !== 201 ? r.text : ''})`);
  const steps2 = (r.json && r.json.steps) || [];
  ok(steps2.some((x) => x.step.includes('liga os endpoints') && x.ok), 'passo: liga os endpoints escolhidos');
  const inbox2 = (await dump()).inboxes.pop();
  ok(inbox2 && inbox2.token === 'token-do-endpoint' && /accounts\/7\//.test(inbox2.path || ''),
    `inbox criada com token e conta do endpoint (${inbox2 && inbox2.path})`);

  console.log('--- desligar endpoint do canal');
  r = await api('DELETE', `/api/meta/channels/${channelId}/routes/${shared.id}`);
  ok(r.status === 204, `desliga o endpoint (${r.status})`);
  r = await api('DELETE', `/api/meta/channels/${channelId}/routes/${shared.id}`);
  ok(r.status === 404, `desligar de novo -> 404 (${r.status})`);
  await sendWa('wamid.shared2');
  dl = await waitFor((ds) => ds.some((x) => x.path === '/webhooks/whatsapp/+554199990000' && idOf(x) === 'wamid.shared2'));
  await new Promise((res) => setTimeout(res, 1500));
  dl = (await dump()).deliveries;
  ok(dl.some((x) => x.path === '/webhooks/whatsapp/+554199990000' && idOf(x) === 'wamid.shared2'), 'rota do onboarding segue recebendo');
  ok(!dl.some((x) => x.path === '/n8n-compartilhado' && idOf(x) === 'wamid.shared2' && x.body.entry[0].changes[0].value.metadata.phone_number_id === PNID)
    , 'endpoint desligado nao recebe mais deste canal');
  r = await api('GET', '/api/webhook-configs');
  ok((r.json || []).some((c) => c.id === shared.id), 'o endpoint continua existindo');

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE:', e); process.exit(2); });
