/**
 * StallFlow — Domain
 * ===========================================================================
 * Catalogue, availability, orders, costing and the market view.
 *
 * Three product types, because three shapes of stall cover almost every market:
 *
 *   stocked   a finite count you made in advance   jam, knitting, resin, bakes
 *   made      cooked to order, limited by capacity  coffee, boerewors rolls
 *   weighed   priced by mass, sold in any amount    biltong, cheese, loose produce
 *
 * They differ in exactly one place — what "available" means — and share
 * everything else. Costing is the same sum for all three: what a run cost,
 * divided by what it produced.
 */

/* =========================================================================
   1. CATALOGUE
   ========================================================================= */

SF.UNITS = {
  each:   { label: 'each',   step: 1,    dp: 0, weighed: false },
  kg:     { label: 'kg',     step: 0.01, dp: 3, weighed: true },
  '100g': { label: '100 g',  step: 1,    dp: 0, weighed: true },
  litre:  { label: 'litre',  step: 0.1,  dp: 2, weighed: true }
};

SF.onHand = function () {
  var out = {};
  SF.rows('movements').forEach(function (m) {
    var id = String(m.ProductId);
    out[id] = (out[id] || 0) + SF.num(m.Qty);
  });
  return out;
};

/** Cost per unit: everything a run cost, over everything it produced. */
SF.costPerUnit = function () {
  var totals = {};
  SF.rows('batches').forEach(function (b) {
    var id = String(b.ProductId);
    if (!totals[id]) totals[id] = { cost: 0, made: 0 };
    totals[id].cost += SF.num(b.TotalCost);
    totals[id].made += SF.num(b.Made);
  });
  var out = {};
  Object.keys(totals).forEach(function (id) {
    out[id] = totals[id].made > 0 ? totals[id].cost / totals[id].made : 0;
  });
  return out;
};

/** How many of each `made` product have gone out at this market already. */
SF.madeSoFar = function (marketId) {
  var out = {};
  SF.rows('orders').forEach(function (o) {
    if (String(o.MarketId) !== String(marketId)) return;
    var status = String(o.Status);
    if (status === 'cancelled') return;
    SF.json(o.Lines, []).forEach(function (l) {
      out[l.id] = (out[l.id] || 0) + SF.num(l.qty);
    });
  });
  return out;
};

SF.products = function (opts) {
  opts = opts || {};
  var hand = SF.onHand(), cost = SF.costPerUnit();
  var made = SF.madeSoFar(SF.activeMarket());

  return SF.rows('products')
    .filter(function (p) {
      return opts.all || String(p.Active).toLowerCase() !== 'no';
    })
    .map(function (p) {
      var id = String(p.ProductId);
      var type = String(p.Type || 'stocked');
      var unit = String(p.Unit || 'each');
      var price = SF.num(p.Price);
      var unitCost = cost[id] || 0;
      var capacity = SF.num(p.Capacity);

      var available, cap = null;
      if (type === 'made') {
        cap = capacity > 0 ? capacity : null;
        available = cap === null ? Infinity : Math.max(0, cap - (made[id] || 0));
      } else {
        available = hand[id] || 0;
      }

      return {
        id: id, row: p._row,
        name: String(p.Name),
        variant: String(p.Variant || ''),
        type: type,
        category: String(p.Category || ''),
        unit: unit,
        weighed: !!(SF.UNITS[unit] && SF.UNITS[unit].weighed),
        price: price,
        capacity: cap,
        options: SF.json(p.Options, []),
        active: String(p.Active).toLowerCase() !== 'no',
        sort: SF.num(p.Sort),
        available: available === Infinity ? null : available,
        onHand: hand[id] || 0,
        cost: unitCost,
        margin: price - unitCost,
        marginPct: price > 0 ? (price - unitCost) / price * 100 : 0
      };
    })
    .sort(function (a, b) {
      return a.sort - b.sort || a.name.localeCompare(b.name);
    });
};

SF.byId = function (list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return list[i];
  return null;
};

SF.move = function (productId, qty, type, ref) {
  SF.append('movements', {
    When: new Date(), ProductId: productId, Qty: qty, Type: type,
    Ref: ref || '', MarketId: SF.activeMarket()
  });
};

/* =========================================================================
   2. PRICING A LINE
   -------------------------------------------------------------------------
   One place decides what a line costs, whatever the product type, so the
   till, the order page and the reports can never disagree.
   ========================================================================= */

SF.priceLine = function (product, line, ctx) {
  var qty = SF.num(line.qty) || 0;
  var priced = { id: product.id, name: product.name, type: product.type,
                 unit: product.unit, qty: qty, price: product.price,
                 options: [], note: String(line.note || '').slice(0, 80) };

  if (product.type === 'weighed') {
    // qty is the measured amount in the product's own unit.
    priced.qty = Math.round(qty * 1000) / 1000;
    priced.total = product.price * priced.qty;
    priced.units = priced.qty;
  } else {
    priced.qty = Math.floor(qty);
    var extra = 0;
    (line.options || []).forEach(function (chosen) {
      var group = null;
      (product.options || []).forEach(function (g) { if (g.id === chosen.group) group = g; });
      if (!group) return;
      var choice = null;
      (group.choices || []).forEach(function (c) { if (c.id === chosen.choice) choice = c; });
      if (!choice) return;
      extra += SF.num(choice.delta);
      priced.options.push({ group: group.name, choice: choice.name, delta: SF.num(choice.delta) });
    });
    priced.each = product.price + extra;
    priced.total = priced.each * priced.qty;
    priced.units = priced.qty;
  }

  priced.cost = (product.cost || 0) * priced.units;
  priced.total = Math.round(priced.total * 100) / 100;
  return SF.filter('line.priced', priced, ctx);
};

