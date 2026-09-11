const http = require('http');
const got = [];
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/dump') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(got));
    }
    let body;
    try { body = JSON.parse(data); } catch { body = data; }
    got.push({ path: req.url, body, attempt: req.headers['x-attempt-count'] });
    res.end('ok');
  });
}).listen(4000, () => console.log('sink on 4000'));
