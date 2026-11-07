// StallFlow connector relay (Cloudflare Worker).
//
// Claude's custom connectors need a plain HTTPS address that answers directly.
// Google Apps Script always answers with a redirect (a 302), which Claude's
// check rejects. This forwards each request to the stall's Apps Script,
// follows that redirect itself, and hands the answer straight back.
//
// The connector address is   https://<this worker>/<KEY>
// where KEY is the long code after "mcp=" in the address StallFlow shows.
// The key is checked by StallFlow, not here; this only passes it on.

const STALL = 'https://script.google.com/macros/s/AKfycbzT__IC8WZBjSLa5mE067GriRLSXNTQRcpsiMcazDqbOdnHHGfCw4NodxhNbaWwetEw4w/exec';

const reply = (status, body) => new Response(body === undefined ? null : body, {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

export default {
  async fetch(request) {
    const key = new URL(request.url).pathname.split('/').filter(Boolean).pop() || '';
    if (!/^[a-f0-9]{32,80}$/.test(key)) return reply(404, '{"error":"not found"}');
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    const body = await request.text();
    if (body.length > 20000) return reply(413, '{"error":"too large"}');
    let up;
    try {
      up = await fetch(STALL + '?mcp=' + key, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body, redirect: 'follow'
      });
    } catch (e) { return reply(502, '{"error":"could not reach the stall"}'); }
    const text = (await up.text()).trim();
    if (!text) return new Response(null, { status: 202 });       // a notification: nothing to say back
    return reply(200, text);
  }
};