/** Shared by the order page and the till. Returns {ok, lines, units, total, cost}. */
SF.buildLines = function (rawLines, ctx, opts) {
  opts = opts || {};
  var catalogue = SF.products();
  var out = [], units = 0, total = 0, cost = 0;

  for (var i = 0; i < (rawLines || []).length; i++) {
    var raw = rawLines[i];
    var product = SF.byId(catalogue, raw.id);
    if (!product) continue;
    if (SF.num(raw.qty) <= 0) continue;

    var priced = SF.priceLine(product, raw, ctx);
    if (priced.units <= 0) continue;

    var free = product.available;
    if (free !== null && priced.units > free + 1e-9) {
      var word = product.type === 'made' ? 'left to make today' : 'left';
      return {
        ok: false,
        message: free <= 0
          ? product.name + ' is finished for today.'
          : 'Only ' + SF.showQty(free, product.unit) + ' of ' + product.name + ' ' + word + '.'
      };
    }
    if (opts.max && product.type !== 'weighed' && priced.qty > opts.max) {
      return { ok: false, message: 'You can reserve up to ' + opts.max + ' of any one thing.' };
    }

    out.push(priced);
    units += priced.units;
    total += priced.total;
    cost += priced.cost;
  }
  if (!out.length) return { ok: false, message: 'Nothing on the order.' };
  return { ok: true, lines: out, units: Math.round(units * 1000) / 1000,
           total: Math.round(total * 100) / 100, cost: Math.round(cost * 100) / 100 };
};

SF.showQty = function (n, unit) {
  var u = SF.UNITS[unit] || SF.UNITS.each;
  return u.weighed ? (Math.round(n * 1000) / 1000) + ' ' + u.label : String(Math.round(n));
};

/* =========================================================================
   3. MARKETS
   ========================================================================= */

SF.activeMarket = function () { return String(SF.get('activeMarket', '')); };

/**
 * Sales made away from a market (at home, to a friend, over WhatsApp) are
 * kept under this id, so they count in the totals without landing on
 * whichever market happens to be live. It is not a row in Markets.
 */
SF.HOME = 'HOME';

SF.markets = function () {
  return SF.rows('markets').map(function (m) {
    return {
      id: String(m.MarketId), row: m._row, name: String(m.Name),
      date: m.Date instanceof Date
        ? Utilities.formatDate(m.Date, SF.TZ, 'yyyy-MM-dd') : String(m.Date || ''),
      location: String(m.Location || ''),
      status: String(m.Status || 'planned'),
      note: String(m.Note || '')
    };
  }).concat([{ id: SF.HOME, row: null, name: 'Sales between markets', date: '',
               location: '', status: 'ongoing', note: '' }]);
};

SF.today = function () { return Utilities.formatDate(new Date(), SF.TZ, 'yyyy-MM-dd'); };

/** The live market has a date and it is already behind us. */
SF.marketPassed = function () {
  var id = SF.activeMarket(), passed = false;
  SF.markets().forEach(function (m) {
    if (m.id === id && /^\d{4}-\d{2}-\d{2}$/.test(m.date) && m.date < SF.today()) passed = true;
  });
  return passed;
};

/** Open only when switched on AND the live market has not been and gone. */
SF.preordersOpen = function () {
  return String(SF.get('preordersOpen', 'yes')).toLowerCase() !== 'no' && !SF.marketPassed();
};

SF.MAX_OPEN_PER_PHONE = 2;

/**
 * Wipe customer names, numbers and notes from orders of markets that are
 * over: not the live market, and dated before today (or undated). The order
 * itself stays, so the numbers still add up. The order page promises this.
 */
SF.purgeCustomers = function () {
  var live = SF.activeMarket(), today = SF.today(), over = {};
  SF.markets().forEach(function (m) {
    if (m.id !== live && (!m.date || m.date < today)) over[m.id] = true;
  });
  var n = 0;
  SF.rows('orders').forEach(function (o) {
    if (!over[String(o.MarketId)] || String(o.Channel) !== 'preorder') return;
    if (!o.Phone && String(o.Customer) === 'Customer') return;
    SF.setCell('orders', o._row, 'Customer', 'Customer');
    SF.setCell('orders', o._row, 'Phone', '');
    SF.setCell('orders', o._row, 'Note', '');
    n++;
  });
  SF.set('lastPurge', today);
  if (n) SF.audit({ role: 'system' }, 'purgeCustomers', '', n + ' orders', 'ok');
  return n;
};

/* =========================================================================
   4. ORDERS
   ========================================================================= */

