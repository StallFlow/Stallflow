/**
 * StallFlow — Presets and bundled plugins
 * ===========================================================================
 * A preset reshapes the whole app for a kind of stall: the words it uses, the
 * product types it offers, the plugins it switches on. A plugin adds actual
 * behaviour and can be switched on or off without touching the core.
 *
 * To add your own plugin: copy one of the three below into a new .gs file and
 * call SF.definePlugin. Nothing in Core or Domain needs to know it exists.
 */

/* =========================================================================
   PRESETS
   ========================================================================= */

SF.presets = {

  general: {
    name: 'General market stall',
    blurb: 'A bit of everything. Start here if none of the others fit.',
    types: ['stocked', 'made', 'weighed'],
    plugins: ['cashup'],
    vocab: { unit: 'item', units: 'items', run: 'batch', runs: 'batches',
             make: 'made', stall: 'stall', maker: 'maker' }
  },

  preserves: {
    name: 'Preserves, bakes and crafts',
    blurb: 'Things you make in a batch at home and bring a finite number of.',
    types: ['stocked'],
    plugins: ['cashup'],
    vocab: { unit: 'jar', units: 'jars', run: 'batch', runs: 'batches',
             make: 'made', stall: 'stall', maker: 'maker' }
  },

  foodcart: {
    name: 'Prepared food and drinks',
    blurb: 'Cooked or poured to order, limited by how fast you can make it.',
    types: ['made', 'stocked'],
    plugins: ['kitchen', 'cashup'],
    vocab: { unit: 'order', units: 'orders', run: 'prep run', runs: 'prep runs',
             make: 'served', stall: 'cart', maker: 'cook' }
  },

  deli: {
    name: 'Weighed goods',
    blurb: 'Sold by mass — biltong, cheese, nuts, loose produce.',
    types: ['weighed', 'stocked'],
    plugins: ['scale', 'cashup'],
    vocab: { unit: 'portion', units: 'portions', run: 'batch', runs: 'batches',
             make: 'made', stall: 'stall', maker: 'maker' }
  }
};

SF.action('presets', 'reports', 'read', function () {
  var out = {};
  Object.keys(SF.presets).forEach(function (k) {
    out[k] = { name: SF.presets[k].name, blurb: SF.presets[k].blurb,
               types: SF.presets[k].types, plugins: SF.presets[k].plugins };
  });
  return { presets: out, active: SF.get('preset', 'general') };
});

SF.action('applyPreset', 'reports', 'write', function (p, ctx) {
  if (ctx.role !== 'owner') return { ok: false, message: 'Only the owner can change the preset.' };
  var key = String(p.preset || '');
  if (!SF.presets[key]) return { ok: false, message: 'No such preset.' };
  SF.set('preset', key);
  // Wording and plugin choice come from the preset again unless overridden.
  var stored = SF.json(SF.get('profile', '{}'), {});
  delete stored.vocab;
  delete stored.plugins;
  SF.set('profile', stored);
  SF.audit(ctx, 'applyPreset', key, SF.presets[key].name, 'ok');
  return { ok: true, preset: key };
});

/* =========================================================================
   PLUGIN — Scale
   -------------------------------------------------------------------------
   Makes weighed goods behave properly: a minimum sale, sensible rounding, and
   a price-per-portion lookup the till uses for its weight pad.
   ========================================================================= */

