/**
 * Duxie's Homemade: one-off corrections to the stall's own data.
 * Run by SF.runDataFixes() the first time the app is opened after an update.
 */
function sfDataFixes() {
  return [{
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