SF.orders = function () {
  return SF.rows('orders').map(function (o) {
    return {
      no: String(o.OrderNo), row: o._row,
      when: o.When instanceof Date ? o.When.getTime() : 0,
      time: o.When instanceof Date ? Utilities.formatDate(o.When, SF.TZ, 'HH:mm') : '',
      marketId: String(o.MarketId || ''),
      channel: String(o.Channel || 'preorder'),
      customer: String(o.Customer || ''),
      phone: String(o.Phone || '').replace(/^'/, ''),
      lines: SF.json(o.Lines, []),
      units: SF.num(o.Units), total: SF.num(o.Total), cost: SF.num(o.Cost),
      status: String(o.Status || 'reserved'),
      note: String(o.Note || '')
    };
  });
};

SF.findOrder = function (no) {
  var all = SF.orders();
  for (var i = 0; i < all.length; i++) if (all[i].no === String(no)) return all[i];
  return null;
};

SF.nextOrderNo = function () {
  var prefix = String(SF.get('orderPrefix', 'S')).slice(0, 3);
  return prefix + '-' + ('000' + (SF.rows('orders').length + 1)).slice(-3);
};

/**
 * Stocked and weighed goods come off the shelf when the order is taken, so a
 * reservation is real. Made-to-order items are capacity, not stock, so they
 * are counted from the orders themselves and never touch the ledger.
 */
SF.commitLines = function (lines, ref, direction) {
  var catalogue = SF.products({ all: true });
  lines.forEach(function (l) {
    var p = SF.byId(catalogue, l.id);
    if (!p || p.type === 'made') return;
    SF.move(l.id, direction * l.units, direction < 0 ? 'sale' : 'return', ref);
  });
};

/* =========================================================================
   5. ACTIONS — public
   ========================================================================= */

SF.action('catalogue', null, 'read', function () {
  var pr = SF.profile();
  var market = null;
  SF.markets().forEach(function (m) { if (m.id === SF.activeMarket()) market = m; });

  return {
    profile: {
      name: pr.name, tagline: pr.tagline, whatsapp: pr.whatsapp,
      colour: pr.colour, ink: pr.ink, paper: pr.paper, vocab: pr.vocab
    },
    open: SF.preordersOpen(),
    market: market,
    maxPerLine: SF.num(SF.get('maxPerLine', 12)) || 12,
    consentText: SF.get('consentText',
      'We keep your name and number only to hand your order over on the day, ' +
      'and delete it after the market.'),
    products: SF.products().map(function (p) {
      return {
        id: p.id, name: p.name, variant: p.variant, category: p.category,
        type: p.type, unit: p.unit, weighed: p.weighed, price: p.price,
        options: p.options, available: p.available
      };
    })
  };
});

SF.action('placeOrder', null, 'write', function (p, ctx) {
  var name = String(p.name || '').trim().slice(0, 60);
  var phone = String(p.phone || '').trim().slice(0, 25);

  if (name.length < 2) return { ok: false, message: 'We still need your name.' };
  if (phone.replace(/\D/g, '').length < 9) return { ok: false, message: 'We need a working phone number.' };
  if (!p.consent) return { ok: false, message: 'Please tick the box so we may keep your details for the day.' };
  if (!SF.preordersOpen()) {
    return { ok: false, message: 'Pre-orders are closed. Come by the stall — we always keep some back.' };
  }
  var digits = phone.replace(/\D/g, ''), open = 0, market = SF.activeMarket();
  SF.orders().forEach(function (o) {
    if (o.marketId === market && o.status === 'reserved' &&
        o.phone.replace(/\D/g, '') === digits) open++;
  });
  if (open >= SF.MAX_OPEN_PER_PHONE) {
    return { ok: false, message: 'This number already has ' + open + ' orders waiting. ' +
                                 'Collect those first, or message the stall.' };
  }

  var built = SF.buildLines(p.lines, ctx, { max: SF.num(SF.get('maxPerLine', 12)) || 12 });
  if (!built.ok) return built;

  var no = SF.nextOrderNo();
  SF.append('orders', {
    OrderNo: no, When: new Date(), MarketId: SF.activeMarket(), Channel: 'preorder',
    Customer: name, Phone: "'" + phone, Lines: JSON.stringify(built.lines),
    Units: built.units, Total: built.total, Cost: built.cost, Status: 'reserved',
    PaidAt: '', CollectedAt: '', Note: String(p.note || '').slice(0, 140),
    Consent: new Date()
  });
  SF.commitLines(built.lines, no, -1);
  SF.emit('order.placed', { orderNo: no, total: built.total, lines: built.lines }, ctx);

  return { ok: true, orderNo: no, total: built.total, units: built.units, name: name };
});

/* =========================================================================
   6. ACTIONS — till and queue
   ========================================================================= */

/**
 * Where a till sale belongs. Several markets can run on the same day, so each
 * phone says which one it is at; anything unknown falls back to the live one.
 */
SF.sellMarket = function (id) {
  id = String(id || '');
  if (id === 'home') return SF.HOME;
  return id && SF.markets().some(function (m) { return m.id === id; }) ? id : SF.activeMarket();
};

/** Markets a salesperson might be standing at: today onwards, plus between markets. */
SF.sellableMarkets = function () {
  var today = SF.today(), live = SF.activeMarket();
  return SF.markets().filter(function (m) {
    return m.id === SF.HOME || m.id === live || !m.date || m.date >= today;
  }).map(function (m) { return { id: m.id, name: m.name, date: m.date }; });
};

SF.action('till', 'sell', 'read', function (p) {
  var market = SF.sellMarket(p && p.marketId);
  var orders = SF.orders().filter(function (o) {
    return o.marketId === market && o.status !== 'cancelled';
  });

  var t = { takings: 0, units: 0, orders: 0, preTotal: 0, preCount: 0, tillTotal: 0, tillCount: 0 };
  orders.forEach(function (o) {
    if (o.status === 'paid' || o.status === 'collected') {
      t.takings += o.total; t.units += o.units; t.orders++;
      if (o.channel === 'till') { t.tillTotal += o.total; t.tillCount++; }
      else { t.preTotal += o.total; t.preCount++; }
    }
  });

  return {
    products: SF.products().map(function (p) {
      return { id: p.id, name: p.name, variant: p.variant, category: p.category,
               type: p.type, unit: p.unit, weighed: p.weighed, price: p.price,
               options: p.options, available: p.available };
    }),
    unpaid: orders.filter(function (o) { return o.status === 'reserved'; })
                  .sort(function (a, b) { return a.when - b.when; }),
    totals: t,
    marketId: market,
    markets: SF.sellableMarkets()
  };
});

SF.action('sell', 'sell', 'write', function (p, ctx) {
  var built = SF.buildLines(p.lines, ctx, {});
  if (!built.ok) return built;

  var no = SF.nextOrderNo(), now = new Date();
  var mid = SF.sellMarket(p.marketId || p.where), home = mid === SF.HOME;
  SF.append('orders', {
    OrderNo: no, When: now, MarketId: mid, Channel: 'till',
    Customer: String(p.customer || (home ? 'Between markets' : 'Walk-up')).slice(0, 60), Phone: '',
    Lines: JSON.stringify(built.lines), Units: built.units, Total: built.total,
    Cost: built.cost, Status: 'collected', PaidAt: now, CollectedAt: now,
    Note: '', Consent: ''
  });
  SF.commitLines(built.lines, no, -1);
  SF.emit('order.completed', { orderNo: no, total: built.total, lines: built.lines,
                               channel: 'till' }, ctx);

  return { ok: true, orderNo: no, total: built.total, units: built.units };
});

SF.action('markPaid', 'sell', 'write', function (p, ctx) {
  var o = SF.findOrder(p.orderNo);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'cancelled') return { ok: false, message: 'That order was cancelled.' };
  SF.setCell('orders', o.row, 'Status', o.status === 'collected' ? 'collected' : 'paid');
  SF.setCell('orders', o.row, 'PaidAt', new Date());
  SF.emit('order.paid', { orderNo: o.no, total: o.total }, ctx);
  return { ok: true };
});

