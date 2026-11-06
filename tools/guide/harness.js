/**
 * The fake Google services from tests/browser.test.js, for tools/guide/guide.js
 * (dates come out the way Apps Script writes them in South Africa).
 *
 * Originally: runs the real staff app in a real browser against the real server code (the
 * same fake spreadsheet as server.test.js), and checks what a person would see:
 * forms surviving a trip to Maps, the People page keeping its place, a new
 * market appearing at once, labels printing without the picker, reports saved.
 *
 *   node tests/browser.test.js        (needs Playwright; skips cleanly without it)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');

let chromium, DEVICE = null;
try { chromium = require('playwright').chromium; }
catch (e) { console.log('skip  Playwright is not installed'); process.exit(0); }
if (process.env.SF_DEVICE) {
  DEVICE = require('playwright').devices[process.env.SF_DEVICE];
  if (!DEVICE) { console.log('no such device: ' + process.env.SF_DEVICE); process.exit(1); }
  delete DEVICE.defaultBrowserType;
}

const ROOT = path.join(__dirname, '..', '..');

/* ---------- the server, with Google's services faked ---------- */
function makeSheet() {
  const rows = [];
  return {
    rows,
    appendRow(r) { rows.push(r.slice()); },
    getLastRow() { return rows.length; },
    getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [], o = [];
            for (let j = 0; j < nc; j++) {
              const v = row[c - 1 + j] === undefined ? '' : row[c - 1 + j];
              o.push(typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);   // as Sheets reads it
            }
            out.push(o);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = v; })); return this; },
        setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
      };
    },
    deleteRow(n) { rows.splice(n - 1, 1); }, deleteRows(n, k) { rows.splice(n - 1, k); }, setFrozenRows() {}
  };
}
function server() {
  const sheets = {}, props = {}, gh = [];
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()), getName: () => 'Test sheet' }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, key) => Array.from(crypto.createHmac('sha256', key).update(v).digest()).map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, f) => {
        // Like Apps Script in South Africa (UTC+2), for the patterns the server uses.
        const z = new Date(new Date(d).getTime() + 2 * 3600e3), p = (n) => String(n).padStart(2, '0');
        const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const parts = { yyyy: z.getUTCFullYear(), MMM: M[z.getUTCMonth()], MM: p(z.getUTCMonth() + 1),
          dd: p(z.getUTCDate()), d: z.getUTCDate(), HH: p(z.getUTCHours()), mm: p(z.getUTCMinutes()) };
        return f.replace(/yyyy|MMM|MM|dd|d|HH|mm/g, (k) => parts[k]);
      }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.indexOf('api.github.com') !== -1) {
        gh.push(JSON.parse(opts.payload));
        return { getResponseCode: () => 201, getContentText: () => JSON.stringify({ html_url: 'https://github.com/o/r/issues/9' }) };
      }
      return { getResponseCode: () => 400, getContentText: () => '{}' };
    } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example/exec' }) },
    ContentService: {}, HtmlService: {}
  };
  vm.createContext(ctx);
  const dir = path.join(ROOT, 'server');
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort()
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  ctx.SF.PLATFORM.googleClientId = ''; ctx.SF.PLATFORM.admins = [];
  ctx.SF.migrate();
  return { SF: ctx.SF, sheets, props, gh };
}

/* ---------- the built site, served locally ---------- */
function serveSite() {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'build-site.sh'), 'test'], { cwd: ROOT, stdio: 'ignore' });
  const root = path.join(ROOT, '_site');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                  '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, () => ok(srv)));
}

const MAPS_STUB = (mode) => `(function () {
  var src = (document.currentScript && document.currentScript.src) || '';
  var cb = (src.match(/callback=([^&]+)/) || [])[1];
  window.__placeQueries = [];
  function T(s) { this.s = s; } T.prototype.toString = function () { return this.s; };
  var all = [['Monument Primary School', 'Monument Park, Pretoria, South Africa'],
             ['Monument Park Shopping Centre', 'Pretoria, South Africa'],
             ['Voortrekker Monument', 'Eeufees Road, Groenkloof, Pretoria, South Africa']];
  var places = {
    AutocompleteSessionToken: function () {},
    AutocompleteSuggestion: { fetchAutocompleteSuggestions: function (req) {
      window.__placeQueries.push(req.input + '|' + (req.includedRegionCodes || []).join(','));
      if ('${mode}' === 'refused') return Promise.reject(new Error('RefererNotAllowedMapError'));
      var q = req.input.toLowerCase();
      return Promise.resolve({ suggestions: all.filter(function (a) {
        return a[0].toLowerCase().indexOf(q) !== -1; }).map(function (a) {
        return { placePrediction: { mainText: new T(a[0]), secondaryText: new T(a[1]), text: new T(a.join(', ')) } };
      }) });
    } }
  };
  window.google = { maps: { importLibrary: function () { return Promise.resolve(places); } } };
  if (cb) window[cb]();
  if ('${mode}' === 'refused' && window.gm_authFailure) setTimeout(window.gm_authFailure, 0);
})();`;

let failures = 0;
module.exports = { server, serveSite, MAPS_STUB, ROOT, chromium };
