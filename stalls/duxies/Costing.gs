/**
 * StallFlow — Duxie's costing
 * ===========================================================================
 * What one jar or one pack costs to make: ingredients, the bottle or bag,
 * gas or power, and fuel to fetch the ingredients. Loaded with the stocktake
 * (StallFlow > Load stocktake) as one costing record per product.
 *
 * Every figure comes from Marian's notes unless it says "estimate". Change a
 * number here and run Load stocktake again: the costing records are updated
 * in place, stock is not touched.
 */

var COSTING = {
  note: 'Costing estimate (Costing.gs)',

  // Rand per kg, from the General tab of her Markets spreadsheet.
  sugar:      65 / 2.5,      // white, R65 for 2.5 kg
  brownSugar: 46 / 2,
  icingSugar: 148.5 / 5,
  custard:    175 / 5,
  flour:      40 / 2.5,
  butter:     70 / 0.5,
  margarine:  60 / 1,
  chocChips:  400 / 5,
  peanutButter: 80 / 0.8,    // R80 for 800 g at Makro
  egg:        2.5,           // each

  // Fruit, Rand per kg. Marian's prices where she wrote one; the rest are
  // estimates until she tells us.
  fruitDefault: 30,          // estimate
  fruit: {
    'Strawberry': 25, 'Strawberry Chilli': 25, 'Strawberry Gin': 25,
    'Gooseberry / Strawberry': 25,
    'Pineapple / Granadilla': 25, 'Pineapple / Mango': 25,
    'Granadilla': 0,           // free
    'Tomato Chilli': 18, 'Tomato Ginger': 18
  },
  // Extras on top of fruit and sugar, per large jar. Estimates.
  extras: {
    'Strawberry Gin': ['Gin', 6],
    'Orange Marmalade Whiskey': ['Whiskey', 8],
    'Strawberry Chilli': ['Chillies', 1],
    'Tomato Chilli': ['Chillies', 1],
    'Tomato Ginger': ['Ginger', 1.5]
  },

  // One pot: 3 kg fruit makes 6 large jars of jam with 2.5 kg sugar, or 5 of
  // marmalade with 3.5 kg sugar, in about 3 hours on gas.
  jam:       { fruit: 3, sugar: 2.5, jars: 6 },
  marmalade: { fruit: 3, sugar: 3.5, jars: 5 },

  // Gas: a 19 kg bottle is R703. A burner on a long simmer uses about
  // 0.25 kg an hour (estimate), so 3 hours is about 0.75 kg.
  gasPerPot: 703 / 19 * 0.25 * 3,

  // Power for the oven: about 2.4 kW for the bake plus 5 minutes heating,
  // at R3.50 a kWh (estimates). Two oven loads per recipe.
  kwhRate: 3.5, ovenKw: 2.4, ovenLoads: 2,

  // Fuel to fetch ingredients: a 20 km round trip at about R1.90 a km
  // (petrol at about R23 a litre, 8 l per 100 km). One trip covers about
  // three pots or bakes. Estimates.
  fuelPerRun: 20 * 1.9 / 3,

  // How full each size is compared with a 352 ml jar, and what the jar costs.
  sizes: {
    L: { share: 1,         bottle: 8.64 },
    M: { share: 250 / 352, bottle: 8.64 },   // odd bottles: estimate, ~250 ml
    S: { share: 125 / 352, bottle: 7.80 }
  },

  biscuitPack: 0,            // bag, ribbon and sticker: not known yet

  // Biscuits: ingredients for one recipe, how many 300 g packs it makes, and
  // minutes in the oven including 5 to heat it.
  biscuits: {
    'Butter Biscuits': { packs: 4, minutes: 15, lines: [
      ['Butter 525 g', 0.525, 'butter'], ['Icing sugar 175 g', 0.175, 'icingSugar'],
      ['Custard powder 175 g', 0.175, 'custard'], ['Flour 525 g', 0.525, 'flour'],
      ['Icing sugar for filling ~100 g', 0.1, 'icingSugar']] },
    'Peanut Butter Biscuits': { packs: 2, minutes: 17, lines: [
      ['Flour 1.5 cups ~190 g', 0.19, 'flour'], ['Butter ½ cup ~115 g', 0.115, 'butter'],
      ['Peanut butter 1 cup ~250 g', 0.25, 'peanutButter'],
      ['White sugar ½ cup ~100 g', 0.1, 'sugar'], ['Brown sugar ½ cup ~100 g', 0.1, 'brownSugar'],
      ['Egg', 1, 'egg'], ['Vanilla, baking powder', 2.5, null]] },
    'Chocolate Chip Biscuits': { packs: 4, minutes: 16, lines: [
      ['Flour 750 g', 0.75, 'flour'], ['Choc chips 500 g', 0.5, 'chocChips'],
      ['Brown sugar 250 g', 0.25, 'brownSugar'], ['White sugar 250 g', 0.25, 'sugar'],
      ['Margarine 250 g', 0.25, 'margarine'], ['Eggs', 2, 'egg'],
      ['Vanilla, bicarb, salt, baking powder', 4, null]] }
  }
};

