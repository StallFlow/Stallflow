/**
 * Duxie's Homemade: one-off corrections to the stall's own data.
 * Run by SF.runDataFixes() the first time the app is opened after an update.
 */
function sfDataFixes() {
  return [{
    id: 'gift-boxes',
    until: '2027-03-31',
    what: 'Added the gift boxes (packages): Teacher\'s Thank You, Taste of Mzansi, Braai Box, Cheese Board Trio, Grown-ups Only, Sunday Breakfast, 12 Jars of Christmas and Jam Club',
    // Safe to repeat until the date: a box that is already there is never touched, so a price or a
    // switch-off done by hand wins. Nothing here moves stock; boxes sell out until the jars are cooked.
    run: function () { return sfAddPackages(); }
  }, {
    id: 'lizard-own-id',
    what: 'Lizard resin ornament moved off the id it shared with Apricot Jam, and its stock with it',
    // The ornament was given P01, which Apricot Jam already has, so one extra jar showed on
    // Apricot Jam. Give the ornament its own id and move its opening-stock line with it.
    run: function () {
      var sharing = SF.rows('products').filter(function (r) { return String(r.ProductId) === 'P01'; });
      if (sharing.length < 2) return false;
      var liz = sharing.filter(function (r) { return /^lizard resin ornament$/i.test(String(r.Name).trim()); })[0];
      if (!liz) return false;
      var id = SF.nextProductId();
      SF.setCell('products', liz._row, 'ProductId', id);
      var mv = SF.rows('movements').filter(function (m) {
        return String(m.ProductId) === 'P01' && String(m.Ref) === 'Opening stock' && Number(m.Qty) === 1;
      }).pop();
      if (mv) SF.setCell('movements', mv._row, 'ProductId', id);
      return true;
    }
  }, {
    id: 'lizard-sales',
    until: '2026-11-14',
    what: 'Sales of the lizard ornament that were recorded as Apricot Jam were put right',
    // While the ornament shared P01 with Apricot Jam, the till recorded its sales as Apricot Jam
    // (priced R70-80 and taken off Apricot's stock). For every such sale since the ornament was
    // added, make the order the ornament at its own price and cost, and move the stock back with
    // two correcting lines (the ledger is only ever added to). Safe to repeat. Apricot Jam 340g
    // is not otherwise sold at present; if it ever is, check Numbers.
    run: function () {
      var liz = SF.products({ all: true }).filter(function (p) { return /^lizard resin ornament$/i.test(String(p.name).trim()); })[0];
      if (!liz || liz.id === 'P01') return false;
      var open = SF.rows('movements').filter(function (m) { return String(m.ProductId) === liz.id && String(m.Ref) === 'Opening stock'; })[0];
      if (!open || !(open.When instanceof Date)) return false;
      var since = open.When.getTime(), changed = false;
      SF.rows('orders').forEach(function (o) {
        if (!(o.When instanceof Date) || o.When.getTime() < since || String(o.Status) === 'cancelled') return;
        var lines = SF.json(o.Lines, []);
        if (!lines.some(function (l) { return String(l.id) === 'P01'; })) return;
        var fixed = [], units = 0, total = 0, cost = 0, moved = 0;
        lines.forEach(function (l) {
          var keep = l;
          if (String(l.id) === 'P01') {
            keep = SF.priceLine(liz, { qty: l.qty, note: l.note }, { role: 'system' });
            moved += keep.units;
          }
          fixed.push(keep);
          units += SF.num(keep.units); total += SF.num(keep.total); cost += SF.num(keep.cost);
        });
        SF.setCell('orders', o._row, 'Lines', JSON.stringify(fixed));
        SF.setCell('orders', o._row, 'Units', Math.round(units * 1000) / 1000);
        SF.setCell('orders', o._row, 'Total', Math.round(total * 100) / 100);
        SF.setCell('orders', o._row, 'Cost', Math.round(cost * 100) / 100);
        var why = 'Correction ' + o.OrderNo + ': it was the lizard ornament';
        SF.move('P01', moved, 'adjust', why, String(o.MarketId || ''));
        SF.move(liz.id, -moved, 'adjust', why, String(o.MarketId || ''));
        SF.audit({ role: 'system' }, 'datafix', String(o.OrderNo), 'lizard ornament was recorded as Apricot Jam; corrected', 'ok');
        changed = true;
      });
      return changed;
    }
  }, {
    id: 'lizard-resin-ornament',
    what: 'Added Lizard resin ornament, R105, with 1 in stock',
    // Asked for by the owner: one lizard ornament on the shelf. Skipped if one is already there.
    run: function () {
      var have = SF.products({ all: true }).some(function (p) { return /lizard/i.test(p.name); });
      if (have) return false;
      var r = SF.CORE_ACTIONS.saveProduct.fn({ name: 'Lizard resin ornament', category: 'Resin', price: 105,
        qty: 1, type: 'stocked', unit: 'each' }, {});
      return !!(r && r.ok);
    }
  }, {
    id: 'blairegowrie-craft-market',
    what: 'Market M03 renamed Blairegowrie Craft Market, at Domus Dei Campus',
    // The market is the Blairgowrie Craft Market at Domus Dei Campus, 39 Malcolm Road,
    // Sat 7 Nov 2026 (its own posters say so). It was entered as a church market.
    run: function () {
      var changed = false;
      SF.rows('markets').forEach(function (m) {
        if (m.MarketId !== 'M03') return;
        if (m.Name === 'Blairegowrie Church Market') { SF.setCell('markets', m._row, 'Name', 'Blairegowrie Craft Market'); changed = true; }
        if (/^Christ Church/.test(String(m.Location))) {
          SF.setCell('markets', m._row, 'Location', 'Domus Dei Campus, 39 Malcolm Road, Blairegowrie, Randburg'); changed = true;
        }
      });
      return changed;
    }
  }, {
    id: 'remove-caroline-test-market',
    what: 'The Caroline test market (Lyttelton) was removed',
    // A market made to try the app out, with nothing sold, spent or moved against it. It goes
    // only while that is still true, and never if it is the live market.
    run: function () {
      var removed = false;
      SF.rows('markets').forEach(function (m) {
        if (!/^caroline$/i.test(String(m.Name).trim()) || !/lyttelton/i.test(String(m.Location))) return;
        var id = String(m.MarketId);
        if (id === SF.activeMarket()) return;
        var used = ['orders', 'expenses', 'movements'].some(function (t) {
          return SF.rows(t).some(function (r) { return String(r.MarketId) === id; });
        });
        if (used) return;
        SF.sheet('markets').deleteRow(m._row);
        SF.touch('markets');
        removed = true;
      });
      return removed;
    }
  }];
}

