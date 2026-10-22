/**
 * StallFlow — Core
 * ===========================================================================
 * The kernel. Sheets, migrations, identity, audit, the plugin host and the
 * request router. It knows nothing about jam, coffee or biltong — that lives
 * in Domain.gs, and anything beyond it lives in a plugin.
 *
 * Three files make up the server, and they load in this order:
 *   Core.gs      this file — kernel
 *   Domain.gs    catalogue, stock, orders, costing
 *   Plugins.gs   bundled plugins and market presets
 *
 * Apps Script has no module system: every .gs shares one global scope and is
 * evaluated before any function runs. So plugins register themselves into
 * SF.registry at load time, and nothing may depend on file order beyond that.
 */

var SF = SF || {};

SF.VERSION = '2.0.0';
SF.SCHEMA = 7;                        // bump when SHEETS changes; see MIGRATIONS
SF.TZ = 'Africa/Johannesburg';

/* =========================================================================
   1. SHEETS
   ========================================================================= */

SF.SHEETS = {
  settings:  ['Key', 'Value'],
  products:  ['ProductId', 'Name', 'Variant', 'Type', 'Category', 'Unit', 'Price',
              'Capacity', 'Options', 'Active', 'Sort'],
  batches:   ['BatchId', 'When', 'ProductId', 'Made', 'CostLines', 'TotalCost',
              'CostPerUnit', 'Note'],
  movements: ['When', 'ProductId', 'Qty', 'Type', 'Ref', 'MarketId'],
  orders:    ['OrderNo', 'When', 'MarketId', 'Channel', 'Customer', 'Phone', 'Lines',
              'Units', 'Total', 'Cost', 'Status', 'PaidAt', 'CollectedAt', 'Note', 'Consent'],
  markets:   ['MarketId', 'Name', 'Date', 'Location', 'Status', 'Note'],
  expenses:  ['ExpenseId', 'MarketId', 'Description', 'Amount', 'Category', 'When'],
  ops:       ['OpId', 'When', 'Action', 'Result'],
  pantry:    ['Item', 'Qty', 'Unit', 'Note', 'UpdatedAt', 'UpdatedBy'],
  recipes:   ['Name', 'Makes', 'Lines', 'UpdatedAt', 'UpdatedBy'],
  audit:     ['When', 'Actor', 'Role', 'Device', 'Action', 'Target', 'Detail', 'Outcome']
};

SF.sheet = function (key) {
  var head = SF.SHEETS[key];
  if (!head) throw new Error('Unknown sheet: ' + key);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = key.charAt(0).toUpperCase() + key.slice(1);
  var s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(head); }
  if (s.getLastRow() === 0) s.appendRow(head);
  return s;
};

SF.rows = function (key) {
  var s = SF.sheet(key), head = SF.SHEETS[key], last = s.getLastRow();
  if (last < 2) return [];
  var values = s.getRange(2, 1, last - 1, head.length).getValues(), out = [];
  for (var i = 0; i < values.length; i++) {
    var o = { _row: i + 2 }, blank = true;
    for (var c = 0; c < head.length; c++) {
      o[head[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) blank = false;
    }
    if (!blank) out.push(o);
  }
  return out;
};

/**
 * Text that starts with = + - or @ is a formula to Google Sheets. A customer
 * typing =IMAGE("https://…"&D2) as their name would otherwise make the sheet
 * send other customers' details to a stranger. A leading apostrophe makes
 * Sheets store it as plain text, and it reads back without the apostrophe.
 */
SF.safe = function (v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
};

SF.append = function (key, obj) {
  SF.sheet(key).appendRow(SF.SHEETS[key].map(function (h) {
    return obj[h] == null ? '' : SF.safe(obj[h]);
  }));
};

SF.setCell = function (key, row, header, value) {
  SF.sheet(key).getRange(row, SF.SHEETS[key].indexOf(header) + 1).setValue(SF.safe(value));
};

SF.num = function (v) { var n = Number(v); return isNaN(n) ? 0 : n; };

/**
 * Parse a stored value. SF.settings() already parses anything that looks like
 * JSON, so this has to accept an object as well as a string — feeding an
 * object back through JSON.parse throws, and the caller would silently get
 * the default. That failure mode is why PINs, the shop profile and plugin
 * settings must all come through here rather than JSON.parse directly.
 */
SF.json = function (v, dflt) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || 'null') || dflt; } catch (e) { return dflt; }
};

/* =========================================================================
   2. SETTINGS
   ========================================================================= */

