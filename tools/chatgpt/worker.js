// StallFlow design connector for ChatGPT (Cloudflare Worker).
//
// ChatGPT's custom apps (developer mode) want a remote MCP server that signs people in with
// OAuth. Google Apps Script cannot be that server (it answers every request with a redirect and
// cannot publish the OAuth addresses ChatGPT looks for), so this Worker sits in front of it:
//
//   ChatGPT ──OAuth──▶ this Worker ──Google sign-in──▶ only the emails in ALLOWED_EMAILS
//           ──/mcp───▶ this Worker ──?design=STALL_KEY──▶ the stall's Apps Script
//
// ChatGPT never sees STALL_KEY: it holds only a token this Worker gave it after Google said who
// the person is. The stall decides what the key may do (server/Support.gs, SF.DESIGN_TOOLS):
// read the brand kit, products, prices and order links, and save one design note. Nothing else.
//
// Settings (Cloudflare › Worker › Settings › Variables):
//   STALL_API              the stall's Apps Script /exec address (stalls/<slug>/stall.json "api")
//   ALLOWED_EMAILS         Google accounts that may connect, comma separated
//   GOOGLE_CLIENT_ID       a Google OAuth "Web application" client
//   GOOGLE_CLIENT_SECRET   (secret) that client's secret
//   STALL_KEY              (secret) the key from StallFlow › Settings › ChatGPT for artwork
//   OAUTH_KV               a KV namespace binding (tokens, stored hashed by the library)

import { OAuthProvider, authorizationErrorRedirect, AuthorizationError } from '@cloudflare/workers-oauth-provider';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const MAX_BODY = 20000;

const allowed = (env, email) => String(env.ALLOWED_EMAILS || '').toLowerCase().split(',')
  .map((s) => s.trim()).filter(Boolean).includes(String(email || '').toLowerCase());

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body, headers, status) => {
  const h = headers || new Headers();
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  h.set('x-frame-options', 'DENY');
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#2a2421;background:#fbf7f2}' +
    'h1{font-size:1.3rem}ul{padding-left:1.2rem}button{font:inherit;padding:.7rem 1.2rem;border-radius:.6rem;border:0;margin:.3rem .4rem 0 0;cursor:pointer}' +
    '.go{background:#3d6b4f;color:#fff}.no{background:#e8e1d9;color:#2a2421}.small{font-size:.85rem;color:#6b625b}</style></head><body>' +
    body + '</body></html>', { status: status || 200, headers: h });
};

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = async (v) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

/** The claims of an ID token that came straight from Google's token endpoint over TLS (OIDC §3.1.3.7: no signature check needed on that path). */
const claims = (idToken) => {
  const part = String(idToken || '').split('.')[1] || '';
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
};

/* ---- /authorize, /callback: who is connecting ---- */