SF.definePlugin({
  id: 'scale',
  name: 'Scale & weighed goods',
  version: '1.0.0',
  provides: ['weighed selling', 'price lookup by weight'],
  settings: [
    { key: 'minimum', label: 'Smallest sale', type: 'number', default: 0.05,
      help: 'In the product’s own unit. 0.05 kg is 50 g.' },
    { key: 'roundTo', label: 'Round weight to', type: 'number', default: 0.005,
      help: 'Most market scales read to 5 g.' }
  ],

  filters: {
    // Every weighed line passes through here before it is priced.
    'line.priced': function (line) {
      if (!line || line.type !== 'weighed') return line;
      var s = SF.pluginSettings('scale');
      var round = Number(s.roundTo) || 0.005;
      var min = Number(s.minimum) || 0;
      line.qty = Math.round(line.qty / round) * round;
      line.qty = Math.round(line.qty * 1000) / 1000;
      if (min && line.qty > 0 && line.qty < min) line.qty = min;
      line.units = line.qty;
      line.total = Math.round(line.price * line.qty * 100) / 100;
      return line;
    }
  },

  actions: {
    'scale.quote': function (p) {
      var product = SF.byId(SF.products(), p.productId);
      if (!product) return { ok: false, message: 'Product not found.' };
      var line = SF.priceLine(product, { qty: SF.num(p.qty) }, {});
      return { ok: true, qty: line.qty, unit: product.unit, total: line.total };
    }
  }
});

/* =========================================================================
   PLUGIN — Kitchen
   -------------------------------------------------------------------------
   For food carts: a make-list in the order it was ordered, and a per-market
   capacity so the page stops taking orders you cannot cook.
   ========================================================================= */

SF.definePlugin({
  id: 'kitchen',
  name: 'Kitchen board',
  version: '1.0.0',
  provides: ['prep queue', 'capacity limits'],
  settings: [
    { key: 'warnAt', label: 'Warn when this many are waiting', type: 'number', default: 6 }
  ],

  actions: {
    'kitchen.board': function () {
      var market = SF.activeMarket();
      var orders = SF.orders().filter(function (o) {
        return o.marketId === market && o.status !== 'cancelled' && o.status !== 'collected';
      }).sort(function (a, b) { return a.when - b.when; });

      var tickets = [], making = {};
      orders.forEach(function (o) {
        var items = o.lines.filter(function (l) { return l.type === 'made'; });
        if (!items.length) return;
        items.forEach(function (l) { making[l.name] = (making[l.name] || 0) + l.qty; });
        tickets.push({
          no: o.no, customer: o.customer, when: o.when, time: o.time,
          paid: o.status !== 'reserved', items: items
        });
      });

      return {
        ok: true,
        tickets: tickets,
        totals: Object.keys(making).map(function (k) { return { name: k, qty: making[k] }; })
                      .sort(function (a, b) { return b.qty - a.qty; }),
        warnAt: Number(SF.pluginSettings('kitchen').warnAt) || 6
      };
    }
  },

  events: {
    'order.placed': function (payload, ctx) {
      var made = (payload.lines || []).filter(function (l) { return l.type === 'made'; });
      if (made.length) SF.audit(ctx, 'kitchen.ticket', payload.orderNo,
        made.map(function (l) { return l.qty + '× ' + l.name; }).join(', '), 'ok');
    }
  }
});

/* =========================================================================
   PLUGIN — Cash-up
   -------------------------------------------------------------------------
   The end-of-day count. What the till says you took, what is actually in the
   tin, and the difference written down before anybody goes home.
   ========================================================================= */