SF.settings = function () {
  var out = {};
  SF.rows('settings').forEach(function (r) {
    out[String(r.Key)] = typeof r.Value === 'string' && r.Value.charAt(0) === '{'
      ? SF.json(r.Value, r.Value) : r.Value;
  });
  return out;
};

SF.get = function (key, dflt) {
  var v = SF.settings()[key];
  return v === undefined || v === '' ? dflt : v;
};

SF.set = function (key, value) {
  var v = (value && typeof value === 'object') ? JSON.stringify(value) : value;
  var all = SF.rows('settings');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].Key) === key) { SF.setCell('settings', all[i]._row, 'Value', v); return; }
  }
  SF.append('settings', { Key: key, Value: v });
};

/** Shop identity and wording, merged over the active preset. */
SF.profile = function () {
  var preset = SF.presets[SF.get('preset', 'general')] || SF.presets.general;
  var stored = SF.json(SF.get('profile', '{}'), {});
  var p = {
    name: 'StallFlow', tagline: '', whatsapp: '',
    colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4',
    preset: SF.get('preset', 'general'),
    vocab: preset.vocab,
    plugins: preset.plugins,
    types: preset.types
  };
  Object.keys(stored).forEach(function (k) { p[k] = stored[k]; });
  if (stored.vocab) {
    p.vocab = {};
    Object.keys(preset.vocab).forEach(function (k) { p.vocab[k] = preset.vocab[k]; });
    Object.keys(stored.vocab).forEach(function (k) { p.vocab[k] = stored.vocab[k]; });
  }
  return p;
};

/* =========================================================================
   3. IDENTITY — roles, PINs, signed device tokens
   -------------------------------------------------------------------------
   A secret URL is not access control. Every write carries a token that this
   server signed; the token names a role, and each action names the capability
   it needs. A cashier's phone cannot change prices even if somebody hands
   them the address.
   ========================================================================= */

SF.ROLES = {
  owner:   ['*'],
  manager: ['sell', 'orders', 'stock', 'price', 'labels', 'reports', 'expenses'],
  cashier: ['sell', 'orders', 'labels'],
  viewer:  ['reports']
};

SF.secret = function () {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SF_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SF_SECRET', s);
  }
  return s;
};

