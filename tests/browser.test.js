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

let chromium;
try { chromium = require('playwright').chromium; }
catch (e) { console.log('skip  Playwright is not installed'); process.exit(0); }

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
            for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
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
      formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString())
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

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
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
    let token;
    if (opts.google) {
      SF.PLATFORM.googleClientId = 'x.apps.googleusercontent.com'; SF.PLATFORM.admins = ['boss@x.com'];
      token = SF.mintToken('owner', 'd', 'boss@x.com');
    } else {
      SF.setPin('owner', '4321');
      token = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
    }
    const ctx = await browser.newContext({ viewport: { width: 420, height: 640 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { env.pageErrors = (env.pageErrors || []).concat(String(e)); });
    await ctx.route('https://script.google.com/**', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
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

  await test('typing a place shows Open in Maps with the right address', async () => {
    const { page, ctx } = await phone({ hash: '#numbers' });
    await openNewMarket(page);
    assert.strictEqual(await page.isVisible('#mlmap'), false, 'hidden while the box is empty');
    await page.fill('#ml', 'Monument Primary School');
    assert.strictEqual(await page.isVisible('#mlmap'), true);
    const href = await page.getAttribute('#mlmap', 'href');
    assert.strictEqual(href, 'https://www.google.com/maps/search/?api=1&query=Monument%20Primary%20School');
    await ctx.close();
  });

  await test('going out to Maps and back keeps what was typed, and the link', async () => {
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
    assert.strictEqual(await page.isVisible('#mlmap'), true, 'the Maps link is still there');
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

  await test('no page errors anywhere in the run', async () => {
    const env = await phone({ hash: '#numbers' });
    for (const h of ['#till', '#collect', '#stock', '#labels', '#numbers', '#settings', '#health', '#report']) {
      await env.page.goto(base + h); await settle(env.page, 500);
    }
    assert.deepStrictEqual(env.pageErrors || [], []);
    await env.ctx.close();
  });

  await browser.close(); srv.close();
  console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