var r2 = function (n) { return Math.round(n * 100) / 100; };

/**
 * The cost lines for one product, or null if we cannot cost it yet.
 * `row` is a stocktake row: [name, variant, category, type, price, count, size].
 */
function sfCostLines(row) {
  var name = row[0], C = COSTING;

  if (row[2] === 'Biscuits') {
    var mix = name === 'Mixed Biscuits';
    var recipes = mix ? ['Chocolate Chip Biscuits', 'Butter Biscuits'] : [name];
    var lines = [], share = 1 / recipes.length;
    recipes.forEach(function (n) {
      var rec = C.biscuits[n];
      if (!rec) return;
      var ingredients = 0;
      rec.lines.forEach(function (l) { ingredients += l[2] ? l[1] * C[l[2]] : l[1]; });
      lines.push({ label: (mix ? n + ' ' : '') + 'ingredients', amount: ingredients / rec.packs * share });
      lines.push({ label: 'Oven power', amount: C.ovenKw * rec.minutes / 60 * C.kwhRate * C.ovenLoads / rec.packs * share });
      lines.push({ label: 'Fuel to fetch ingredients', amount: C.fuelPerRun / rec.packs * share });
    });
    if (!lines.length) return null;   // Crunchies: no recipe yet
    if (C.biscuitPack) lines.push({ label: 'Packaging', amount: C.biscuitPack });
    return sfMergeLines(lines);
  }

  var size = C.sizes[row[6]];
  if (!size) return null;
  var pot = /marmalade/i.test(name) ? C.marmalade : C.jam;
  var perJar = size.share / pot.jars;
  var fruitKg = name in C.fruit ? C.fruit[name] : C.fruitDefault;
  var out = [
    { label: 'Fruit' + (name in C.fruit ? '' : ' (estimate)'), amount: pot.fruit * fruitKg * perJar },
    { label: 'Sugar', amount: pot.sugar * C.sugar * perJar },
    { label: 'Bottle ' + row[1] + (row[6] === 'M' ? ' (estimate)' : ''), amount: size.bottle },
    { label: 'Gas', amount: C.gasPerPot * perJar },
    { label: 'Fuel to fetch ingredients', amount: C.fuelPerRun * perJar }
  ];
  var extra = C.extras[name];
  if (extra) out.push({ label: extra[0], amount: extra[1] * size.share });
  return sfMergeLines(out);
}

function sfMergeLines(lines) {
  var by = {}, order = [];
  lines.forEach(function (l) {
    if (!(l.label in by)) { by[l.label] = 0; order.push(l.label); }
    by[l.label] += l.amount;
  });
  return order.map(function (k) { return { label: k, amount: r2(by[k]) }; })
    .filter(function (l) { return l.amount > 0; });
}

/**
 * One costing record per product, for one jar or pack. It adds no stock.
 * Running it again updates the same record, so the numbers here stay the
 * truth. A real batch entered on the Stock screen is averaged in with it.
 */
function sfCostProduct(productId, row) {
  var lines = sfCostLines(row);
  if (!lines) return false;
  var total = r2(lines.reduce(function (s, l) { return s + l.amount; }, 0));
  var mine = SF.rows('batches').filter(function (b) {
    return String(b.ProductId) === productId &&
      (String(b.Note) === COSTING.note || /^Bottle only/.test(String(b.Note)));
  })[0];
  var rec = { Made: 1, CostLines: JSON.stringify(lines), TotalCost: total,
              CostPerUnit: total, Note: COSTING.note };
  if (mine) {
    Object.keys(rec).forEach(function (k) { SF.setCell('batches', mine._row, k, rec[k]); });
  } else {
    var id = 'B-' + ('000' + (SF.rows('batches').length + 1)).slice(-3);
    SF.append('batches', Object.assign({ BatchId: id, When: new Date(), ProductId: productId }, rec));
  }
  return true;
}
