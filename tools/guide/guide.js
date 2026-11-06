/**
 * StallFlow video guide, step 1 of 2: drives the real app on an iPhone-sized
 * screen against the real server code (fake sheet, demo data, made-up
 * customers), and saves full-resolution frames + captions per chapter in
 * tools/guide/rec/. Step 2, make_video.py, turns them into the MP4s the app
 * shows under More › How-to videos (web/guide/).
 *
 *   node tools/guide/guide.js            all chapters
 *   CH=3 node tools/guide/guide.js       one chapter (for checking)
 *   python3 tools/guide/make_video.py    then build the videos
 *
 * After changing the app, run both again and commit web/guide/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { server, serveSite, chromium } = require('./harness.js');
const { devices } = require('playwright');

const OUT = path.join(__dirname, 'rec');
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- demo stall: Duxie's products, made-up customers ---------- */
function seed(SF) {
  SF.set('preset', 'preserves');
  SF.set('orderPrefix', 'D');
  SF.set('profile', JSON.stringify({
    name: "Duxie's Homemade", tagline: 'Jams, knitted things and resin pieces, all made by hand',
    whatsapp: '066 000 0000', ownerName: 'Marian', colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4' }));
  SF.set('preordersOpen', 'yes');
  SF.set('consentText', 'We keep your name and number only to hand your order over, and delete it after the market.');
  const stockIn = [];
  const products = [   // name, size, category, price, jars on hand, what one cost to make
    ['Apricot Jam', '340g', 'Jams', 60, 12, 24], ['Marmalade', '340g', 'Jams', 60, 10, 22],
    ['Strawberry Jam', '340g', 'Jams', 65, 14, 27], ['Guava Jam', '340g', 'Jams', 60, 8, 23],
    ['Pineapple Jam', '340g', 'Jams', 60, 9, 23], ['Mango Jam', '340g', 'Jams', 65, 3, 26],
    ['Topsy-turvy doll', 'knitted', 'Knitting', 320, 4, 120], ['Knitted animal', 'small', 'Knitting', 180, 6, 65],
    ['Resin coaster set', 'set of 4', 'Resin', 220, 5, 85], ['Resin keyring', 'each', 'Resin', 45, 20, 14]];
  products.forEach((p, i) => {
    const id = 'P' + String(i + 1).padStart(2, '0');
    SF.append('products', { ProductId: id, Name: p[0], Variant: p[1], Type: 'stocked', Category: p[2],
      Unit: 'each', Price: p[3], Capacity: 0, Options: '[]', Active: 'Yes', Sort: (i + 1) * 10 });
    stockIn.push([id, p[4], p[5]]);
  });
  SF.append('markets', { MarketId: 'M01', Name: 'Monument Primary Market', Date: day(0),
    Location: 'School hall · 09:00–14:00', Status: 'planned' });
  SF.append('markets', { MarketId: 'M02', Name: 'Blairgowrie Church Market', Date: day(7),
    Location: 'Church grounds · 08:00–13:00', Status: 'planned' });
  SF.set('activeMarket', 'M01');
  [['Stall fee', 250, 'Stall'], ['Petrol there and back', 120, 'Travel']].forEach((c, i) =>
    SF.append('expenses', { ExpenseId: 'E-00' + (i + 1), MarketId: 'M01', Description: c[0], Amount: c[1], Category: c[2], When: new Date() }));
  [['Sugar', 10, 'kg'], ['Apricots', 6, 'kg'], ['Empty jars', 48, 'each']].forEach((r) =>
    SF.append('pantry', { Item: r[0], Qty: r[1], Unit: r[2], Note: '', UpdatedAt: new Date(), UpdatedBy: 'Marian' }));
  SF.setPin('owner', '4321');
  const token = SF.dispatch('signIn', { pin: '4321', device: 'guide' }).data.token;
  stockIn.forEach(([id, n, each], i) => {
    const r = SF.dispatch('addBatch', { token, opId: 'batch' + i, productId: id, made: n,
      lines: [{ label: 'Ingredients, jars and labels', amount: n * each }] });
    if (!r.ok) console.log('batch:', r.message);
  });
  // A few earlier walk-up sales, so the numbers are not all zero.
  [[['P01', 1], ['P03', 1]], [['P10', 2]], [['P09', 1]]].forEach((s, i) => {
    const r = SF.dispatch('sell', { token, opId: 'seed' + i, marketId: 'M01', lines: s.map((l) => ({ id: l[0], qty: l[1] })) });
    if (!r.ok) console.log('seed sale:', r.message);
  });
  return token;
}

/* ---------- what runs inside every page ---------- */
function pageInit() {
  // The tap marker: a soft ring where a finger touches.
  const css = '.__tap{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;' +
    'background:rgba(255,196,0,.42);border:3px solid rgba(240,150,0,.95);z-index:2147483647;pointer-events:none;' +
    'transition:transform .45s ease-out,opacity .45s ease-out}' +
    '::-webkit-scrollbar{display:none}';
  const add = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
  window.__tapAt = (x, y) => {
    const d = document.createElement('div'); d.className = '__tap';
    d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d);
    setTimeout(() => { d.style.transform = 'scale(1.7)'; d.style.opacity = '0'; }, 380);
    setTimeout(() => d.remove(), 900);
  };
  // The camera: a jar on a table with its label, as the phone would see it.
  delete window.BarcodeDetector;
  window.__fakeText = '';
  window.__fakeName = '';
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
    const c = document.createElement('canvas'); c.width = 720; c.height = 1280;
    const x = c.getContext('2d');
    const paint = () => {
      const g = x.createLinearGradient(0, 0, 0, 1280);
      g.addColorStop(0, '#6b5444'); g.addColorStop(1, '#3e2f25');
      x.fillStyle = g; x.fillRect(0, 0, 720, 1280);
      if (!window.__fakeText || !window.QR) return;
      // the jar
      x.fillStyle = '#c8741f'; x.beginPath(); x.roundRect(150, 260, 420, 760, 60); x.fill();
      x.fillStyle = '#d9d2c5'; x.fillRect(190, 210, 340, 70);
      // the label
      x.fillStyle = '#fff'; x.fillRect(180, 470, 360, 380);
      x.fillStyle = '#7B2D43'; x.font = 'bold 22px sans-serif'; x.textAlign = 'center';
      x.fillText("DUXIE'S HOMEMADE", 360, 505);
      x.fillStyle = '#111'; x.font = 'bold 30px sans-serif'; x.fillText(window.__fakeName || '', 360, 545);
      if (!window.__fakeSharp) {               // still focusing: the code is a blur
        x.fillStyle = '#c9c9c9'; x.fillRect(235, 570, 250, 250);
        x.fillStyle = '#e4e4e4'; x.fillRect(265, 600, 190, 190);
        return;
      }
      const q = window.QR.make(window.__fakeText, 'M'), cell = Math.floor(250 / (q.size + 2));
      const ox = 360 - (q.size * cell) / 2, oy = 570;
      x.fillStyle = '#000';
      for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++)
        if (q.modules[r][k]) x.fillRect(ox + k * cell, oy + r * cell, cell, cell);
    };
    paint(); setInterval(paint, 100);
    return c.captureStream(12);
  };
}