SF.action('markCollected', 'sell', 'write', function (p, ctx) {
  var o = SF.findOrder(p.orderNo);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'reserved') return { ok: false, message: 'Take the money first.' };
  SF.setCell('orders', o.row, 'Status', 'collected');
  SF.setCell('orders', o.row, 'CollectedAt', new Date());
  SF.emit('order.completed', { orderNo: o.no, total: o.total, lines: o.lines,
                               channel: 'preorder' }, ctx);
  return { ok: true };
});

SF.action('cancelOrder', 'orders', 'write', function (p, ctx) {
  var o = SF.findOrder(p.orderNo);
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'cancelled') return { ok: true };
  SF.commitLines(o.lines, o.no, 1);
  SF.setCell('orders', o.row, 'Status', 'cancelled');
  SF.emit('order.cancelled', { orderNo: o.no }, ctx);
  return { ok: true };
});

SF.action('queue', 'orders', 'read', function () {
  var market = SF.activeMarket();
  var all = SF.orders().filter(function (o) {
    return o.marketId === market && o.channel === 'preorder' && o.status !== 'cancelled';
  }).sort(function (a, b) { return a.when - b.when; });

  return {
    waiting: all.filter(function (o) { return o.status === 'paid'; }),
    unpaid: all.filter(function (o) { return o.status === 'reserved'; }),
    done: all.filter(function (o) { return o.status === 'collected'; }).reverse().slice(0, 12)
  };
});

/* =========================================================================
   7. ACTIONS — stock and costing
   ========================================================================= */

SF.action('stock', 'stock', 'read', function () {
  var batches = SF.rows('batches').map(function (b) {
    return {
      id: String(b.BatchId),
      when: b.When instanceof Date
        ? Utilities.formatDate(b.When, SF.TZ, 'd MMM yyyy') : String(b.When || ''),
      productId: String(b.ProductId), made: SF.num(b.Made),
      lines: SF.json(b.CostLines, []),
      totalCost: SF.num(b.TotalCost), costPerUnit: SF.num(b.CostPerUnit),
      note: String(b.Note || '')
    };
  }).reverse();

  var ps = SF.products({ all: true });
  var value = 0;
  ps.forEach(function (p) { if (p.type !== 'made') value += p.onHand * p.cost; });

  return { products: ps, batches: batches, stockValue: value, units: SF.UNITS,
           pantry: SF.pantry(), pots: SF.pots(),
           stocktake: typeof STOCKTAKE !== 'undefined'
             ? { ref: STOCKTAKE.ref, loaded: String(SF.get('stocktakeLoaded', '')) === STOCKTAKE.ref + ' v' + STOCKTAKE.version }
             : null };
});

/**
 * Recipes for "I cooked a pot". A stall's own file can define sfPots() to
 * return [{name, expect, lines: [{label, item, qty, unit, price}],
 * sizes: [{productId, variant, share, bottle, bottleItem}]}]; without one,
 * the Stock screen just shows the plain "I made a batch" card.
 */
SF.pots = function () { return typeof sfPots === 'function' ? sfPots() : []; };

/**
 * The stall's stocktake file, run from the app. The sheet menu does the same,
 * but custom menus do not show in the Google Sheets phone app. Owner only.
 */
SF.action('loadStocktake', 'people', 'write', function (p, ctx) {
  if (typeof sfApplyStocktake !== 'function') return { ok: false, message: 'No stocktake to load.' };
  SF.migrate();
  var r = sfApplyStocktake();
  SF.set('stocktakeLoaded', STOCKTAKE.ref + ' v' + STOCKTAKE.version);
  return { ok: true, result: r };
});

/** A recipe saved from the app, or null. Lines: [{label, item, qty, unit, price}]. */
SF.recipe = function (name) {
  var key = String(name || '').toLowerCase(), out = null;
  SF.rows('recipes').forEach(function (r) {
    if (String(r.Name).toLowerCase() === key) {
      out = { row: r._row, name: String(r.Name), makes: SF.num(r.Makes), lines: SF.json(r.Lines, []) };
    }
  });
  return out;
};

