// node tools/relay/test.js : the relay against a pretend Apps Script that redirects like the real one.
const http = require('http'), fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/worker.js', 'utf8');
const up = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/exec')) {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      global.__seen = { url: req.url, body: b, type: req.headers['content-type'] };
      res.writeHead(302, { Location: '/echo?x=' + (JSON.parse(b || '{}').id === undefined ? 'none' : 'answer') }); res.end();
    });
  } else if (req.url.startsWith('/echo')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('none') ? '' : JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
  } else { res.writeHead(404); res.end(); }
});
up.listen(0, async () => {
  const port = up.address().port;
  const mod = new Function('return (function(){' + src.replace(/const STALL = '[^']*';/, "const STALL = 'http://127.0.0.1:" + port + "/exec';").replace('export default', 'return') + '})()')();
  const key = 'a'.repeat(40);
  let r = await mod.fetch(new Request('https://relay.test/' + key, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }));
  assert.strictEqual(r.status, 200); assert.ok(JSON.parse(await r.text()).result, 'the redirect was followed');
  assert.ok(global.__seen.url.endsWith('?mcp=' + key) && global.__seen.type === 'text/plain', 'key passed on, as text/plain');
  r = await mod.fetch(new Request('https://relay.test/' + key, { method: 'POST', body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }));
  assert.strictEqual(r.status, 202, 'a notification gets 202');
  assert.strictEqual((await mod.fetch(new Request('https://relay.test/' + key))).status, 405);
  assert.strictEqual((await mod.fetch(new Request('https://relay.test/nope', { method: 'POST', body: '{}' }))).status, 404);
  console.log('relay ok'); up.close();
});