SF.definePlugin({
  id: 'cashup',
  name: 'Cash-up',
  version: '1.0.0',
  provides: ['end of day reconciliation'],
  sheets: {
    cashups: ['CashupId', 'When', 'MarketId', 'Float', 'Expected', 'Counted',
              'Difference', 'By', 'Note']
  },
  settings: [
    { key: 'float', label: 'Cash float you start with', type: 'number', default: 200 },
    { key: 'tolerance', label: 'Difference to accept without a note', type: 'number', default: 20 }
  ],

  actions: {
    'cashup.expected': function () {
      var market = SF.activeMarket();
      var cash = 0, other = 0;
      SF.orders().forEach(function (o) {
        if (o.marketId !== market) return;
        if (o.status !== 'paid' && o.status !== 'collected') return;
        // Everything is cash unless a payments plugin says otherwise.
        var method = SF.filter('order.method', 'cash', { orderNo: o.no });
        if (method === 'cash') cash += o.total; else other += o.total;
      });
      var s = SF.pluginSettings('cashup');
      return { ok: true, marketId: market, cash: cash, other: other,
               float: Number(s.float) || 0,
               expectedInTin: cash + (Number(s.float) || 0),
               tolerance: Number(s.tolerance) || 0,
               history: SF.rows('cashups').slice(-5).reverse().map(function (r) {
                 return { id: String(r.CashupId), marketId: String(r.MarketId),
                          expected: SF.num(r.Expected), counted: SF.num(r.Counted),
                          difference: SF.num(r.Difference), by: String(r.By) };
               }) };
    },

    'cashup.record': function (p, ctx) {
      var counted = SF.num(p.counted);
      if (counted < 0) return { ok: false, message: 'Enter what is in the tin.' };
      var s = SF.pluginSettings('cashup');
      var float = Number(s.float) || 0;
      var tolerance = Number(s.tolerance) || 0;

      var cash = 0;
      var market = SF.activeMarket();
      SF.orders().forEach(function (o) {
        if (o.marketId !== market) return;
        if (o.status !== 'paid' && o.status !== 'collected') return;
        cash += o.total;
      });
      var expected = cash + float;
      var diff = Math.round((counted - expected) * 100) / 100;
      var note = String(p.note || '').slice(0, 200);

      if (Math.abs(diff) > tolerance && !note) {
        return { ok: false,
                 message: 'That is ' + (diff < 0 ? 'short' : 'over') + ' by R ' +
                          Math.abs(diff).toFixed(2) + '. Write a note before saving.' };
      }

      var id = 'C-' + ('000' + (SF.rows('cashups').length + 1)).slice(-3);
      SF.append('cashups', {
        CashupId: id, When: new Date(), MarketId: market, Float: float,
        Expected: expected, Counted: counted, Difference: diff,
        By: ctx.role + '@' + ctx.device, Note: note
      });
      SF.audit(ctx, 'cashup', market, 'expected ' + expected + ', counted ' + counted +
               ', diff ' + diff, Math.abs(diff) > tolerance ? 'variance' : 'ok');
      return { ok: true, id: id, expected: expected, counted: counted, difference: diff };
    }
  }
});

/** Settings for one plugin, defaults filled in. */
SF.pluginSettings = function (pluginId) {
  var all = SF.json(SF.get('pluginSettings', '{}'), {});
  var saved = all[pluginId] || {};
  var out = {};
  SF.registry.plugins.forEach(function (p) {
    if (p.id !== pluginId) return;
    (p.settings || []).forEach(function (s) {
      out[s.key] = saved[s.key] !== undefined ? saved[s.key] : s.default;
    });
  });
  Object.keys(saved).forEach(function (k) { if (out[k] === undefined) out[k] = saved[k]; });
  return out;
};

/* =========================================================================
   SETUP, MENU AND DEMO DATA
   ========================================================================= */

function onOpen() {
  var menu = SpreadsheetApp.getUi().createMenu('StallFlow')
    .addItem('Set up / upgrade', 'sfSetup')
    .addItem('Choose a market type…', 'sfChoosePreset')
    .addSeparator();

  // A tenant file (e.g. Duxies.gs) adds itself here just by existing.
  if (typeof sfSeedTenant === 'function') menu.addItem('Load this stall', 'sfSeedTenant');
  if (typeof sfPractiseStock === 'function') menu.addItem('Add practice stock', 'sfPractiseStock');

  menu.addItem('Load the sample stall', 'sfDemo')
    .addItem('Show my web address', 'sfLinks')
    .addSeparator()
    .addItem('Health check', 'sfHealth')
    .addItem('Check Google sign-in', 'sfCheckGoogle')
    .addItem('Delete past customers\' details', 'sfPurge')
    .addItem('Export orders', 'sfExport')
    .addItem('Clear trading data', 'sfClear')
    .addToUi();
}