SF.RECIPE_UNITS = ['kg', 'g', 'litre', 'each', 'pot'];
SF.newPot = function (name) { if (typeof sfNewPot === 'function') sfNewPot(name); };

/**
 * Save the usual recipe for a pot. A name the stall has no product for yet
 * is a new jam: the stall's own file (sfNewPot) puts it on the shelf list.
 */
SF.action('saveRecipe', 'stock', 'write', function (p, ctx) {
  var name = String(p.name || '').trim().slice(0, 50);
  if (name.length < 2) return { ok: false, message: 'Give the jam a name.' };
  var lines = (p.lines || []).map(function (l) {
    var label = String(l.label || '').trim().slice(0, 40);
    var unit = SF.RECIPE_UNITS.indexOf(l.unit) === -1 ? 'kg' : String(l.unit);
    return { label: label, item: unit === 'pot' ? '' : String(l.item || label).trim().slice(0, 40),
             qty: Math.max(0, Math.round(SF.num(l.qty) * 1000) / 1000), unit: unit,
             price: Math.max(0, Math.round(SF.num(l.price) * 100) / 100) };
  }).filter(function (l) { return l.label && l.qty > 0; });
  if (!lines.length) return { ok: false, message: 'Add at least one ingredient.' };
  var makes = Math.max(1, Math.round(SF.num(p.makes) || 6));

  var known = SF.pots().some(function (x) { return x.name.toLowerCase() === name.toLowerCase(); });
  if (!known) SF.newPot(name);

  var fields = { Name: name, Makes: makes, Lines: JSON.stringify(lines),
                 UpdatedAt: new Date(), UpdatedBy: ctx.user || ctx.role };
  var have = SF.recipe(name);
  if (have) {
    fields.Name = have.name;
    Object.keys(fields).forEach(function (k) { SF.setCell('recipes', have.row, k, fields[k]); });
  } else SF.append('recipes', fields);
  SF.audit(ctx, 'saveRecipe', name, lines.length + ' ingredients', 'ok');
  return { ok: true, isNew: !known };
});

/** Take an amount out of the cupboard, if the cupboard lists it. Never below 0. */
SF.usePantry = function (item, qty, unit, ctx) {
  if (!item || !(qty > 0)) return null;
  var found = null;
  SF.pantry().forEach(function (r) { if (r.item.toLowerCase() === String(item).toLowerCase()) found = r; });
  if (!found) return null;
  var take = qty;
  if (unit === 'kg' && found.unit === 'g') take = qty * 1000;
  else if (unit === 'g' && found.unit === 'kg') take = qty / 1000;
  else if (unit !== found.unit) return null;
  var left = Math.max(0, Math.round((found.qty - take) * 1000) / 1000);
  SF.setCell('pantry', found.row, 'Qty', left);
  SF.setCell('pantry', found.row, 'UpdatedAt', new Date());
  SF.setCell('pantry', found.row, 'UpdatedBy', ctx.user || ctx.role);
  return { item: found.item, left: left, unit: found.unit };
};

/**
 * One pot, poured into jars of one or more sizes. The pot's cost is shared
 * across the jars by how much each holds, each jar adds its own bottle, the
 * jars go on the shelf, and what went in comes out of the cupboard.
 */
SF.action('cookPot', 'stock', 'write', function (p, ctx) {
  var pot = null;
  SF.pots().forEach(function (x) { if (x.name === p.name) pot = x; });
  if (!pot) return { ok: false, message: 'I do not know that jam.' };

  var lines = (p.lines || []).map(function (l) {
    return { label: String(l.label || '').slice(0, 40), item: String(l.item || ''),
             qty: Math.max(0, SF.num(l.qty)), unit: String(l.unit || ''),
             price: Math.max(0, SF.num(l.price)) };
  }).filter(function (l) { return l.label && l.qty > 0; });
  var potCost = lines.reduce(function (s, l) { return s + l.qty * l.price; }, 0);

  var jars = p.jars || {}, filled = [], volume = 0, count = 0;
  pot.sizes.forEach(function (s) {
    var n = Math.max(0, Math.floor(SF.num(jars[s.productId])));
    if (n) { filled.push({ size: s, n: n }); volume += n * s.share; count += n; }
  });
  if (!count) return { ok: false, message: 'How many jars did you fill?' };

  var made = [];
  filled.forEach(function (f) {
    var share = Math.round(potCost * f.n * f.size.share / volume * 100) / 100;
    var bottles = Math.round(f.n * f.size.bottle * 100) / 100;
    var total = Math.round((share + bottles) * 100) / 100;
    var id = 'B-' + ('000' + (SF.rows('batches').length + 1)).slice(-3);
    SF.append('batches', {
      BatchId: id, When: new Date(), ProductId: f.size.productId, Made: f.n,
      CostLines: JSON.stringify([{ label: 'Share of the pot', amount: share },
                                 { label: 'Bottles', amount: bottles }]),
      TotalCost: total, CostPerUnit: Math.round(total / f.n * 10000) / 10000,
      Note: 'Cooked ' + pot.name
    });
    SF.move(f.size.productId, f.n, 'batch', id);
    made.push({ productId: f.size.productId, variant: f.size.variant, jars: f.n,
                each: Math.round(total / f.n * 100) / 100 });
  });

  var used = [];
  lines.forEach(function (l) { var u = SF.usePantry(l.item, l.qty, l.unit, ctx); if (u) used.push(u); });
  filled.forEach(function (f) {
    var u = SF.usePantry(f.size.bottleItem, f.n, 'each', ctx);
    if (u) used.push(u);
  });

  SF.audit(ctx, 'cookPot', pot.name, count + ' jars, R' + Math.round(potCost), 'ok');
  return { ok: true, jars: count, made: made, used: used };
});