/* ---------- frames + captions ---------- */
class Recorder {
  constructor() { this.page = null; this.on = false; }
  async start(id, title) {
    this.dir = path.join(OUT, id); fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.id = id; this.frames = []; this.caps = []; this.n = 0; this.on = true; this.t0 = Date.now();
    this.title = title;
    this.loop = (async () => {
      while (this.on) {
        const t = Date.now();
        try {
          const b = await this.page.screenshot({ type: 'jpeg', quality: 88, timeout: 3000 });
          const f = String(this.n++).padStart(5, '0') + '.jpg';
          fs.writeFileSync(path.join(this.dir, f), b);
          this.frames.push({ t: t - this.t0, f });
        } catch (e) { await sleep(50); }
      }
    })();
  }
  cap(text) { this.caps.push({ t: Date.now() - this.t0, text }); }
  async stop() {
    await sleep(400);
    this.on = false; await this.loop;
    const end = Date.now() - this.t0;
    fs.writeFileSync(path.join(this.dir, 'meta.json'),
      JSON.stringify({ id: this.id, title: this.title, end, frames: this.frames, caps: this.caps }, null, 1));
    console.log(this.id, this.frames.length + ' frames', (end / 1000).toFixed(1) + 's');
  }
}

(async () => {
  const only = process.env.CH ? Number(process.env.CH) : 0;
  const srv = await serveSite();
  const local = 'http://localhost:' + srv.address().port;
  const base = 'https://stallflow.github.io/Stallflow/duxies/app/';
  const site = base.replace(/app\/$/, '');
  const env = server(), SF = env.SF;
  const token = seed(SF);
  const browser = await chromium.launch();
  const ctx = await browser.newContext(Object.assign({}, devices['iPhone 13'],
    { serviceWorkers: 'block', acceptDownloads: true, locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' }));
  await ctx.route('https://stallflow.github.io/Stallflow/**', async (route) => {
    const u = new URL(route.request().url());
    const r = await fetch(local + u.pathname.replace(/^\/Stallflow/, ''));
    await route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/html' },
      body: Buffer.from(await r.arrayBuffer()) });
  });
  await ctx.addInitScript(pageInit);
  await ctx.route('https://script.google.com/**', async (route) => {
    const req = route.request();
    const body = req.method() === 'GET' ? Object.fromEntries(new URL(req.url()).searchParams) : JSON.parse(req.postData() || '{}');
    await sleep(250);                                  // a little like a real phone signal
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(SF.dispatch(body.action, body)) });
  });
  await ctx.route('**/duxies/config.js', async (route) => {
    const real = fs.readFileSync(path.join(__dirname, '..', '..', '_site', 'duxies', 'config.js'), 'utf8');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: real + '\ndelete window.STALLFLOW.mapsKey;' });
  });
  await ctx.route('https://wa.me/**', (route) => route.abort());
  const staff = await ctx.newPage();
  staff.on('pageerror', (e) => console.log('page error:', String(e).slice(0, 200)));
  await staff.goto(base);
  await staff.evaluate((a) => SF.ls.set('sf.auth', a), { token, role: 'owner', user: 'Marian' });
  await staff.goto('about:blank');
  await staff.goto(base + '#till');
  await staff.waitForFunction(() => window.SF && SF.state.ready && SF.state.data.till);
  await sleep(800);

  const rec = new Recorder();
  rec.page = staff;
  let page = staff;
  const use = (p) => { page = p; rec.page = p; };

  /* helpers that look like a person using the phone */
  const beat = (ms) => sleep(ms || 1100);
  const say = async (text, ms) => { rec.cap(text); await beat(ms || 2200); };
  const find = (sel) => page.locator(sel).first();
  async function tap(sel, opts) {
    opts = opts || {};
    const el = find(sel);
    await el.waitFor({ state: 'visible', timeout: 15000 });
    await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(500);
    const b = await el.boundingBox();
    if (b) await page.evaluate(([x, y]) => window.__tapAt(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
    await sleep(320);
    if (!opts.markOnly) await el.click();
    await beat(opts.after || 800);
  }
  async function type(sel, text) {
    await tap(sel, { after: 200 });
    await find(sel).fill('');
    await find(sel).pressSequentially(text, { delay: 55 });
    await beat(400);
  }
  const scrollTo = (y) => page.evaluate((v) => window.scrollTo({ top: v, behavior: 'smooth' }), y).then(() => sleep(900));
  // A jar comes into view, the camera focuses for a moment, then the code is readable.
  const camera = async (text, name, focus) => {
    await page.evaluate(([t, n, f]) => { window.__fakeText = t; window.__fakeName = n; window.__fakeSharp = !f; },
      [text, name || '', !!(text && focus)]);
    if (text && focus) { await sleep(focus); await page.evaluate(() => { window.__fakeSharp = true; }); }
  };
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await beat(900); };
  const tab = async (screen, t) => { await page.evaluate(([s, v]) => SF.ls.set('sf.tab.' + s, v), [screen, t]); };

  const chapters = [
    /* 1 */ ['till', '1 · Selling at the till', async () => {
      await tab('till', 'sell'); await go('till'); await page.evaluate(() => window.scrollTo(0, 0));
      await say('The Till is where you sell. Tap a product to add it to the sale.', 2600);
      await tap('button.tile:has-text("Apricot Jam")');
      await say('Tap again for another one.', 1200);
      await tap('button.tile:has-text("Strawberry Jam")', { after: 500 });
      await tap('button.tile:has-text("Strawberry Jam")');
      await say('Tap a category to find things quickly.', 1400);
      await tap('.chips button:has-text("Knitting")');
      await tap('button.tile:has-text("Topsy-turvy doll")');
      await say('The bar at the bottom shows how many and the total.', 2400);
      await tap('.basketbtn');
      await say('In the basket, change amounts with − and +, or tap the number to type it.', 1800);
      await tap('button[aria-label^="One more Apricot Jam"]');
      await beat(800);
      await say('Then tap Take payment.', 1200);
      await tap('#basketbody button:has-text("Take payment")');
      await say('Tap the notes the customer hands you. The app works out the change.', 1500);
      await tap('.sheet button:has-text("R200")', { after: 500 });
      await tap('.sheet button:has-text("R200")', { after: 500 });
      await tap('.sheet button:has-text("R200")', { after: 1200 });
      await say('R600 for a R570 sale: give R30 change.', 2000);
      await tap('#doSale', { after: 1200 });
      await say('Give the change. The sale is saved, even with no signal.', 2800);
      const close = page.locator('.sheet button:has-text("Next sale"), .sheet button:has-text("Done"), .sheet button:has-text("Back to the till")').first();
      if (await close.count()) await tap('.sheet button:has-text("Next sale"), .sheet button:has-text("Done"), .sheet button:has-text("Back to the till")');
      else await page.evaluate(() => SF.closeSheet && SF.closeSheet());
      await beat(800);
    }],
    /* 2 */ ['scan', '2 · Scanning a jar', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await say('You can also scan the QR code on a jar instead of tapping.', 2000);
      await camera('', '');
      await tap('button:has-text("Scan")', { after: 1400 });
      await say('Point the camera at the label…', 1200);
      await camera(site + '?p=P05', 'Pineapple Jam', 1300);
      await page.waitForFunction(() => !document.querySelector('#scan') || document.querySelector('#scan').style.display === 'none', null, { timeout: 15000 });
      await say('…and the jar goes straight onto the bill.', 2400);
      await say('Take payment as before. Exact, when they pay the exact amount.', 600);
      await tap('.cart .takebtn');
      await tap('.sheet button:has-text("Exact")', { after: 900 });
      await tap('#doSale', { after: 1600 });
      const done = page.locator('.sheet button:has-text("Next sale"), .sheet button:has-text("Done"), .sheet button:has-text("Back to the till")').first();
      if (await done.count()) await tap('.sheet button:has-text("Next sale"), .sheet button:has-text("Done"), .sheet button:has-text("Back to the till")');
      else await page.evaluate(() => SF.closeSheet && SF.closeSheet());
      await beat(600);
    }],
    /* 3 */ ['preorder', '3 · Pre-orders and WhatsApp', async () => {
      const shop = await ctx.newPage();
      await shop.goto(site + '?p=P03');
      await shop.waitForSelector('.item');
      await sleep(900);
      use(shop);
      await say('Customers scan a jar or the market poster with their own phone camera.', 2600);
      await say('The order page opens with that product picked out.', 2200);
      await tap('.item:has-text("Strawberry Jam") button[aria-label^="More"]', { after: 500 });
      await tap('.item:has-text("Strawberry Jam") button[aria-label^="More"]');
      await say('They choose what they want, then their name and number.', 1200);
      await type('#nm', 'Anna Bester');
      await type('#ph', '082 555 0101');
      await tap('#cs');
      await tap('#go', { after: 1800 });
      await say('Their order is reserved…', 1800);
      await tap('#sendwa', { markOnly: true, after: 400 });
      await say('…and one tap sends it to Marian on WhatsApp.', 2600);
      await say('Marian replies to accept it, with her banking details.', 2800);
      use(staff);
      await page.bringToFront();
      await shop.close();
      await tab('till', 'topay');
      await page.evaluate(() => { location.hash = 'till'; SF.load('till'); window.scrollTo(0, 0); });
      await page.waitForSelector('.porder', { timeout: 15000 });
      await beat(1500);
      await say('In the app, the order waits under Till › Still to pay.', 2400);
      await tap('.porder button:has-text("Take payment")');
      await say('When Anna pays, record it, and the order is done.', 1400);
      await tap('.sheet button:has-text("Exact")');
      await tap('#doSale', { after: 1500 });
      await page.evaluate(() => SF.closeSheet && SF.closeSheet());
      await tab('till', 'sell');
      await beat(600);
    }],
    /* 4 */ ['stock', '4 · Stock', async () => {
      await tab('stock', 'shelf');
      await tap('#tabs a[href="#stock"]', { after: 1500 });
      await say('Stock shows what is on the shelf, and what it is worth.', 2400);
      await scrollTo(260);
      await say('Search, filter or sort the list.', 1000);
      await type('#fq-shelf', 'jam');
      await page.evaluate(() => document.querySelector('#fq-shelf').scrollIntoView({ behavior: 'smooth', block: 'start' }));
      await beat(2200);
      await find('#fq-shelf').fill(''); await page.dispatchEvent('#fq-shelf', 'input');
      await beat(600);
      await say('Scan a jar to see how many are left.', 1200);
      await camera('', '');
      await tap('button:has-text("Scan a jar")', { after: 1000 });
      await camera(site + '?p=P03', 'Strawberry Jam', 1300);
      await page.waitForFunction(() => /in stock/.test(document.getElementById('toast').textContent), null, { timeout: 15000 });
      await beat(2600);
      await page.evaluate(() => window.scrollTo(0, 0));
      await say('Cupboard keeps the fruit, sugar and jars you buy in.', 1000);
      await tap('.stabs button:has-text("Cupboard")', { after: 2400 });
    }],
    /* 5 */ ['labels', '5 · Printing QR labels', async () => {
      await page.evaluate(() => SF.openMore());
      await beat(900);
      await say('More › QR labels makes a label for every product.', 1200);
      await tap('.sheet button:has-text("QR labels")', { after: 1500 });
      await say('Choose the size of the labels in your Niimbot.', 1200);
      await tap('#lsize', { markOnly: true, after: 200 });
      await page.selectOption('#lsize', 'nb-50x30');
      await beat(1500);
      await say('The preview shows exactly what will print.', 2400);
      await say('Tick the products you want labels for…', 800);
      await tap('text=Tick none', { after: 600 });
      await tap('#c-P01', { after: 400 });
      await tap('#c-P03', { after: 400 });
      await tap('#c-P05', { after: 800 });
      await say('…then Download, or Send to printer app on your phone.', 1200);
      const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await tap('text=Download ticked (.zip)', { after: 1200 });
      await dl;
      await say('In the Niimbot app: New label › Image, pick the label, print.', 3200);
    }],
    /* 6 */ ['stocktake', '6 · Stocktake', async () => {
      await tab('stock', 'count');
      await tap('#tabs a[href="#stock"]', { after: 1500 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await say('A stocktake checks what is really on the shelf.', 2000);
      await say('Marian or a manager starts it.', 800);
      await tap('#ctstart', { after: 1500 });
      await say('Everyone picks the spot they are counting.', 1000);
      await tap('button[data-loc="Stall table"]', { after: 1300 });
      await say('Scan each jar: one beep, one jar.', 800);
      await camera('', '');
      await tap('button:has-text("Scan jars")', { after: 1000 });
      for (const [code, name] of [['P01', 'Apricot Jam'], ['P01', 'Apricot Jam'], ['P02', 'Marmalade']]) {
        await camera(site + '?p=' + code, name, 700); await beat(1200);
        await camera('', ''); await beat(800);
      }
      await tap('#scan .x', { after: 1000 });
      await say('Or use − and +, or type the amount.', 900);
      await tap('button[aria-label^="One more Strawberry Jam"]', { after: 400 });
      await tap('button[aria-label^="One more Strawberry Jam"]', { after: 900 });
      await say('Tap Done when that spot is counted.', 900);
      await tap('#ctdone', { after: 1800 });
      await page.waitForSelector('#ctapprove', { timeout: 15000 });
      await say('Marian sees what was expected, what was counted, and the difference.', 1000);
      await page.evaluate(() => { const t = document.querySelector('#ctapprove'); if (t) t.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      await beat(2600);
      await say('She approves it: stock is corrected and any loss is recorded.', 900);
      await tap('#ctapprove', { after: 2600 });
    }],
    /* 7 */ ['markets', '7 · Markets and numbers', async () => {
      await tab('numbers', 'today');
      await tap('#tabs a[href="#numbers"]', { after: 1500 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await say('Numbers shows the takings, costs and profit for each market.', 2400);
      await scrollTo(420);
      await beat(1400);
      await page.evaluate(() => window.scrollTo(0, 0)); await beat(600);
      await say('Add each market you are going to.', 800);
      await tap('.stabs button:has-text("New market")', { after: 1000 });
      await type('#mn', 'Spring Craft Market');
      await find('#md').fill(day(14)); await beat(600);
      await type('#ml', 'Community hall');
      await tap('text=Add market', { after: 1400 });
      await page.evaluate(() => window.scrollTo(0, 0)); await beat(500);
      await tap('.stabs button:has-text("All markets")', { after: 700 });
      await page.evaluate(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => /Every market/.test(e.textContent));
        if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      await beat(900);
      await say('Each market gets its own order page and QR poster for customers.', 3200);
    }]
  ];

  for (let i = 0; i < chapters.length; i++) {
    if (only && only !== i + 1) continue;
    const [id, title, run] = chapters[i];
    await rec.start(String(i + 1).padStart(2, '0') + '-' + id, title);
    try { await run(); }
    catch (e) { console.log('chapter', id, 'stopped:', e.message.split('\n')[0]); }
    await rec.stop();
    use(staff);
  }
  await browser.close(); srv.close();
})();
