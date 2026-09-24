const crypto = require('crypto');
const BASE = 'http://wr-meta-app:3005';
const SINK = 'http://wr-meta-sink:4000';
const APP_ID = '1234567890123456';
const SECRET = 'test-app-secret';
let failures = 0, passes = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); cond ? passes++ : failures++; };
// webhook_jobs.payload e JSONB: o Postgres reordena as chaves ao gravar, entao
// o repasse (legado inclusive) nunca preservou a ordem. Compara conteudo.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// O /dump do duplo devolve { deliveries, graph, inboxes, state }; aqui so
// interessam os repasses que chegaram ao sink.
const fetchDeliveries = async () => ((await (await fetch(SINK + '/dump')).json()).deliveries) || [];
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function sendRaw(raw, { sign = true, secret = SECRET, appId = APP_ID } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return (await fetch(`${BASE}/webhook/app/${appId}`, { method: 'POST', headers, body: raw })).status;
}
const sendMeta = (p, o) => sendRaw(JSON.stringify(p), o);

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/login.html'); break; } catch { await sleep(1000); } }

  console.log('--- admin / cadastro');
  let r = await api('GET', '/api/meta/apps');
  ok(r.status !== 200, `admin API sem login bloqueada (status ${r.status})`);
  const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok(login.status === 200 && cookie.startsWith('connect.sid='), 'login');

  r = await api('POST', '/api/meta/apps', { name: 'App teste', app_id: APP_ID, app_secret: SECRET });
  ok(r.status === 201, `cria app (${r.status} ${r.status !== 201 ? r.text : ''})`);
  const app = r.json;
  ok(app && app.app_secret === undefined && app.has_app_secret === true, 'app_secret nao volta na resposta');
  ok(app && typeof app.verify_token === 'string' && app.verify_token.length >= 16, 'verify_token gerado quando omitido');
  ok(app && app.webhook_path === `/webhook/app/${APP_ID}`, 'resposta traz o webhook_path para colar na Meta');
  r = await api('POST', '/api/meta/apps', { name: 'dup', app_id: APP_ID, app_secret: 'x' });
  ok(r.status === 409, `app_id duplicado -> 409 (${r.status})`);
  r = await api('POST', '/api/meta/apps', { name: 'num', app_id: 123, app_secret: 'x' });
  ok(r.status === 400, `app_id como numero (nao string) -> 400 (${r.status})`);
  r = await api('GET', '/api/meta/apps');
  ok(r.status === 200 && !r.text.includes(SECRET), 'listagem nao vaza o secret');
  r = await api('PUT', `/api/meta/apps/${app.id}`, { name: 'App teste renomeado', app_secret: '' });
  ok(r.status === 200 && r.json.name === 'App teste renomeado', 'PUT parcial do app com secret vazio');

  console.log('--- handshake');
  let h = await fetch(`${BASE}/webhook/app/${APP_ID}?hub.mode=subscribe&hub.verify_token=${app.verify_token}&hub.challenge=abc123`);
  ok(h.status === 200 && (await h.text()) === 'abc123', 'token certo devolve o challenge');
  h = await fetch(`${BASE}/webhook/app/${APP_ID}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=abc123`);
  ok(h.status === 403, `token errado -> 403 (${h.status})`);
  h = await fetch(`${BASE}/webhook/app/999?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
  ok(h.status === 404, `app desconhecido -> 404 (${h.status})`);

  console.log('--- canais');
  const WABA = '1605484530829321', PN1 = '841801725692939', PN2 = '222222222222222', PN3 = '333333333333333';
  const IG = '17841400000000001', WABA2 = '5555555555', PN_OFF = '5551';
  const mkCh = async (b) => {
    const x = await api('POST', '/api/meta/channels', { meta_app_id: app.id, ...b });
    ok(x.status === 201, `cria canal "${b.name}" (${x.status} ${x.status !== 201 ? x.text : ''})`);
    return x.json;
  };
  const ch1 = await mkCh({ name: 'numero 1', product: 'whatsapp', external_id: WABA, phone_number_id: PN1 });
  const ch2 = await mkCh({ name: 'numero 2', product: 'whatsapp', external_id: WABA, phone_number_id: PN2 });
  const ch3 = await mkCh({ name: 'WABA inteiro (fallback)', product: 'whatsapp', external_id: WABA });
  const ch4 = await mkCh({ name: 'Instagram', product: 'instagram', external_id: IG });
  const ch5 = await mkCh({ name: 'canal inativo', product: 'whatsapp', external_id: WABA2, phone_number_id: PN_OFF, is_active: false });
  r = await api('POST', '/api/meta/channels', { meta_app_id: app.id, name: 'dup', product: 'whatsapp', external_id: WABA });
  ok(r.status === 409, `WABA inteiro duplicado (phone nulo) -> 409 (${r.status})`);
  r = await api('POST', '/api/meta/channels', { meta_app_id: app.id, name: 'tel', product: 'whatsapp', external_id: WABA, phone_number_id: '+5541984811513' });
  ok(r.status === 400, `telefone no lugar do phone_number_id -> 400 (${r.status})`);
  r = await api('POST', '/api/meta/channels', { meta_app_id: app.id, name: 'ig', product: 'instagram', external_id: IG, phone_number_id: PN1 });
  ok(r.status === 400, `phone_number_id em instagram -> 400 (${r.status})`);
  r = await api('POST', '/api/meta/channels', { meta_app_id: 99999, name: 'x', product: 'whatsapp', external_id: '1' });
  ok(r.status === 400, `meta_app_id inexistente -> 400 (${r.status})`);

  console.log('--- endpoints');
  const mkCfg = async (slug, channelId, extra = {}) => {
    const x = await api('POST', '/api/webhook-configs', { name: slug, slug, source_type: 'meta_cloud_api', target_type: 'raw_forward', target_config: { url: `${SINK}/${slug}` }, meta_channel_id: channelId, ...extra });
    ok(x.status === 201, `cria endpoint ${slug} (${x.status} ${x.status !== 201 ? x.text : ''})`);
    return x.json;
  };
  await mkCfg('a', ch1.id); await mkCfg('b', ch1.id); const cCfg = await mkCfg('c', ch2.id);
  await mkCfg('d', ch3.id); await mkCfg('e', ch4.id);
  await mkCfg('f-inativo', ch1.id, { is_active: false });
  await mkCfg('g-canal-inativo', ch5.id);
  const hCfg = await mkCfg('h-toggle', ch4.id, { inbound_token: 'tok-123', source_config: { x: 1 }, is_active: false });
  r = await api('POST', '/api/webhook-configs', { name: 'z', slug: 'z', source_type: 'meta_cloud_api', target_type: 'raw_forward', target_config: { url: SINK + '/z' }, meta_channel_id: 99999 });
  ok(r.status === 400, `meta_channel_id inexistente -> 400 (${r.status})`);

  await api('PUT', `/api/webhook-configs/${hCfg.id}`, { is_active: true });
  await api('PUT', `/api/webhook-configs/${hCfg.id}`, { is_active: false });
  r = await api('GET', '/api/webhook-configs');
  const h2 = r.json.find((c) => c.id === hCfg.id);
  ok(h2.inbound_token === 'tok-123', `toggle preserva inbound_token (${h2.inbound_token})`);
  ok(h2.source_config && h2.source_config.x === 1, `toggle preserva source_config (${JSON.stringify(h2.source_config)})`);
  ok(h2.meta_channel_id === ch4.id && h2.is_active === false, `toggle preserva meta_channel_id (${h2.meta_channel_id})`);

  r = await api('GET', `/api/meta/channels?meta_app_id=${app.id}`);
  const ch1row = r.json.find((c) => c.id === ch1.id);
  const slugs = ch1row ? ch1row.routes.map((x) => x.slug).sort().join(',') : '';
  ok(slugs === 'a,b,f-inativo', `listagem de canais mostra os endpoints de cada um (${slugs})`);

  console.log('--- ingress');
  const waMsg = (pnid, id, text) => ({ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '554184811513', phone_number_id: pnid }, contacts: [{ profile: { name: 'Cliente' }, wa_id: '5541999999999' }], messages: [{ from: '5541999999999', id, timestamp: '1757600000', type: 'text', text: { body: text || 'oi ' + id } }] } });
  const tplStatus = { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 42, message_template_name: 'boas_vindas', message_template_language: 'pt_BR', reason: 'NONE' } };
  const wa = (entries) => ({ object: 'whatsapp_business_account', entry: entries });
  const P1 = wa([{ id: WABA, changes: [waMsg(PN1, 'm1')] }]);
  const P2 = wa([{ id: WABA, changes: [waMsg(PN1, 'm2a'), waMsg(PN2, 'm2b'), waMsg(PN3, 'm2c')] }]);
  const P3 = wa([{ id: WABA, time: 1757600000, changes: [tplStatus] }]);
  const P4 = wa([{ id: '999999999', changes: [waMsg('111', 'm4')] }]);
  const P5 = { object: 'instagram', entry: [{ id: IG, time: 1757600000, messaging: [{ sender: { id: '1' }, recipient: { id: IG }, timestamp: 1757600000, message: { mid: 'ig1', text: 'oi ig' } }] }] };
  const P6 = wa([{ id: WABA, changes: [waMsg(PN2, 'm6')] }, { id: '888888888', changes: [waMsg('222', 'm6x')] }]);
  const P7 = wa([{ id: WABA2, changes: [waMsg(PN_OFF, 'm7')] }]);
  // Espacos e é escapado: o JSON re-serializado nao bate byte a byte com
  // este, entao so passa se o HMAC for calculado sobre o corpo cru.
  const raw8 = `{"object": "whatsapp_business_account",   "entry": [{"id": "${WABA}", "changes": [{"field": "messages", "value": {"metadata": {"phone_number_id": "${PN1}"}, "messages": [{"id": "m8", "type": "text", "text": {"body": "caf\\u00e9 \\u2014 ok"}}]}}]}]}`;
  const P8 = JSON.parse(raw8);

  ok((await sendMeta(P1, { sign: false })) === 401, 'POST sem assinatura -> 401');
  ok((await sendMeta(P1, { secret: 'outro' })) === 401, 'POST com secret errado -> 401');
  ok((await sendMeta(P1, { appId: '999' })) === 404, 'POST para app desconhecido -> 404');
  for (const [name, p] of [['P1', P1], ['P2', P2], ['P3', P3], ['P4', P4], ['P5', P5], ['P6', P6], ['P7', P7]]) {
    ok((await sendMeta(p)) === 200, `POST ${name} assinado -> 200`);
  }
  ok((await sendRaw(raw8)) === 200, 'POST P8 (bytes crus com escape unicode) -> 200');

  const only = (P, e, idxs) => ({ ...P, entry: [{ ...P.entry[e], changes: idxs.map((i) => P.entry[e].changes[i]) }] });
  const expected = {
    a: [P1, only(P2, 0, [0]), P3, P8],
    b: [P1, only(P2, 0, [0]), P3, P8],
    c: [only(P2, 0, [1]), P3, only(P6, 0, [0])],
    d: [only(P2, 0, [2]), P3],
    e: [P5],
    'f-inativo': [], 'g-canal-inativo': [], 'h-toggle': [],
  };
  const total = Object.values(expected).reduce((n, l) => n + l.length, 0);
  let dump = [];
  for (let i = 0; i < 40; i++) {
    dump = await fetchDeliveries();
    if (dump.length >= total) break;
    await sleep(1000);
  }
  await sleep(7000); // janela para aparecer entrega a mais (duplicada ou para inativo)
  dump = await fetchDeliveries();
  for (const [slug, list] of Object.entries(expected)) {
    const got = dump.filter((d) => d.path === '/' + slug).map((d) => canon(d.body)).sort();
    const want = list.map((p) => canon(p)).sort();
    const same = JSON.stringify(got) === JSON.stringify(want);
    ok(same, `endpoint ${slug}: ${got.length} entrega(s), esperado ${want.length}` + (same ? '' : `\n   got:  ${got.join('\n         ')}\n   want: ${want.join('\n         ')}`));
  }
  ok(dump.length === total, `total entregue ${dump.length}, esperado ${total}`);

  r = await api('GET', `/api/received?slug=meta-app-${APP_ID}&limit=50`);
  ok(r.json && r.json.total === 8, `auditoria: 1 linha por POST aceito, 0 por recusado (${r.json && r.json.total} de 8)`);

  console.log('--- remocao e rotas antigas');
  r = await api('DELETE', `/api/meta/channels/${ch2.id}`);
  ok(r.status === 204, 'remove canal');
  r = await api('GET', '/api/webhook-configs');
  const c2 = r.json.find((c) => c.id === cCfg.id);
  ok(c2 && c2.meta_channel_id === null, 'endpoint do canal removido fica desvinculado, nao apagado');
  let lg = await fetch(BASE + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(P1) });
  ok(lg.status === 200, `POST /webhook legado continua 200 (${lg.status})`);
  lg = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=leg`);
  ok(lg.status === 200 && (await lg.text()) === 'leg', 'handshake do /webhook legado intacto');
  lg = await fetch(BASE + '/webhook/a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(P1) });
  ok(lg.status === 200, `POST /webhook/<slug> continua 200 (${lg.status})`);

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE:', e); process.exit(2); });
