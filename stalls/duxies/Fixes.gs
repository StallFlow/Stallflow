/**
 * Duxie's Homemade: one-off corrections to the stall's own data.
 * Run by SF.runDataFixes() the first time the app is opened after an update.
 */
function sfDataFixes() {
  return [{
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