/* Uncooked stock: fruit, sugar, empty bottles. A plain count she updates
   when she checks the cupboard, not a ledger: nothing is sold from it. */
SF.PANTRY_UNITS = ['kg', 'g', 'litre', 'each'];

SF.pantry = function () {
  return SF.rows('pantry').map(function (r) {
    return { row: r._row, item: String(r.Item), qty: SF.num(r.Qty),
             unit: String(r.Unit || 'kg'), note: String(r.Note || ''),
             updated: r.UpdatedAt instanceof Date
               ? Utilities.formatDate(r.UpdatedAt, SF.TZ, 'd MMM') : '' };
  }).filter(function (r) { return r.item; })
    .sort(function (a, b) { return a.item.localeCompare(b.item); });
};

SF.action('savePantry', 'stock', 'write', function (p, ctx) {
  var item = String(p.item || '').trim().slice(0, 40);
  var unit = SF.PANTRY_UNITS.indexOf(p.unit) === -1 ? 'kg' : String(p.unit);
  var qty = Math.round(SF.num(p.qty) * 1000) / 1000;
  if (item.length < 2) return { ok: false, message: 'Say what it is, e.g. Sugar.' };
  if (qty < 0) return { ok: false, message: 'The amount cannot be below nothing.' };
  var found = null;
  SF.pantry().forEach(function (r) { if (r.item.toLowerCase() === item.toLowerCase()) found = r; });
  var fields = { Item: item, Qty: qty, Unit: unit, Note: String(p.note || '').slice(0, 60),
                 UpdatedAt: new Date(), UpdatedBy: ctx.user || ctx.role };
  if (found) fields.Item = found.item;   // keep the spelling it was first saved with
  if (found) Object.keys(fields).forEach(function (k) { SF.setCell('pantry', found.row, k, fields[k]); });
  else SF.append('pantry', fields);
  return { ok: true };
});

SF.action('addBatch', 'stock', 'write', function (p, ctx) {
  var productId = String(p.productId || '');
  var made = SF.num(p.made);
  if (!productId) return { ok: false, message: 'Choose which product this run is.' };
  if (made <= 0) return { ok: false, message: 'How many did it make?' };

  var clean = [], total = 0;
  (p.lines || []).forEach(function (l) {
    var label = String(l.label || '').trim().slice(0, 40), amount = SF.num(l.amount);
    if (!label && amount === 0) return;
    clean.push({ label: label || 'Cost', amount: amount });
    total += amount;
  });
  if (!clean.length) return { ok: false, message: 'Add at least one cost.' };
  if (total <= 0) return { ok: false, message: 'The total cost must be more than nothing.' };

  var product = SF.byId(SF.products({ all: true }), productId);
  if (!product) return { ok: false, message: 'Product not found.' };

  var id = 'B-' + ('000' + (SF.rows('batches').length + 1)).slice(-3);
  SF.append('batches', {
    BatchId: id, When: new Date(), ProductId: productId, Made: made,
    CostLines: JSON.stringify(clean), TotalCost: total,
    CostPerUnit: Math.round(total / made * 10000) / 10000,
    Note: String(p.note || '').slice(0, 120)
  });
  // A run of a made-to-order product is a costing record, not stock on a shelf.
  if (product.type !== 'made') SF.move(productId, made, 'batch', id);
  SF.emit('batch.added', { batchId: id, productId: productId, made: made, total: total }, ctx);

  return { ok: true, batchId: id, costPerUnit: total / made, total: total };
});

SF.action('setPrice', 'price', 'write', function (p) {
  var product = SF.byId(SF.products({ all: true }), p.productId);
  if (!product) return { ok: false, message: 'Product not found.' };
  var value = Math.round(SF.num(p.price) * 100) / 100;
  if (value < 0) return { ok: false, message: 'A price cannot be negative.' };
  SF.setCell('products', product.row, 'Price', value);
  return { ok: true, price: value };
});

SF.action('saveProduct', 'stock', 'write', function (p) {
  var name = String(p.name || '').trim().slice(0, 60);
  var type = String(p.type || 'stocked');
  var unit = String(p.unit || 'each');
  var price = Math.round(SF.num(p.price) * 100) / 100;

  if (name.length < 2) return { ok: false, message: 'Give it a name.' };
  if (['stocked', 'made', 'weighed'].indexOf(type) === -1) {
    return { ok: false, message: 'That is not a product type I know.' };
  }
  if (!SF.UNITS[unit]) return { ok: false, message: 'That is not a unit I know.' };
  if (type === 'weighed' && !SF.UNITS[unit].weighed) unit = 'kg';
  if (type !== 'weighed' && SF.UNITS[unit].weighed) unit = 'each';
  if (price <= 0) return { ok: false, message: 'Set a selling price.' };

  var existing = p.productId ? SF.byId(SF.products({ all: true }), p.productId) : null;
  var fields = {
    Name: name, Variant: String(p.variant || '').slice(0, 30), Type: type,
    Category: String(p.category || '').slice(0, 30), Unit: unit, Price: price,
    Capacity: SF.num(p.capacity), Options: JSON.stringify(p.options || []),
    Active: p.active === false ? 'No' : 'Yes'
  };

  if (existing) {
    Object.keys(fields).forEach(function (k) { SF.setCell('products', existing.row, k, fields[k]); });
    return { ok: true, id: existing.id };
  }
  var count = SF.rows('products').length;
  fields.ProductId = 'P' + ('00' + (count + 1)).slice(-2);
  fields.Sort = (count + 1) * 10;
  SF.append('products', fields);
  return { ok: true, id: fields.ProductId };
});

