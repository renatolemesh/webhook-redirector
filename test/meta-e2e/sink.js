/**
 * Duplo de tres coisas, num processo so, para o teste ponta a ponta:
 *
 *  1. SINK      - recebe os repasses do redirector (POST /<slug>) e guarda.
 *  2. GRAPH     - finge a Graph API da Meta (META_GRAPH_BASE aponta para ca).
 *  3. CONNECT   - finge a API do Chatwoot (POST /api/v1/accounts/:id/inboxes).
 *
 * Endpoints de controle para o teste dirigir o duplo:
 *   GET  /dump                 tudo o que foi recebido
 *   POST /control/override     define o override que o GET subscribed_apps devolve
 *   POST /control/debug-app    faz o debug_token responder outro app_id
 */
const http = require('http');

const deliveries = [];
const graph = [];
const inboxes = [];
const state = { override: null, debugAppId: null, igUserId: '17841400000000001' };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    // ---------------- controle
    if (req.method === 'GET' && path === '/dump') return json(res, 200, { deliveries, graph, inboxes, state });
    if (req.method === 'POST' && path === '/control/override') { state.override = body?.override ?? null; return json(res, 200, state); }
    if (req.method === 'POST' && path === '/control/debug-app') { state.debugAppId = body?.app_id ?? null; return json(res, 200, state); }

    // ---------------- Graph: troca de code (WhatsApp)
    if (req.method === 'GET' && path.endsWith('/oauth/access_token')) {
      graph.push({ op: 'exchange_code', q });
      return json(res, 200, { access_token: 'TOKEN-CLIENTE-FAKE', token_type: 'bearer', expires_in: 5184000 });
    }
    if (req.method === 'GET' && path.endsWith('/debug_token')) {
      const appFromToken = String(q.access_token || '').split('|')[0];
      graph.push({ op: 'debug_token', q });
      return json(res, 200, { data: { app_id: state.debugAppId || appFromToken, is_valid: true, scopes: ['whatsapp_business_management'] } });
    }
    // ---------------- Graph: inscricao do WABA
    if (path.endsWith('/subscribed_apps')) {
      const wabaId = path.split('/').filter(Boolean).slice(-2)[0];
      if (req.method === 'POST') {
        if (body && body.override_callback_uri) state.override = body.override_callback_uri;
        graph.push({ op: body && body.override_callback_uri ? 'override' : 'subscribe', wabaId, body });
        return json(res, 200, { success: true });
      }
      graph.push({ op: 'get_subscribed', wabaId });
      return json(res, 200, {
        data: [{ whatsapp_business_api_data: { id: '9999999999999999', name: 'App de teste' }, override_callback_uri: state.override }],
      });
    }
    // ---------------- Graph/IG: token longo e conta
    if (req.method === 'GET' && path === '/access_token' && q.grant_type === 'ig_exchange_token') {
      graph.push({ op: 'ig_exchange', q });
      return json(res, 200, { access_token: 'IG-TOKEN-LONGO', expires_in: 5184000 });
    }
    if (req.method === 'GET' && path === '/refresh_access_token') {
      graph.push({ op: 'ig_refresh', q });
      return json(res, 200, { access_token: 'IG-TOKEN-RENOVADO', expires_in: 5184000 });
    }
    if (req.method === 'POST' && path === '/oauth/access_token') {
      graph.push({ op: 'ig_code', raw });
      return json(res, 200, { access_token: 'IG-TOKEN-CURTO', user_id: state.igUserId });
    }
    if (req.method === 'GET' && path.endsWith('/me')) {
      graph.push({ op: 'ig_me', q });
      return json(res, 200, { id: 'ig-app-scoped', user_id: state.igUserId, username: 'lojateste', account_type: 'BUSINESS' });
    }
    // ---------------- Connect: cria inbox
    if (req.method === 'POST' && /^\/api\/v1\/accounts\/\d+\/inboxes$/.test(path)) {
      inboxes.push({ path, body, token: req.headers.api_access_token || null });
      return json(res, 200, { id: 4242, name: body?.name, channel_type: 'Channel::Whatsapp' });
    }
    // ---------------- Graph: consulta do numero (qualquer outro GET com fields)
    if (req.method === 'GET' && q.fields && q.fields.includes('display_phone_number')) {
      graph.push({ op: 'phone_info', q, path });
      return json(res, 200, { id: path.split('/').pop(), display_phone_number: '+554199990000', verified_name: 'Loja Teste', code_verification_status: 'VERIFIED' });
    }

    // ---------------- sink dos repasses
    deliveries.push({ path, body, attempt: req.headers['x-attempt-count'] });
    res.end('ok');
  });
}).listen(4000, () => console.log('duplo (sink + graph + connect) na 4000'));
