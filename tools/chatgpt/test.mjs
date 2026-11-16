// node tools/chatgpt/test.mjs : the whole ChatGPT sign-in and a tool call, in workerd (Miniflare),
// against a pretend Google token endpoint and a pretend Apps Script that redirects like the real one.
// Needs: cd tools/chatgpt && npm install (see README.md).
import http from 'node:http';
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const here = new URL('.', import.meta.url).pathname;
const b64u = (b) => Buffer.from(b).toString('base64url');
const idToken = (c) => b64u('{"alg":"RS256"}') + '.' + b64u(JSON.stringify(c)) + '.sig';

let googleSays = {}, seen = null;
const CLIENT = 'test-client.apps.googleusercontent.com', KEY = 'k'.repeat(64);
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.url === '/google-token') {
      const f = new URLSearchParams(b);
      assert.ok(f.get('code_verifier') && f.get('client_secret') === 'shh', 'PKCE verifier and secret sent to Google');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id_token: idToken(googleSays) }));
    }
    if (req.url.startsWith('/exec')) {
      seen = { url: req.url, body: b, type: req.headers['content-type'] };
      res.writeHead(302, { Location: '/echo?x=' + (JSON.parse(b || '{}').id === undefined ? 'none' : 'answer') }); return res.end();
    }
    if (req.url.startsWith('/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(req.url.endsWith('none') ? '' : JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'brand_kit' }] } }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const M = 'http://127.0.0.1:' + mock.address().port;

const out = await build({ entryPoints: [here + 'worker.js'], bundle: true, format: 'esm', platform: 'neutral',
  mainFields: ['module', 'main'], external: ['cloudflare:*'], write: false, nodePaths: (process.env.NODE_PATH || '').split(':').filter(Boolean) });
const mf = new Miniflare({
  modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-01-01', kvNamespaces: ['OAUTH_KV'],
  bindings: { STALL_API: M + '/exec', STALL_KEY: KEY, ALLOWED_EMAILS: 'Boss@StallFlow.co.za, other@x.com',
    GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'shh', GOOGLE_TOKEN_URL: M + '/google-token' }
});
const O = 'https://relay.test';
const go = (path, init) => mf.dispatchFetch(O + path, { redirect: 'manual', ...init });
const cookies = (r, jar) => { (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach((c) => { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }); return jar; };
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

try {
  // 1. Without a token: a challenge pointing at the metadata, and the metadata itself.
  let r = await go('/mcp', { method: 'POST', body: '{}' });
  assert.strictEqual(r.status, 401);
  assert.ok(/resource_metadata=/.test(r.headers.get('www-authenticate')), r.headers.get('www-authenticate'));
  const prm = await (await go('/.well-known/oauth-protected-resource/mcp')).json();
  assert.strictEqual(prm.resource, O + '/mcp'); assert.deepStrictEqual(prm.authorization_servers, [O]);
  const asm = await (await go('/.well-known/oauth-authorization-server')).json();
  assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes('S256'));

  const signIn = async (email, extra) => {
    googleSays = { iss: 'https://accounts.google.com', aud: CLIENT, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, ...extra };
    const reg = await (await go('/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none' }) })).json();
    assert.ok(reg.client_id, JSON.stringify(reg));
    const verifier = b64u(randomBytes(32)), challenge = b64u(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scope: 'design', state: 'st8', code_challenge: challenge, code_challenge_method: 'S256', resource: O + '/mcp' });
    const jar = {};
    let a = await go('/authorize?' + q);
    assert.strictEqual(a.status, 200);
    const html = await a.text(); cookies(a, jar);
    assert.ok(html.includes('ChatGPT wants to use StallFlow for artwork') && html.includes('cannot see cost prices'));
    assert.strictEqual(a.headers.get('x-frame-options'), 'DENY', 'the consent page cannot be framed');
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    a = await go('/authorize', { method: 'POST', headers: { cookie: cookieHeader(jar), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    assert.strictEqual(a.status, 302); cookies(a, jar);
    const g = new URL(a.headers.get('location'));
    assert.strictEqual(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.strictEqual(g.searchParams.get('client_id'), CLIENT); assert.strictEqual(g.searchParams.get('scope'), 'openid email');
    assert.strictEqual(g.searchParams.get('redirect_uri'), O + '/callback');
    const cb = await go('/callback?code=good&state=' + encodeURIComponent(g.searchParams.get('state')), { headers: { cookie: cookieHeader(jar) } });
    return { cb, reg, verifier };
  };

  // 2. The allowed account (any case) gets through, and ChatGPT swaps the code for a token.
  const { cb, reg, verifier } = await signIn('boss@stallflow.co.za');
  assert.strictEqual(cb.status, 302, await cb.clone().text());
  const back = new URL(cb.headers.get('location'));
  assert.strictEqual(back.origin + back.pathname, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.strictEqual(back.searchParams.get('state'), 'st8');
  const tok = await (await go('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_verifier: verifier, resource: O + '/mcp' }) })).json();
  assert.ok(tok.access_token && tok.refresh_token, JSON.stringify(tok));

  // 3. A tool call goes to the stall with the stall's key, which ChatGPT never had.
  const auth = { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json' };
  r = await go('/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).result.tools[0].name, 'brand_kit', 'the Apps Script redirect was followed');
  assert.ok(seen.url === '/exec?design=' + KEY && seen.type === 'text/plain', 'key added here, sent as text/plain');
  assert.ok(!JSON.stringify(tok).includes(KEY), 'ChatGPT never sees the stall key');
  r = await go('/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
  assert.strictEqual(r.status, 202, 'a notification gets 202');
  r = await go('/mcp', { method: 'POST', headers: auth, body: 'x'.repeat(20001) });
  assert.strictEqual(r.status, 413);
  r = await go('/mcp', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.strictEqual(r.status, 401, 'a made-up token is refused');

  // 4. Anyone else, or a token not meant for this app, is turned away at Google's step.
  for (const [email, extra, why] of [['someone@gmail.com', {}, 'not on the list'],
    ['boss@stallflow.co.za', { aud: 'another-app' }, 'token for another app'],
    ['boss@stallflow.co.za', { email_verified: false }, 'unverified email'],
    ['boss@stallflow.co.za', { exp: 1 }, 'expired']]) {
    const x = await signIn(email, extra);
    assert.strictEqual(x.cb.status, 403, why);
    assert.ok((await x.cb.text()).includes('not allowed'), why);
  }

  // 5. Taken off the list after signing in: the next call is refused.
  await mf.setOptions({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-01-01', kvNamespaces: ['OAUTH_KV'],
    bindings: { STALL_API: M + '/exec', STALL_KEY: KEY, ALLOWED_EMAILS: 'other@x.com', GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'shh', GOOGLE_TOKEN_URL: M + '/google-token' } });
  r = await go('/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.ok(r.status === 403 || r.status === 401, 'removed from the list: ' + r.status);

  console.log('chatgpt relay ok');
} finally {
  await mf.dispose(); mock.close();
}