SF.action('setActive', 'stock', 'write', function (p) {
  var product = SF.byId(SF.products({ all: true }), p.productId);
  if (!product) return { ok: false, message: 'Product not found.' };
  SF.setCell('products', product.row, 'Active', p.active ? 'Yes' : 'No');
  return { ok: true };
});

SF.action('adjustStock', 'stock', 'write', function (p, ctx) {
  var n = SF.num(p.qty);
  if (!n) return { ok: false, message: 'Enter how many, up or down.' };
  var product = SF.byId(SF.products({ all: true }), p.productId);
  if (!product) return { ok: false, message: 'Product not found.' };
  if (product.type === 'made') {
    return { ok: false, message: 'Made-to-order items have a daily capacity, not a stock count.' };
  }
  SF.move(product.id, n, 'adjust', String(p.reason || '').slice(0, 60));
  SF.audit(ctx, 'adjustStock', product.name, n + ' — ' + (p.reason || 'no reason given'), 'ok');
  return { ok: true };
});

/* =========================================================================
   8. ACTIONS — labels and the market view
   ========================================================================= */

SF.action('labels', 'labels', 'read', function () {
  var pr = SF.profile();
  return {
    profile: { name: pr.name, tagline: pr.tagline, colour: pr.colour },
    products: SF.products({ all: true }).map(function (p) {
      return { id: p.id, name: p.name, variant: p.variant, type: p.type, unit: p.unit,
               price: p.price, active: p.active, available: p.available, onHand: p.onHand };
    })
  };
});

SF.action('dashboard', 'reports', 'read', function (p) {
  var id = String(p.marketId || SF.activeMarket() || '');
  var all = SF.orders();
  var expenses = SF.rows('expenses').map(function (x) {
    return {
      id: String(x.ExpenseId), row: x._row, marketId: String(x.MarketId || ''),
      description: String(x.Description || ''), amount: SF.num(x.Amount),
      category: String(x.Category || 'Other')
    };
  });

  function summarise(mid) {
    var orders = all.filter(function (o) { return o.marketId === mid && o.status !== 'cancelled'; });
    var sold = orders.filter(function (o) { return o.status === 'paid' || o.status === 'collected'; });
    var revenue = 0, cogs = 0, units = 0, preTotal = 0, tillTotal = 0, outstanding = 0;
    sold.forEach(function (o) {
      revenue += o.total; cogs += o.cost; units += o.units;
      if (o.channel === 'till') tillTotal += o.total; else preTotal += o.total;
    });
    orders.forEach(function (o) { if (o.status === 'reserved') outstanding += o.total; });
    var spend = 0;
    expenses.forEach(function (x) { if (x.marketId === mid) spend += x.amount; });

    var gross = revenue - cogs;
    var per = units > 0 ? gross / units : 0;
    return {
      revenue: revenue, cogs: cogs, gross: gross, expenses: spend, profit: gross - spend,
      units: Math.round(units * 100) / 100, orders: sold.length,
      preTotal: preTotal, tillTotal: tillTotal, outstanding: outstanding,
      contributionPerUnit: per,
      breakEvenUnits: per > 0 ? Math.ceil(spend / per) : null,
      unitsToBreakEven: per > 0 ? Math.max(0, Math.ceil((spend - gross) / per)) : null,
      brokeEven: gross >= spend && spend > 0
    };
  }

  var perProduct = {};
  all.filter(function (o) {
    return o.marketId === id && (o.status === 'paid' || o.status === 'collected');
  }).forEach(function (o) {
    o.lines.forEach(function (l) {
      var k = l.name;
      if (!perProduct[k]) perProduct[k] = { name: k, qty: 0, value: 0, unit: l.unit || 'each' };
      perProduct[k].qty += SF.num(l.units || l.qty);
      perProduct[k].value += SF.num(l.total);
    });
  });

  var ps = SF.products({ all: true }), stockValue = 0, stockUnits = 0;
  ps.forEach(function (x) {
    if (x.type === 'made') return;
    stockValue += x.onHand * x.cost;
    stockUnits += x.onHand;
  });

  return {
    marketId: id,
    markets: SF.markets(),
    summary: summarise(id),
    expenses: expenses.filter(function (x) { return x.marketId === id; }),
    best: Object.keys(perProduct).map(function (k) { return perProduct[k]; })
      .sort(function (a, b) { return b.value - a.value; }),
    history: SF.markets().map(function (m) {
      var s = summarise(m.id);
      return { id: m.id, name: m.name, date: m.date, location: m.location, status: m.status,
               revenue: s.revenue, expenses: s.expenses, profit: s.profit, units: s.units };
    }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }),
    stock: { value: stockValue, units: Math.round(stockUnits * 100) / 100 },
    preordersOpen: SF.preordersOpen(),
    marketPassed: SF.marketPassed()
  };
});

SF.action('addMarket', 'reports', 'write', function (p) {
  var name = String(p.name || '').trim().slice(0, 60);
  if (name.length < 2) return { ok: false, message: 'Give the market a name.' };
  var id = 'M' + ('00' + (SF.rows('markets').length + 1)).slice(-2);
  SF.append('markets', {
    MarketId: id, Name: name, Date: String(p.date || ''),
    Location: String(p.location || '').slice(0, 80), Status: 'planned', Note: ''
  });
  if (p.makeActive) { SF.set('activeMarket', id); SF.purgeCustomers(); }
  return { ok: true, id: id };
});