function sfSetup() {
  var done = SF.migrate();
  Object.keys(SF.SHEETS).forEach(function (k) {
    var s = SF.sheet(k), head = SF.SHEETS[k];
    s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold')
      .setBackground(SF.profile().colour).setFontColor('#FFFFFF');
    s.setFrozenRows(1);
  });
  if (!SF.get('preordersOpen')) SF.set('preordersOpen', 'yes');
  if (!SF.get('preset')) SF.set('preset', 'general');
  SF.audit({ role: 'system' }, 'setup', '', done.join('; '), 'ok');
  SpreadsheetApp.getUi().alert('StallFlow ' + SF.VERSION + ' is set up.' +
    (done.length ? '\n\nUpgrades applied:\n• ' + done.join('\n• ') : '') +
    '\n\nNext: StallFlow > Choose a market type.');
}

function sfChoosePreset() {
  var ui = SpreadsheetApp.getUi();
  var keys = Object.keys(SF.presets);
  var list = keys.map(function (k, i) {
    return (i + 1) + '. ' + SF.presets[k].name + ' — ' + SF.presets[k].blurb;
  }).join('\n');
  var res = ui.prompt('What kind of stall is this?',
    list + '\n\nType the number:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var n = parseInt(res.getResponseText(), 10);
  if (!n || n < 1 || n > keys.length) { ui.alert('That was not one of the numbers.'); return; }
  SF.set('preset', keys[n - 1]);
  var stored = SF.json(SF.get('profile', '{}'), {});
  delete stored.vocab; delete stored.plugins;
  SF.set('profile', stored);
  ui.alert('Set to "' + SF.presets[keys[n - 1]].name + '".\n\nPlugins on: ' +
           SF.presets[keys[n - 1]].plugins.join(', '));
}

function sfLinks() {
  var url = SF.url();
  SpreadsheetApp.getUi().alert(url
    ? 'Paste this into config.js as the "api" value:\n\n' + url
    : 'Not deployed yet. Deploy > New deployment first.');
}

function sfHealth() {
  // Called from the sheet's own menu, so whoever clicked it already has the
  // sheet open; there is no phone and no token to check.
  var h = SF.CORE_ACTIONS.health.fn({}, { role: 'owner', device: 'sheet' });
  SpreadsheetApp.getUi().alert(
    'StallFlow ' + h.version + '\n' +
    'Schema ' + h.schema.at + ' of ' + h.schema.expected + '\n' +
    'Market type: ' + h.preset + '\n' +
    'Sign-in: ' + (h.google ? 'Google' : h.locked ? 'PINs' :
                   'OFF — anyone with the link is an owner') + '\n\n' +
    'Plugins:\n• ' + h.plugins.map(function (p) {
      return p.name + ' ' + p.version + (p.on ? '' : ' (off)'); }).join('\n• ') + '\n\n' +
    (h.problems.length ? 'Problems:\n• ' + h.problems.join('\n• ') : 'No problems found.'));
}

function sfExport() {
  var name = 'Orders ' + Utilities.formatDate(new Date(), SF.TZ, 'yyyy-MM-dd HHmm');
  var s = SpreadsheetApp.getActiveSpreadsheet().insertSheet(name);
  var head = ['Order', 'When', 'Market', 'Channel', 'Customer', 'Item', 'Type',
              'Qty', 'Unit', 'Line total', 'Status'];
  var out = [head];
  SF.orders().forEach(function (o) {
    o.lines.forEach(function (l) {
      out.push([o.no, o.time, o.marketId, o.channel, o.customer, l.name, l.type,
                l.units || l.qty, l.unit || 'each', l.total, o.status]);
    });
  });
  s.getRange(1, 1, out.length, head.length).setValues(out);
  s.getRange(1, 1, 1, head.length).setFontWeight('bold')
    .setBackground(SF.profile().colour).setFontColor('#FFFFFF');
  s.setFrozenRows(1);
  SpreadsheetApp.getUi().alert('Exported to "' + name + '".');
}

function sfClear() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Wipe orders, batches, movements, expenses, cash-ups and the retry log? ' +
      'Products, markets and the audit trail stay.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ['orders', 'batches', 'movements', 'expenses', 'ops', 'cashups'].forEach(function (k) {
    if (!SF.SHEETS[k]) return;
    var s = SF.sheet(k);
    if (s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1);
  });
  SF.audit({ role: 'owner', device: 'sheet' }, 'clearTrading', '', '', 'ok');
  ui.alert('Cleared.');
}