SF.hash = function (value) {
  var raw = Utilities.computeHmacSha256Signature(String(value), SF.secret());
  return raw.map(function (b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');
};

/** Owner sets PINs. Stored hashed — the sheet never holds a readable PIN. */
SF.setPin = function (role, pin) {
  if (!SF.ROLES[role]) return { ok: false, message: 'No such role.' };
  var clean = String(pin || '').replace(/\D/g, '');
  if (clean.length < 4) return { ok: false, message: 'A PIN needs at least 4 digits.' };
  var pins = SF.json(SF.get('pins', '{}'), {});
  pins[role] = SF.hash(role + ':' + clean);
  SF.set('pins', pins);
  return { ok: true };
};

SF.signIn = function (p) {
  if (SF.googleOn()) {
    return { ok: false, message: 'This stall uses Google sign-in now. Refresh the page.' };
  }
  var pin = String(p.pin || '').replace(/\D/g, '');
  var device = String(p.device || '').slice(0, 60) || 'unknown';
  var pins = SF.json(SF.get('pins', '{}'), {});

  if (!Object.keys(pins).length) {
    // Nobody has locked it yet. First run gives owner access so setup is possible.
    return { ok: true, token: SF.mintToken('owner', device), role: 'owner', unlocked: true };
  }
  var role = null;
  Object.keys(pins).forEach(function (r) {
    if (pins[r] === SF.hash(r + ':' + pin)) role = r;
  });
  if (!role) {
    SF.audit({ role: 'anon', device: device }, 'signIn', device, 'wrong PIN', 'refused');
    return { ok: false, message: 'That PIN was not recognised.' };
  }
  SF.audit({ role: role, device: device }, 'signIn', device, '', 'ok');
  return { ok: true, token: SF.mintToken(role, device), role: role };
};

/**
 * role|device|expiry|signature for a PIN sign-in, and
 * role|device|expiry|email|signature for a Google one. The role inside a
 * Google token is only a hint; SF.dispatch looks the person up again.
 */
SF.mintToken = function (role, device, user) {
  var body = role + '|' + device + '|' + (Date.now() + 1000 * 60 * 60 * 24 * 30) +
             (user ? '|' + user : '');
  return body + '|' + SF.hash(body);
};

SF.readToken = function (token) {
  var parts = String(token || '').split('|');
  if (parts.length !== 4 && parts.length !== 5) return null;
  var sig = parts.pop();
  if (SF.hash(parts.join('|')) !== sig) return null;
  if (Number(parts[2]) < Date.now()) return null;
  return { role: parts[0], device: parts[1], user: parts[3] || '' };
};

SF.can = function (role, capability) {
  var caps = SF.ROLES[role] || [];
  return caps.indexOf('*') !== -1 || caps.indexOf(capability) !== -1;
};

/* =========================================================================
   4. AUDIT — append only, and never the customer's phone number
   ========================================================================= */

SF.audit = function (ctx, action, target, detail, outcome) {
  try {
    SF.append('audit', {
      When: new Date(),
      Actor: ctx && ctx.user ? ctx.user
        : (ctx && ctx.role ? ctx.role : 'system') + '@' + (ctx && ctx.device ? ctx.device : '-'),
      Role: ctx && ctx.role ? ctx.role : 'system',
      Device: ctx && ctx.device ? ctx.device : '-',
      Action: action,
      Target: String(target || '').slice(0, 60),
      Detail: String(detail == null ? '' : detail).slice(0, 300),
      Outcome: outcome || 'ok'
    });
  } catch (e) { /* an audit failure must never sink the operation it describes */ }
};

/* =========================================================================
   5. PLUGIN HOST
   -------------------------------------------------------------------------
   A plugin may add actions, transform values through filters, listen to
   events, and declare settings. Core never imports a plugin; plugins register
   themselves, and an unregistered plugin simply is not there.
   ========================================================================= */

SF.registry = { plugins: [], actions: {}, filters: {}, events: {} };

SF.definePlugin = function (spec) {
  if (!spec || !spec.id) throw new Error('A plugin needs an id.');
  SF.registry.plugins.push({
    id: spec.id, name: spec.name || spec.id, version: spec.version || '0.0.0',
    provides: spec.provides || [], settings: spec.settings || []
  });

  // A plugin may bring its own storage. Declared here, created on first use.
  Object.keys(spec.sheets || {}).forEach(function (key) {
    if (SF.SHEETS[key] && String(SF.SHEETS[key]) !== String(spec.sheets[key])) {
      throw new Error('Plugin "' + spec.id + '" redefines the sheet "' + key + '".');
    }
    SF.SHEETS[key] = spec.sheets[key];
  });

  Object.keys(spec.actions || {}).forEach(function (name) {
    if (SF.registry.actions[name]) {
      throw new Error('Two plugins both define the action "' + name + '".');
    }
    SF.registry.actions[name] = { fn: spec.actions[name], plugin: spec.id };
  });

  Object.keys(spec.filters || {}).forEach(function (name) {
    (SF.registry.filters[name] = SF.registry.filters[name] || [])
      .push({ fn: spec.filters[name], plugin: spec.id });
  });

  Object.keys(spec.events || {}).forEach(function (name) {
    (SF.registry.events[name] = SF.registry.events[name] || [])
      .push({ fn: spec.events[name], plugin: spec.id });
  });
};

SF.enabled = function (pluginId) {
  var list = SF.profile().plugins || [];
  return list.indexOf(pluginId) !== -1;
};

/** Run a value through every enabled handler in turn. */
SF.filter = function (name, value, ctx) {
  (SF.registry.filters[name] || []).forEach(function (h) {
    if (!SF.enabled(h.plugin)) return;
    try {
      var out = h.fn(value, ctx);
      if (out !== undefined) value = out;
    } catch (e) {
      SF.audit(ctx, 'plugin.error', h.plugin, name + ': ' + e.message, 'error');
    }
  });
  return value;
};

/** Tell every enabled listener something happened. Never throws. */
SF.emit = function (name, payload, ctx) {
  (SF.registry.events[name] || []).forEach(function (h) {
    if (!SF.enabled(h.plugin)) return;
    try { h.fn(payload, ctx); }
    catch (e) { SF.audit(ctx, 'plugin.error', h.plugin, name + ': ' + e.message, 'error'); }
  });
};

/* =========================================================================
   6. ROUTER
   ========================================================================= */

/**
 * Each entry: [handler, capability, kind]
 *   capability null  -> public, no token needed
 *   kind 'read'      -> no opId, no audit
 *   kind 'write'     -> idempotent by opId, audited
 */
SF.CORE_ACTIONS = {};

SF.action = function (name, capability, kind, fn) {
  SF.CORE_ACTIONS[name] = { fn: fn, capability: capability, kind: kind };
};

SF.dispatch = function (action, p) {
  var def = SF.CORE_ACTIONS[action];
  var fromPlugin = false;

  if (!def && SF.registry.actions[action]) {
    var reg = SF.registry.actions[action];
    if (!SF.enabled(reg.plugin)) {
      return { ok: false, message: 'That feature is switched off for this stall.' };
    }
    def = { fn: reg.fn, capability: 'sell', kind: 'write' };
    fromPlugin = true;
  }
  if (!def) return { ok: false, message: 'Unknown action: ' + action };

  var ctx = { role: 'public', device: '-' };
  if (def.capability) {
    var who = SF.readToken(p.token);
    if (!who) return { ok: false, code: 'auth', message: 'Please sign in again.' };
    if (SF.googleOn()) {
      // Once Google is on, PIN tokens stop working, and a person's role is
      // whatever the Users tab says now, not what it said when they signed in.
      who.role = who.user ? SF.roleOf(who.user) : null;
      if (!who.role) return { ok: false, code: 'auth', message: 'Please sign in again.' };
    }
    if (!SF.can(who.role, def.capability)) {
      SF.audit(who, action, '', 'needs ' + def.capability, 'refused');
      return { ok: false, code: 'forbidden',
               message: 'A ' + who.role + ' cannot do that. Ask the owner.' };
    }
    ctx = who;
  }
  ctx.action = action;

  if (def.kind === 'read') {
    return { ok: true, data: def.fn(p, ctx), at: Date.now() };
  }
  return SF.once(String(p.opId || ''), action, ctx, function () {
    var res = def.fn(p, ctx);
    SF.audit(ctx, action, p.productId || p.orderNo || p.marketId || '',
             res && res.ok === false ? res.message : (res && res.orderNo) || '',
             res && res.ok === false ? 'refused' : 'ok');
    if (fromPlugin) SF.emit('plugin.action', { action: action, result: res }, ctx);
    return res;
  });
};

/**
 * Idempotency gate. A phone that loses signal mid-request will send the same
 * operation again; the second one must return the first one's answer rather
 * than doing the work twice.
 */
SF.once = function (opId, action, ctx, fn) {
  if (!opId) return SF.lock(fn);
  return SF.lock(function () {
    var seen = SF.rows('ops');
    for (var i = 0; i < seen.length; i++) {
      if (String(seen[i].OpId) === opId) {
        var prior = SF.json(seen[i].Result, { ok: true });
        prior.replayed = true;
        return prior;
      }
    }
    var result = fn();
    SF.append('ops', {
      OpId: opId, When: new Date(), Action: action,
      Result: JSON.stringify(result).slice(0, 4000)
    });
    return result;
  });
};

SF.lock = function (fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); }
  catch (e) { return { ok: false, message: 'Busy for a moment — please try again.' }; }
  try { return fn(); } finally { lock.releaseLock(); }
};