SF.action('setActiveMarket', 'reports', 'write', function (p) {
  SF.set('activeMarket', String(p.marketId || ''));
  SF.purgeCustomers();
  return { ok: true };
});

SF.action('setPreordersOpen', 'reports', 'write', function (p) {
  SF.set('preordersOpen', p.open ? 'yes' : 'no');
  return { ok: true, open: !!p.open };
});

SF.action('addExpense', 'expenses', 'write', function (p) {
  var marketId = String(p.marketId || SF.activeMarket());
  var description = String(p.description || '').trim().slice(0, 60);
  var amount = SF.num(p.amount);
  if (!marketId) return { ok: false, message: 'Choose a market first.' };
  if (description.length < 2) return { ok: false, message: 'What was the money for?' };
  if (amount <= 0) return { ok: false, message: 'Enter the amount.' };
  var id = 'E-' + ('000' + (SF.rows('expenses').length + 1)).slice(-3);
  SF.append('expenses', {
    ExpenseId: id, MarketId: marketId, Description: description, Amount: amount,
    Category: String(p.category || 'Other').slice(0, 30), When: new Date()
  });
  return { ok: true, id: id };
});

SF.action('deleteExpense', 'expenses', 'write', function (p) {
  var all = SF.rows('expenses');
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].ExpenseId) === String(p.expenseId)) {
      SF.sheet('expenses').deleteRow(all[i]._row);
      return { ok: true };
    }
  }
  return { ok: false, message: 'Not found.' };
});

/* =========================================================================
   9. ACTIONS — profile and settings
   ========================================================================= */

/** Owner or manager: put every unpaid reservation for the live market back on the shelf. */
SF.action('releaseUnpaid', 'reports', 'write', function (p, ctx) {
  var market = SF.activeMarket(), n = 0;
  SF.orders().forEach(function (o) {
    if (o.marketId !== market || o.status !== 'reserved') return;
    SF.commitLines(o.lines, o.no, 1);
    SF.setCell('orders', o.row, 'Status', 'cancelled');
    n++;
  });
  return { ok: true, released: n };
});

SF.action('boot', 'sell', 'read', function (p, ctx) {
  // New code with new tabs: upgrade the sheet on first open instead of
  // waiting for someone to find StallFlow > Set up / upgrade.
  if ((Number(SF.get('schemaVersion', 0)) || 0) < SF.SCHEMA) SF.migrate();
  // Once a day, the first person to open the app clears finished markets' customers.
  if (String(SF.get('lastPurge', '')) !== SF.today()) SF.purgeCustomers();
  var pr = SF.profile();
  return {
    version: SF.VERSION,
    me: { user: ctx.user || '', role: ctx.role },
    auth: { google: SF.googleOn() },
    profile: pr,
    marketId: SF.activeMarket(),
    units: SF.UNITS,
    roles: Object.keys(SF.ROLES),
    plugins: SF.registry.plugins.filter(function (x) { return SF.enabled(x.id); })
      .map(function (x) { return { id: x.id, name: x.name, version: x.version,
                                   settings: x.settings }; }),
    settings: SF.json(SF.get('pluginSettings', '{}'), {})
  };
});

SF.action('saveProfile', 'reports', 'write', function (p, ctx) {
  if (ctx.role !== 'owner' && ctx.role !== 'manager') {
    return { ok: false, message: 'Only an owner or manager can change the shop details.' };
  }
  var stored = SF.json(SF.get('profile', '{}'), {});
  ['name', 'tagline', 'whatsapp', 'colour', 'ink', 'paper'].forEach(function (k) {
    if (p[k] !== undefined) stored[k] = String(p[k]).slice(0, 120);
  });
  if (p.vocab) stored.vocab = p.vocab;
  if (p.plugins) stored.plugins = p.plugins;
  SF.set('profile', stored);
  return { ok: true };
});

SF.action('savePluginSettings', 'reports', 'write', function (p) {
  var all = SF.json(SF.get('pluginSettings', '{}'), {});
  all[String(p.plugin)] = p.values || {};
  SF.set('pluginSettings', all);
  return { ok: true };
});

/**
 * Hand a stall over clean: wipe the trading history but keep everything that
 * describes the shop.
 *
 * Cleared:  orders, batches, stock movements, the retry log, cash-ups
 * Kept:     products and prices, markets, the cost of being there, settings,
 *           and the audit trail — which records that this happened
 *
 * Two keys, not one: an owner's token AND the exact phrase. Nothing else in
 * the API destroys history, so it does not get to be a one-tap action.
 */
SF.action('resetTrading', 'reports', 'write', function (p, ctx) {
  if (ctx.role !== 'owner') {
    return { ok: false, message: 'Only the owner can reset trading data.' };
  }
  if (String(p.confirm || '') !== 'RESET TRADING') {
    return { ok: false, message: 'Confirmation phrase missing. Nothing was changed.' };
  }

  var cleared = {};
  ['orders', 'batches', 'movements', 'ops', 'cashups'].forEach(function (key) {
    if (!SF.SHEETS[key]) return;
    var sheet = SF.sheet(key), last = sheet.getLastRow();
    cleared[key] = Math.max(0, last - 1);
    if (last > 1) sheet.deleteRows(2, last - 1);
  });

  SF.audit(ctx, 'resetTrading', SF.profile().name, JSON.stringify(cleared), 'ok');
  return { ok: true, cleared: cleared };
});