/**
 * A sample stall showing all three product types at once. Useful for a demo or
 * for trying the platform; a real stall gets its own tenant file instead.
 */
function sfDemo() {
  var ui = SpreadsheetApp.getUi();
  if (SF.rows('products').length &&
      ui.alert('There are already products. Load the sample anyway?',
               ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  sfSetup();

  SF.set('preset', 'general');
  SF.set('orderPrefix', 'S');
  SF.set('profile', { name: 'THE SAMPLE STALL', tagline: 'One of everything, to try it out',
                      colour: '#7B2D43', ink: '#221A1C', paper: '#FCF8F4' });

  var demo = [
    // name, variant, type, unit, price, category, capacity, cost lines, made
    ['Strawberry Jam', '340g', 'stocked', 'each', 65, 'Preserves', 0,
      [['Strawberries', 260], ['Sugar', 70], ['Jars & lids', 216]], 24],
    ['Knitted animal', 'small', 'stocked', 'each', 180, 'Crafts', 0,
      [['Wool', 260], ['Stuffing', 55]], 8],
    ['Filter coffee', '', 'made', 'each', 30, 'Drinks', 40,
      [['Beans', 180], ['Milk', 60], ['Cups & lids', 120]], 40],
    ['Beef biltong', 'sliced', 'weighed', 'kg', 480, 'Deli', 0,
      [['Silverside', 900], ['Spice', 60]], 6]
  ];

  demo.forEach(function (d, i) {
    var id = 'P' + ('00' + (i + 1)).slice(-2);
    SF.append('products', {
      ProductId: id, Name: d[0], Variant: d[1], Type: d[2], Category: d[5],
      Unit: d[3], Price: d[4], Capacity: d[6], Options: '[]', Active: 'Yes',
      Sort: (i + 1) * 10
    });
    var lines = d[7].map(function (l) { return { label: l[0], amount: l[1] }; });
    var total = lines.reduce(function (a, l) { return a + l.amount; }, 0);
    var batchId = 'B-' + ('000' + (i + 1)).slice(-3);
    SF.append('batches', {
      BatchId: batchId, When: new Date(), ProductId: id, Made: d[8],
      CostLines: JSON.stringify(lines), TotalCost: total,
      CostPerUnit: Math.round(total / d[8] * 10000) / 10000, Note: 'Sample'
    });
    if (d[2] !== 'made') {
      SF.append('movements', {
        When: new Date(), ProductId: id, Qty: d[8], Type: 'batch', Ref: batchId, MarketId: ''
      });
    }
  });

  SF.append('markets', {
    MarketId: 'M01', Name: 'Saturday Market', Date: '', Location: 'Town square',
    Status: 'planned', Note: ''
  });
  SF.set('activeMarket', 'M01');
  SF.set('preordersOpen', 'yes');
  [['Stall fee', 250, 'Stall'], ['Petrol', 120, 'Travel']].forEach(function (x, i) {
    SF.append('expenses', {
      ExpenseId: 'E-' + ('000' + (i + 1)).slice(-3), MarketId: 'M01',
      Description: x[0], Amount: x[1], Category: x[2], When: new Date()
    });
  });

  ui.alert('Sample stall loaded — one stocked, one made-to-order, one weighed.' +
    '\n\nEvery figure in it is invented. Clear it before trading.');
}

function sfPurge() {
  var n = SF.purgeCustomers();
  SpreadsheetApp.getUi().alert(n + ' finished orders had their customer details removed.');
}
