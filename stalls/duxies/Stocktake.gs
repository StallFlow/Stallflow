/**
 * StallFlow — Duxie's product list, prices and stocktake of 22 October 2026
 * ===========================================================================
 * From Marian's count sheet, the flyer and her Markets spreadsheet.
 *
 * Run it from the spreadsheet: StallFlow > Load stocktake (22 Oct 2026).
 * Safe to run more than once: products are matched on name + size, prices
 * are updated, and stock is moved up or down to the counted number with one
 * 'adjust' movement each, so the Movements ledger shows the stocktake.
 * Products not on this list are switched off (Active = No), never deleted.
 */

var STOCKTAKE = {
  ref: 'Stocktake 22 Oct 2026',

  sizes: {
    L: '352 ml',
    M: 'Medium (odd bottle)',
    S: '125 ml'
  },

  // Standard jam prices by size. Premium jams (marked * on the count sheet)
  // override them below.
  price: { L: 70, M: 50, S: 40 },
  premium: {
    'Fig':                     { L: 80, M: 60, S: 50 },
    'Fig Chunky':              { L: 80 },
    'Orange Marmalade Whiskey':{ L: 80, M: 60, S: 50 },
    'Strawberry Gin':          { L: 80, S: 50 }
  },

  // name, 352 ml, medium, 125 ml   (null = that size is not made)
  jams: [
    ['3 Fruit Marmalade',               12, 1, 7],
    ['Apricot',                          2, null, 1],
    ['Fig',                              3, 2, 1],
    ['Fig Chunky',                       0, null, null],
    ['Gooseberry',                       2, null, 2],
    ['Gooseberry / Strawberry',          5, 1, 2],
    ['Granadilla',                    null, null, 6],
    ['Guavadilla',                       1, null, null],
    ['Lemon / Pink Grapefruit Marmalade',4, null, 1],
    ['Makataan',                         7, null, null],
    ['Mulberry',                         7, null, 4],
    ['Naartjie Marmalade',              12, 2, 9],
    ['Nectarine',                        2, null, 2],
    ['Orange Marmalade',                11, 4, 6],
    ['Orange Marmalade Whiskey',         7, 1, 2],
    ['Peach',                            5, null, 2],
    ['Peachdilla',                       2, null, 2],
    ['Pineapple / Granadilla',           7, null, null],
    ['Pineapple / Mango',                0, null, null],
    ['Red Grapefruit Marmalade',         2, null, null],
    ['Strawberry',                      14, 4, 17],
    ['Strawberry Chilli',                6, 1, 3],
    ['Strawberry Gin',                   1, null, 4],
    ['Tomato Chilli',                    9, null, null],
    ['Tomato Ginger',                   10, 3, 4]
  ],

  // Baked to order, so no shelf stock: name, variant, price
  biscuits: [
    ['Chocolate Chip Biscuits', '300 g pack', 70],
    ['Butter Biscuits',         '300 g pack', 70],
    ['Peanut Butter Biscuits',  '300 g pack', 80],
    ['Crunchies',               '300 g pack', 70],
    ['Mixed Biscuits',          '300 g pack', 70]
  ],

  // One-off handmade pieces. Prices from past markets; stock not counted yet.
  handmade: [
    ['Crochet Wolf',          'Crochet', 95],
    ['Crochet Fox',           'Crochet', 115],
    ['Crochet Groot',         'Crochet', 95],
    ['Crochet Bear',          'Crochet', 50],
    ['Crochet Cat',           'Crochet', 80],
    ['Crochet Octopus',       'Crochet', 60],
    ['Crochet Snail',         'Crochet', 70],
    ['Crochet Doll',          'Crochet', 120],
    ['Balloon Dog',           'Crochet', 40],
    ['Resin Tangram',         'Resin',  180]
  ],

  // Oven times include 5 minutes to heat the oven.
  recipes: [
    ['Butter Biscuits', '4 packs of 300 g', '15 min (10 baking + 5 to heat the oven)',
     '525 g butter · 175 g icing sugar · 175 g custard powder · 525 g flour · ' +
     'icing sugar between the biscuits'],
    ['Peanut Butter Biscuits', '2 packs of 300 g', '17 min (12 baking + 5 to heat the oven)',
     '1.5 cup flour · ½ cup butter · 1 cup peanut butter · ½ cup white sugar · ' +
     '½ cup brown sugar · 1 t vanilla essence · 1 egg · 1 t baking powder'],
    ['Chocolate Chip Biscuits', '4 packs of 300 g',
     '150 °C, 16 min (11 baking + 5 to heat the oven); up to 20 min for a crisper bake',
     '3 cups flour (750 g) · 2 cups choc chips (500 g) · 1 cup brown sugar (250 g) · ' +
     '1 cup white sugar (250 g) · 1 cup margarine (250 g) · 1 t bicarb · 1 t salt · ' +
     '½ t baking powder · 2 t vanilla essence · 2 eggs'],
    ['Jam', '6 × 352 ml bottles', 'about 3 hours on the gas stove',
     '3 kg fruit · 2.5 kg sugar'],
    ['Marmalade', '5 × 352 ml bottles', 'about 3 hours on the gas stove',
     '3 kg fruit · 3.5 kg sugar']
  ]
};

