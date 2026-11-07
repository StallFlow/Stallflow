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
  }];
}
