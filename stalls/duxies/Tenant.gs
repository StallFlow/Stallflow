/**
 * StallFlow — tenant file: DUXIE'S HOMEMADE
 * ===========================================================================
 * This is the only file that knows which stall this is. Core.gs, Domain.gs and
 * Plugins.gs are the same for every stall and never need editing.
 *
 * To set up a different stall later: copy this file, change the block below,
 * and delete this one.
 *
 * Run it from the spreadsheet: StallFlow > Load this stall.
 */

/* =========================================================================
   1. THE STALL
   ========================================================================= */

var TENANT = {

  profile: {
    name:     "DUXIE'S HOMEMADE",
    tagline:  'Jams, knitted things and resin pieces — all made by hand',
    whatsapp: '066 235 1439',
    colour:   '#7B2D43',            // deep berry — buttons, headings, labels
    ink:      '#221A1C',
    paper:    '#FCF8F4'
  },

  preset: 'preserves',              // jars, batches, cash-up
  orderPrefix: 'D',                 // order numbers come out as D-001

  market: {
    name: 'The Tin Road Spring Market',
    date: '2026-09-05',
    location: '46 Tin Road, Bromhof · 09:00–15:00'
  },

  /* ---------------------------------------------------------------------
     PRICES ARE PLACEHOLDERS UNTIL MARIAN CONFIRMS THEM.
     Ask her: "What do you charge for each of these?" and type the answers
     in here before you run this. Everything else can be changed later in
     the app; the price is the one thing worth getting right up front.
     --------------------------------------------------------------------- */
  products: [
    // name,               variant,      category,   price
    ['Apricot Jam',        '340g',       'Jams',      60],
    ['Marmalade',          '340g',       'Jams',      60],
    ['Strawberry Jam',     '340g',       'Jams',      65],
    ['Guava Jam',          '340g',       'Jams',      60],
    ['Pineapple Jam',      '340g',       'Jams',      60],
    ['Mango Jam',          '340g',       'Jams',      65],
    ['Topsy-turvy doll',   'knitted',    'Knitting', 320],
    ['Knitted animal',     'small',      'Knitting', 180],
    ['Resin coaster set',  'set of 4',   'Resin',    220],
    ['Resin keyring',      'each',       'Resin',     45]
  ],

  /* What it costs her to stand at Tin Road. Also placeholders — check them. */
  costs: [
    ['Stall fee',              250, 'Stall'],
    ['Petrol there and back',  120, 'Travel'],
    ['Table cloth & signage',  180, 'Setup']
  ]
};

/* =========================================================================
   2. LOADING IT
   -------------------------------------------------------------------------
   Deliberately does NOT invent batches. Cost per jar has to come from a real
   run of real ingredients, so the app shows "no batch yet" until Marian
   enters one. An invented cost is worse than a blank, because it looks true.
   ========================================================================= */

function sfSeedTenant() {
  var ui = SpreadsheetApp.getUi();

  if (SF.rows('products').length) {
    if (ui.alert('There are already products in here. Load Duxie\'s anyway? ' +
        'This adds them again rather than replacing them.',
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  }

  sfSetup();

  SF.set('preset', TENANT.preset);
  SF.set('orderPrefix', TENANT.orderPrefix);
  SF.set('profile', TENANT.profile);
  SF.set('preordersOpen', 'yes');
  SF.set('maxPerLine', 12);
  SF.set('consentText',
    'We keep your name and number only to hand your order over on the day, ' +
    'and delete it after the market.');

  var start = SF.rows('products').length;
  TENANT.products.forEach(function (p, i) {
    var n = start + i + 1;
    SF.append('products', {
      ProductId: 'P' + ('00' + n).slice(-2),
      Name: p[0], Variant: p[1], Type: 'stocked', Category: p[2],
      Unit: 'each', Price: p[3], Capacity: 0, Options: '[]',
      Active: 'Yes', Sort: n * 10
    });
  });

  var marketId = 'M' + ('00' + (SF.rows('markets').length + 1)).slice(-2);
  SF.append('markets', {
    MarketId: marketId, Name: TENANT.market.name, Date: TENANT.market.date,
    Location: TENANT.market.location, Status: 'planned', Note: 'First market on StallFlow'
  });
  SF.set('activeMarket', marketId);

  TENANT.costs.forEach(function (c, i) {
    SF.append('expenses', {
      ExpenseId: 'E-' + ('000' + (SF.rows('expenses').length + 1)).slice(-3),
      MarketId: marketId, Description: c[0], Amount: c[1], Category: c[2], When: new Date()
    });
  });

  SF.audit({ role: 'owner', device: 'sheet' }, 'seedTenant', TENANT.profile.name,
           TENANT.products.length + ' products', 'ok');

  ui.alert(
    TENANT.profile.name + ' is loaded.\n\n' +
    TENANT.products.length + ' products · ' + TENANT.market.name + '\n\n' +
    'Next, in order:\n' +
    '1. Set the PINs (till app: More > Settings). Until you do, anyone with the ' +
    'link is an owner.\n' +
    '2. Add one batch per product on the Stock screen, with what it really cost. ' +
    'Until then there is no cost per jar and no break-even.\n' +
    '3. Check the stall fee and petrol on the Numbers screen.');
}

/**
 * Handy for a rehearsal: puts a plausible amount of stock on the shelf without
 * pretending to know what anything cost. Use it to practise, then
 * StallFlow > Clear trading data before the real market.
 */
function sfPractiseStock() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Put 12 of everything on the shelf so you can practise? ' +
      'Clear trading data afterwards.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  SF.products({ all: true }).forEach(function (p) {
    if (p.type !== 'made') SF.move(p.id, 12, 'adjust', 'practice stock');
  });
  ui.alert('Twelve of everything. Remember to clear it before the real thing.');
}