/** Every product on the list as one flat row: [name, variant, category, type, price, count]. */
function sfStocktakeRows() {
  var out = [];
  STOCKTAKE.jams.forEach(function (j) {
    ['L', 'M', 'S'].forEach(function (size, i) {
      var count = j[i + 1];
      if (count === null) return;
      var prem = STOCKTAKE.premium[j[0]] || {};
      var price = prem[size] || STOCKTAKE.price[size];
      var category = /marmalade/i.test(j[0]) ? 'Marmalades'
                   : /tomato/i.test(j[0]) ? 'Chutney-style jams' : 'Jams';
      out.push([j[0], STOCKTAKE.sizes[size], category, 'stocked', price, count]);
    });
  });
  STOCKTAKE.biscuits.forEach(function (b) {
    out.push([b[0], b[1], 'Biscuits', 'made', b[2], null]);
  });
  STOCKTAKE.handmade.forEach(function (h) {
    out.push([h[0], 'each', h[1], 'stocked', h[2], null]);
  });
  return out;
}

function sfLoadStocktake() {
  var ui = SpreadsheetApp.getUi();
  var rows = sfStocktakeRows();
  if (ui.alert('Load ' + rows.length + ' products with prices, and set the jam stock to the ' +
      '22 October count? Products not on the list are switched off, not deleted.',
      ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var r = sfApplyStocktake();
  ui.alert('Stocktake loaded.\n\n' + r.added + ' new products · ' + r.updated + ' updated · ' +
    r.off + ' switched off\n' + r.moved + ' stock adjustments · ' + r.jars + ' jars on the shelf\n\n' +
    'Recipes are on the Recipes tab.');
}

/** The work itself, without the dialogs, so it can be tested. */
function sfApplyStocktake() {
  var key = function (n, v) { return (String(n) + '|' + String(v)).toLowerCase(); };
  var existing = {};
  SF.rows('products').forEach(function (p) { existing[key(p.Name, p.Variant)] = p; });
  var hand = SF.onHand();
  var next = SF.rows('products').length;
  var wanted = {}, r = { added: 0, updated: 0, off: 0, moved: 0, jars: 0 };

  sfStocktakeRows().forEach(function (row, i) {
    var name = row[0], variant = row[1], k = key(name, variant), id;
    wanted[k] = true;
    var p = existing[k];
    if (p) {
      id = String(p.ProductId);
      SF.setCell('products', p._row, 'Price', row[4]);
      SF.setCell('products', p._row, 'Category', row[2]);
      SF.setCell('products', p._row, 'Type', row[3]);
      SF.setCell('products', p._row, 'Active', 'Yes');
      SF.setCell('products', p._row, 'Sort', (i + 1) * 10);
      r.updated++;
    } else {
      next++;
      id = 'P' + ('00' + next).slice(-2);
      SF.append('products', {
        ProductId: id, Name: name, Variant: variant, Type: row[3], Category: row[2],
        Unit: 'each', Price: row[4], Capacity: 0, Options: '[]', Active: 'Yes',
        Sort: (i + 1) * 10
      });
      r.added++;
    }
    if (row[5] === null) return;
    var delta = row[5] - (hand[id] || 0);
    if (delta) { SF.move(id, delta, 'adjust', STOCKTAKE.ref); r.moved++; }
    r.jars += row[5];
  });

  SF.rows('products').forEach(function (p) {
    if (!wanted[key(p.Name, p.Variant)] && String(p.Active).toLowerCase() !== 'no') {
      SF.setCell('products', p._row, 'Active', 'No');
      r.off++;
    }
  });

  sfWriteRecipes();
  SF.audit({ role: 'owner', device: 'sheet' }, 'stocktake', STOCKTAKE.ref,
           r.added + ' added, ' + r.updated + ' updated, ' + r.moved + ' adjusted', 'ok');
  return r;
}

/** A plain reference tab. It is not one of SF.SHEETS, so the app never reads it. */
function sfWriteRecipes() {
  if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getActive) return;
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName('Recipes') || ss.insertSheet('Recipes');
  s.clear();
  var data = [['Recipe', 'Makes', 'Oven / cooking time', 'Ingredients']]
    .concat(STOCKTAKE.recipes);
  s.getRange(1, 1, data.length, 4).setValues(data);
  s.getRange(1, 1, 1, 4).setFontWeight('bold');
  s.setFrozenRows(1);
}