/* =========================================================================
   7. HTTP
   ========================================================================= */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.action) return SF.engineRoom();
  return SF.reply(SF.safely(String(p.action), p));
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents || '{}'); }
  catch (err) { return SF.reply({ ok: false, message: 'Could not read that request.' }); }
  return SF.reply(SF.safely(String(body.action || ''), body));
}

SF.safely = function (action, p) {
  try {
    return SF.dispatch(action, p);
  } catch (err) {
    SF.audit({ role: 'system' }, action, '', String(err && err.message || err), 'error');
    return { ok: false, message: 'Something went wrong on our side. It has been logged.' };
  }
};

SF.reply = function (obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
};

SF.url = function () { return ScriptApp.getService().getUrl() || ''; };

SF.engineRoom = function () {
  var pr = SF.profile();
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + pr.name + ' — engine room</title>' +
    '<style>body{font:16px/1.6 system-ui,sans-serif;background:' + pr.paper + ';color:' + pr.ink +
    ';margin:0;padding:40px 22px}main{max-width:620px;margin:0 auto}h1{font-size:22px}' +
    'code{background:#fff;border:1px solid #e5ded6;border-radius:6px;padding:2px 6px;' +
    'font-size:13px;word-break:break-all}.ok{color:#2C7A5A;font-weight:700}</style>' +
    '<main><h1>' + pr.name + ' — engine room</h1>' +
    '<p class="ok">&check; StallFlow ' + SF.VERSION + ' is running (schema ' + SF.SCHEMA + ').</p>' +
    '<p>Nothing to use here. This address holds the data; the screens are the web app.</p>' +
    '<p>Paste this into <code>config.js</code>:</p><p><code>' + SF.url() + '</code></p>' +
    '</main>')
    .setTitle(pr.name + ' — engine room')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
};

