/**
 * Runs the real staff app in a real browser against the real server code (the
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

const ROOT = path.join(__dirname, '..');

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
  const sheets = {}, props = {}, gh = [], backups = [];
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: (n) => sheets[n] || null, getName: () => 'Test sheet',
      insertSheet: (n) => (sheets[n] = Object.assign(makeSheet(), { getName: () => n })),
      getSheets: () => Object.keys(sheets).map((n) => sheets[n]) }),
      // The weekly backup: a new spreadsheet, kept in memory.
      create: (name) => { const tabs = {}; backups.push({ name, tabs });
        tabs.Sheet1 = Object.assign(makeSheet(), { getName: () => 'Sheet1' });
        return { getUrl: () => 'https://docs.google.com/spreadsheets/d/backup', getSheets: () => Object.values(tabs),
          insertSheet: (n) => (tabs[n] = Object.assign(makeSheet(), { getName: () => n })),
          deleteSheet: (t) => { delete tabs[t.getName()]; } }; } },
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
  return { SF: ctx.SF, sheets, props, gh, backups };
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
async function test(name, fn) {
  // SF_ONLY=stocktake node tests/browser.test.js runs just the tests whose names contain it.
  if (process.env.SF_ONLY && name.indexOf(process.env.SF_ONLY) === -1) return;
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' +
    String(e.message).split('\n').filter((l) => !/^[+-]?\s*(\[|\]|actual|expected)/.test(l)).slice(0, 14).join('\n     ')); }
}
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const srv = await serveSite();
  const base = 'http://localhost:' + srv.address().port + '/duxies/app/';
  const browser = await chromium.launch();

  /** A fresh phone, signed in, talking to a fresh server. */
  async function phone(opts) {
    opts = opts || {};
    const env = server(), SF = env.SF;
    SF.append('products', { ProductId: 'P01', Name: 'Apricot Jam', Type: 'stocked', Unit: 'each', Price: 70, Active: 'Yes', Sort: 10 });
    SF.append('products', { ProductId: 'P02', Name: 'Marmalade', Type: 'stocked', Unit: 'each', Price: 70, Active: 'Yes', Sort: 20 });
    SF.move('P01', 10, 'adjust', 'test'); SF.move('P02', 10, 'adjust', 'test');
    SF.append('markets', { MarketId: 'M01', Name: 'Test Market', Date: day(-3), Status: 'planned' });
    SF.set('activeMarket', 'M01');
    if (opts.seed) opts.seed(SF);
    let token;
    if (opts.google) {
      SF.PLATFORM.googleClientId = 'x.apps.googleusercontent.com'; SF.PLATFORM.admins = ['boss@x.com'];
      token = SF.mintToken('owner', 'd', 'boss@x.com');
    } else {
      SF.setPin('owner', '4321');
      token = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
    }
    // Service workers off, so the routed config.js above is what the app really reads.
    // SF_DEVICE='iPhone 13' (any Playwright device name) runs every test on that
    // phone's screen, touch and browser name instead of the plain 420×640 window.
    const ctx = await browser.newContext(DEVICE
      ? Object.assign({}, DEVICE, { serviceWorkers: 'block' })
      : { viewport: { width: 420, height: 640 },
          deviceScaleFactor: process.env.SF_SHOT ? 2 : 1, serviceWorkers: 'block' });
    // An iPhone or iPad has no BarcodeDetector in any browser: take it away so
    // the scanner uses jsQR, as it does there.
    if (DEVICE && /iPhone|iPad/.test(DEVICE.userAgent)) {
      await ctx.addInitScript(() => { try { delete window.BarcodeDetector; } catch (e) {} });
    }
    if (opts.init) await ctx.addInitScript(opts.init);
    const page = await ctx.newPage();
    env.mapsRequests = 0;
    await ctx.route('https://maps.googleapis.com/**', async (route) => {
      env.mapsRequests++;
      if (env.offline) return route.abort('internetdisconnected');
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: MAPS_STUB(opts.maps || 'ok') });
    });
    // The test decides whether there is a Maps key, whatever stalls/platform.json holds,
    // and Google itself is never called: maps.googleapis.com is the stand-in above.
    await ctx.route('**/duxies/config.js', async (route) => {
      const real = fs.readFileSync(path.join(ROOT, '_site', 'duxies', 'config.js'), 'utf8');
      await route.fulfill({ status: 200, contentType: 'text/javascript',
        body: real + (opts.maps ? '\nwindow.STALLFLOW.mapsKey = "test-key"; window.STALLFLOW.mapsRegion = "za";'
                                : '\ndelete window.STALLFLOW.mapsKey;') });
    });
    page.on('pageerror', (e) => { env.pageErrors = (env.pageErrors || []).concat(String(e)); });
    if (process.env.SF_DEBUG) page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
    await ctx.route('https://script.google.com/**', async (route) => {
      const req = route.request();
      // The order page reads with GET (?action=catalogue&market=…); the staff app always POSTs.
      const body = req.method() === 'GET'
        ? Object.fromEntries(new URL(req.url()).searchParams)
        : JSON.parse(req.postData() || '{}');
      if (env.offline) return route.abort('internetdisconnected');
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      const out = SF.dispatch(body.action, body);
      await route.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
    });
    await page.goto(base);
    await page.evaluate((a) => SF.ls.set('sf.auth', a), { token, role: 'owner', user: opts.google ? 'boss@x.com' : '' });
    await page.goto('about:blank');                 // a real fresh open, not just a hash change
    await page.goto(base + (opts.hash || '#till'));
    await page.waitForFunction(() => window.SF && SF.state.ready);
    await page.waitForTimeout(700);
    env.page = page; env.ctx = ctx;
    return env;
  }
  /** What happens when you go out to Maps and come back. */
  const leaveAndReturn = (page) => page.evaluate(() => {
    const set = (v) => Object.defineProperty(document, 'hidden', { value: v, configurable: true });
    set(true); document.dispatchEvent(new Event('visibilitychange'));
    set(false); document.dispatchEvent(new Event('visibilitychange'));
  });
  const settle = (page, ms) => page.waitForTimeout(ms || 1200);
  const openNewMarket = async (page) => {
    await page.waitForFunction(() => SF.state.data.numbers);
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'new'); SF.render(); });
    await page.waitForSelector('#ml');
  };

  const suggestions = (page) => page.locator('#ml-sug .opt');

  await test('typing a place suggests Google places inside the app', async () => {
    const env = await phone({ hash: '#numbers', maps: 'ok' });
    const page = env.page;
    await openNewMarket(page);
    await page.click('#ml'); await page.keyboard.type('Monument', { delay: 30 });
    await page.waitForSelector('#ml-sug .opt');
    const names = await suggestions(page).allTextContents();
    assert.ok(names[0].indexOf('Monument Primary School') !== -1, names.join(' / '));
    assert.ok((await page.textContent('#ml-sug')).indexOf('Suggestions from Google') !== -1);
    if (process.env.SF_SHOT) {           // pictures for a person to look at: SF_SHOT is a folder
      await page.locator('.card:has(#ml)').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.SF_SHOT, 'place-suggestions.png') });
    }
    assert.ok((await page.evaluate(() => window.__placeQueries)).every((q) => /\|za$/.test(q)), 'South Africa only');
    await suggestions(page).first().click();
    assert.strictEqual(await page.inputValue('#ml'), 'Monument Primary School, Monument Park, Pretoria, South Africa');
    assert.strictEqual(await page.isVisible('#ml-sug'), false, 'the list closes');
    assert.strictEqual(env.ctx.pages().length, 1, 'nothing opened another tab or browser');
    await env.ctx.close();
  });

  await test('arrow keys and Enter pick a suggestion', async () => {
    const env = await phone({ hash: '#numbers', maps: 'ok' });
    const page = env.page;
    await openNewMarket(page);
    await page.click('#ml'); await page.keyboard.type('Monu', { delay: 30 });
    await page.waitForSelector('#ml-sug .opt');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.inputValue('#ml'), 'Monument Park Shopping Centre, Pretoria, South Africa');
    assert.strictEqual(await page.inputValue('#mn'), '', 'Enter picked the place, it did not add the market');
    await env.ctx.close();
  });

  await test('the whole place Google suggested is saved with the market', async () => {
    const env = await phone({ hash: '#numbers', maps: 'ok' });
    const page = env.page;
    await openNewMarket(page);
    await page.fill('#mn', 'Voortrekker Craft Day'); await page.fill('#md', day(6));
    await page.click('#ml'); await page.keyboard.type('Voortrekker', { delay: 20 });
    await page.waitForSelector('#ml-sug .opt'); await suggestions(page).first().click();
    await page.click('text=Add market');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const row = env.sheets.Markets.rows.find((r) => r[1] === 'Voortrekker Craft Day');
    assert.strictEqual(row[3], 'Voortrekker Monument, Eeufees Road, Groenkloof, Pretoria, South Africa');
    await env.ctx.close();
  });

  await test('coming back to the app keeps the place and does not pop the list open', async () => {
    const env = await phone({ hash: '#numbers', maps: 'ok' });
    const page = env.page;
    await openNewMarket(page);
    await page.fill('#mn', 'Monument Primary Market');
    await page.click('#ml'); await page.keyboard.type('Monument Pri', { delay: 20 });
    await page.waitForSelector('#ml-sug .opt');
    await leaveAndReturn(page); await settle(page);
    assert.strictEqual(await page.inputValue('#mn'), 'Monument Primary Market');
    assert.strictEqual(await page.inputValue('#ml'), 'Monument Pri');
    assert.strictEqual(await page.isVisible('#ml-sug .opt'), false, 'no list pops up by itself');
    await env.ctx.close();
  });

  await test('with no Maps key the Where box is plain text and never calls Google', async () => {
    const env = await phone({ hash: '#numbers' });
    const page = env.page;
    await openNewMarket(page);
    await page.click('#ml'); await page.keyboard.type('Church hall', { delay: 20 });
    await settle(page, 800);
    assert.strictEqual(await page.inputValue('#ml'), 'Church hall');
    assert.strictEqual(await page.isVisible('#ml-sug .opt'), false);
    assert.strictEqual(env.mapsRequests, 0);
    assert.strictEqual(await page.locator('a[href*="google.com/maps"]').count(), 0, 'no link out to Maps');
    await env.ctx.close();
  });

  await test('a key Google refuses turns suggestions off quietly', async () => {
    const env = await phone({ hash: '#numbers', maps: 'refused' });
    const page = env.page;
    await openNewMarket(page);
    await page.click('#ml'); await page.keyboard.type('Monument', { delay: 20 });
    await settle(page, 900);
    assert.strictEqual(await page.isVisible('#ml-sug .opt'), false);
    assert.strictEqual(await page.inputValue('#ml'), 'Monument');
    assert.strictEqual(await page.evaluate(() => SFP.on()), false);
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await test('with no signal there are no suggestions and typing still works', async () => {
    const env = await phone({ hash: '#numbers', maps: 'ok' });
    const page = env.page;
    await openNewMarket(page);
    env.offline = true; await env.ctx.setOffline(true);
    await page.click('#ml'); await page.keyboard.type('Monument', { delay: 20 });
    await settle(page, 800);
    assert.strictEqual(await page.inputValue('#ml'), 'Monument');
    assert.strictEqual(await page.isVisible('#ml-sug .opt'), false);
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await test('going out of the app and back keeps what was typed', async () => {
    const { page, ctx } = await phone({ hash: '#numbers' });
    await openNewMarket(page);
    await page.fill('#mn', 'Monument Primary Market');
    await page.fill('#md', day(2));
    await page.fill('#ml', 'Monument Primary');
    await leaveAndReturn(page);
    await settle(page);
    assert.strictEqual(await page.inputValue('#mn'), 'Monument Primary Market');
    assert.strictEqual(await page.inputValue('#md'), day(2));
    assert.strictEqual(await page.inputValue('#ml'), 'Monument Primary');
    await ctx.close();
  });

  await test('the cursor stays in the box it was in', async () => {
    const { page, ctx } = await phone({ hash: '#numbers' });
    await openNewMarket(page);
    await page.click('#ml'); await page.keyboard.type('Church');
    await leaveAndReturn(page); await settle(page);
    assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), 'ml');
    await ctx.close();
  });

  await test('adding a market clears the form and the market is saved and listed', async () => {
    const env = await phone({ hash: '#numbers' });
    const page = env.page;
    await openNewMarket(page);
    await page.fill('#mn', 'Spring Craft'); await page.fill('#md', day(5)); await page.fill('#ml', 'Church hall');
    await page.click('text=Add market');
    assert.strictEqual(await page.inputValue('#mn'), '', 'form cleared');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const stored = env.sheets.Markets.rows.map((r) => r[1]);
    assert.ok(stored.indexOf('Spring Craft') !== -1, 'saved to the sheet: ' + stored);
    await page.waitForFunction(() => SF.state.data.till && SF.state.data.till.markets.some((m) => m.name === 'Spring Craft' && !m.pending));
    await env.ctx.close();
  });

  await test('a new market shows as saving, greyed out, until the server has it', async () => {
    const env = await phone({ hash: '#numbers', delay: 1500 });
    const page = env.page;
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'today'); });
    await page.goto(base + '#numbers'); await page.waitForSelector('#mk');
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'new'); SF.render(); });
    await page.fill('#mn', 'Later Market'); await page.fill('#md', day(9));
    await page.click('text=Add market');
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'today'); SF.render(); });
    const txt = await page.textContent('#mk');
    assert.ok(/Later Market.*saving/.test(txt), txt);
    assert.strictEqual(await page.locator('#mk option:has-text("Later Market")').isDisabled(), true);
    await env.ctx.close();
  });

  await test('the People page keeps its place and does not blank when you come back', async () => {
    const env = await phone({ google: true, hash: '#people', delay: 800 });
    const page = env.page;
    for (let i = 0; i < 12; i++) env.SF.append('users', { Email: 'p' + i + '@x.com', Name: 'P' + i, Role: 'cashier', Active: 'yes' });
    await page.goto(base + '#people');
    await page.waitForSelector('#peoplebox .rowitem, #peoplebox .card h2', { timeout: 8000 });
    await page.evaluate(() => { SFA.loadPeople(true); });
    await settle(page, 2500);
    await page.evaluate(() => window.scrollTo(0, 400));
    const before = await page.evaluate(() => Math.round(window.pageYOffset));
    assert.ok(before > 100, 'the page is long enough to scroll: ' + before);
    const blanks = [];
    await page.exposeFunction('noteBlank', (b) => blanks.push(b));
    await page.evaluate(() => {
      new MutationObserver(() => { if (document.querySelector('#peoplebox .loading')) noteBlank(true); })
        .observe(document.getElementById('view'), { childList: true, subtree: true });
    });
    await leaveAndReturn(page); await settle(page, 3500);
    const after = await page.evaluate(() => Math.round(window.pageYOffset));
    assert.ok(Math.abs(after - before) < 5, 'scrolled to ' + before + ', back at ' + after);
    assert.strictEqual(blanks.length, 0, 'the list blanked to "Fetching…"');
    await env.ctx.close();
  });

  await test('People: the role box shows its whole word and a long email stays whole, even with large text', async () => {
    const env = await phone({ google: true, hash: '#people' });
    const page = env.page;
    env.SF.append('users', { Email: 'duxies.homemade@gmail.com', Name: '', Role: 'owner', Active: 'yes' });
    env.SF.append('users', { Email: 'roxane.ceronio-duxbury@example.co.za', Name: 'Roxane', Role: 'manager', Active: 'yes' });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('about:blank'); await page.goto(base + '#people');
    await page.waitForSelector('#pr-0');
    for (const zoom of ['1', '1.6']) {
      await page.evaluate((z) => { document.documentElement.style.zoom = z; }, zoom);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const sel = document.getElementById('pr-0'), opt = sel.options[sel.selectedIndex];
        const email = document.querySelector('.who-email'), btns = Array.from(document.querySelectorAll('.peoplebtns button'));
        const W = document.documentElement.clientWidth;
        return { label: opt.textContent, selW: sel.getBoundingClientRect().width,
          clipped: sel.scrollWidth > sel.clientWidth + 1,
          lines: Math.round(email.getBoundingClientRect().height / parseFloat(getComputedStyle(email).lineHeight || 20)),
          btnsOk: btns.length === 4 && btns.every((b) => b.getBoundingClientRect().right <= W && b.getBoundingClientRect().width > 80),
          wide: document.documentElement.scrollWidth > W + 1 };
      });
      assert.strictEqual(r.label, 'Owner');
      assert.ok(r.selW > (360 / Number(zoom)) * 0.7, 'the role box is the full width: ' + r.selW);
      assert.ok(!r.clipped && r.btnsOk && !r.wide, JSON.stringify(r) + ' at ' + zoom + 'x');
    }
    await env.ctx.close();
  });

  await test('an email half typed on the People page survives a refresh', async () => {
    const env = await phone({ google: true, hash: '#people' });
    const page = env.page;
    await page.waitForSelector('#pe');
    await page.fill('#pe', 'new.person@gmail');
    await leaveAndReturn(page); await settle(page, 2500);
    assert.strictEqual(await page.inputValue('#pe'), 'new.person@gmail');
    await env.ctx.close();
  });

  await test('printing the QR labels leaves out the picker and keeps the labels', async () => {
    const env = await phone({ hash: '#labels' });
    const page = env.page;
    await page.waitForSelector('#out .label');
    const screenN = await page.locator('#out .label').count();
    await page.emulateMedia({ media: 'print' });
    assert.strictEqual(await page.isVisible('#controls'), false, 'the picker is hidden in print');
    assert.strictEqual(await page.locator('#out .label').first().isVisible(), true);
    assert.ok(screenN >= 2, 'labels drawn: ' + screenN);
    const pages = await page.pdf({ format: 'A4' }).then((b) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length);
    assert.ok(pages <= 2, 'a few labels should be one or two sheets, got ' + pages);
    await env.ctx.close();
  });

  await test('a problem report is saved, kept off the phone number, and opens one GitHub issue', async () => {
    const env = await phone({ hash: '#report' });
    const page = env.page;
    env.props.GITHUB_TOKEN = 'ghp_test';
    await page.waitForSelector('#rmsg');
    await page.fill('#rmsg', 'Anna 082 123 4567 could not pay, Take payment did nothing');
    await page.click('text=Send report');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const row = env.sheets.Issues.rows[1];
    assert.ok(row[5].indexOf('082') === -1 && row[5].indexOf('[number]') !== -1, row[5]);
    assert.strictEqual(row[7], 'sent');
    assert.strictEqual(env.gh.length, 1);
    assert.ok(JSON.stringify(env.gh[0]).indexOf('082') === -1);
    await env.ctx.close();
  });

  await test('a report with no signal waits on the phone and goes up when it returns', async () => {
    const env = await phone({ hash: '#report' });
    const page = env.page;
    await page.waitForSelector('#rmsg');
    env.offline = true; await page.context().setOffline(true);
    await page.fill('#rmsg', 'The till froze when I had no signal');
    await page.click('text=Send report');
    assert.strictEqual(await page.evaluate(() => SF.outbox.pending().length), 1);
    assert.strictEqual((env.sheets.Issues.rows[1] || [])[5], undefined);
    env.offline = false; await page.context().setOffline(false);
    await page.evaluate(() => SF.sync());
    await page.waitForFunction(() => !SF.outbox.pending().length, null, { timeout: 8000 });
    assert.ok(/froze/.test(env.sheets.Issues.rows[1][5]));
    await env.ctx.close();
  });

  await test('a cashier sees Report a problem in More and cannot see People', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    env.SF.setPin('cashier', '1111');
    const tok = env.SF.dispatch('signIn', { pin: '1111', device: 'd2' }).data.token;
    await page.evaluate((t) => { SF.ls.set('sf.auth', { token: t, role: 'cashier', user: '' }); }, tok);
    await page.goto('about:blank'); await page.goto(base + '#till');
    await page.waitForFunction(() => window.SF && SF.state.ready);
    await page.evaluate(() => SF.openMore());
    const sheet = await page.textContent('.sheet');
    assert.ok(sheet.indexOf('Report a problem') !== -1, sheet);
    assert.ok(sheet.indexOf('People') === -1);
    await env.ctx.close();
  });

  /* ---------- an order page for every market, and between markets ---------- */
  const site = base.replace(/app\/$/, '');
  const addFuture = (SF, id, name, n, where) =>
    SF.append('markets', { MarketId: id, Name: name, Date: day(n), Location: where || '', Status: 'planned' });
  async function customer(env, query) {
    const page = await env.ctx.newPage();
    await page.setViewportSize({ width: 412, height: 860 });
    page.on('pageerror', (e) => { env.pageErrors = (env.pageErrors || []).concat(String(e)); });
    await page.goto(site + (query || ''));
    await page.waitForSelector('.card');
    return page;
  }
  async function reserveOne(page, name) {
    await page.click('.stepper button[aria-label^="More"]');
    await page.fill('#nm', name || 'Anna Bester'); await page.fill('#ph', '082 555 0101');
    await page.check('#cs'); await page.click('#go');
    await page.waitForSelector('.done');
  }

  await test('the posters are one per open market plus between markets, each with its own link', async () => {
    const env = await phone({ hash: '#labels' });
    addFuture(env.SF, 'M02', 'Monument Primary Market', 2, 'Monument Primary School, Pretoria');
    const page = env.page;
    await page.evaluate(() => { SF.load('labels'); });
    await page.waitForFunction(() => SF.state.data.labels && SF.state.data.labels.markets.length === 2);
    await page.click('#tabP');
    const options = await page.locator('#pfor option').allTextContents();
    assert.ok(/Monument Primary Market/.test(options[0]), options.join(' / '));
    assert.ok(/Between markets/.test(options[1]), options.join(' / '));
    assert.ok(!options.some((o) => /Test Market/.test(o)), 'the past market has no poster');
    assert.strictEqual((await page.textContent('.poster .url')).trim(), site + '?m=M02');
    assert.ok(/Monument Primary School, Pretoria/.test(await page.textContent('.poster .mkt')));
    if (process.env.SF_SHOT) await page.locator('.poster').screenshot({ path: path.join(process.env.SF_SHOT, 'poster-market.png') });
    await page.selectOption('#pfor', 'home');
    assert.strictEqual((await page.textContent('.poster .url')).trim(), site + '?m=home');
    assert.ok(/Order any time/.test(await page.textContent('.poster .mkt')));
    await env.ctx.close();
  });

  await test('a new market gets its own order page and poster straight away', async () => {
    const env = await phone({ hash: '#numbers' });
    const page = env.page;
    await openNewMarket(page);
    await page.fill('#mn', 'Spring Fair'); await page.fill('#md', day(4));
    await page.click('text=Add market');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const id = env.sheets.Markets.rows.find((r) => r[1] === 'Spring Fair')[0];
    await page.evaluate((m) => { SF.ls.set('sf.tab.numbers', 'today'); SFA.pickMarket(m); }, id);
    await page.waitForFunction((m) => SF.state.data.numbers && SF.state.data.numbers.marketId === m, id);
    await page.waitForSelector('#olink');
    assert.strictEqual((await page.textContent('#olink')).trim(), site + '?m=' + id);
    assert.ok(/Taking orders/.test(await page.textContent('.card:has(#olink)')));
    await page.click('text=Poster');
    await page.waitForSelector('.poster .url');
    assert.strictEqual((await page.textContent('.poster .url')).trim(), site + '?m=' + id);
    await env.ctx.close();
  });

  await test("a market's order page takes orders for that market only", async () => {
    const env = await phone({ hash: '#till' });
    addFuture(env.SF, 'M02', 'Monument Primary Market', 2, 'Monument Primary School');
    const page = await customer(env, '?m=M02');
    assert.ok(/Monument Primary Market/.test(await page.textContent('.when')));
    await reserveOne(page);
    assert.ok(/on \w{3} \d+ \w{3}/.test(await page.textContent('.done')), 'tells them which day');
    const row = env.sheets.Orders.rows.find((r) => r[4] === 'Anna Bester');
    assert.strictEqual(row[2], 'M02');
    await env.ctx.close();
  });

  await test('the usual link with a past market offers the open markets instead of a dead end', async () => {
    const env = await phone({ hash: '#till' });
    addFuture(env.SF, 'M02', 'Monument Primary Market', 2);
    const page = await customer(env, '');
    const text = await page.textContent('.card');
    assert.ok(/Pre-orders for Test Market are closed/.test(text), text);
    assert.ok(/Which market are you coming to/.test(text));
    if (process.env.SF_SHOT) await page.screenshot({ path: path.join(process.env.SF_SHOT, 'order-page-choose.png'), fullPage: true });
    const choices = await page.locator('a.mkt b').allTextContents();
    assert.deepStrictEqual(choices, ['Monument Primary Market', 'Between markets']);
    await page.click('a.mkt:has-text("Monument Primary Market")');
    await page.waitForSelector('.stepper');
    assert.ok(page.url().endsWith('?m=M02'));
    await env.ctx.close();
  });

  await test('orders between markets are taken any time and kept apart', async () => {
    const env = await phone({ hash: '#till' });
    const page = await customer(env, '?m=home');
    assert.ok(/Order any time/.test(await page.textContent('.when')));
    assert.ok(/Pay when you collect/.test(await page.textContent('.steps')));
    await reserveOne(page, 'Thabo Nkosi');
    assert.ok(/arrange the collection/.test(await page.textContent('.done')));
    assert.strictEqual(env.sheets.Orders.rows.find((r) => r[4] === 'Thabo Nkosi')[2], 'HOME');
    await env.ctx.close();
  });

  await test('with no market open and between markets off, the page says so plainly', async () => {
    const env = await phone({ hash: '#till' });
    env.SF.set('homeOrders', 'no');
    const page = await customer(env, '');
    assert.ok(/Pre-orders are closed/.test(await page.textContent('.card')));
    assert.strictEqual(await page.locator('a.mkt').count(), 0);
    await env.ctx.close();
  });

  await test('Collect shows the orders for the market this phone is at', async () => {
    const env = await phone({ hash: '#collect', seed: (SF) => SF.set('collectStep', 'yes') });
    addFuture(env.SF, 'M02', 'Monument Primary Market', 2);
    const placed = env.SF.dispatch('placeOrder', { opId: 'x1', market: 'M02', name: 'Marie du Plessis',
      phone: '082 111 2222', consent: true, lines: [{ id: 'P01', qty: 1 }] });
    assert.strictEqual(placed.ok, true, placed.message);
    const page = env.page;
    await page.goto(base + '#till'); await page.goto(base + '#collect');
    await page.waitForSelector('#sellat');
    await page.evaluate(() => { SF.ls.set('sf.tab.collect', 'topay'); SF.render(); });
    assert.ok(!/Marie du Plessis/.test(await page.textContent('#view')), 'not at the live market');
    await page.selectOption('#sellat', 'M02');
    await page.waitForFunction(() => SF.state.data.collect && SF.state.data.collect.marketId === 'M02');
    await page.evaluate(() => SF.render());
    assert.ok(/Marie du Plessis/.test(await page.textContent('#view')));
    await env.ctx.close();
  });

  /* ---------- filters on long lists ---------- */
  // Ten products: 4 jams (one running low, one sold out), 3 dolls (one hidden), 3 resin.
  const shop10 = (SF) => {
    [['P03', 'Strawberry Jam', 'Jams', 3], ['P04', 'Fig Jam', 'Jams', 0], ['P05', 'Guava Jam', 'Jams', 9],
     ['P06', 'Apricot Preserve', 'Jams', 7], ['P07', 'Topsy-turvy doll', 'Dolls', 5],
     ['P08', 'Rag doll', 'Dolls', 6], ['P09', 'Sock monkey', 'Dolls', 2],
     ['P10', 'Resin coaster', 'Resin', 12], ['P11', 'Resin bookmark', 'Resin', 8],
     ['P12', 'Resin keyring', 'Resin', 10]].forEach(([id, name, cat, n], i) => {
      SF.append('products', { ProductId: id, Name: name, Category: cat, Type: 'stocked', Unit: 'each',
                              Price: 50 + i * 10, Active: id === 'P08' ? 'No' : 'Yes', Sort: 30 + i });
      if (n) SF.move(id, n, 'adjust', 'test');
    });
  };
  const openShelf = async (page) => {
    await page.waitForFunction(() => SF.state.data.stock);
    await page.evaluate(() => { SF.ls.set('sf.tab.stock', 'shelf'); SF.render(); });
    await page.waitForSelector('#fq-shelf');
  };
  const cartQty = (page) => page.$$eval('.sheet .qn', (b) => b.map((x) => Number(x.textContent)));
  const openBasket = async (page) => { await page.click('.basketbtn'); await page.waitForSelector('#basketbody'); };
  const shownNames = (page, id) => page.$$eval('[data-frow="' + id + '"]', (rows) =>
    rows.filter((r) => r.style.display !== 'none').map((r) => r.querySelector('b').textContent));

  await test('Stock: the search narrows the list as you type and keeps the keyboard', async () => {
    const env = await phone({ hash: '#stock', seed: shop10 });
    const page = env.page;
    await openShelf(page);
    assert.strictEqual((await shownNames(page, 'shelf')).length, 12);
    await page.click('#fq-shelf'); await page.keyboard.type('resin', { delay: 25 });
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin coaster', 'Resin bookmark', 'Resin keyring']);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'fq-shelf');
    assert.ok(/Showing 3 of 12 products/.test(await page.textContent('#fc-shelf')));
    await page.keyboard.type(' key', { delay: 25 });
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin keyring'], 'every word must match');
    await page.fill('#fq-shelf', 'zzz');
    assert.strictEqual(await page.isVisible('[data-fempty="shelf"]'), true, 'says nothing matches');
    await env.ctx.close();
  });

  await test('Stock: Category, Show and Sort narrow and order the list', async () => {
    const env = await phone({ hash: '#stock', seed: shop10 });
    const page = env.page;
    await openShelf(page);
    await page.selectOption('#ff-shelf-cat', 'Jams');
    assert.strictEqual((await shownNames(page, 'shelf')).length, 4);
    if (process.env.SF_SHOT) {
      await page.locator('.card:has(#fq-shelf)').scrollIntoViewIfNeeded();
      await page.locator('.card:has(#fq-shelf)').screenshot({ path: path.join(process.env.SF_SHOT, 'stock-filters.png') });
    }
    await page.selectOption('#ff-shelf-show', 'out');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Fig Jam']);
    await page.selectOption('#ff-shelf-show', 'low');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Strawberry Jam']);
    await page.selectOption('#ff-shelf-cat', 'all'); await page.selectOption('#ff-shelf-show', 'hidden');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Rag doll']);
    await page.selectOption('#ff-shelf-show', 'all'); await page.selectOption('#ff-shelf-cat', 'Resin');
    await page.selectOption('#ff-shelf-sort', 'left');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin bookmark', 'Resin keyring', 'Resin coaster']);
    await page.selectOption('#ff-shelf-sort', 'name');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin bookmark', 'Resin coaster', 'Resin keyring']);
    await page.click('#fc-shelf button');
    assert.strictEqual((await shownNames(page, 'shelf')).length, 12, 'Show all clears the filters');
    await env.ctx.close();
  });

  await test('Stock: choices are remembered on this phone, the search is not', async () => {
    const env = await phone({ hash: '#stock', seed: shop10 });
    const page = env.page;
    await openShelf(page);
    await page.selectOption('#ff-shelf-cat', 'Dolls');
    await page.fill('#fq-shelf', 'rag');
    await page.goto('about:blank'); await page.goto(base + '#stock');
    await openShelf(page);
    assert.strictEqual(await page.inputValue('#ff-shelf-cat'), 'Dolls');
    assert.strictEqual(await page.inputValue('#fq-shelf'), '');
    assert.strictEqual((await shownNames(page, 'shelf')).length, 3);
    await env.ctx.close();
  });

  await test('Stock: the filter survives a refresh and hiding a product', async () => {
    const env = await phone({ hash: '#stock', seed: shop10 });
    const page = env.page;
    await openShelf(page);
    await page.click('#fq-shelf'); await page.keyboard.type('doll', { delay: 20 });
    await leaveAndReturn(page); await settle(page);
    assert.strictEqual(await page.inputValue('#fq-shelf'), 'doll');
    // "doll" also finds Sock monkey: the search covers the category (Dolls) too.
    const dolls = ['Topsy-turvy doll', 'Rag doll', 'Sock monkey'];
    assert.deepStrictEqual(await shownNames(page, 'shelf'), dolls, 'after coming back');
    await page.click('tr:has-text("Topsy-turvy doll") button:has-text("hide")');
    await settle(page, 600);
    assert.strictEqual(await page.inputValue('#fq-shelf'), 'doll');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), dolls, 'after hiding');
    await env.ctx.close();
  });

  await test('Stock: tapping a column heading sorts by it, then reverses, then goes back', async () => {
    const env = await phone({ hash: '#stock', seed: shop10 });
    const page = env.page;
    await openShelf(page);
    await page.selectOption('#ff-shelf-cat', 'Resin');
    await page.click('th[data-field="price"] button');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin coaster', 'Resin bookmark', 'Resin keyring']);
    assert.strictEqual(await page.getAttribute('th[data-field="price"]', 'aria-sort'), 'ascending');
    assert.strictEqual(await page.inputValue('#ff-shelf-sort'), 'price', 'the Sort dropdown agrees');
    await page.click('th[data-field="price"] button');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin keyring', 'Resin bookmark', 'Resin coaster']);
    assert.strictEqual(await page.getAttribute('th[data-field="price"]', 'aria-sort'), 'descending');
    assert.ok(/▼/.test(await page.textContent('th[data-field="price"]')));
    await page.click('th[data-field="price"] button');
    assert.strictEqual(await page.inputValue('#ff-shelf-sort'), '', 'back to shelf order');
    await page.click('th[data-field="left"] button');
    assert.deepStrictEqual(await shownNames(page, 'shelf'), ['Resin bookmark', 'Resin keyring', 'Resin coaster']);
    await page.goto('about:blank'); await page.goto(base + '#stock'); await openShelf(page);
    assert.strictEqual(await page.getAttribute('th[data-field="left"]', 'aria-sort'), 'ascending', 'remembered');
    await env.ctx.close();
  });

  await test('Till: a sale of ten different things — all added, all visible, all changeable', async () => {
    const env = await phone({ hash: '#till', seed: shop10 });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    const ids = ['P01', 'P02', 'P03', 'P05', 'P06', 'P07', 'P09', 'P10', 'P11', 'P12'];
    for (const id of ids) await page.evaluate((x) => SFT.tap(x), id);
    assert.strictEqual((await page.textContent('.basketbtn .cnt')).trim(), '10');
    if (process.env.SF_SHOT) {
      await page.setViewportSize({ width: 412, height: 860 });
      await page.waitForTimeout(2800);                  // let the "Added" message fade
      await page.screenshot({ path: path.join(process.env.SF_SHOT, 'till-10-bar.png') });
    }
    await openBasket(page);
    if (process.env.SF_SHOT) await page.screenshot({ path: path.join(process.env.SF_SHOT, 'till-10-basket.png') });
    assert.strictEqual(await page.locator('#basketbody .l').count(), 10, 'every line is in the basket');
    // The last line can be reached and changed, however long the list.
    const last = page.locator('#basketbody .l').last();
    await last.scrollIntoViewIfNeeded();
    await last.locator('button[aria-label^="One more"]').click();
    assert.strictEqual((await cartQty(page))[9], 2);
    assert.strictEqual((await page.textContent('.basketbtn .cnt')).trim(), '11');
    await page.click('#basketbody button:has-text("Take payment")');
    await page.click('.sheet button:has-text("Exact")');
    await page.click('#doSale');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const sale = env.sheets.Orders.rows.slice(1).find((r) => r[3] === 'till');
    assert.strictEqual(JSON.parse(sale[6]).length, 10, 'ten lines recorded');
    assert.strictEqual(sale[7], 11);
    await env.ctx.close();
  });

  await test('Till, zoomed in on a small phone: the basket never hides the products', async () => {
    const env = await phone({ hash: '#till', seed: shop10 });
    const page = env.page;
    await page.setViewportSize({ width: 360, height: 640 });
    await page.addStyleTag({ content: 'html{zoom:1.6}' });       // like a phone set to large text
    await page.waitForFunction(() => SF.state.data.till);
    for (const id of ['P01', 'P02', 'P03', 'P05', 'P06', 'P07']) await page.evaluate((x) => SFT.tap(x), id);
    await page.evaluate(() => { SF.ls.set('sf.tillcat', 'Resin'); SF.render(); });
    const bar = await page.$eval('.cart', (c) => c.getBoundingClientRect().height);
    assert.ok(bar < 640 * 0.25, 'the bar is slim: ' + Math.round(bar) + 'px of 640');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const gap = await page.evaluate(() => {
      const tiles = document.querySelectorAll('#tilesbox .tile');
      const lastTile = tiles[tiles.length - 1].getBoundingClientRect();
      return document.querySelector('.cart').getBoundingClientRect().top - lastTile.bottom;
    });
    assert.ok(gap >= 0, 'the last product sits above the basket, not under it (' + Math.round(gap) + 'px)');
    if (process.env.SF_SHOT) await page.screenshot({ path: path.join(process.env.SF_SHOT, 'till-zoomed.png') });
    await openBasket(page);
    if (process.env.SF_SHOT) await page.screenshot({ path: path.join(process.env.SF_SHOT, 'till-basket-open.png') });
    await env.ctx.close();
  });

  /** Wider than the screen? A phone then widens the whole page to fit, and the
   *  bars at the bottom slide off it. Names what sticks out, to fix it. */
  const tooWide = (page) => page.evaluate(() => {
    const W = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
    if (sw <= W + 1) return null;
    const scrolls = (e) => { for (let a = e.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX; if (o !== 'visible') return true; } return false; };
    const out = [];
    document.querySelectorAll('body *').forEach((e) => {
      const b = e.getBoundingClientRect();
      if (out.length < 4 && b.width && b.right > W + 1 && !scrolls(e) &&
          getComputedStyle(e).position !== 'fixed' && !e.closest('.cart,.tabs,#toast'))
        out.push(e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
    });
    return sw + 'px on a ' + W + 'px screen: ' + out.join(', ');
  });

  await test('Every screen fits a small phone, even with large text', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      shop10(SF);
      SF.append('markets', { MarketId: 'M02', Name: 'Spring Fair', Date: day(3), Status: 'planned' });
      SF.set('activeMarket', 'M02');
      // A long name with no spaces in it, the hardest thing to fit.
      SF.append('pantry', { Item: 'Strawberries-frozen-from-the-farm-5kg', Qty: 2, Unit: 'kg', Note: '', UpdatedAt: new Date(), UpdatedBy: 'x' });
    } });
    const page = env.page;
    await page.evaluate(() => { SFT.tap('P01'); SFT.tap('P02'); });
    const screens = [
      ['till', 'till', 'sell'], ['till', 'till', 'topay'],
      ['stock', 'stock', 'cook'], ['stock', 'stock', 'shelf'], ['stock', 'stock', 'cupboard'],
      ['stock', 'stock', 'count'], ['stock', 'stock', 'history'],
      ['numbers', 'numbers', 'today'], ['numbers', 'numbers', 'costs'],
      ['numbers', 'numbers', 'all'], ['numbers', 'numbers', 'new'],
      ['labels'], ['stocktake'], ['settings'], ['people'], ['health'], ['report']];
    const wide = [];
    // The smallest phones in use (320 wide, the first iPhone SE) at normal text,
    // and an ordinary small phone (360) with large text.
    for (const [width, zoom] of [[320, '1'], [360, '1.6']]) {
      await page.setViewportSize({ width: width, height: 640 });
      await page.evaluate((z) => { document.documentElement.style.zoom = z; }, zoom);
      for (const [hash, tab, on] of screens) {
        await page.evaluate(([h, t, o]) => {
          if (t) SF.ls.set('sf.tab.' + t, o);
          if (location.hash !== '#' + h) location.hash = h; else SF.render();
        }, [hash, tab, on]);
        await page.waitForTimeout(500);
        const w = await tooWide(page);
        if (w) wide.push(hash + (on ? ' › ' + on : '') + ' at ' + width + 'px ' + zoom + '×: ' + w);
      }
      await page.evaluate(() => { location.hash = 'till'; });
      await page.waitForTimeout(500);
      await page.click('.basketbtn');
      await page.waitForSelector('#basketbody');
      const w = await tooWide(page);
      if (w) wide.push('basket at ' + width + 'px ' + zoom + '×: ' + w);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const s = document.querySelector('.sheetbg,.sheet'); if (s && SF.closeSheet) SF.closeSheet(); });
    }
    const shop = await customer(env, '?m=M02');
    for (const [width, zoom] of [[320, '1'], [360, '1.6']]) {
      await shop.setViewportSize({ width: width, height: 640 });
      await shop.evaluate((z) => { document.documentElement.style.zoom = z; }, zoom);
      await shop.waitForTimeout(300);
      const w = await tooWide(shop);
      if (w) wide.push('order page at ' + width + 'px ' + zoom + '×: ' + w);
    }
    assert.deepStrictEqual(wide, [], 'screens wider than the phone:\n  ' + wide.join('\n  '));
    await env.ctx.close();
  });

  await test('the order page says why + stops at the stock limit', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      shop10(SF);
      SF.append('markets', { MarketId: 'M02', Name: 'Spring Fair', Date: day(3), Status: 'planned' });
      SF.set('activeMarket', 'M02');
    } });
    const page = await customer(env, '?m=M02');
    const plus = page.locator('.item:has-text("Strawberry Jam") button[aria-label^="More"]');
    for (let i = 0; i < 4; i++) await plus.click();
    assert.strictEqual((await page.textContent('.item:has-text("Strawberry Jam") .q')).trim(), '3');
    assert.ok(/Only 3 of Strawberry Jam left/.test(await page.textContent('#toast')));
    await env.ctx.close();
  });

  await test('a short list has no filter bar', async () => {
    const env = await phone({ hash: '#stock' });
    await openShelf(env.page).catch(() => {});
    assert.strictEqual(await env.page.locator('.fbar').count(), 0);
    await env.ctx.close();
  });

  await test('QR labels: Tick none only touches the products you filtered to', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#fq-labels');
    await page.selectOption('#ff-labels-cat', 'Dolls');
    await page.click('text=Tick none');
    assert.strictEqual(await page.isChecked('#c-P07'), false);
    assert.strictEqual(await page.isChecked('#c-P03'), true, 'a jam, not shown, stays ticked');
    await page.emulateMedia({ media: 'print' });
    assert.strictEqual(await page.isVisible('.fbar'), false, 'the filter never prints');
    await env.ctx.close();
  });

  await test('Collect: find a customer by name or order number', async () => {
    const placed = {};
    const env = await phone({ hash: '#collect', seed: (SF) => {
      SF.set('collectStep', 'yes');
      ['Anna Bester', 'Marie du Plessis', 'Thabo Nkosi', 'Pieter Smit', 'Lerato Dube', 'Johan Venter', 'Zanele Mokoena']
        .forEach((n, i) => {
          const r = SF.dispatch('placeOrder', { opId: 'q' + i, name: n, phone: '082 000 00' + (10 + i),
            consent: true, lines: [{ id: 'P01', qty: 1 }], market: 'home' });
          if (!r.ok) throw new Error(r.message);
          placed[n] = r.orderNo;
        });
    } });
    const page = env.page;
    await page.evaluate(() => { SF.ls.set('sf.sellAt', 'home'); SF.ls.set('sf.tab.collect', 'topay'); });
    await page.goto('about:blank'); await page.goto(base + '#collect');
    await page.waitForSelector('#fq-collect');
    await page.fill('#fq-collect', 'marie');
    assert.deepStrictEqual(await shownNames(page, 'collect'), ['Marie du Plessis']);
    await page.fill('#fq-collect', placed['Thabo Nkosi']);
    assert.deepStrictEqual(await shownNames(page, 'collect'), ['Thabo Nkosi'], 'by order number ' + placed['Thabo Nkosi']);
    await page.fill('#fq-collect', 'zzz');
    assert.strictEqual(await page.isVisible('[data-fempty="collect"]'), true);
    await env.ctx.close();
  });

  await test('All markets: Show Coming up and sort by profit', async () => {
    const env = await phone({ hash: '#numbers', seed: (SF) => {
      [['M02', 'Spring Fair', 5], ['M03', 'Winter Fair', -40], ['M04', 'Craft Night', 12], ['M05', 'Easter Market', -200],
       ['M06', 'School Fete', 2]].forEach(([id, name, n]) =>
        SF.append('markets', { MarketId: id, Name: name, Date: day(n), Status: 'planned' }));
    } });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.numbers);
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'all'); SF.render(); });
    await page.waitForSelector('#fq-markets');
    await page.selectOption('#ff-markets-when', 'upcoming');
    assert.deepStrictEqual((await shownNames(page, 'markets')).sort(), ['Craft Night', 'School Fete', 'Spring Fair']);
    await page.selectOption('#ff-markets-when', 'past');
    assert.deepStrictEqual((await shownNames(page, 'markets')).sort(), ['Easter Market', 'Test Market', 'Winter Fair']);
    await page.selectOption('#ff-markets-sort', 'date');
    assert.deepStrictEqual(await shownNames(page, 'markets'), ['Easter Market', 'Winter Fair', 'Test Market']);
    await env.ctx.close();
  });

  /* ---------- the till: how many of each ---------- */


  await test('Till: − and + change how many, and − at one takes it off', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => SFT.tap('P01'));
    await page.waitForSelector('.basketbtn');
    await openBasket(page);
    await page.click('button[aria-label="One more Apricot Jam"]');
    await page.click('button[aria-label="One more Apricot Jam"]');
    assert.deepStrictEqual(await cartQty(page), [3]);
    assert.ok(/R 210\.00/.test(await page.textContent('.sheet .tot')), await page.textContent('.sheet .tot'));
    assert.ok(/R 210\.00/.test(await page.textContent('.cart .takebtn')), 'the bar keeps up');
    await page.click('button[aria-label="One less Apricot Jam"]');
    assert.deepStrictEqual(await cartQty(page), [2]);
    await page.click('button[aria-label="One less Apricot Jam"]');
    assert.deepStrictEqual(await cartQty(page), [1]);
    await page.click('button[aria-label="Remove Apricot Jam"]');
    assert.strictEqual(await page.locator('.cart').count(), 0, 'the line is gone');
    assert.strictEqual(await page.locator('.sheet').count(), 0, 'an empty basket closes');
    await env.ctx.close();
  });

  await test('Till: tap the number to type how many, never more than is left', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => SFT.tap('P01'));
    await openBasket(page);
    await page.click('button[aria-label="How many Apricot Jam"]');
    await page.waitForSelector('#hq');
    await page.fill('#hq', '6'); await page.keyboard.press('Enter');
    await page.waitForSelector('#basketbody');
    assert.deepStrictEqual(await cartQty(page), [6], 'back in the basket with the new amount');
    await page.click('button[aria-label="How many Apricot Jam"]');
    await page.click('.sheet button:has-text("12")');
    assert.deepStrictEqual(await cartQty(page), [10], 'only 10 in stock, so it stops at 10');
    assert.ok(/Only 10/.test(await page.textContent('#toast')));
    await page.click('button[aria-label="One more Apricot Jam"]');
    assert.deepStrictEqual(await cartQty(page), [10]);
    await env.ctx.close();
  });

  await test('Till: the sale is recorded with the amount chosen', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { SFT.tap('P01'); SFT.tap('P02'); });
    await openBasket(page);
    await page.click('button[aria-label="How many Apricot Jam"]');
    await page.fill('#hq', '3'); await page.click('.sheet button:has-text("Done")');
    await page.click('#basketbody button:has-text("Take payment")');
    await page.click('.sheet button:has-text("Exact")');
    await page.click('#doSale');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const sale = env.sheets.Orders.rows.slice(1).find((r) => r[3] === 'till');
    assert.strictEqual(sale[7], 4, 'three jam and one marmalade: ' + sale[6]);
    assert.strictEqual(sale[8], 280);
    await env.ctx.close();
  });

  /* ---------- pre-orders at the till, Collect off, more filters, label files ---------- */
  const withPreorder = (SF) => {
    SF.append('markets', { MarketId: 'M02', Name: 'Monument Primary Market', Date: day(2), Status: 'planned' });
    SF.set('activeMarket', 'M02');
    const r = SF.dispatch('placeOrder', { opId: 'v1', market: 'M02', name: 'Viv Pieters', phone: '082 444 5555',
      consent: true, note: 'Collecting after 11', lines: [{ id: 'P01', qty: 1 }, { id: 'P02', qty: 1 }] });
    if (!r.ok) throw new Error(r.message);
  };
  const openToPay = async (page) => {
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { SF.ls.set('sf.tab.till', 'topay'); SF.render(); });
    await page.waitForSelector('.porder');
  };

  await test('Still to pay shows the market, what was ordered and the note', async () => {
    const env = await phone({ hash: '#till', seed: withPreorder });
    const page = env.page;
    await openToPay(page);
    assert.ok(/for Monument Primary Market/.test(await page.textContent('h2:has-text("still to pay")')));
    const items = await page.locator('.porder .items li').allTextContents();
    assert.strictEqual(items.length, 2);
    assert.ok(/1 ×\s*Apricot Jam/.test(items[0]) && /1 ×\s*Marmalade/.test(items[1]), items.join(' | '));
    assert.ok(/Collecting after 11/.test(await page.textContent('.porder .note')));
    assert.strictEqual(await page.isVisible('#sellat'), true, 'the market can be changed here too');
    await env.ctx.close();
  });

  await test('paying a pre-order with R200 shows R60 change and hands it over', async () => {
    const env = await phone({ hash: '#till', seed: withPreorder });
    const page = env.page;
    await openToPay(page);
    await page.click('.porder button:has-text("Take payment")');
    await page.waitForSelector('#got');
    assert.ok(/Viv Pieters/.test(await page.textContent('.sheet h2')));
    assert.strictEqual(await page.isDisabled('#doSale'), true, 'nothing received yet');
    await page.click('.sheet button:has-text("R200")');
    assert.ok(/Change to give/.test(await page.textContent('#changeBox')));
    assert.ok(/R 60\.00/.test(await page.textContent('#changeAmt')));
    await page.fill('#got', '150'); await page.dispatchEvent('#got', 'input');
    assert.ok(/R 10\.00/.test(await page.textContent('#changeAmt')), 'a typed amount works too');
    await page.fill('#got', '200'); await page.dispatchEvent('#got', 'input');
    await page.click('#doSale');
    await page.waitForSelector('.give');
    assert.ok(/R 60\.00/.test(await page.textContent('.give')));
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const row = env.sheets.Orders.rows.find((r) => r[4] === 'Viv Pieters');
    assert.strictEqual(row[10], 'collected', 'paid at the table is handed over');
    await env.ctx.close();
  });

  await test('Collect is hidden unless the stall switches it on in Settings', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    assert.strictEqual(await page.locator('#tabs a[href="#collect"]').count(), 0);
    await page.goto(base + '#collect'); await settle(page, 500);
    assert.ok(page.url().endsWith('#till'), 'an old Collect link goes to the till: ' + page.url());
    await page.goto(base + '#settings');
    await page.click('button:has-text("Switch on")');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    await page.waitForSelector('#tabs a[href="#collect"]');
    assert.strictEqual(env.SF.get('collectStep'), 'yes');
    await env.ctx.close();
  });

  await test('More shows the app version and can check for an update', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.evaluate(() => SF.openMore());
    assert.ok(/App version test/.test(await page.textContent('.sheet')), await page.textContent('.sheet .foot'));
    assert.strictEqual(await page.locator('.sheet button:has-text("Check for update")').count(), 1);
    assert.strictEqual(await page.locator('.sheet button:has-text("Fix a stuck update")').count(), 1);
    await env.ctx.close();
  });

  await test('Till: searching products skips straight to the ones you want', async () => {
    const env = await phone({ hash: '#till', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#tq');
    await page.click('#tq'); await page.keyboard.type('resin', { delay: 20 });
    const names = await page.$$eval('#tilesbox .tile .nm', (t) => t.map((x) => x.textContent.trim()));
    assert.strictEqual(names.length, 3, names.join(' | '));
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'tq', 'the keyboard stays up');
    await page.click('#tilesbox .tile:has-text("Resin coaster")');
    assert.strictEqual((await page.textContent('.basketbtn .cnt')).trim(), '1');
    assert.ok(/1 in basket/.test(await page.textContent('#tilesbox .tile:has-text("Resin coaster")')));
    assert.strictEqual(await page.inputValue('#tq'), 'resin', 'the search stays for the next one');
    await page.fill('#tq', 'zzz'); await page.dispatchEvent('#tq', 'input');
    assert.ok(/Nothing called/.test(await page.textContent('#tilesbox')));
    await env.ctx.close();
  });

  await test('Still to pay and Costs can be searched once they are long', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      withPreorder(SF);
      ['Anna', 'Ben', 'Cara', 'Dirk', 'Elsa', 'Fanie'].forEach((n, i) => SF.dispatch('placeOrder', { opId: 'w' + i,
        market: 'M02', name: n + ' Test', phone: '083 111 22' + (10 + i), consent: true, lines: [{ id: 'P02', qty: 1 }] }));
      [['Stall fee', 250, 'Stall'], ['Petrol', 180, 'Travel'], ['Gazebo pegs', 60, 'Setup'], ['Bags', 90, 'Packaging'],
       ['Flyers', 120, 'Marketing'], ['Toll', 45, 'Travel']].forEach(([d, a, c], i) =>
        SF.append('expenses', { ExpenseId: 'X' + i, MarketId: 'M02', Description: d, Amount: a, Category: c, When: new Date() }));
    } });
    const page = env.page;
    await openToPay(page);
    await page.fill('#fq-topay', 'viv'); await page.dispatchEvent('#fq-topay', 'input');
    assert.deepStrictEqual(await shownNames(page, 'topay'), ['Viv Pieters']);
    await page.goto(base + '#numbers');
    await page.waitForFunction(() => SF.state.data.numbers);
    await page.evaluate(() => { SF.ls.set('sf.tab.numbers', 'costs'); SF.render(); });
    await page.waitForSelector('#ff-costs-type');
    await page.selectOption('#ff-costs-type', 'Travel');
    assert.deepStrictEqual((await shownNames(page, 'costs')).sort(), ['Petrol', 'Toll']);
    await page.selectOption('#ff-costs-type', 'all'); await page.selectOption('#ff-costs-sort', '-amount');
    assert.strictEqual((await shownNames(page, 'costs'))[0], 'Stall fee');
    await env.ctx.close();
  });

  await test('the order page has a search and category chips once there is a lot to choose from', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      shop10(SF);
      SF.append('markets', { MarketId: 'M02', Name: 'Spring Fair', Date: day(3), Status: 'planned' });
      SF.set('activeMarket', 'M02');
    } });
    const page = await customer(env, '?m=M02');
    await page.waitForSelector('#find');
    const visible = () => page.$$eval('.item', (it) => it.filter((x) => x.offsetParent).map((x) => x.querySelector('.nm').textContent.trim()));
    await page.click('.chip:has-text("Dolls")');
    assert.deepStrictEqual((await visible()).sort(), ['Sock monkey', 'Topsy-turvy doll'], 'hidden products never show');
    await page.click('.chip:has-text("All")');
    await page.fill('#find', 'jam'); await page.dispatchEvent('#find', 'input');
    // "jam" finds the jams by name and Apricot Preserve by its category, Jams.
    const jams = ['Apricot Jam', 'Apricot Preserve', 'Fig Jam', 'Guava Jam', 'Strawberry Jam'];
    assert.deepStrictEqual((await visible()).sort(), jams);
    await page.click('.item:has-text("Guava Jam") button[aria-label^="More"]');
    assert.strictEqual(await page.inputValue('#find'), 'jam', 'adding something keeps the search');
    assert.deepStrictEqual((await visible()).sort(), jams);
    await page.fill('#find', 'zzz'); await page.dispatchEvent('#find', 'input');
    assert.strictEqual(await page.isVisible('#nofind'), true);
    await env.ctx.close();
  });

  const pngInfo = (buf) => {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const at = buf.indexOf(Buffer.from('pHYs'));
    return { w, h, ppm: at > 0 ? buf.readUInt32BE(at + 4) : 0, sig: buf.slice(1, 4).toString() };
  };

  await test('a label downloads as a 300 dpi picture at the chosen size', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    await page.selectOption('#lsize', '50x30');
    assert.ok(/50 × 30 mm · 300 dpi/.test(await page.textContent('#lprevcap')));
    const [dl] = await Promise.all([page.waitForEvent('download'),
      page.click('button[aria-label="Download the label for Apricot Jam"]')]);
    assert.strictEqual(dl.suggestedFilename(), 'P01-apricot-jam-50x30.png');
    const info = pngInfo(fs.readFileSync(await dl.path()));
    assert.deepStrictEqual(info, { w: 591, h: 354, ppm: 11811, sig: 'PNG' });
    await page.selectOption('#lsize', '62x29');
    const [dl2] = await Promise.all([page.waitForEvent('download'),
      page.click('button[aria-label="Download the label for Apricot Jam"]')]);
    const info2 = pngInfo(fs.readFileSync(await dl2.path()));
    assert.strictEqual(info2.w + 'x' + info2.h, '732x343', 'Brother 62 × 29 mm at 300 dpi');
    if (process.env.SF_SHOT) fs.copyFileSync(await dl.path(), path.join(process.env.SF_SHOT, 'label-50x30.png'));
    await env.ctx.close();
  });

  /** Read a downloaded label's QR back with the app's own scanner library. */
  const readQR = async (page, file) => {
    await page.addScriptTag({ path: path.join(ROOT, 'web', 'core', 'vendor', 'jsQR.js') });
    return page.evaluate(async (b64) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
      const k = 4, c = document.createElement('canvas'); c.width = im.width * k; c.height = im.height * k;
      const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(im, 0, 0, c.width, c.height);
      const r = window.jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      return r && r.data;
    }, fs.readFileSync(file).toString('base64'));
  };

  await test('Niimbot: labels come out at the printer\'s own 203 dpi, with the steps shown', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    assert.strictEqual(await page.inputValue('#lsize'), 'nb-50x30', 'Niimbot 50 × 30 is the starting size');
    assert.ok(/203 dpi/.test(await page.textContent('#lprevcap')));
    assert.strictEqual(await page.isVisible('#lsteps'), true);
    assert.ok(/NIIMBOT/.test(await page.textContent('#lsteps')));
    const [dl] = await Promise.all([page.waitForEvent('download'),
      page.click('button[aria-label="Download the label for Apricot Jam"]')]);
    assert.strictEqual(dl.suggestedFilename(), 'P01-apricot-jam-niimbot-50x30.png');
    const file = await dl.path();
    assert.deepStrictEqual(pngInfo(fs.readFileSync(file)), { w: 400, h: 240, ppm: 7992, sig: 'PNG' });
    assert.strictEqual(await readQR(page, file), site + '?p=P01', 'the QR is a link to the product, and it scans');
    if (process.env.SF_SHOT) fs.copyFileSync(file, path.join(process.env.SF_SHOT, 'label-niimbot-50x30.png'));
    await page.selectOption('#lsize', '62x29');
    assert.strictEqual(await page.isVisible('#lsteps'), false, 'Niimbot steps only for Niimbot sizes');
    await env.ctx.close();
  });

  await test('Niimbot 60 × 40 and 70 × 50: right size, and the QR link scans', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    for (const [key, w, h] of [['nb-60x40', 480, 320], ['nb-70x50', 559, 400]]) {
      await page.selectOption('#lsize', key);
      const [dl] = await Promise.all([page.waitForEvent('download'),
        page.click('button[aria-label="Download the label for Guava Jam"]')]);
      const file = await dl.path(), info = pngInfo(fs.readFileSync(file));
      assert.strictEqual(info.w + 'x' + info.h, w + 'x' + h, key);
      assert.strictEqual(info.ppm, 7992, key + ' at 203 dpi');
      assert.strictEqual(await readQR(page, file), site + '?p=P05', key);
      if (process.env.SF_SHOT) fs.copyFileSync(file, path.join(process.env.SF_SHOT, 'label-' + key + '.png'));
    }
    await env.ctx.close();
  });

  await test('Niimbot D11 strip: a 40 × 12 mm label still carries a QR that scans', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    await page.selectOption('#lsize', 'nd-40x12');
    const [dl] = await Promise.all([page.waitForEvent('download'),
      page.click('button[aria-label="Download the label for Topsy-turvy doll"]')]);
    assert.strictEqual(dl.suggestedFilename(), 'P07-topsy-turvy-doll-niimbot-40x12.png');
    const file = await dl.path();
    const info = pngInfo(fs.readFileSync(file));
    assert.strictEqual(info.w + 'x' + info.h, '320x96');
    assert.strictEqual(await readQR(page, file), 'SF:P07', 'a thin strip keeps the short code, which scans at that size');
    if (process.env.SF_SHOT) fs.copyFileSync(file, path.join(process.env.SF_SHOT, 'label-niimbot-40x12.png'));
    await env.ctx.close();
  });

  await test('the label look: contact lines and a logo, tried in the preview, then saved', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    await page.click('.lookedit summary');
    await page.fill('#lkcontact', 'Marian\nMobile 066 000 0000');
    await page.dispatchEvent('#lkcontact', 'input');
    // A logo: a dark ring on a light background, as a phone photo of a drawing would be.
    const logo = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 260;
      const x = c.getContext('2d'); x.fillStyle = '#f4efe6'; x.fillRect(0, 0, 300, 260);
      x.strokeStyle = '#222'; x.lineWidth = 14; x.beginPath(); x.arc(150, 130, 80, 0, 7); x.stroke();
      return c.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await page.setInputFiles('#lkfile', { name: 'logo.png', mimeType: 'image/png', buffer: logo });
    await page.waitForSelector('#lklogo');
    const cleaned = await page.getAttribute('#lklogo', 'src');
    assert.ok(/^data:image\/png;base64,/.test(cleaned) && cleaned.length < 58000, 'a small black-and-white PNG');
    await page.click('button:has-text("Save the look")');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    assert.strictEqual(env.SF.get('labelContact'), 'Marian\nMobile 066 000 0000');
    assert.strictEqual(env.SF.get('labelLogo'), cleaned);
    await page.selectOption('#lsize', 'nb-50x30');
    const [dl] = await Promise.all([page.waitForEvent('download'),
      page.click('button[aria-label="Download the label for Strawberry Jam"]')]);
    const file = await dl.path();
    assert.strictEqual(await readQR(page, file), site + '?p=P03');
    if (process.env.SF_SHOT) {
      fs.copyFileSync(file, path.join(process.env.SF_SHOT, 'label-classic-niimbot-50x30.png'));
      await page.selectOption('#lsize', '50x30');
      const [d2] = await Promise.all([page.waitForEvent('download'),
        page.click('button[aria-label="Download the label for Apricot Preserve"]')]);
      fs.copyFileSync(await d2.path(), path.join(process.env.SF_SHOT, 'label-classic-300dpi.png'));
    }
    await env.ctx.close();
  });

  await test('a cashier sees the labels but not the look editor', async () => {
    const env = await phone({ hash: '#labels', seed: (SF) => { shop10(SF); SF.setPin('cashier', '1111'); } });
    const page = env.page;
    const tok = env.SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
    await page.evaluate((t) => SF.ls.set('sf.auth', { token: t, role: 'cashier', user: '' }), tok);
    await page.goto('about:blank'); await page.goto(base + '#labels');
    await page.waitForSelector('#lsize');
    assert.strictEqual(await page.locator('.lookedit').count(), 0);
    await env.ctx.close();
  });

  await test('a customer scanning a jar lands on that product, even via the market list', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      shop10(SF);
      SF.append('markets', { MarketId: 'M02', Name: 'Spring Fair', Date: day(3), Status: 'planned' });
    } });
    const page = await customer(env, '?p=P03');           // the live market has passed: the list comes first
    assert.ok(/Which market are you coming to/.test(await page.textContent('.card')));
    await page.click('a.mkt:has-text("Spring Fair")');
    await page.waitForSelector('#it-P03');
    assert.ok(page.url().endsWith('?m=M02&p=P03'), page.url());
    assert.ok(await page.$eval('#it-P03', (e) => e.classList.contains('hl')), 'highlighted');
    await page.waitForFunction(() => /You scanned Strawberry Jam/.test(document.getElementById('toast').textContent));
    await env.ctx.close();
  });

  await test('Send to printer app: when an iPhone refuses the late share sheet, the next tap sends', async () => {
    const env = await phone({ hash: '#labels', seed: shop10, init: () => {
      // Like Safari on an iPhone: the share sheet is refused once the tap is too long ago.
      window.__shared = [];
      navigator.canShare = () => true;
      navigator.share = (data) => {
        if (!window.__refused) {
          window.__refused = true;
          return Promise.reject(new DOMException('not from a tap', 'NotAllowedError'));
        }
        window.__shared.push(data.files.map((f) => f.name + ':' + f.type + ':' + (f.size > 100)));
        return Promise.resolve();
      };
    } });
    const page = env.page;
    await page.waitForSelector('#sharebtn');
    await page.click('text=Tick none');
    for (const id of ['P03', 'P05']) await page.check('#c-' + id);
    await page.click('#sharebtn');
    await page.waitForFunction(() => /ready/.test(document.getElementById('sharebtn').textContent));
    assert.ok(/Tap Send again/.test(await page.textContent('#toast')));
    await page.click('#sharebtn');
    await page.waitForFunction(() => window.__shared.length === 1);
    const sent = await page.evaluate(() => window.__shared[0]);
    assert.deepStrictEqual(sent.map((s) => s.split(':')[1] + ':' + s.split(':')[2]),
      ['image/png:true', 'image/png:true']);
    assert.ok(/^P03-/.test(sent[0]) && /^P05-/.test(sent[1]), sent.join(' '));
    assert.strictEqual(await page.textContent('#sharebtn'), 'Send to printer app');
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await test('the ticked labels download together as one .zip', async () => {
    const env = await phone({ hash: '#labels', seed: shop10 });
    const page = env.page;
    await page.waitForSelector('#lsize');
    await page.selectOption('#ff-labels-cat', 'Resin');
    await page.click('text=Tick none'); await page.selectOption('#ff-labels-cat', 'all');
    await page.click('text=Tick none');
    await page.selectOption('#lsize', '50x30');
    for (const id of ['P03', 'P05', 'P07']) await page.check('#c-' + id);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download ticked (.zip)')]);
    assert.ok(/-labels-50x30\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const zip = fs.readFileSync(await dl.path());
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.strictEqual(zip.readUInt16LE(end + 10), 3, 'three labels in the zip');
    const names = [];
    for (let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at > 0 && at < end;
         at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
      const n = zip.readUInt16LE(at + 28); names.push(zip.slice(at + 46, at + 46 + n).toString());
    }
    assert.deepStrictEqual(names.sort(), ['P03-strawberry-jam-50x30.png', 'P05-guava-jam-50x30.png',
                                          'P07-topsy-turvy-doll-50x30.png']);
    const first = zip.readUInt16LE(26), data = zip.slice(30 + first, 30 + first + zip.readUInt32LE(18));
    assert.strictEqual(pngInfo(data).w, 591, 'the files inside are the labels');
    await env.ctx.close();
  });

  /* ---------- scanning on a phone without BarcodeDetector, like every iPhone ---------- */
  // A fake back camera that films whatever QR code window.__fakeText holds.
  const iphoneCamera = () => {
    delete window.BarcodeDetector;
    window.__fakeText = 'SF:P01';
    if (!navigator.mediaDevices) return;                 // a blank page has no camera to fake
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__denyCamera) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const x = c.getContext('2d');
      const paint = () => {
        x.fillStyle = '#fff'; x.fillRect(0, 0, 640, 480);
        if (!window.__fakeText) return;                 // between jars: nothing in view
        const q = window.QR.make(window.__fakeText, 'M'), cell = Math.floor(300 / (q.size + 4));
        x.fillStyle = '#000';
        for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++)
          if (q.modules[r][k]) x.fillRect(170 + (k + 2) * cell, 90 + (r + 2) * cell, cell, cell);
      };
      paint(); setInterval(paint, 100);
      return c.captureStream(10);
    };
  };

  await test('Scan works with no BarcodeDetector, as on an iPhone', async () => {
    const env = await phone({ hash: '#till', init: iphoneCamera });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    assert.strictEqual(await page.evaluate(() => 'BarcodeDetector' in window), false);
    await page.click('button:has-text("Scan")');
    await page.waitForFunction(() => document.querySelector('.basketbtn .cnt'), null, { timeout: 10000 });
    assert.strictEqual((await page.textContent('.basketbtn .cnt')).trim(), '1');
    assert.strictEqual(await page.isVisible('#scan'), false, 'the camera closes after a hit');
    assert.strictEqual(await page.evaluate(() => typeof window.jsQR), 'function', 'the built-in reader was used');
    await env.ctx.close();
  });

  await test('Scan says so when the code is not a product label, then keeps looking', async () => {
    const env = await phone({ hash: '#till', init: iphoneCamera });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { window.__fakeText = 'https://stallflow.github.io/Stallflow/duxies/'; });
    await page.click('button:has-text("Scan")');
    await page.waitForFunction(() => /not a product label/.test((document.getElementById('scanhint') || {}).textContent || ''),
                               null, { timeout: 10000 });
    assert.strictEqual(await page.locator('.basketbtn').count(), 0, 'nothing added');
    await page.evaluate(() => { window.__fakeText = 'SF:P02'; });
    await page.waitForFunction(() => document.querySelector('.basketbtn .cnt'), null, { timeout: 10000 });
    await openBasket(page);
    assert.ok(/Marmalade/.test(await page.textContent('#basketbody')));
    await env.ctx.close();
  });

  await test('Scan with the camera blocked says how to allow it on an iPhone', async () => {
    const env = await phone({ hash: '#till', init: iphoneCamera });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { window.__denyCamera = true; });
    await page.click('button:has-text("Scan")');
    await page.waitForFunction(() => /Settings › Safari › Camera/.test(document.getElementById('toast').textContent));
    await env.ctx.close();
  });

  await test('Scan reads the product link on a jar label too', async () => {
    const env = await phone({ hash: '#till', seed: shop10, init: iphoneCamera });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { window.__fakeText = SF.site + '?p=P03'; });
    await page.click('button:has-text("Scan")');
    await page.waitForFunction(() => document.querySelector('.basketbtn .cnt'), null, { timeout: 10000 });
    await openBasket(page);
    assert.ok(/Strawberry Jam/.test(await page.textContent('#basketbody')));
    await env.ctx.close();
  });

  /* ---------- the order goes to Marian on WhatsApp ---------- */
  await test('after ordering, the customer can send the whole order to Marian on WhatsApp', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      shop10(SF);
      SF.append('markets', { MarketId: 'M02', Name: 'Spring Fair', Date: day(3), Status: 'planned' });
      SF.set('profile', JSON.stringify({ name: "Duxie's Homemade", ownerName: 'Marian', whatsapp: '066 000 0000' }));
    } });
    const page = await customer(env, '?m=M02');
    await page.click('.item:has-text("Strawberry Jam") button[aria-label^="More"]');
    await page.click('.item:has-text("Strawberry Jam") button[aria-label^="More"]');
    await page.fill('#nm', 'Anna Bester'); await page.fill('#ph', '082 555 0101');
    await page.fill('#nt', 'After 11 please');
    await page.check('#cs'); await page.click('#go');
    await page.waitForSelector('#sendwa');
    assert.ok(/Send my order to Marian on WhatsApp/.test(await page.textContent('#sendwa')));
    const href = await page.getAttribute('#sendwa', 'href');
    assert.ok(href.startsWith('https://wa.me/27660000000?text='), href.slice(0, 50));
    const text = decodeURIComponent(href.split('text=')[1]);
    const no = env.sheets.Orders.rows.find((r) => r[4] === 'Anna Bester')[0];
    for (const want of ['Hi Marian', 'Order ' + no, 'Anna Bester', 'Spring Fair', '2 × Strawberry Jam',
                        'Total: R 100.00', 'Note: After 11 please', 'banking details']) {
      assert.ok(text.indexOf(want) !== -1, 'message has "' + want + '":\n' + text);
    }
    await env.ctx.close();
  });

  /* ---------- stocktake ---------- */
  const show = (page, code) => page.evaluate((c) => { window.__fakeText = c; }, code);

  await test('stocktake: start, count a location by scanning jar by jar, approve, and the stock follows', async () => {
    const env = await phone({ hash: '#stock', seed: shop10, init: iphoneCamera });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.stock);
    await page.evaluate(() => { SF.ls.set('sf.tab.stock', 'count'); SF.render(); });
    await page.waitForTimeout(1500);
    if (process.env.SF_DEBUG) console.log('DEBUG countbox:', await page.evaluate(() => (document.getElementById('countbox') || {}).innerHTML || document.getElementById('view').innerHTML.slice(0, 400)), JSON.stringify(env.pageErrors || []));
    await page.waitForSelector('#ctstart');
    await page.click('#ctstart');
    await page.waitForSelector('button[data-loc="Storeroom"]');
    await page.click('button[data-loc="Storeroom"]');
    await page.waitForSelector('#ctdone');
    // Scan: Apricot Jam, away, Apricot Jam again (a second jar), away, Marmalade.
    await show(page, ''); await page.click('button:has-text("Scan jars")');
    await page.waitForSelector('#sfcam');
    await show(page, 'SF:P01'); await page.waitForFunction(() => /Apricot Jam · 1/.test(document.getElementById('scanhint').textContent));
    await page.waitForTimeout(700);
    const stillOne = await page.evaluate(() => document.getElementById('scanhint').textContent);
    assert.ok(/Apricot Jam · 1/.test(stillOne), 'the same jar left in view counts once: ' + stillOne);
    await show(page, ''); await page.waitForTimeout(700);
    await show(page, site + '?p=P01'); await page.waitForFunction(() => /Apricot Jam · 2/.test(document.getElementById('scanhint').textContent));
    await show(page, ''); await page.waitForTimeout(700);
    await show(page, 'SF:P02'); await page.waitForFunction(() => /Marmalade · 1/.test(document.getElementById('scanhint').textContent));
    await page.click('#scan .x');
    // Type a number for one more product.
    await page.click('button[aria-label="How many Strawberry Jam"]');
    await page.fill('#ctq', '2'); await page.keyboard.press('Enter');
    assert.ok(/^5/.test((await page.textContent('#cttotal')).trim()), 'five counted here');
    await page.click('#ctdone');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    await page.waitForSelector('#ctapprove');
    const row = async (name) => page.$eval('tr:has-text("' + name + '")', (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()));
    assert.deepStrictEqual((await row('Apricot Jam')).slice(1, 4), ['10', '2', '-8']);
    assert.deepStrictEqual((await row('Strawberry Jam')).slice(1, 4), ['3', '2', '-1']);
    if (process.env.SF_SHOT) await page.locator('.card:has(#ctapprove)').screenshot({ path: path.join(process.env.SF_SHOT, 'stocktake-review.png') });
    await page.click('#ctapprove');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    await page.waitForFunction(() => /Earlier stocktakes/.test(document.getElementById('countbox').textContent));
    const hand = env.SF.onHand();
    assert.strictEqual(hand.P01, 2); assert.strictEqual(hand.P02, 1); assert.strictEqual(hand.P03, 2);
    assert.strictEqual(hand.P05, 9, 'not counted anywhere: left as it was');
    assert.ok(/approved/.test(await page.textContent('#countbox')));
    await env.ctx.close();
  });

  await test('stocktake: a cashier counts from More, but cannot start or approve', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => { shop10(SF); SF.setPin('cashier', '1111'); } });
    const page = env.page;
    const owner = env.SF.dispatch('signIn', { pin: '4321', device: 'o' }).data.token;
    env.SF.dispatch('countStart', { token: owner, opId: 'st1' });
    const tok = env.SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
    await page.evaluate((t) => SF.ls.set('sf.auth', { token: t, role: 'cashier', user: '' }), tok);
    await page.goto('about:blank'); await page.goto(base + '#till');
    await page.waitForFunction(() => window.SF && SF.state.ready);
    await page.evaluate(() => SF.openMore());
    await page.click('.sheet button:has-text("Stocktake")');
    await page.waitForSelector('button[data-loc="Car"]');
    assert.strictEqual(await page.locator('#ctapprove').count(), 0);
    assert.strictEqual(await page.locator('#ctstart').count(), 0);
    await page.click('button[data-loc="Car"]');
    await page.click('button[aria-label="One more Fig Jam"]');
    // Close the app half way: the count is still there when it opens again.
    await page.goto('about:blank'); await page.goto(base + '#stocktake');
    await page.waitForSelector('#ctdone');
    assert.strictEqual((await page.textContent('button[aria-label="How many Fig Jam"]')).trim(), '1');
    await page.click('#ctdone');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    const lines = env.sheets.Countlines.rows.filter((r) => r[1] === 'Car' && r[3] === 'P04');
    assert.strictEqual(lines.length, 1); assert.strictEqual(lines[0][4], 1);
    await env.ctx.close();
  });

  await test('Stock: scan a jar to see how many are in stock', async () => {
    const env = await phone({ hash: '#stock', seed: shop10, init: iphoneCamera });
    const page = env.page;
    await openShelf(page);
    await show(page, site + '?p=P06');
    await page.click('button:has-text("Scan a jar")');
    await page.waitForFunction(() => /Apricot Preserve: 7 in stock/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
    assert.strictEqual(await page.isVisible('#scan'), false);
    await env.ctx.close();
  });

  await test('each part of the app keeps its own name (no two scripts share one)', async () => {
    const env = await phone({ hash: '#till' });
    const kinds = await env.page.evaluate(() => ({
      cashup: typeof (window.SFC && window.SFC.save), kitchen: typeof (window.SFK && window.SFK.load),
      stocktake: typeof (window.SFCount && window.SFCount.render), till: typeof (window.SFT && window.SFT.tap),
      admin: typeof (window.SFA && window.SFA.drawLabels), labels: typeof (window.SFL && window.SFL.canvas),
      places: typeof (window.SFP && window.SFP.typed), filters: typeof (window.SF && SF.filters && SF.filters.bar)
    }));
    Object.keys(kinds).forEach((k) => assert.strictEqual(kinds[k], 'function', k + ' was overwritten'));
    await env.ctx.close();
  });

  /* ---------- security: text that tries to be code stays text ---------- */
  const pwned = (page) => page.evaluate(() => window.__pwned);

  await test('a market date that hides code shows as text on the poster', async () => {
    const env = await phone({ hash: '#labels', seed: (SF) => {
      shop10(SF);
      // Planted straight into the sheet, past the server's own date check.
      SF.append('markets', { MarketId: 'M02', Name: 'Bad Market', Date: '2099-01-01<img src=x onerror="window.__pwned=1">', Status: 'planned' });
    } });
    const page = env.page;
    await page.waitForSelector('#tabP');
    await page.click('#tabP');
    await page.selectOption('#pfor', 'M02');
    await page.waitForSelector('.poster .mkt');
    await page.waitForTimeout(300);
    assert.strictEqual(await pwned(page), undefined);
    assert.ok(/<img/.test(await page.textContent('.poster .mkt')), 'shown as text');
    await env.ctx.close();
  });

  await test('shop words that hide code show as text on Numbers and the till', async () => {
    const env = await phone({ hash: '#numbers', seed: (SF) => {
      shop10(SF);
      SF.set('profile', JSON.stringify({ name: 'Test', vocab: { units: '<img src=x onerror="window.__pwned=1">', unit: 'jar' } }));
    } });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.numbers);
    await page.goto(base + '#till'); await page.waitForFunction(() => SF.state.data.till);
    await page.goto(base + '#numbers'); await page.waitForTimeout(500);
    assert.strictEqual(await pwned(page), undefined);
    await env.ctx.close();
  });

  await test('a category or cupboard item with a quote in it cannot break out of its button', async () => {
    const evil = "Jams');window.__pwned=1;//";
    const env = await phone({ hash: '#till', seed: (SF) => {
      SF.append('products', { ProductId: 'P20', Name: 'Odd Jam', Category: evil, Type: 'stocked', Unit: 'each', Price: 10, Active: 'Yes', Sort: 1 });
      SF.move('P20', 3, 'adjust', 'test');
      SF.append('pantry', { Item: "Sugar');window.__pwned=1;//", Qty: 2, Unit: 'kg', Note: '', UpdatedAt: new Date(), UpdatedBy: 'x' });
    } });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.click('.chips button[data-c="' + evil.replace(/"/g, '\\"') + '"]');
    assert.strictEqual(await pwned(page), undefined);
    assert.strictEqual(await page.evaluate(() => SF.ls.get('sf.tillcat')), evil, 'the chip still picks its category');
    await page.goto(base + '#stock');
    await page.waitForFunction(() => SF.state.data.stock);
    await page.evaluate(() => { SF.ls.set('sf.tab.stock', 'cupboard'); SF.render(); });
    await page.click('button[data-i^="Sugar"]');
    assert.strictEqual(await pwned(page), undefined);
    assert.strictEqual(await page.inputValue('#pi'), "Sugar');window.__pwned=1;//", 'the item still fills the form');
    await env.ctx.close();
  });

  await test('labels: a long size under the name never runs over the QR, at any size, in either style', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.addScriptTag({ path: path.join(ROOT, 'web', 'core', 'vendor', 'jsQR.js') });
    const bad = await page.evaluate(() => {
      const p = { id: 'P11', name: 'Tomato Ginger', variant: 'Medium (odd bottle)', price: 85, unit: 'each' };
      const out = [];
      for (const style of ['classic', 'simple']) for (const s of SFL.sizes) {
        const look = { style, price: false, contact: '', base: 'https://stallflow.github.io/Stallflow/duxies/' };
        const c = SFL.canvas(p, s[0], "Duxie's Homemade", look), x = c.getContext('2d');
        const img = x.getImageData(0, 0, c.width, c.height);
        const q = window.jsQR(img.data, img.width, img.height);
        const want = s[3] < 20 ? 'SF:P11' : look.base + '?p=P11';
        if (!q || q.data !== want) out.push(style + ' ' + s[0] + ': ' + (q ? q.data : 'QR does not scan'));
      }
      return out;
    });
    assert.deepStrictEqual(bad, []);
    await env.ctx.close();
  });

  /* ---------- paid by, receipts, the live market, costs, a day with no signal ---------- */
  const sellOne = async (page, id, how, notes) => {
    await page.evaluate((x) => SFT.tap(x), id);
    await page.click('.cart .takebtn');
    await page.waitForSelector('#doSale');
    if (how !== 'cash') await page.click('#pw-' + how);
    else for (const n of notes || []) await page.click('.sheet .cash button:has-text("R' + n + '")');
    await page.click('#doSale');
    await page.evaluate(() => { if (document.querySelector('.give')) SF.closeSheet(); });
  };

  await test('Till: a card sale needs no notes, gives no change, and is kept as card', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => SFT.tap('P01'));
    await page.click('.cart .takebtn');
    await page.waitForSelector('#doSale');
    assert.strictEqual(await page.isDisabled('#doSale'), true, 'cash first: nothing received yet');
    await page.click('#pw-card');
    assert.strictEqual(await page.isVisible('.sheet .cash'), false, 'no notes for a card');
    assert.strictEqual(await page.isDisabled('#doSale'), false);
    await page.click('#doSale');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    assert.strictEqual(await page.locator('.give').count(), 0, 'no change to give');
    const sale = env.SF.orders().find((o) => o.channel === 'till');
    assert.strictEqual(sale.paid, 'card');
    assert.ok(/Last sale\s*R 70\.00\s*· card/.test(await page.textContent('.lastsale')), await page.textContent('.lastsale'));
    await env.ctx.close();
  });

  await test('Still to pay: a pre-order paid by EFT is kept as EFT', async () => {
    const env = await phone({ hash: '#till', seed: withPreorder });
    const page = env.page;
    await openToPay(page);
    await page.click('.porder button:has-text("Take payment")');
    await page.click('#pw-eft');
    await page.click('#doSale');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    assert.strictEqual(env.SF.orders().find((o) => o.customer === 'Viv Pieters').paid, 'eft');
    await env.ctx.close();
  });

  await test('Send receipt opens WhatsApp with the sale typed in, and the number goes nowhere else', async () => {
    const sent = [];
    const env = await phone({ hash: '#till', init: () => { window.open = (u) => { window.__opened = u; return null; }; } });
    const page = env.page;
    page.on('request', (r) => sent.push(r.url() + ' ' + (r.postData() || '')));
    await page.waitForFunction(() => SF.state.data.till);
    await page.evaluate(() => { SFT.tap('P01'); SFT.tap('P01'); SFT.tap('P02'); });
    await page.click('.cart .takebtn');
    await page.click('.sheet button:has-text("R200")');
    await page.click('.sheet button:has-text("R20")');
    await page.click('#doSale');
    await page.evaluate(() => SF.closeSheet());
    await page.click('.lastsale button:has-text("Send receipt")');
    await page.fill('#rph', '082 555 0101');
    await page.click('#rsend');
    const url = await page.evaluate(() => window.__opened);
    assert.ok(url.startsWith('https://wa.me/27825550101?text='), url);
    const text = decodeURIComponent(url.split('text=')[1]);
    for (const want of ['2 × Apricot Jam', '1 × Marmalade', 'Total R 210.00', 'paid by cash']) {
      assert.ok(text.indexOf(want) !== -1, 'receipt has "' + want + '":\n' + text);
    }
    await page.waitForTimeout(300);
    assert.ok(!sent.some((x) => /555.?0101/.test(x)), 'the number never reached the server');
    assert.ok(!/555.?0101/.test(await page.evaluate(() => JSON.stringify(localStorage))), 'nor is it kept on the phone');
    await env.ctx.close();
  });

  await test('Till: when the live market is over, the owner makes today\'s market live in one tap', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      SF.append('markets', { MarketId: 'M02', Name: 'Monument Primary Market', Date: day(0), Status: 'planned' });
    } });
    const page = env.page;
    await page.waitForSelector('.card.stale');
    const text = await page.textContent('.card.stale');
    assert.ok(/The live market, Test Market, was on/.test(text) && /Monument Primary Market is today/.test(text), text);
    await page.click('.card.stale button:has-text("Make Monument Primary Market live")');
    await page.waitForFunction(() => !SF.outbox.pending().length);
    assert.strictEqual(env.SF.activeMarket(), 'M02');
    await page.waitForFunction(() => !document.querySelector('.card.stale'));
    await env.ctx.close();
  });

  await test('Till: a cashier is told to ask the owner, with no button', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => {
      SF.append('markets', { MarketId: 'M02', Name: 'Monument Primary Market', Date: day(0), Status: 'planned' });
      SF.setPin('cashier', '1111');
    } });
    const page = env.page;
    const tok = env.SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
    await page.evaluate((t) => SF.ls.set('sf.auth', { token: t, role: 'cashier', user: '' }), tok);
    await page.goto('about:blank'); await page.goto(base + '#till');
    await page.waitForSelector('.card.stale');
    assert.ok(/Ask the owner to make Monument Primary Market live/.test(await page.textContent('.card.stale')));
    assert.strictEqual(await page.locator('.card.stale button').count(), 0);
    await env.ctx.close();
  });

  await test('Stock says which products have no cost yet, until a batch gives them one', async () => {
    const env = await phone({ hash: '#stock' });
    const page = env.page;
    await page.waitForSelector('.card.stale');
    assert.ok(/2 products have no cost yet/.test(await page.textContent('.card.stale')));
    const tok = env.SF.dispatch('signIn', { pin: '4321', device: 'x' }).data.token;
    for (const id of ['P01', 'P02']) {
      env.SF.dispatch('addBatch', { token: tok, opId: 'b' + id, productId: id, made: 6, lines: [{ label: 'Fruit', amount: 120 }] });
    }
    await page.evaluate(() => SF.load('stock'));
    await page.waitForFunction(() => !document.querySelector('.card.stale'));
    await env.ctx.close();
  });

  await test('a whole market day with no signal: every sale arrives once when it comes back', async () => {
    const env = await phone({ hash: '#till' });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    env.offline = true; await env.ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await sellOne(page, 'P01', 'cash', [100]);
    await sellOne(page, 'P02', 'card');
    await sellOne(page, 'P01', 'cash', [50, 20]);
    await sellOne(page, 'P02', 'eft');
    await sellOne(page, 'P01', 'card');
    assert.strictEqual(await page.evaluate(() => SF.outbox.pending().length), 5, 'five sales waiting on the phone');
    assert.strictEqual(env.SF.orders().length, 0, 'nothing reached the sheet yet');
    // The phone is closed and opened again, still without signal: the sales are still there.
    assert.strictEqual(await page.evaluate(() => JSON.parse(JSON.stringify(SF.outbox.pending())).length), 5);
    env.offline = false; await env.ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !SF.outbox.pending().length, null, { timeout: 15000 });
    await page.evaluate(() => SF.sync());                 // a second sync must not add anything
    await page.waitForTimeout(500);
    const sales = env.SF.orders().filter((o) => o.channel === 'till');
    assert.strictEqual(sales.length, 5, 'five sales, no doubles');
    assert.strictEqual(JSON.stringify(sales.map((o) => o.paid)), JSON.stringify(['cash', 'card', 'cash', 'eft', 'card']));
    const hand = env.SF.onHand();
    assert.strictEqual(hand.P01, 7); assert.strictEqual(hand.P02, 8);
    await env.ctx.close();
  });

  /* ---------- Google sign-in trouble ---------- */
  const gsiStub = (button) => `(function () {
    var g = window.__gsi = window.__gsi || { loads: 0, cancels: 0, inits: 0 }; g.loads++;
    window.google = window.google || {};
    window.google.accounts = { id: {
      initialize: function (o) { g.inits++; g.cb = o.callback; },
      renderButton: function (el) { ${button ? "var f = document.createElement('iframe'); f.title = 'Sign in with Google'; el.appendChild(f);" : ''} },
      cancel: function () { g.cancels++; }, disableAutoSelect: function () {} } };
  })();`;
  const signedOutWithGoogle = async (script) => {
    const env = await phone({ google: true });
    env.gsi = { blocked: script === 'blocked' };
    await env.ctx.route('https://accounts.google.com/**', (r) => env.gsi.blocked ? r.abort()
      : r.fulfill({ status: 200, contentType: 'text/javascript', body: gsiStub(script !== 'nobutton') }));
    await env.page.evaluate(() => SF.forceSignOut());
    return env;
  };
  const authLog = (env) => env.sheets.Audit.rows.filter((r) => r[4] === 'authError').map((r) => r[5] + ' ' + r[6]);

  await test('Google sign-in: if Google\'s script is blocked, say so, then Try again starts fresh and works', async () => {
    const env = await signedOutWithGoogle('blocked');
    const page = env.page;
    await page.waitForSelector('#gsitrouble .notice');
    assert.ok(/could not load/.test(await page.textContent('#gsitrouble')), await page.textContent('#gsitrouble'));
    await page.waitForFunction(() => !SF.outbox.pending().length);
    await page.waitForTimeout(600);
    assert.ok(authLog(env).some((l) => /^load blocked/.test(l)), authLog(env).join(' | '));
    env.gsi.blocked = false;
    await page.click('#gsiretry');
    await page.waitForSelector('#gsi iframe');
    assert.strictEqual(await page.locator('#gsitrouble .notice').count(), 0, 'the message is gone');
    assert.strictEqual(await page.evaluate(() => window.__gsi.loads), 1, 'Google\'s script was loaded afresh');
    assert.strictEqual(await page.evaluate(() => window.__gsi.inits), 1);
    await page.click('#gsiretry');                       // and again: the old request is cancelled first
    await page.waitForFunction(() => window.__gsi.loads === 2);
    assert.strictEqual(await page.evaluate(() => window.__gsi.cancels), 1, 'the old request was cancelled');
    assert.strictEqual(await page.evaluate(() => window.__gsi.inits), 2);
    await env.ctx.close();
  });

  await test('Google sign-in: a button that never appears is explained, with Try again', async () => {
    const env = await signedOutWithGoogle('nobutton');
    const page = env.page;
    await page.waitForSelector('#gsitrouble .notice', { timeout: 15000 });
    assert.ok(/button did not appear/.test(await page.textContent('#gsitrouble')));
    assert.strictEqual(await page.isVisible('#gsiretry'), true);
    await env.ctx.close();
  });

  await test('Google sign-in: a refused token shows a plain message, is logged without the token, and Try again is there', async () => {
    const env = await signedOutWithGoogle('ok');
    const page = env.page;
    await page.waitForSelector('#gsi iframe');
    await page.evaluate(() => window.__gsi.cb({ credential: 'eyJhbGciOi.SECRET-TOKEN-VALUE.sig' }));
    await page.waitForFunction(() => /Tap Try again/.test(document.getElementById('view').textContent));
    assert.strictEqual(await page.isVisible('#gsiretry'), true);
    assert.ok(authLog(env).some((l) => /^refused token-not-accepted/.test(l)), authLog(env).join(' | '));
    assert.ok(JSON.stringify(env.sheets.Audit.rows).indexOf('SECRET-TOKEN') === -1, 'the token is never stored');
    await env.ctx.close();
  });

  await test('Google sign-in: inside another app\'s browser, it says to open Chrome', async () => {
    const env = await phone({ google: true, init: () => {
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 13; SM-S918B; wv) AppleWebKit/537.36 Version/4.0 Chrome/120 Mobile Safari/537.36 Instagram 300' });
    } });
    await env.ctx.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: gsiStub(true) }));
    await env.page.evaluate(() => SF.forceSignOut());
    await env.page.waitForSelector('.notice.warn');
    assert.ok(/Open this address in Chrome/.test(await env.page.textContent('.notice.warn')));
    await env.ctx.close();
  });

  /* ---------- sending the order page out, and the poster as a picture for advertising ---------- */
  const adSeed = (SF) => {
    SF.append('markets', { MarketId: 'M02', Name: 'Monument Primary Market', Date: day(2), Location: 'School hall · 09:00–14:00', Status: 'planned' });
    SF.set('activeMarket', 'M02');
    SF.set('profile', JSON.stringify({ name: "Duxie's Homemade", tagline: 'Jams, knitted things and resin pieces, all made by hand',
      colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4' }));
  };

  await test('Order page card: Send on WhatsApp opens WhatsApp with the market and its link typed in', async () => {
    const env = await phone({ hash: '#numbers', seed: adSeed, init: () => { window.open = (u) => { window.__opened = u; return null; }; } });
    const page = env.page;
    await page.waitForSelector('#olink');
    const link = (await page.textContent('#olink')).trim();
    await page.click('button:has-text("Send on WhatsApp")');
    const url = await page.evaluate(() => window.__opened);
    assert.ok(url.startsWith('https://wa.me/?text='), url);
    const text = decodeURIComponent(url.split('text=')[1]);
    for (const want of ["Duxie's Homemade", 'Pre-order for Monument Primary Market', 'No app, no account', link]) {
      assert.ok(text.indexOf(want) !== -1, 'message has "' + want + '":\n' + text);
    }
    await env.ctx.close();
  });

  await test('Poster pictures: both sizes are the right shape, and the QR in each opens the order page', async () => {
    const env = await phone({ hash: '#till', seed: adSeed });
    const page = env.page;
    await page.addScriptTag({ path: path.join(ROOT, 'web', 'core', 'vendor', 'jsQR.js') });
    const link = site + '?m=M02';
    const r = await page.evaluate((link) => {
      const info = { shop: "Duxie's Homemade", tagline: 'Jams, knitted things and resin pieces, all made by hand',
        title: 'Monument Primary Market', when: 'Sun 8 Nov', where: 'School hall · 09:00–14:00', link: link,
        colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4' };
      const out = {};
      [['feed', info], ['story', info], ['home', Object.assign({}, info, { home: true, link: link.replace('M02', 'home') })],
       ['long', Object.assign({}, info, { shop: 'The Extraordinarily Long Named Homemade Goods Company', title: 'Blairgowrie Church Craft and Food Market Spring Edition', where: 'Church grounds, 12 Long Road, Blairgowrie, Randburg · 08:00–13:00' })]]
        .forEach(([k, i]) => {
          const c = SFL.poster(i, k === 'story' ? 'story' : 'feed'), x = c.getContext('2d');
          const q = window.jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
          out[k] = { w: c.width, h: c.height, qr: q && q.data };
        });
      return out;
    }, link);
    assert.deepStrictEqual([r.feed.w, r.feed.h], [1080, 1350]);
    assert.deepStrictEqual([r.story.w, r.story.h], [1080, 1920]);
    assert.strictEqual(r.feed.qr, link); assert.strictEqual(r.story.qr, link);
    assert.strictEqual(r.home.qr, site + '?m=home');
    assert.strictEqual(r.long.qr, link, 'long names still leave room for a scannable QR');
    await env.ctx.close();
  });

  await test('Poster screen: download both pictures, share the picture, send the link on WhatsApp', async () => {
    const env = await phone({ hash: '#labels', seed: adSeed, init: () => {
      window.open = (u) => { window.__opened = u; return null; };
      navigator.canShare = () => true;
      navigator.share = (d) => { window.__shared = d.files.map((f) => f.name + ':' + f.type + ':' + (f.size > 5000)); return Promise.resolve(); };
    } });
    const page = env.page;
    await page.waitForSelector('#tabP');
    await page.click('#tabP');
    await page.waitForSelector('.adbtns');
    await page.waitForTimeout(800);                       // the pictures are drawn as the poster shows
    for (const [button, name] of [['Download for Facebook and Instagram', /duxie-s-homemade-monument-primary-market-post-1080x1350\.png$/],
                                  ['Download for WhatsApp Status', /-status-1080x1920\.png$/]]) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("' + button + '")')]);
      assert.ok(name.test(dl.suggestedFilename()), dl.suggestedFilename());
      const png = fs.readFileSync(await dl.path());
      assert.strictEqual(png.readUInt32BE(16), 1080, 'a PNG 1080 wide');
    }
    await page.click('#adshare');
    await page.waitForFunction(() => window.__shared);
    const shared = await page.evaluate(() => window.__shared);
    assert.ok(/post-1080x1350\.png:image\/png:true/.test(shared[0]), shared.join());
    await page.click('button:has-text("Send the link on WhatsApp")');
    assert.ok((await page.evaluate(() => window.__opened)).startsWith('https://wa.me/?text='));
    if (process.env.SF_SHOT) {
      const png = await page.evaluate(async () => { const b = await SFL.posterBlob({ shop: "Duxie's Homemade", tagline: 'Jams, knitted things and resin pieces, all made by hand', title: 'Monument Primary Market', when: 'Sun 8 Nov', where: 'School hall · 09:00–14:00', link: SF.site + '?m=M02', colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4' }, 'feed'); return Array.from(new Uint8Array(await b.arrayBuffer())); });
      fs.writeFileSync(path.join(process.env.SF_SHOT, 'poster-feed.png'), Buffer.from(png));
    }
    await env.ctx.close();
  });

  await test('Order page: Tell a friend on WhatsApp links to this page without the scanned product', async () => {
    const env = await phone({ hash: '#till', seed: adSeed });
    const page = await customer(env, '?m=M02&p=P01');
    const href = await page.getAttribute('.friend a', 'href');
    assert.ok(href.startsWith('https://wa.me/?text='), href);
    const text = decodeURIComponent(href.split('text=')[1]);
    assert.ok(text.indexOf('?m=M02') !== -1 && text.indexOf('p=P01') === -1, text);
    await env.ctx.close();
  });

  /* ---------- landscape ---------- */
  await test('the app may be turned sideways: the manifest allows it, and the till, payment and basket still work on a short screen', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'app', 'manifest.webmanifest'), 'utf8'));
    assert.strictEqual(manifest.orientation, 'any', 'not locked to portrait');
    const env = await phone({ hash: '#till', seed: shop10 });
    const page = env.page;
    await page.waitForFunction(() => SF.state.data.till);
    for (const [w, h] of [[844, 390], [667, 375], [915, 412]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => { SF.closeSheet(); window.scrollTo(0, 0); });
      await page.waitForTimeout(300);
      const wide = await tooWide(page);
      assert.ok(!wide, 'till at ' + w + '×' + h + ': ' + wide);
      await page.evaluate(() => { SFT.tap('P03'); SFT.tap('P05'); });
      // the products and the bars: the tab bar is slim, and a product can be tapped without the bars covering it
      const bars = await page.evaluate(() => ({
        tabs: document.querySelector('.tabs').getBoundingClientRect().height,
        cart: document.querySelector('.cart').getBoundingClientRect().height, vh: innerHeight }));
      assert.ok(bars.tabs <= 56, 'the tab bar is slim in landscape: ' + bars.tabs);
      assert.ok(bars.tabs + bars.cart < bars.vh * 0.36, 'the bars leave room for products: ' + JSON.stringify(bars));
      await page.click('.basketbtn');
      await page.waitForSelector('#basketbody');
      const ph = await page.evaluate(() => { const p = document.querySelector('.sheet .panel').getBoundingClientRect(); return [p.top, p.bottom, innerHeight]; });
      assert.ok(ph[0] >= 0 && ph[1] <= ph[2] + 1, 'the basket fits the screen: ' + ph);
      await page.click('#basketbody button:has-text("Take payment")');
      await page.waitForSelector('#doSale');
      await page.click('#pw-card');
      await page.click('#doSale');                         // reachable by scrolling inside the sheet
      await page.waitForFunction(() => !SF.outbox.pending().length);
      if (process.env.SF_SHOT) await page.screenshot({ path: path.join(process.env.SF_SHOT, 'landscape-' + w + '.png') });
    }
    await env.ctx.close();
  });

  await test('How-to videos: anyone signed in finds them in More, and every video is published', async () => {
    const env = await phone({ hash: '#till', seed: (SF) => SF.setPin('cashier', '1111') });
    const page = env.page;
    const tok = env.SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
    await page.evaluate((t) => SF.ls.set('sf.auth', { token: t, role: 'cashier', user: '' }), tok);
    await page.goto('about:blank'); await page.goto(base + '#till');
    await page.waitForFunction(() => window.SF && SF.state.ready);
    await page.evaluate(() => SF.openMore());
    await page.click('.sheet button:has-text("How-to videos")');
    await page.waitForSelector('.guidevid video');
    const vids = await page.$$eval('.guidevid video', (v) => v.map((x) => [x.getAttribute('src'), x.getAttribute('poster'), x.preload]));
    assert.strictEqual(vids.length, 7);
    for (const [src, poster, preload] of vids) {
      assert.strictEqual(preload, 'none', 'nothing downloads until play is tapped');
      for (const f of [src, poster]) {
        assert.ok(fs.existsSync(path.join(ROOT, '_site', 'duxies', 'app', f)), f + ' is published');
      }
    }
    const sw = fs.readFileSync(path.join(ROOT, 'web', 'app', 'sw.js'), 'utf8');
    assert.ok(sw.indexOf('guide/') === -1 || sw.indexOf('.mp4') === -1, 'videos are never kept offline');
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await test('the QR reader is kept for offline use', async () => {
    const sw = fs.readFileSync(path.join(ROOT, 'web', 'app', 'sw.js'), 'utf8');
    assert.ok(sw.indexOf("'../core/vendor/jsQR.js'") !== -1);
    assert.ok(fs.existsSync(path.join(ROOT, 'web', 'core', 'vendor', 'jsQR.LICENSE.txt')));
  });

  await test('no page errors anywhere in the run', async () => {
    const env = await phone({ hash: '#numbers' });
    for (const h of ['#till', '#collect', '#stock', '#labels', '#numbers', '#settings', '#health', '#report']) {
      await env.page.goto(base + h); await settle(env.page, 500);
    }
    for (const q of ['', '?m=home', '?m=M01', '?m=nonsense']) await customer(env, q);
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await browser.close(); srv.close();
  console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
