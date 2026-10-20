/**
 * Plugin — Scale
 * ---------------------------------------------------------------------------
 * For anything sold by mass. Adds a price-check screen (the thing a customer
 * asks for before they commit) and rounds weights the way a market scale
 * actually reads, through a filter on the till's own pricing.
 */
SF.plugin({
  id: 'scale',
  name: 'Scale & weighed goods',
  version: '1.0.0',

  screens: [{
    id: 'pricecheck', title: 'Price check', cap: 'sell',
    render: function () {
      var till = SF.state.data.till;
      var weighed = (till ? till.products : []).filter(function (p) { return p.weighed; });
      if (!weighed.length) {
        return '<div class="wrap"><div class="card"><div class="empty">' +
          'Nothing here is sold by weight yet. Add a product and choose ' +
          '<b>By weight</b>.</div></div></div>';
      }
      setTimeout(function () { SFW.pick(weighed[0].id); }, 0);
      return '<div class="wrap"><div class="card">' +
        '<h2>What will it come to?</h2>' +
        '<div class="sub">Put it on the scale, type what it says, tell them the price. ' +
          'Nothing is rung up until you send it to the till.</div>' +
        '<div class="field"><label for="pcp">Product</label><select id="pcp" ' +
          'onchange="SFW.pick(this.value)">' +
          weighed.map(function (p) {
            return '<option value="' + p.id + '">' + SF.esc(p.name) + ' — ' +
              SF.money(p.price) + ' per ' + SF.esc(p.unit) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label for="pcw">Scale reading</label>' +
          '<input id="pcw" type="number" inputmode="decimal" step="0.005" min="0" ' +
          'style="font-size:30px;text-align:center" oninput="SFW.calc()"></div>' +
        '<div class="row tight" id="pcquick" style="margin-bottom:14px"></div>' +
        '<div class="figure lead" id="pcout"><div class="k">Comes to</div>' +
          '<div class="v">R 0.00</div></div>' +
        '<button class="block" style="margin-top:14px" onclick="SFW.toTill()">' +
          'Send it to the till</button>' +
        '</div><div class="foot">StallFlow · price check</div></div>';
    }
  }],

  filters: {
    // Keep the on-screen figure to what a 5 g scale can actually show, so the
    // number she reads out is the number the server will charge.
    'till.weight': function (w) {
      var s = SF.settingsOf('scale');
      var step = Number(s.roundTo) || 0.005;
      return Math.round(w / step) * step;
    }
  }
});

window.SFW = {
  current: null,

  pick: function (id) {
    var till = SF.state.data.till;
    SFW.current = SF.find(till.products, id);
    var quick = SFW.current.unit === 'kg' ? [0.1, 0.25, 0.5, 1] : [1, 2, 5, 10];
    var box = SF.el('pcquick');
    if (box) {
      box.innerHTML = quick.map(function (q) {
        return '<button class="ghost sm" onclick="SFW.set(' + q + ')">' +
          SF.qty(q, SFW.current.unit) + '</button>';
      }).join('');
    }
    SFW.calc();
  },

  set: function (v) { SF.el('pcw').value = v; SFW.calc(); },

  calc: function () {
    var p = SFW.current;
    if (!p) return;
    var w = SF.apply('till.weight', Number(SF.el('pcw').value) || 0);
    var out = SF.el('pcout');
    if (!out) return;
    out.innerHTML = '<div class="k">Comes to</div>' +
      '<div class="v">' + SF.money(p.price * w) + '</div>' +
      '<div class="n">' + SF.qty(w, p.unit) + ' at ' + SF.money(p.price) +
      ' per ' + SF.esc(p.unit) + '</div>';
  },

  toTill: function () {
    var p = SFW.current;
    var w = SF.apply('till.weight', Number(SF.el('pcw').value) || 0);
    if (!p || w <= 0) { SF.toast('Type the weight first.', true); return; }
    if (p.available !== null && w > p.available + 1e-9) {
      SF.toast('Only ' + SF.qty(p.available, p.unit) + ' left.', true);
      return;
    }
    SF.go('till');
    setTimeout(function () {
      window.SFT.weigh(p);
      setTimeout(function () {
        var input = SF.el('wq');
        if (input) { input.value = w; window.SFT.weighPreview(p.id); }
      }, 80);
    }, 60);
  }
};