/* =========================================================================
   8. MIGRATIONS
   -------------------------------------------------------------------------
   Sheets already carrying a season of trading cannot be recreated, so every
   schema change ships with the step that moves the old shape to the new one.
   ========================================================================= */

SF.MIGRATIONS = [
  { to: 2, what: 'Add the audit trail', run: function () { SF.sheet('audit'); } },
  { to: 3, what: 'Add product type, unit, options and capacity', run: function () {
      var s = SF.sheet('products'), head = SF.SHEETS.products;
      var have = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
      if (have.indexOf('Type') === -1) {
        s.getRange(1, 1, 1, head.length).setValues([head]);
        var last = s.getLastRow();
        if (last > 1) {
          // Everything that existed before types were a thing was stocked.
          for (var r = 2; r <= last; r++) {
            if (!s.getRange(r, head.indexOf('Type') + 1).getValue()) {
              s.getRange(r, head.indexOf('Type') + 1).setValue('stocked');
              s.getRange(r, head.indexOf('Unit') + 1).setValue('each');
            }
          }
        }
      }
    } },
  { to: 4, what: 'Record consent on orders', run: function () {
      var s = SF.sheet('orders'), head = SF.SHEETS.orders;
      var have = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
      if (have.indexOf('Consent') === -1) s.getRange(1, 1, 1, head.length).setValues([head]);
    } },
  { to: 5, what: 'Add the Users tab for Google sign-in', run: function () { SF.sheet('users'); } },
  { to: 6, what: 'Add the Pantry tab for uncooked stock', run: function () { SF.sheet('pantry'); } },
  { to: 7, what: 'Add the Recipes tab for recipes changed in the app', run: function () { SF.sheet('recipes'); } }
];

SF.migrate = function () {
  var from = Number(SF.get('schemaVersion', 0)) || 0;
  var done = [];
  SF.MIGRATIONS.forEach(function (m) {
    if (m.to > from) {
      m.run();
      SF.set('schemaVersion', m.to);
      done.push(m.to + ': ' + m.what);
      SF.audit({ role: 'system' }, 'migrate', 'schema ' + m.to, m.what, 'ok');
    }
  });
  if (from === 0) SF.set('schemaVersion', SF.SCHEMA);
  return done;
};

/* =========================================================================
   9. HEALTH — what an operator needs before trusting the numbers
   ========================================================================= */

SF.action('health', 'reports', 'read', function () {
  var counts = {};
  Object.keys(SF.SHEETS).forEach(function (k) {
    counts[k] = Math.max(0, SF.sheet(k).getLastRow() - 1);
  });

  var problems = [];
  var ids = {};
  SF.rows('products').forEach(function (p) {
    if (ids[p.ProductId]) problems.push('Two products share the id ' + p.ProductId);
    ids[p.ProductId] = true;
    if (!p.Type) problems.push(p.Name + ' has no type set');
  });
  SF.rows('movements').forEach(function (m) {
    if (!ids[m.ProductId]) problems.push('A stock movement points at missing product ' + m.ProductId);
  });
  var negative = [];
  var hand = SF.onHand();
  Object.keys(hand).forEach(function (id) {
    if (hand[id] < 0) negative.push(id);
  });
  if (negative.length) problems.push('Negative stock on: ' + negative.join(', '));

  return {
    version: SF.VERSION,
    schema: { at: Number(SF.get('schemaVersion', 0)), expected: SF.SCHEMA },
    preset: SF.get('preset', 'general'),
    plugins: SF.registry.plugins.map(function (p) {
      return { id: p.id, name: p.name, version: p.version, on: SF.enabled(p.id) };
    }),
    counts: counts,
    locked: SF.googleOn() || Object.keys(SF.json(SF.get('pins', '{}'), {})).length > 0,
    google: SF.googleOn(),
    problems: problems,
    checkedAt: Date.now()
  };
});

// Public: the PIN itself is the credential, so this needs no token.
// Returned inside `data` like any read; the client checks data.ok.
SF.action('signIn', null, 'read', function (p) { return SF.signIn(p); });

SF.action('setPin', 'reports', 'write', function (p, ctx) {
  if (ctx.role !== 'owner') return { ok: false, message: 'Only the owner can set PINs.' };
  if (SF.googleOn()) return { ok: false, message: 'PINs are off. Add people under People.' };
  return SF.setPin(String(p.role), String(p.pin));
});