const defaultHandler = {
  async fetch(req, env) {
    const url = new URL(req.url), oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const request = await oauth.parseAuthRequest(req);
        const client = await oauth.lookupClient(request.clientId);
        const consent = await oauth.beginConsent(request);
        const who = esc((client && client.clientName) || 'An app');
        return page('Connect to StallFlow',
          '<h1>' + who + ' wants to use StallFlow for artwork</h1>' +
          '<p>If you allow it, it can:</p><ul>' +
          '<li>read the shop\'s name, colours, label look and order page links</li>' +
          '<li>read the products that are on sale, with prices and stock</li>' +
          '<li>save one short design note for the owner</li></ul>' +
          '<p>It cannot see cost prices, money, orders or customers, and cannot change stock or prices.</p>' +
          '<p class="small">Next you sign in with Google. Only accounts StallFlow has allowed get in.</p>' +
          '<form method="post" action="/authorize"><input type="hidden" name="handle" value="' + esc(consent.handle) + '">' +
          '<button class="go" name="decision" value="approve">Allow and sign in with Google</button>' +
          '<button class="no" name="decision" value="deny">Cancel</button></form>', consent.headers);
      }

      if (url.pathname === '/authorize' && req.method === 'POST') {
        const form = await req.formData(), handle = String(form.get('handle') || '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
        const g = new URL(GOOGLE_AUTH);
        g.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
        g.searchParams.set('redirect_uri', url.origin + '/callback');
        g.searchParams.set('response_type', 'code');
        g.searchParams.set('scope', 'openid email');
        g.searchParams.set('state', state);
        g.searchParams.set('code_challenge', await s256(verifier));
        g.searchParams.set('code_challenge_method', 'S256');
        g.searchParams.set('prompt', 'select_account');
        headers.set('Location', g.toString());
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/callback' && req.method === 'GET') {
        const { request: original, data, headers } = await oauth.finishUpstream(req);
        const code = url.searchParams.get('code');
        const refuse = () => { headers.set('Location', authorizationErrorRedirect(original, 'access_denied')); return new Response(null, { status: 302, headers }); };
        if (url.searchParams.get('error') || !code) return refuse();
        const tr = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN, {          // the override is for tests only
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: url.origin + '/callback', grant_type: 'authorization_code', code_verifier: data.verifier })
        });
        if (!tr.ok) return refuse();
        const c = claims((await tr.json()).id_token);
        const good = c && c.aud === env.GOOGLE_CLIENT_ID && /^(https:\/\/)?accounts\.google\.com$/.test(c.iss) &&
          (c.email_verified === true || c.email_verified === 'true') && Number(c.exp) * 1000 > Date.now();
        if (!good || !allowed(env, c.email)) {
          return page('Not allowed', '<h1>That Google account is not allowed</h1>' +
            '<p>Only the StallFlow administrator can connect ChatGPT to this shop. Close this window and sign in with the right account.</p>', headers, 403);
        }
        const email = String(c.email).toLowerCase();
        const { redirectTo } = await oauth.completeAuthorization({
          request: original, userId: encodeURIComponent(email), metadata: { email },
          scope: original.scope, props: { email }
        });
        headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/' || url.pathname === '') {
        return page('StallFlow for ChatGPT', '<h1>StallFlow design connector</h1><p>Add <b>' + esc(url.origin) + '/mcp</b> in ChatGPT as a custom app.</p>');
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (e instanceof AuthorizationError) {
        if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
        return page('Sign-in stopped', '<h1>That sign-in has expired</h1><p>Go back to ChatGPT and connect again.</p>', null, 400);
      }
      throw e;
    }
  }
};

/* ---- /mcp: pass the request on to the stall, with the stall's key added here ---- */

const mcpHandler = {
  async fetch(req, env, ctx) {
    const email = ctx && ctx.props && ctx.props.email;
    if (!allowed(env, email)) {                                   // taken off the list since signing in
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This Google account is no longer allowed.' } }, { status: 403 });
    }
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const body = await req.text();
    if (body.length > MAX_BODY) return Response.json({ error: 'too large' }, { status: 413 });
    let up;
    try {
      up = await fetch(env.STALL_API + '?design=' + encodeURIComponent(env.STALL_KEY), {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body, redirect: 'follow'
      });
    } catch (e) { return Response.json({ error: 'could not reach the stall' }, { status: 502 }); }
    const text = (await up.text()).trim();
    if (!text) return new Response(null, { status: 202 });       // a notification: nothing to say back
    if (text.charAt(0) !== '{' && text.charAt(0) !== '[') {       // an Apps Script error page, not JSON
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'The stall did not answer properly. Try again in a minute.' } }, { status: 502 });
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
};

/* ---- the provider: built once per address, since the resource must name its own URL ---- */

let provider = null, origin = '';
const build = (o) => new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ['design'],
  requiredScopes: ['design'],
  resourceMetadata: { resource: o + '/mcp', authorization_servers: [o], resource_name: 'StallFlow design connector' },
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30
});

export default {
  async fetch(req, env, ctx) {
    const o = new URL(req.url).origin;
    if (!provider || origin !== o) { provider = build(o); origin = o; }
    return provider.fetch(req, env, ctx);
  }
};

// For tests only.
export { defaultHandler, mcpHandler, claims, allowed };