/**
 * The gift boxes and bundles (packages). Each one is a product of type `package`; what goes in
 * the box is its Contents (see SF.packageSlots in Domain.gs). Jars are looked up by name and
 * size, never by a made-up id, because the ids on the live till are whatever the sheet gave them.
 * Prices include the box. `jar` is a fixed jar [name, size]; `pick` lets the buyer choose.
 */
var DUXIE_PACKAGES = [
  { name: "Teacher's Thank You", variant: '2 x 125 ml', price: 85,
    slots: [{ pick: 2, size: '125 ml', label: 'Any two 125 ml jars' }] },
  { name: 'Taste of Mzansi', variant: '3 x 125 ml', price: 135,
    slots: [{ jar: ['Makataan', '125 ml'] }, { jar: ['Guavadilla', '125 ml'] }, { jar: ['Peachdilla', '125 ml'] }] },
  { name: 'Braai Box', variant: '3 x 352 ml', price: 220,
    slots: [{ jar: ['Tomato Chilli', '352 ml'] }, { jar: ['Tomato Ginger', '352 ml'] }, { jar: ['Strawberry Chilli', '352 ml'] }] },
  { name: 'Cheese Board Trio', variant: '3 x 352 ml', price: 220,
    slots: [{ jar: ['Fig', '352 ml'] }, { jar: ['Fig Chunky', '352 ml'] }, { jar: ['Red Grapefruit Marmalade', '352 ml'] }] },
  { name: 'Grown-ups Only', variant: '2 x 352 ml + 125 ml', price: 230,
    slots: [{ jar: ['Strawberry Gin', '352 ml'] }, { jar: ['Orange Marmalade Whiskey', '352 ml'] },
            { pick: 1, size: '125 ml', label: 'Any one 125 ml jar' }] },
  { name: 'Sunday Breakfast', variant: '2 x 352 ml + biscuits', price: 230,
    slots: [{ pick: 1, size: '352 ml', cats: ['Marmalades'], label: 'One marmalade (352 ml)' },
            { pick: 1, size: '352 ml', cats: ['Jams'], label: 'One jam (352 ml)' },
            { jar: ['Butter Biscuits', '300 g pack'] }] },
  { name: '12 Jars of Christmas', variant: '12 x 125 ml', price: 480,
    slots: [{ pick: 12, size: '125 ml', numbered: true, label: 'Twelve 125 ml jars, numbered 1 to 12' }] },
  // Recurring monthly billing is not part of StallFlow: this is a box sold once a month, so each
  // month it is sold again. The buyer picks the two jars (Marian can narrow the choice to the
  // flavour of the month with a `from` list).
  { name: 'Jam Club (monthly)', variant: '2 x 352 ml', price: 150,
    slots: [{ pick: 2, size: '352 ml', label: 'Two 352 ml jars (the flavour of the month)' }] }
];

/** Add the packages that are not there yet. Safe to repeat: a package already there is left as it is. */
function sfAddPackages() {
  var have = {}, added = 0;
  SF.rows('products').forEach(function (r) { have[String(r.Name).trim().toLowerCase()] = true; });
  // Every open of the app runs this until the date, so stop early (cheaply) once all are there.
  if (DUXIE_PACKAGES.every(function (pk) { return have[pk.name.toLowerCase()]; })) return false;
  var all = SF.products({ all: true });
  var find = function (name, size) {
    return all.filter(function (p) {
      return p.type !== 'package' && String(p.name).trim().toLowerCase() === name.toLowerCase() && p.variant === size;
    })[0];
  };
  DUXIE_PACKAGES.forEach(function (pk, i) {
    if (have[pk.name.toLowerCase()]) return;
    var contents = [], ok = true;
    pk.slots.forEach(function (s) {
      if (s.jar) {
        var jar = find(s.jar[0], s.jar[1]);
        if (jar) contents.push({ id: jar.id, qty: 1 }); else ok = false;
      } else contents.push(s);
    });
    if (!ok) return;                      // a jar it needs is not on the sheet yet: try again at the next open
    SF.append('products', {
      ProductId: SF.nextProductId(), Name: pk.name, Variant: pk.variant, Type: 'package', Category: 'Gift boxes',
      Unit: 'each', Price: pk.price, Capacity: 0, Options: '[]', Active: 'Yes', Sort: 5000 + i * 10,
      Contents: JSON.stringify(contents)
    });
    added++;
  });
  return added > 0;
}
