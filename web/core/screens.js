/**
 * StallFlow — the screens that ship with the core.
 * Each one is registered the same way a plugin registers its own, so there is
 * no privileged path: a plugin screen is a first-class screen.
 */
(function () {
  'use strict';

  var esc = SF.esc, money = SF.money, moneyShort = SF.moneyShort, qty = SF.qty;

  function indexOfNo(list, no) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].no === no) return i;
    return -1;
  }

  /* ---- Every main screen: a snapshot that stays put, then tabs -------
     tabs: [[key, label], …]; the open one is remembered per screen. */
  SF.snap = function (figures) { return '<div class="snap">' + figures.join('') + '</div>'; };
  SF.tabs = function (screen, tabs, fallback) {
    var on = SF.ls.get('sf.tab.' + screen, fallback || tabs[0][0]);
    if (!tabs.some(function (t) { return t[0] === on; })) on = tabs[0][0];
    var html = '<div class="stabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" aria-selected="' + (t[0] === on) + '" class="' +
        (t[0] === on ? 'on' : '') + '" onclick="SF.pickTab(\'' + screen + '\',\'' + t[0] + '\')">' +
        esc(t[1]) + '</button>';
    }).join('') + '</div>';
    return { on: on, html: html };
  };
  SF.pickTab = function (screen, t) {
    SF.ls.set('sf.tab.' + screen, t); SF.render(); window.scrollTo(0, 0);
  };

  function figure(k, v, n, lead) {
    return '<div class="figure' + (lead ? ' lead' : '') + '">' +
      '<div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
      '<div class="n">' + esc(n) + '</div></div>';
  }

  /* ==================================================================
     TILL
     ================================================================== */

  var cart = [];
  var tendered = 0;      // money handed over for the sale being rung up
  var notes = [];        // the notes tapped, so the last one can be undone
  var method = 'cash';   // how the sale being rung up is paid: cash, card or eft
  var lastSale = null;   // for Send receipt; kept on this phone only, never the customer's number
  var METHODS = [['cash', 'Cash'], ['card', 'Card'], ['eft', 'EFT']];

  /** A South African number as WhatsApp wants it: 082 123 4567 → 27821234567. */
  function waNumber(v) {
    var d = String(v || '').replace(/[^0-9]/g, '');
    if (d.charAt(0) === '0') d = '27' + d.slice(1);
    return /^27[0-9]{9}$/.test(d) || /^[1-9][0-9]{9,13}$/.test(d) ? d : '';
  }

  /** The live market is one whose day is already over: offer today's (or the next) instead. */
  function staleMarket(d) {
    if (!d.liveId || !d.today || !d.allMarkets) return '';
    var live = SF.find(d.allMarkets, d.liveId);
    if (!live || !live.date || live.date >= d.today) return '';
    var next = d.allMarkets.filter(function (m) { return m.date && m.date >= d.today; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })[0];
    var when = next && next.date === d.today ? 'today' : next ? 'on ' + esc(next.date) : '';
    return '<div class="card stale"><b>The live market, ' + esc(live.name) + ', was on ' + esc(live.date) + '.</b> ' +
      (next
        ? (SF.can('settings')
            ? 'Sales and the order page still go to it. ' + esc(next.name) + ' is ' + when + '.' +
              '<button class="block" style="margin-top:10px" data-id="' + esc(next.id) + '" ' +
              'onclick="SFT.makeLive(this.getAttribute(\'data-id\'))">Make ' + esc(next.name) + ' live</button>'
            : 'Ask the owner to make ' + esc(next.name) + ' live, so today\'s sales go to it.')
        : 'Add the next market under Numbers \u203a New market, then make it live.') +
      '</div>';
  }

  /** Says plainly which market this phone's sales and pre-orders go to, and warns when it is
      not today's. Every market is kept apart; several phones can sell at different markets
      at the same moment. */
  function sellingBanner(d) {
    var at = SF.sellingAt();
    if (!at) return '';
    var today = (d.allMarkets || []).filter(function (m) { return m.date === d.today && m.id !== at.id; })[0];
    var line, cls = 'ok';
    if (at.state === 'home') line = 'Between markets: sales are not for a market day.';
    else if (at.state === 'today') line = 'Today \u00b7 ' + esc(at.date);
    else if (at.state === 'past') { cls = 'warn'; line = 'This market was on ' + esc(at.date) + ': not today!'; }
    else if (at.state === 'soon') { cls = 'warn'; line = 'This market is on ' + esc(at.date) + ': not today!'; }
    else line = 'No date set';
    return '<div class="sellbanner ' + cls + '" role="status"><span class="k">You are selling at</span>' +
      '<b class="n">' + esc(at.name) + '</b><span class="d">' + line + '</span>' +
      (cls === 'warn' && today
        ? '<button class="block" data-id="' + esc(today.id) + '" onclick="SFT.sellAt(this.getAttribute(\'data-id\'))">' +
          'Switch to ' + esc(today.name) + ' (today)</button>'
        : '') + '</div>';
  }

  /** Markets trading today. Each one can be started from this phone with a tap, and every
      phone chooses its own, so all of them can run at once. Only shown when there is more
      than one, or the one this phone is not on. */
  function marketsToday(d) {
    var run = d.running || [];
    if (!run.length) return '';
    var here = SF.sellingAt();
    if (run.length === 1 && here && here.id === run[0].id) return '';
    return '<div class="card todaymk"><h3>Markets today</h3>' +
      '<div class="sub">Each phone sells at one market. Start the others on their own phones, ' +
      'or tap one here to switch this phone.</div>' +
      run.map(function (m) {
        var mine = here && here.id === m.id;
        return '<div class="mk' + (mine ? ' on' : '') + '"><div class="who"><b>' + esc(m.name) + '</b>' +
          '<span>' + (mine ? 'Selling here' : m.count ? m.count + (m.count === 1 ? ' sale' : ' sales') + ' so far · ' + money(m.total)
                                                       : 'Not started yet') + '</span></div>' +
          (mine ? '<span class="tick">\u2713</span>'
                : '<button class="ghost sm" data-id="' + esc(m.id) + '" onclick="SFT.sellAt(this.getAttribute(\'data-id\'))">' +
                  (m.count ? 'Switch' : 'Start') + '</button>') + '</div>';
      }).join('') + '</div>';
  }

  /** The last sale, with a way to send the customer a receipt on WhatsApp. */
  function lastSaleBar() {
    if (!lastSale) return '';
    return '<div class="lastsale"><span>Last sale <b>' + money(lastSale.total) + '</b> · ' +
      esc(lastSale.methodName) + '</span>' +
      '<button class="ghost sm" onclick="SFT.receipt()">Send receipt</button></div>';
  }

  function priceOf(product, line) {
    if (product.type === 'weighed') {
      return { each: product.price, total: product.price * line.qty, units: line.qty };
    }
    var extra = 0;
    (line.options || []).forEach(function (o) { extra += Number(o.delta) || 0; });
    return { each: product.price + extra, total: (product.price + extra) * line.qty,
             units: line.qty };
  }

  function cartTotals() {
    var total = 0, count = 0;
    cart.forEach(function (l) { total += l.total; count += l.type === 'weighed' ? 1 : l.qty; });
    return { total: Math.round(total * 100) / 100, count: count };
  }

  function availableNow(product) {
    if (product.available === null) return null;
    var inCart = 0;
    cart.forEach(function (l) { if (l.id === product.id) inCart += l.units; });
    return product.available - inCart;
  }

  SF.screen({
    id: 'till', title: 'Till', cap: 'sell',
    render: function (ctx) {
      var d = ctx.data, t = d.totals;
      var tiles = picker(d);

      // What they ordered, so it can be checked against the bag before the money
      // changes hands — and the note they left, if any.
      var collect = SF.collectOn();
      var here = null;
      (d.markets || []).forEach(function (m) {
        if (m.id === d.marketId || (m.id === 'HOME' && d.marketId === 'HOME')) here = m;
      });
      var hereName = !here ? '' : here.id === 'HOME' ? 'between markets'
        : esc(here.name) + (here.date ? ' · ' + esc(here.date) : '');
      var orderRow = function (o, action) {
        return '<div class="porder"' + SF.filters.row('topay', { text: [o.customer, o.no,
            o.no.replace(/\D/g, '')].concat((o.lines || []).map(function (l) { return l.name; })).join(' ') }) +
          '><div class="hd"><div class="who"><b>' + esc(o.customer) + '</b>' +
          '<span>' + esc(o.no) + ' · ordered ' + esc(o.time) +
          ' · <button class="quiet" onclick="SFT.cancel(\'' + o.no + '\')">cancel</button></span></div>' +
          '<span class="amt">' + money(o.total) + '</span>' + action + '</div>' +
          '<ul class="items">' + (o.lines || []).map(function (l) {
            var opts = (l.options || []).map(function (x) { return x.name || x.choice; }).join(', ');
            return '<li><b>' + (l.type === 'weighed' ? qty(l.units, l.unit) : l.qty + ' ×') + '</b> ' +
              esc(l.name) + (opts ? ' <span class="muted small">' + esc(opts) + '</span>' : '') +
              '<span class="num">' + money(l.total) + '</span></li>';
          }).join('') + '</ul>' +
          (o.note ? '<div class="note">“' + esc(o.note) + '”</div>' : '') + '</div>';
      };
      var unpaid = d.unpaid.length ? SF.filters.bar('topay', { search: 'Find a name or order number',
          count: d.unpaid.length, noun: 'orders' }) +
        d.unpaid.map(function (o) {
          return orderRow(o, '<button class="ok sm" onclick="SFT.payOrder(\'' + o.no + '\')">Take payment</button>');
        }).join('') +
        '<div class="empty" data-fempty="topay" style="display:none">Nobody by that name or number.</div>'
        : '<div class="empty">Nothing outstanding — every pre-order ' +
        (hereName ? 'for ' + hereName + ' ' : '') + 'has paid.</div>';
      var waiting = !collect && (d.waiting || []).length
        ? '<div class="card"><h2>Paid, not handed over yet</h2>' +
          '<div class="sub">From before paying meant handing over. Tap when it is in their hands.</div>' +
          d.waiting.map(function (o) {
            return orderRow(o, '<button class="ghost sm" onclick="SFT.collect(\'' + o.no + '\')">Handed over</button>');
          }).join('') + '</div>'
        : '';

      // Takings and the day's count deliberately live on Numbers, not here —
      // this screen faces the customer and is for ringing up, not reporting.
      var owed = d.unpaid.reduce(function (a, o) { return a + o.total; }, 0);
      var tb = SF.tabs('till', [['sell', 'Sell'],
                                ['topay', 'Still to pay' + (d.unpaid.length ? ' (' + d.unpaid.length + ')' : '')]]);
      return '<div class="wrap wide">' +
        SF.snap([
          figure('Pre-orders', moneyShort(t.preTotal), t.preCount + ' collected'),
          figure('Walk-ups', moneyShort(t.tillTotal), t.tillCount + ' sold'),
          figure('Still to pay', moneyShort(owed), d.unpaid.length + (d.unpaid.length === 1 ? ' order' : ' orders'))
        ]) +
        SF.slot('till.figures', ctx) + sellingBanner(d) + marketsToday(d) + staleMarket(d) + SF.slot('till.top', ctx) + tb.html +
        (tb.on === 'sell'
          ? lastSaleBar() + '<div class="card"><div style="display:flex;gap:10px;align-items:center">' +
              '<h2 style="flex:1">Ring up a sale</h2>' +
              '<button class="ghost sm" onclick="SFT.scan()">Scan</button>' +
              SF.slot('till.actions', ctx) +
            '</div>' + marketPicker(d) + tillSearch(d) + '<div id="tilesbox">' + tiles + '</div></div>'
          : '<div class="card"><h2>Pre-orders still to pay' +
              (hereName ? '<span class="for"> for ' + hereName + '</span>' : '') + '</h2>' +
              '<div class="sub">Already put aside. Check the items with them, then tap ' +
                '<b>Take payment</b>' + (collect ? '' : ' and hand the order over') + '.</div>' +
              marketPicker(d) + unpaid + '</div>' + waiting) +
        SF.slot('till.after', ctx) +
        '<div class="foot">StallFlow · till</div></div>' + cartBar();
    }
  });

  /* Which market this phone is selling at. Several can run on the same
     day, so each phone remembers its own; blank means the live market. */
  function sellAt() { return SF.ls.get('sf.sellAt', ''); }

  function marketPicker(d) {
    var at = sellAt() || d.marketId;
    var list = (d.markets || []).slice();
    // A market that has been and gone stays listed while this phone is still set to it,
    // so the box never shows a different market from the one sales are going to.
    if (at && !list.some(function (m) { return m.id === at; })) {
      (d.allMarkets || []).forEach(function (m) { if (m.id === at) list.push(m); });
    }
    var opts = list.map(function (m) {
      var label = m.id === 'HOME' ? 'Between markets (home, friends, WhatsApp)'
        : m.name + (m.date ? ' · ' + m.date : '');
      if (m.pending) label = m.name + ' · saving…';
      return '<option value="' + (m.id === 'HOME' ? 'home' : esc(m.id)) + '"' +
        (m.pending ? ' disabled' : '') +
        ((m.id === at || (m.id === 'HOME' && (at === 'HOME' || at === 'home'))) ? ' selected' : '') + '>' +
        esc(label) + '</option>';
    }).join('');
    return '<div class="field" style="margin:10px 0 4px"><label for="sellat">Selling at</label>' +
      '<select id="sellat" class="bigsel" onchange="SFT.sellAt(this.value)">' + opts + '</select></div>';
  }

  /* Type first, then the product, then its size: never a long list. */
  var pickName = null;
  var payFor = null;          // a pre-order being paid for; null while ringing up a sale
  var backToBasket = false;   // the "How many?" box was opened from the basket

  function dueNow() { return payFor ? payFor.total : cartTotals().total; }
  var tillQuery = '';         // what is typed in the till's product search

  /** Products matching every word typed, by name, size, category or code. */
  function tillMatches(d) {
    var words = tillQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return d.products.filter(function (p) {
      var text = [p.name, p.variant, p.category, p.id].join(' ').toLowerCase();
      return words.every(function (w) { return text.indexOf(w) !== -1; });
    });
  }

  /** The search box above the products; it only redraws the tiles under it. */
  function tillSearch(d) {
    if (d.products.length < 6) return '';
    return '<div class="fbar" style="margin:10px 0 4px"><input type="search" id="tq" class="fq" ' +
      'autocomplete="off" enterkeyhint="search" placeholder="Search products" aria-label="Search products" ' +
      'value="' + esc(tillQuery) + '" oninput="SFT.search(this.value)" onfocus="this.select()"></div>';
  }

  function picker(d) {
    if (tillQuery.trim()) {
      // Searching skips category, product and size: every match is one tap away.
      var hits = tillMatches(d);
      return hits.length
        ? '<div class="tiles">' + hits.map(function (p) { return tile(p, false); }).join('') + '</div>'
        : '<div class="empty">Nothing called “' + esc(tillQuery) + '”. ' +
          '<button class="quiet" onclick="SFT.search(\'\');SF.el(\'tq\').value=\'\'">Show everything</button></div>';
    }
    var groups = {}, order = [];
    d.products.forEach(function (p) {
      var cat = p.category || 'Other';
      if (!groups[cat]) { groups[cat] = []; order.push(cat); }
      groups[cat].push(p);
    });
    order.sort();
    if (!order.length) return '<div class="empty">No products yet.</div>';
    var cat = SF.ls.get('sf.tillcat', order[0]);
    if (!groups[cat]) cat = order[0];

    var chips = '<div class="chips">' + order.map(function (c) {
      return '<button class="' + (c === cat ? 'on' : '') + '" data-c="' + esc(c) + '" ' +
        'onclick="SFT.cat(this.getAttribute(\'data-c\'))">' + esc(c) + '</button>';
    }).join('') + '</div>';

    var byName = {}, names = [];
    groups[cat].forEach(function (p) {
      if (!byName[p.name]) { byName[p.name] = []; names.push(p.name); }
      byName[p.name].push(p);
    });

    if (pickName && byName[pickName]) {
      var sizes = byName[pickName];
      return chips + '<div class="sizepick"><div class="sizehead">' +
        '<button class="ghost sm" onclick="SFT.back()">‹ Back</button>' +
        '<b>' + esc(pickName) + '</b><span class="muted">choose the size</span></div>' +
        '<div class="tiles">' + sizes.map(function (p) { return tile(p, true); }).join('') + '</div></div>';
    }

    return chips + '<div class="tiles">' + names.map(function (n) {
      var list = byName[n];
      if (list.length === 1) return tile(list[0]);
      var left = 0, open = false, from = Infinity;
      list.forEach(function (p) {
        var l = availableNow(p);
        if (l === null) open = true; else left += Math.max(0, l);
        from = Math.min(from, p.price);
      });
      var out = !open && left <= 0;
      return '<button class="tile' + (out ? ' out' : '') + '"' + (out ? ' disabled' : '') +
        ' data-n="' + esc(n) + '" onclick="SFT.name(this.getAttribute(\'data-n\'))">' +
        '<span class="nm">' + esc(n) + ' <span class="vr">' + list.length + ' sizes · tap to choose</span></span>' +
        '<span class="bot"><span class="pr">' + money(from) + '</span>' +
        (out ? '<span class="st sold">SOLD OUT</span>'
             : open ? '<span class="st">to order</span>'
             : '<span class="st' + (left <= 4 ? ' low' : '') + '">' + left + ' left</span>') +
        '</span></button>';
    }).join('') + '</div>';
  }

  function tile(p, sizeOnly) {
    var left = availableNow(p);
    var out = left !== null && left <= 0;
    var state = left === null ? '<span class="st">to order</span>'
      : out ? '<span class="st sold">SOLD OUT</span>'
      : '<span class="st' + (left <= 4 ? ' low' : '') + '">' + qty(left, p.unit) + ' left</span>';
    var have = inBasket(p.id);
    return '<button class="tile' + (out ? ' out' : '') + (have ? ' has' : '') + '"' + (out ? ' disabled' : '') +
      ' onclick="SFT.tap(\'' + p.id + '\')">' +
      '<span class="nm">' + (sizeOnly ? esc(p.variant || p.name) : esc(p.name) +
        (p.variant ? ' <span class="vr">' + esc(p.variant) + '</span>' : '')) + '</span>' +
      (have ? '<span class="inb">' + have + ' in basket</span>' : '') +
      '<span class="bot"><span class="pr">' + money(p.price) +
        (p.weighed ? '<span class="per">/' + esc(p.unit) + '</span>' : '') + '</span>' +
        state + '</span></button>';
  }

  /* The basket. Docked at the bottom it is one slim bar — how many, how much,
     Take payment — so it never hides the products, however big the text is.
     Tapping it opens every line, full height, to change or remove. */
  function cartBar() {
    if (!cart.length) return '';
    var t = cartTotals();
    return '<div class="cart compact">' +
      '<button class="basketbtn" onclick="SFT.openBasket()" aria-label="Open the basket: ' +
        t.count + (t.count === 1 ? ' item, ' : ' items, ') + money(t.total) + '">' +
        '<span class="cnt">' + t.count + '</span>' +
        '<span class="lbl">' + (t.count === 1 ? 'item' : 'items') + '<i>View ▴</i></span>' +
        '<span class="up" aria-hidden="true">▴</span></button>' +
      '<button class="ok takebtn" onclick="SFT.take()"><span>Take payment</span>' +
        '<b class="amt">' + money(t.total) + '</b></button></div>';
  }

  function basketLines() {
    return cart.map(function (l, i) {
      var opts = (l.options || []).map(function (o) { return o.name || o.choice; }).join(', ');
      var name = esc(l.name) + (opts ? ' <span class="muted small">' + esc(opts) + '</span>' : '');
      if (l.type === 'weighed') {
        return '<div class="l"><span class="what">' + qty(l.qty, l.unit) + ' × ' + name +
          ' <button class="quiet" onclick="SFT.drop(' + i + ')">remove</button></span>' +
          '<span class="num">' + money(l.total) + '</span></div>';
      }
      // − 2 +  : change how many without going back through the products.
      // Tap the number to type it (twelve jars is not twelve taps).
      var label = esc(l.name);
      return '<div class="l"><span class="what">' + name + '</span>' +
        '<span class="qstep">' +
          '<button class="qb" aria-label="' + (l.qty > 1 ? 'One less ' : 'Remove ') + label + '" ' +
            'onclick="SFT.step(' + i + ',-1)">' + (l.qty > 1 ? '&minus;' : '&times;') + '</button>' +
          '<button class="qn num" aria-label="How many ' + label + '" onclick="SFT.howMany(' + i + ')">' +
            l.qty + '</button>' +
          '<button class="qb" aria-label="One more ' + label + '" onclick="SFT.step(' + i + ',1)">+</button>' +
        '</span><span class="num">' + money(l.total) + '</span></div>';
    }).join('');
  }

  function basketBody() {
    var t = cartTotals();
    // The total and Take payment stay pinned at the bottom while the lines scroll.
    return '<div class="basketlist cart">' + basketLines() + '</div>' +
      '<div class="bfoot"><div class="tot"><span class="muted">' + t.count +
        (t.count === 1 ? ' item' : ' items') + '</span><span class="amt">' + money(t.total) + '</span></div>' +
      '<button class="ok block" onclick="SFT.take()">Take payment</button>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="ghost" onclick="SF.closeSheet()">Add more</button>' +
        '<button class="ghost" onclick="SFT.clear()">Clear the basket</button></div></div>';
  }

  /** Redraw the open basket in place, keeping where it was scrolled to. */
  function refreshBasket() {
    var body = SF.el('basketbody');
    if (!body) return;
    if (!cart.length) { SF.closeSheet(); return; }
    var panel = body.closest('.panel'), y = panel ? panel.scrollTop : 0;
    body.innerHTML = basketBody();
    var c = SF.el('basketcount'), t = cartTotals();
    if (c) c.textContent = t.count + (t.count === 1 ? ' item' : ' items');
    if (panel) panel.scrollTop = y;
  }

  function inBasket(id) {
    var n = 0;
    cart.forEach(function (l) { if (l.id === id) n += l.type === 'weighed' ? 1 : l.qty; });
    return n;
  }

  /* Till behaviour, exposed for the inline handlers above. */
  window.SFT = {
    sellAt: function (v) {
      SF.ls.set('sf.sellAt', v);
      // Till and Collect share it: refresh whichever is open, and the other quietly.
      SF.load(SF.state.view === 'collect' ? 'collect' : 'till');
      SF.load(SF.state.view === 'collect' ? 'till' : 'collect');
    },
    cat: function (c) { SF.ls.set('sf.tillcat', c); pickName = null; SF.render(); },
    search: function (v) {
      tillQuery = String(v || '');
      var box = SF.el('tilesbox'), d = SF.state.data.till;
      if (box && d) box.innerHTML = picker(d);
    },
    name: function (n) { pickName = n; SF.render(); },
    back: function () { pickName = null; SF.render(); },
    tap: function (id) {
      var p = SF.find(SF.state.data.till.products, id);
      if (!p) return;
      if (p.weighed) return SFT.weigh(p);
      if ((p.options || []).length) return SFT.options(p);
      pickName = null;   // back to the jams for the next item
      SFT.add(p, 1, []);
    },

    add: function (p, n, options) {
      var left = availableNow(p);
      if (left !== null && n > left) {
        SF.toast('Only ' + qty(left, p.unit) + ' of ' + p.name + ' left.', true);
        return;
      }
      var key = p.id + '|' + (options || []).map(function (o) { return o.choice; }).join(',');
      var existing = null;
      cart.forEach(function (l) { if (l.key === key && l.type !== 'weighed') existing = l; });
      if (existing) {
        existing.qty += n;
        var pr = priceOf(p, existing);
        existing.total = pr.total; existing.units = pr.units;
      } else {
        var line = { key: key, id: p.id, name: p.name + (p.variant ? ' ' + p.variant : ''),
                     unit: p.unit, type: p.type,
                     qty: n, options: options || [] };
        var priced = priceOf(p, line);
        line.each = priced.each; line.total = priced.total; line.units = priced.units;
        cart.push(line);
      }
      SF.render();
      SF.toast('Added ' + p.name);
    },

    openBasket: function () {
      if (!cart.length) return;
      var t = cartTotals();
      SF.openSheet('<div class="bhead"><h2>Basket</h2><span class="muted" id="basketcount">' +
        t.count + (t.count === 1 ? ' item' : ' items') + '</span></div>' +
        '<div id="basketbody">' + basketBody() + '</div>');
    },

    /** True while a sale is being rung up — an update must not interrupt it. */
    busy: function () { return cart.length > 0; },

    drop: function (i) { cart.splice(i, 1); SF.render(); refreshBasket(); },

    /** Set how many of one line, within what is left; 0 takes it off the sale. */
    setQty: function (i, n) {
      var l = cart[i];
      if (!l) return;
      n = Math.floor(Number(n));
      if (!(n > 0)) { SFT.drop(i); return; }
      var p = SF.find(SF.state.data.till.products, l.id);
      if (p) {
        var left = availableNow(p);
        if (left !== null && n > left + l.units) {
          SF.toast('Only ' + qty(left + l.units, p.unit) + ' of ' + p.name + ' left.', true);
          n = left + l.units;
          if (n <= l.qty) { SF.render(); refreshBasket(); return; }
        }
        l.qty = n;
        var pr = priceOf(p, l);
        l.each = pr.each; l.total = pr.total; l.units = pr.units;
      } else {
        l.total = l.each * n; l.units = n; l.qty = n;
      }
      SF.render();
      refreshBasket();
    },
    step: function (i, dir) { var l = cart[i]; if (l) SFT.setQty(i, l.qty + dir); },

    howMany: function (i) {
      var l = cart[i];
      if (!l) return;
      backToBasket = !!SF.el('basketbody');
      SF.openSheet('<h2>How many?</h2><div class="sub">' + esc(l.name) + '</div>' +
        '<div class="field"><label for="hq">How many</label>' +
          '<input id="hq" type="number" inputmode="numeric" min="0" step="1" value="' + l.qty + '" ' +
          'style="font-size:28px;text-align:center" ' +
          'onkeydown="if(event.key===\'Enter\'){event.preventDefault();SFT.confirmQty(' + i + ')}"></div>' +
        '<div class="row tight" style="margin-bottom:12px">' + [1, 2, 3, 5, 10, 12].map(function (n) {
          return '<button class="ghost sm" onclick="SF.el(\'hq\').value=' + n + ';SFT.confirmQty(' + i + ')">' +
            n + '</button>';
        }).join('') + '</div>' +
        '<button class="block" onclick="SFT.confirmQty(' + i + ')">Done</button>');
      setTimeout(function () { var x = SF.el('hq'); if (x) { x.focus(); x.select(); } }, 60);
    },
    confirmQty: function (i) {
      var v = SF.el('hq') ? SF.el('hq').value : '';
      SF.closeSheet();
      if (String(v).trim() !== '') SFT.setQty(i, v);
      if (backToBasket && cart.length) SFT.openBasket();   // straight back to where she was
      backToBasket = false;
    },
    clear: function () { cart = []; SF.closeSheet(); SF.render(); },

    options: function (p) {
      var html = '<h2>' + esc(p.name) + '</h2><div class="sub">Pick the extras.</div>' +
        (p.options || []).map(function (g, gi) {
          return '<div class="field"><label>' + esc(g.name) + '</label>' +
            '<div class="row tight">' + (g.choices || []).map(function (c, ci) {
              return '<button class="ghost sm opt" data-g="' + gi + '" data-c="' + ci + '" ' +
                'onclick="SFT.pick(this)">' + esc(c.name) +
                (c.delta ? ' <span class="muted">+' + money(c.delta) + '</span>' : '') +
                '</button>';
            }).join('') + '</div></div>';
        }).join('') +
        '<button class="block" onclick="SFT.confirmOptions(\'' + p.id + '\')">Add to the till</button>';
      SF.openSheet(html);
    },

    pick: function (btn) {
      var g = btn.getAttribute('data-g');
      document.querySelectorAll('.opt[data-g="' + g + '"]').forEach(function (b) {
        b.classList.remove('picked');
      });
      btn.classList.add('picked');
    },

    confirmOptions: function (id) {
      var p = SF.find(SF.state.data.till.products, id);
      var chosen = [];
      document.querySelectorAll('.opt.picked').forEach(function (b) {
        var g = p.options[Number(b.getAttribute('data-g'))];
        var c = g.choices[Number(b.getAttribute('data-c'))];
        chosen.push({ group: g.id, choice: c.id, name: c.name, delta: Number(c.delta) || 0 });
      });
      var missing = (p.options || []).filter(function (g, gi) {
        return g.required && !chosen.some(function (c) { return c.group === g.id; });
      });
      if (missing.length) { SF.toast('Choose ' + missing[0].name + '.', true); return; }
      SF.closeSheet();
      SFT.add(p, 1, chosen);
    },

    weigh: function (p) {
      var unit = p.unit;
      var quick = unit === 'kg' ? [0.1, 0.25, 0.5, 1] : [1, 2, 5, 10];
      SF.openSheet(
        '<h2>' + esc(p.name) + '</h2>' +
        '<div class="sub">' + money(p.price) + ' per ' + esc(unit) +
          '. Type what the scale says.</div>' +
        '<div class="field"><label for="wq">Weight (' + esc(unit) + ')</label>' +
          '<input id="wq" type="number" inputmode="decimal" step="0.005" min="0" ' +
          'style="font-size:26px;text-align:center" oninput="SFT.weighPreview(\'' + p.id + '\')">' +
        '</div>' +
        '<div class="row tight" style="margin-bottom:12px">' + quick.map(function (q) {
          return '<button class="ghost sm" onclick="SFT.quick(' + q + ',\'' + p.id + '\')">' +
            qty(q, unit) + '</button>';
        }).join('') + '</div>' +
        '<div class="figure lead" id="wpreview" style="margin-bottom:14px">' +
          '<div class="k">Comes to</div><div class="v">R 0.00</div></div>' +
        '<button class="block" onclick="SFT.confirmWeigh(\'' + p.id + '\')">Add to the till</button>');
      setTimeout(function () { var i = SF.el('wq'); if (i) i.focus(); }, 60);
    },

    quick: function (v, id) { SF.el('wq').value = v; SFT.weighPreview(id); },

    weighPreview: function (id) {
      var p = SF.find(SF.state.data.till.products, id);
      var w = Number(SF.el('wq').value) || 0;
      SF.el('wpreview').innerHTML = '<div class="k">Comes to</div>' +
        '<div class="v">' + money(p.price * w) + '</div>' +
        '<div class="n">' + qty(w, p.unit) + ' at ' + money(p.price) + ' per ' + esc(p.unit) + '</div>';
    },

    confirmWeigh: function (id) {
      var p = SF.find(SF.state.data.till.products, id);
      var w = Number(SF.el('wq').value) || 0;
      if (w <= 0) { SF.toast('Type the weight first.', true); return; }
      var left = availableNow(p);
      if (left !== null && w > left + 1e-9) {
        SF.toast('Only ' + qty(left, p.unit) + ' of ' + p.name + ' left.', true);
        return;
      }
      SF.closeSheet();
      var line = { key: p.id + '|w' + SF.uid(), id: p.id, name: p.name, unit: p.unit,
                   type: 'weighed', qty: w, options: [] };
      var priced = priceOf(p, line);
      line.each = priced.each; line.total = priced.total; line.units = priced.units;
      cart.push(line);
      SF.render();
    },

    /**
     * Taking payment is two steps: work out the change, then record the sale.
     * The notes are tapped as they are handed over rather than typed as a
     * total, because that is what actually happens across a market table.
     */
    take: function () {
      if (!cart.length) return;
      payFor = null;
      SFT.paySheet(cartTotals().total, 'Take payment', 'Record the sale');
    },

    /** A pre-order paying at the table: the same notes, typed amount and change as a sale. */
    payOrder: function (no) {
      var till = SF.state.data.till, o = till && till.unpaid.filter(function (x) { return x.no === no; })[0];
      if (!o) return;
      payFor = { no: o.no, total: o.total, customer: o.customer };
      SFT.paySheet(o.total, esc(o.customer) + ' · ' + esc(o.no), 'Record the payment');
    },

    paySheet: function (total, title, recordLabel) {
      tendered = 0;
      notes = [];
      method = 'cash';
      SF.openSheet(
        '<h2>' + title + '</h2>' +
        '<div class="moneyrow"><span>Total</span><b>' + money(total) + '</b></div>' +
        '<div class="paywith" role="group" aria-label="How they pay">' +
          METHODS.map(function (m) {
            return '<button id="pw-' + m[0] + '" class="' + (m[0] === 'cash' ? 'on' : 'ghost') + '" ' +
              'aria-pressed="' + (m[0] === 'cash') + '" onclick="SFT.payWith(\'' + m[0] + '\')">' + m[1] + '</button>';
          }).join('') +
        '</div>' +
        '<div id="cashbits">' +
        '<label style="margin-top:16px">Money received — tap the notes, or type it</label>' +
        '<div class="cash">' +
          [5, 10, 20, 50, 100, 200].map(function (n) {
            return '<button class="ghost" onclick="SFT.addNote(' + n + ')">R' + n + '</button>';
          }).join('') +
          '<button class="ghost" onclick="SFT.exact()">Exact</button>' +
          '<button class="ghost" onclick="SFT.clearCash()">Clear</button>' +
          '<button class="ghost" onclick="SFT.undoNote()">&larr; Back</button>' +
        '</div>' +
        '<div class="moneyrow" style="margin-top:12px"><span>Received</span>' +
          '<span class="gotwrap">R <input id="got" type="tel" inputmode="numeric" value="0" ' +
          'oninput="SFT.paintChange()"></span></div>' +
        '<div class="change short" id="changeBox"><i id="changeLbl">Still short</i>' +
          '<b id="changeAmt">' + money(total) + '</b></div>' +
        '</div>' +
        '<div id="cardnote" class="muted small" style="display:none;margin:14px 0">' +
          'Take the payment on the card machine or check the EFT first, then record it.</div>' +
        '<button class="ok block" id="doSale" disabled onclick="SFT.recordSale()">' +
          recordLabel + '</button>' +
        '<button class="quiet block" style="margin-top:6px" onclick="SF.closeSheet()">' +
          'Back to the till</button>');
      SFT.paintChange();
    },

    addNote: function (n) {
      notes.push(n);
      tendered += n;
      SF.el('got').value = tendered;
      SFT.paintChange();
    },
    undoNote: function () {
      if (!notes.length) return;
      tendered -= notes.pop();
      SF.el('got').value = tendered;
      SFT.paintChange();
    },
    exact: function () {
      tendered = dueNow();
      notes = [];
      SF.el('got').value = tendered;
      SFT.paintChange();
    },
    clearCash: function () {
      tendered = 0; notes = [];
      SF.el('got').value = 0;
      SFT.paintChange();
    },

    /** Cash, card or EFT. Card and EFT need no notes and give no change. */
    payWith: function (m) {
      method = m;
      METHODS.forEach(function (x) {
        var b = SF.el('pw-' + x[0]);
        if (b) { b.className = x[0] === m ? 'on' : 'ghost'; b.setAttribute('aria-pressed', String(x[0] === m)); }
      });
      SF.el('cashbits').style.display = m === 'cash' ? '' : 'none';
      SF.el('cardnote').style.display = m === 'cash' ? 'none' : '';
      SFT.paintChange();
    },

    /** Ask for the customer's WhatsApp number; it opens WhatsApp and is not kept anywhere. */
    receipt: function () {
      if (!lastSale) return;
      SF.openSheet('<h2>Send a receipt</h2>' +
        '<div class="sub">Type their WhatsApp number. WhatsApp opens with the receipt typed in, ' +
          'ready to send. The number is not saved.</div>' +
        '<div class="field"><label for="rph">Their number</label>' +
          '<input id="rph" type="tel" inputmode="tel" autocomplete="off" placeholder="082 123 4567"></div>' +
        '<button class="block" id="rsend" onclick="SFT.sendReceipt()">Open WhatsApp</button>' +
        '<button class="quiet block" style="margin-top:6px" onclick="SF.closeSheet()">Not now</button>');
    },
    sendReceipt: function () {
      var n = waNumber(SF.el('rph') && SF.el('rph').value);
      if (!n || !lastSale) { SF.toast('Type a phone number, like 082 123 4567.', true); return; }
      var shop = (SF.state.boot && SF.state.boot.profile && SF.state.boot.profile.name) || 'Our stall';
      var d = lastSale.when, pad = function (x) { return (x < 10 ? '0' : '') + x; };
      var text = shop + ' \u2014 receipt\n' +
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) +
        (lastSale.market ? ' \u00b7 ' + lastSale.market : '') + '\n\n' +
        lastSale.lines.map(function (l) { return l.qty + ' \u00d7 ' + l.name + '  ' + money(l.total); }).join('\n') +
        '\n\nTotal ' + money(lastSale.total) + ' \u00b7 paid by ' + lastSale.methodName + '\nThank you!';
      window.open('https://wa.me/' + n + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
      SF.closeSheet();
    },
    makeLive: function (id) {
      SF.write('setActiveMarket', { marketId: id }, function () {
        var d = SF.state.data.till;
        if (d) { d.liveId = id; d.marketId = id; }
        if (SF.state.boot) SF.state.boot.marketId = id;
      });
      SF.toast('That is the live market now.');
      SF.sync().then(function () { SF.load('till'); });
    },

    paintChange: function () {
      var box = SF.el('changeBox');
      if (!box) return;
      if (method !== 'cash') { SF.el('doSale').disabled = false; return; }
      tendered = Number(SF.el('got').value) || 0;
      var total = dueNow();
      var diff = Math.round((tendered - total) * 100) / 100;
      var short = diff < 0;
      box.className = 'change' + (short ? ' short' : '');
      SF.el('changeLbl').textContent = short ? 'Still short' : 'Change to give';
      SF.el('changeAmt').textContent = money(Math.abs(diff));
      SF.el('doSale').disabled = short;
    },

    recordSale: function () {
      if (payFor) {
        // A pre-order: mark it paid (and handed over, where there is no Collect step).
        var o = payFor, back = method === 'cash' ? Math.round((tendered - o.total) * 100) / 100 : 0;
        payFor = null;
        SFT.pay(o.no, method);
        SF.closeSheet();
        if (back > 0) {
          SF.openSheet('<div class="give"><i>Give change</i><b>' + money(back) + '</b>' +
            '<span>' + esc(o.customer) + ' · ' + money(o.total) + ' · ' + money(tendered) +
            ' received</span></div>' +
            '<button class="block" onclick="SF.closeSheet()">Done</button>');
        } else SF.toast('Paid — ' + money(o.total));
        return;
      }
      if (!cart.length) return;
      var t = cartTotals();
      var change = method === 'cash' ? Math.round((tendered - t.total) * 100) / 100 : 0;
      var how = method;
      var lines = cart.map(function (l) {
        return { id: l.id, qty: l.qty, options: (l.options || []).map(function (o) {
          return { group: o.group, choice: o.choice }; }) };
      });
      var snapshot = cart.slice();
      cart = [];
      var till = SF.state.data.till || {};
      var at = SF.sellingAt();
      lastSale = { total: t.total, method: how, when: new Date(),
                   methodName: { cash: 'cash', card: 'card', eft: 'EFT' }[how],
                   market: at && at.id !== 'HOME' ? at.name : '',
                   lines: snapshot.map(function (l) { return { name: l.name, qty: l.qty, unit: l.unit, total: l.total }; }) };
      SF.write('sell', { lines: lines, marketId: sellAt() || till.marketId, paid: how }, function () {
        var till = SF.state.data.till, stock = SF.state.data.stock;
        snapshot.forEach(function (l) {
          [till, stock].forEach(function (d) {
            if (!d) return;
            var p = SF.find(d.products, l.id);
            if (p && p.available !== null && p.available !== undefined) p.available -= l.units;
            if (p && p.onHand !== undefined) p.onHand -= l.units;
          });
        });
        if (till) {
          till.totals.takings += t.total;
          till.totals.units += snapshot.reduce(function (a, l) { return a + l.units; }, 0);
          till.totals.orders += 1;
          till.totals.tillTotal += t.total;
          till.totals.tillCount += 1;
        }
      });
      SF.fire('sale.taken', { total: t.total, lines: snapshot });

      // She needs the change figure in front of her while she counts it out,
      // not a message that disappears in two seconds.
      SF.closeSheet();                   // the payment sheet, before anything replaces it
      if (change > 0) {
        SF.openSheet(
          '<div class="give"><i>Give change</i><b>' + money(change) + '</b>' +
          '<span>' + money(t.total) + ' sale · ' + money(tendered) + ' received</span>' +
          (lastSale.market ? '<span>at ' + esc(lastSale.market) + '</span>' : '') + '</div>' +
          '<button class="block" onclick="SF.closeSheet()">Next sale</button>');
      } else {
        SF.closeSheet();
        SF.toast((SF.state.online ? 'Sold — ' + money(t.total)
                                  : 'Sold — will sync when signal returns') +
                 (lastSale.market ? ' · ' + lastSale.market : ''));
      }
    },

    pay: function (no, how) {
      var handOver = !SF.collectOn();
      SF.write('markPaid', { orderNo: no, paid: how || 'cash' }, function () {
        var till = SF.state.data.till, q = SF.state.data.collect;
        if (till) {
          for (var i = 0; i < till.unpaid.length; i++) {
            if (till.unpaid[i].no === no) {
              var o = till.unpaid.splice(i, 1)[0];
              till.totals.takings += o.total; till.totals.units += o.units;
              till.totals.orders += 1; till.totals.preTotal += o.total;
              till.totals.preCount += 1;
              break;
            }
          }
        }
        if (q) {
          for (var j = 0; j < q.unpaid.length; j++) {
            if (q.unpaid[j].no === no) {
              var oo = q.unpaid.splice(j, 1)[0];
              oo.status = handOver ? 'collected' : 'paid';
              if (handOver) { q.done.unshift(oo); break; }
              q.waiting.push(oo);
              q.waiting.sort(function (a, b) { return a.when - b.when; });
              break;
            }
          }
        }
      });
      SF.toast('Marked paid');
    },

    /**
     * Cancelling puts the stock back on the shelf, so it is never silent —
     * she sees exactly what is going back and, if the order was already paid,
     * that handing the money back is hers to do.
     */
    cancel: function (no) {
      var order = null;
      ['till', 'collect'].forEach(function (v) {
        var d = SF.state.data[v];
        if (!d) return;
        [].concat(d.unpaid || [], d.waiting || []).forEach(function (o) {
          if (o.no === no) order = o;
        });
      });
      if (!order) { SF.toast('That order is not on this screen any more.', true); return; }
      var paid = order.status !== 'reserved';

      SF.openSheet(
        '<h2>Cancel ' + esc(order.customer) + '?</h2>' +
        '<div class="sub">' + esc(order.no) + ' · ' + SF.countOf(order.units) + '</div>' +
        '<div class="card flat" style="border:1px solid var(--rule);margin-bottom:14px">' +
          order.lines.map(function (l) {
            return '<div class="rowitem"><div class="who"><b>' +
              (l.type === 'weighed' ? qty(l.units, l.unit) : l.qty + ' ×') + ' ' +
              esc(l.name) + '</b></div><span class="amt">' + money(l.total) + '</span></div>';
          }).join('') +
        '</div>' +
        '<div class="notice ' + (paid ? 'bad' : 'warn') + '" style="border-radius:10px;' +
          'margin-bottom:14px;display:block;text-align:left">' +
          (paid
            ? '<b>This one has already paid.</b> Cancelling puts the stock back, but the ' +
              'money is yours to hand back — the app cannot do that.'
            : 'The stock goes straight back on the shelf and someone else can buy it.') +
        '</div>' +
        '<div class="row">' +
          '<button class="ghost" onclick="SF.closeSheet()">Keep it</button>' +
          '<button class="bad" style="flex:2" onclick="SFT.confirmCancel(\'' + no +
            '\')">Cancel the order</button>' +
        '</div>');
    },

    confirmCancel: function (no) {
      SF.closeSheet();
      SF.write('cancelOrder', { orderNo: no }, function () {
        var lines = null;
        ['till', 'collect'].forEach(function (v) {
          var d = SF.state.data[v];
          if (!d) return;
          ['unpaid', 'waiting'].forEach(function (list) {
            if (!d[list]) return;
            var i = indexOfNo(d[list], no);
            if (i > -1) { lines = lines || d[list][i].lines; d[list].splice(i, 1); }
          });
        });
        // Put the stock back on screen straight away, the way the server will.
        (lines || []).forEach(function (l) {
          if (l.type === 'made') return;
          ['till', 'stock'].forEach(function (v) {
            var d = SF.state.data[v];
            if (!d) return;
            var p = SF.find(d.products, l.id);
            if (!p) return;
            if (p.available !== null && p.available !== undefined) p.available += l.units;
            if (p.onHand !== undefined) p.onHand += l.units;
          });
        });
      });
      SF.toast('Cancelled — stock is back on the shelf');
    },

    collect: function (no) {
      SF.write('markCollected', { orderNo: no }, function () {
        var q = SF.state.data.collect;
        if (!q) return;
        for (var i = 0; i < q.waiting.length; i++) {
          if (q.waiting[i].no === no) {
            var o = q.waiting.splice(i, 1)[0];
            o.status = 'collected';
            q.done.unshift(o);
            break;
          }
        }
      });
      SF.toast('Handed over');
    },

    scan: function () { SF.scan(); }
  };

  /* ==================================================================
     COLLECT
     ================================================================== */

  function waited(o) {
    if (!o.when) return o.time ? 'ordered ' + o.time : '';
    var m = Math.round((Date.now() - o.when) / 60000);
    if (m < 0 || m > 720) return o.time ? 'ordered ' + o.time : '';
    if (m < 1) return 'just now';
    if (m < 60) return 'waiting ' + m + ' min';
    return 'waiting ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  SF.screen({
    id: 'collect', title: 'Collect', cap: 'orders',
    render: function (ctx) {
      var q = ctx.data;
      var next = q.waiting[0] || null, rest = q.waiting.slice(1);

      var head = next
        ? '<div class="serving"' + SF.filters.row('collect', { text: findText(next) }) +
          '><div class="k">Now serving</div>' +
          '<div class="nm">' + esc(next.customer) + '</div>' +
          '<div class="no">' + esc(next.no) + '</div>' +
          '<div class="what">' + next.lines.map(function (l) {
            return (l.type === 'weighed' ? qty(l.units, l.unit) : l.qty + ' ×') + ' ' + esc(l.name);
          }).join('<br>') + '</div>' +
          '<div class="waited">' + esc(waited(next)) + ' · paid</div>' +
          '<button onclick="SFT.collect(\'' + next.no + '\')">Handed over — next please</button>' +
          '</div>'
        : '<div class="card"><div class="empty">' +
          (q.unpaid.length
            ? 'Nobody waiting to collect. ' + q.unpaid.length + ' still to pay at the till.'
            : 'The queue is empty. Everything ordered ahead has been handed over.') +
          '</div></div>';

      var tb = SF.tabs('collect', [['queue', 'Queue'], ['topay', 'Still to pay'],
                                   ['done', 'Handed over']]);
      var none = '<div class="empty" data-fempty="collect" style="display:none">Nobody by that ' +
        'name or number here. Try the other tabs.</div>';
      var find = SF.filters.bar('collect', { search: 'Find a name or order number',
        count: q.waiting.length + q.unpaid.length + q.done.length, noun: 'orders' });
      var sections = {
        queue: find + head + none + '<div class="card"><h2>Next in line</h2>' +
          '<div class="sub">Oldest first — whoever ordered first gets served first.</div>' +
          (rest.length ? rest.map(function (o, i) {
            return row(i + 2, 'var(--ink)', o,
              '<button class="ghost sm" onclick="SFT.collect(\'' + o.no + '\')">Done</button>',
              true);
          }).join('') : '<div class="empty">No one else in the line.</div>') + '</div>',
        topay: find + none + '<div class="card"><h2>Still to pay</h2>' +
          '<div class="sub">They join the queue once the money is in.</div>' +
          (q.unpaid.length ? q.unpaid.map(function (o) {
            return row('!', 'var(--warn)', o,
              '<button class="ok sm" onclick="SFT.pay(\'' + o.no + '\')">Paid</button>', true);
          }).join('') : '<div class="empty">Everyone who ordered ahead has paid.</div>') + '</div>',
        done: find + none + '<div class="card"><h2>Handed over</h2>' +
          (q.done.length ? '<div class="done">' + q.done.map(function (o) {
            return row('✓', 'var(--ok)', o, '');
          }).join('') + '</div>' : '<div class="empty">Nothing handed over yet.</div>') + '</div>'
      };
      // Same "Selling at" as the till: the queue is the orders for the market this phone is at.
      return '<div class="wrap">' + (q.markets ? marketPicker(q) : '') +
        SF.snap([
          figure('Waiting', String(q.waiting.length), 'paid, to collect'),
          figure('Still to pay', String(q.unpaid.length), 'orders'),
          figure('Handed over', String(q.done.length), 'so far')
        ]) + tb.html + sections[tb.on] +
        SF.slot('collect.after', ctx) +
        '<div class="foot">StallFlow · collection</div></div>';
    }
  });

  function findText(o) {
    return [o.customer, o.no, o.no.replace(/\D/g, '')].concat((o.lines || []).map(function (l) {
      return l.name; })).join(' ');
  }

  function row(pos, colour, o, action, cancellable) {
    return '<div class="rowitem"' + SF.filters.row('collect', { text: findText(o) }) +
      '><span class="pos" style="background:' + colour + '">' +
      pos + '</span><div class="who"><b>' + esc(o.customer) + '</b><span>' + esc(o.no) +
      ' · ' + SF.countOf(o.units) +
      (o.status === 'reserved' ? ' · ordered ' + esc(o.time) : ' · ' + esc(waited(o))) +
      (cancellable ? ' · <button class="quiet" onclick="SFT.cancel(\'' + o.no +
        '\')">cancel</button>' : '') +
      '</span></div><span class="amt">' + money(o.total) + '</span>' + action + '</div>';
  }

  /* ==================================================================
     STOCK & COSTING
     ================================================================== */

  var runLines = [{ label: '', amount: '' }];

  SF.screen({
    id: 'stock', title: 'Stock', cap: 'stock',
    render: function (ctx) {
      var s = ctx.data;
      var v = SF.state.vocab;
      var counted = s.products.filter(function (p) { return p.type !== 'made' && p.active; });
      var onShelf = counted.reduce(function (a, p) { return a + p.onHand; }, 0);
      var ifSold = counted.reduce(function (a, p) { return a + p.onHand * p.price; }, 0);

      setTimeout(drawRunLines, 0);
      setTimeout(drawCook, 0);

      var st = s.stocktake && !s.stocktake.loaded && SF.can('people')
        ? '<div class="card stcard"><div><b>' + esc(s.stocktake.ref) + '</b>' +
          '<div class="muted small">Ready to load. Only you see this.</div></div>' +
          '<button id="stgo" onclick="SFS.loadStocktake()">Load</button></div>'
        : '';
      return '<div class="wrap wide">' + st +
        // The snapshot stays put whichever tab is open.
        SF.snap([
          figure('On the shelf', qty(onShelf, 'each'), counted.length + ' products'),
          figure('What it cost', moneyShort(s.stockValue), 'in stock'),
          figure('If it all sells', moneyShort(ifSold), moneyShort(ifSold - s.stockValue) + ' profit')
        ]) +
        stockTabs(s, v) +
        SF.slot('stock.after', ctx) +
        '<div class="foot">StallFlow · stock &amp; costing</div></div>';
    }
  });

  /* ---- I cooked a pot ------------------------------------------------
     Built for someone who should not have to think about costing: pick the
     jam, the recipe fills itself in, check the prices, count the jars. */
  var cook = null;

  function cookStart(name) {
    var s = SF.state.data.stock;
    var pot = SF.find((s.pots || []).map(function (p) { return Object.assign({ id: p.name }, p); }), name) ||
              (s.pots || [])[0];
    if (!pot) { cook = null; return; }
    var jars = {};
    pot.sizes.forEach(function (z, i) { jars[z.productId] = i === 0 ? pot.expect : 0; });
    cook = { pot: pot, lines: pot.lines.map(function (l) { return Object.assign({}, l); }), jars: jars };
  }

  function cookSums() {
    var potCost = cook.lines.reduce(function (a, l) {
      return a + (Number(l.qty) || 0) * (Number(l.price) || 0); }, 0);
    var volume = 0, count = 0;
    cook.pot.sizes.forEach(function (z) {
      var n = cook.jars[z.productId] || 0; volume += n * z.share; count += n; });
    var each = cook.pot.sizes.map(function (z) {
      var n = cook.jars[z.productId] || 0;
      return { z: z, n: n, cost: n && volume ? potCost * z.share / volume + z.bottle : 0 };
    });
    return { potCost: potCost, count: count, each: each };
  }

  function drawCook() {
    var box = SF.el('cookbox');
    if (!box) return;
    var s = SF.state.data.stock;
    if (!cook) cookStart();
    if (!cook) { box.style.display = 'none'; return; }
    var opts = s.pots.map(function (p) {
      return '<option' + (p.name === cook.pot.name ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('') + (cook.isNew ? '<option selected>' + esc(cook.pot.name) + ' (new)</option>' : '') +
      '<option value="__new">+ A new jam…</option>';
    var units = ['kg', 'g', 'litre', 'each', 'pot'];
    var lines = cook.lines.map(function (l, i) {
      var fixed = l.unit === 'pot' && !l.fresh;
      var x = '<button class="x" onclick="SFS.cookDrop(' + i + ')" aria-label="Take ' +
        esc(l.label || 'this') + ' out of the recipe">×</button>';
      if (l.fresh) {
        return '<div class="cookline">' +
          '<input class="lbl" placeholder="What is it? e.g. Lemon juice" value="' + esc(l.label) + '" ' +
            'oninput="SFS.cookSet(' + i + ',\'label\',this.value)">' +
          '<input class="q num" type="number" inputmode="decimal" min="0" step="0.1" value="' +
            esc(l.qty) + '" oninput="SFS.cookSet(' + i + ',\'qty\',this.value)" aria-label="How much">' +
          '<select onchange="SFS.cookSet(' + i + ',\'unit\',this.value)">' +
            units.map(function (u) { return '<option' + (u === l.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') +
          '</select><span class="muted">R</span>' +
          '<input class="p num" type="number" inputmode="decimal" min="0" step="0.5" value="' +
            esc(l.price) + '" oninput="SFS.cookSet(' + i + ',\'price\',this.value)" aria-label="Price">' + x + '</div>';
      }
      return '<div class="cookline">' +
        '<span class="lbl">' + esc(l.label) + '</span>' + x +
        (fixed ? '<span class="muted">this pot</span>'
          : '<input class="q num" type="number" inputmode="decimal" min="0" step="0.1" value="' +
            esc(l.qty) + '" oninput="SFS.cookSet(' + i + ',\'qty\',this.value)" aria-label="How much">' +
            '<span class="muted">' + esc(l.unit) + ' at R</span>') +
        '<input class="p num" type="number" inputmode="decimal" min="0" step="0.5" value="' +
          esc(l.price) + '" oninput="SFS.cookSet(' + i + ',\'price\',this.value)" aria-label="Price">' +
        (fixed ? '' : '<span class="muted">a ' + esc(l.unit) + '</span>') + '</div>';
    }).join('');
    var sizes = cook.pot.sizes.map(function (z) {
      var n = cook.jars[z.productId] || 0;
      return '<div class="jarrow"><span class="lbl">' + esc(z.variant) + '</span>' +
        '<button class="ghost big" onclick="SFS.cookJar(\'' + z.productId + '\',-1)" aria-label="One less">−</button>' +
        '<b class="n">' + n + '</b>' +
        '<button class="ghost big" onclick="SFS.cookJar(\'' + z.productId + '\',1)" aria-label="One more">+</button></div>';
    }).join('');
    box.innerHTML = '<h2>I cooked a pot</h2>' +
      '<div class="sub">Choose the jam. What usually goes in is filled in for you.</div>' +
      '<select id="cookName" class="bigsel" onchange="SFS.cookPick(this.value)">' + opts + '</select>' +
      '<h3 class="step">1. What went in</h3>' +
      '<div class="sub">Check the prices. Change any that were different this time.</div>' + lines +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="ghost" onclick="SFS.cookAdd()">+ Add an ingredient</button>' +
        '<button class="ghost" onclick="SFS.cookKeep()">Save as the usual recipe</button></div>' +
      (cook.isNew || !cook.pot.sizes.length
        ? '<div class="notice" style="border-radius:10px;margin-top:14px"><span>This is a new jam. Put in ' +
          'what goes into one pot, then tap <strong>Save as the usual recipe</strong>. It is added to your ' +
          'shelf list in all three sizes (352 ml R70, medium R50, 125 ml R40), and then you can cook it.</span></div>'
        : '<h3 class="step">2. How many jars did you fill?</h3>' + sizes +
          '<div id="cookanswer"></div>' +
          '<button class="block bigbtn" id="cookgo" onclick="SFS.cookSave()"></button>');
    cookAnswer();
  }

  function cookAnswer() {
    var box = SF.el('cookanswer');
    if (!box || !cook.pot.sizes.length) return;
    var t = cookSums();
    box.innerHTML = '<div class="answer" style="margin-top:12px">' +
      '<div class="r"><span>The pot cost</span><b>' + money(t.potCost) + '</b></div>' +
      t.each.filter(function (e) { return e.n; }).map(function (e) {
        return '<div class="r big"><span>Each ' + esc(e.z.variant) + ' jar costs</span><b>' +
          money(e.cost) + '</b></div>';
      }).join('') + '</div>';
    var go = SF.el('cookgo');
    go.textContent = t.count ? 'Put ' + t.count + ' jar' + (t.count === 1 ? '' : 's') + ' on the shelf'
                             : 'Fill in how many jars';
    go.disabled = !t.count;
  }

  /* One section at a time, picked from tabs, remembered on the phone. */
  function stockTabs(s, v) {
    var pots = (s.pots || []).length;
    var tabs = [
      ['cook', pots ? 'Cook a pot' : 'Add a ' + v.run],
      ['shelf', 'Shelf & prices'],
      ['cupboard', 'Cupboard'],
      ['count', 'Stocktake'],
      ['history', 'History']
    ];
    if (pots) tabs.splice(3, 0, ['other', 'Other']);
    var tb = SF.tabs('stock', tabs), on = tb.on;
    // Stock with no cost makes profit look better than it is: say so, once, at the top.
    var free = (s.products || []).filter(function (p) {
      return p.active && p.type !== 'made' && p.onHand > 0 && !(p.cost > 0);
    });
    var nudge = free.length && on !== 'count'
      ? '<div class="card stale slim"><b>' + free.length + (free.length === 1 ? ' product has' : ' products have') +
          ' no cost yet.</b> Profit counts ' + (free.length === 1 ? 'it' : 'them') + ' as free, and a stocktake ' +
          'loss as nothing.' + (on !== 'cook'
            ? ' <button class="quiet" onclick="SF.pickTab(\'stock\',\'cook\')">' + esc(tabs[0][1]) + '</button>' : '') + '</div>'
      : '';
    var body = on === 'cook' ? (pots ? '<div class="card" id="cookbox"></div>' : runCard(s, v))
      : on === 'other' ? '<div class="sub" style="margin:4px 2px 10px">Biscuits, crochet, anything ' +
          'that is not a pot of jam.</div>' + runCard(s, v)
      : on === 'shelf' ? priceTable(s)
      : on === 'cupboard' ? pantryCard(s)
      : on === 'count' ? (window.SFCount ? SFCount.render() : '')
      : runHistory(s, v);
    // Every jam in all three sizes (352 ml, medium, 125 ml), so each can be counted and cooked.
    var sizesCard = s.sizesMissing > 0 && on !== 'count'
      ? '<div class="card stale"><b>' + s.sizesMissing + ' jam size' + (s.sizesMissing === 1 ? ' is' : 's are') +
          ' missing.</b> Every jam should come in all three sizes: 352 ml, medium and 125 ml. This adds the ' +
          'missing ones at the usual prices with none in stock, ready to count or cook. Sizes already there ' +
          'are not touched.<button class="block" id="addsizes" style="margin-top:10px" onclick="SFS.addSizes()">' +
          'Add the missing sizes</button></div>'
      : '';
    return sizesCard + nudge + tb.html + body;
  }

  function pantryCard(s) {
    var items = s.pantry || [];
    var units = ['kg', 'g', 'litre', 'each'];
    var rows = items.length ? items.map(function (r) {
      return '<tr' + SF.filters.row('cupboard', { text: r.item + ' ' + (r.note || '') + ' ' + r.unit },
                                     { name: String(r.item).toLowerCase(), qty: r.qty }) + '><td>' + esc(r.item) + (r.note ? ' <span class="muted small">' + esc(r.note) + '</span>' : '') +
        '</td><td class="num"><b>' + esc(r.qty) + '</b> ' + esc(r.unit) + '</td>' +
        '<td class="muted small">' + esc(r.updated) + '</td>' +
        '<td><button class="quiet" data-i="' + esc(r.item) + '" data-q="' + esc(r.qty) + '" data-u="' + esc(r.unit) + '" ' +
        'onclick="SFS.editPantry(this.getAttribute(\'data-i\'),this.getAttribute(\'data-q\'),this.getAttribute(\'data-u\'))">' +
        'change</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">Nothing yet. Add fruit, sugar, ' +
      'empty bottles — whatever is waiting to be cooked.</td></tr>';
    return '<div class="card"><h2>Uncooked stock</h2>' +
      '<div class="sub">Fruit, sugar, bottles and bags in the cupboard. Type the new amount ' +
        'whenever you check; set it to 0 when it is used up.</div>' +
      SF.filters.bar('cupboard', { search: 'Search the cupboard', count: items.length, noun: 'items',
        sorts: [['', 'As listed'], ['name', 'A–Z'], ['qty', 'Least first']] }) +
      '<table><tbody>' + rows +
      '<tr data-fempty="cupboard" style="display:none"><td colspan="4" class="empty">Nothing matches.</td></tr>' +
      '</tbody></table>' +
      '<div class="row" style="margin-top:12px">' +
        '<div class="field" style="flex:2"><label for="pi">What</label>' +
          '<input id="pi" placeholder="Strawberries, sugar, 352 ml bottles…"></div>' +
        '<div class="field"><label for="pq">How much</label>' +
          '<input id="pq" type="number" inputmode="decimal" min="0" step="0.01" placeholder="3"></div>' +
        '<div class="field"><label for="pu">Unit</label><select id="pu">' +
          units.map(function (u) { return '<option>' + u + '</option>'; }).join('') +
        '</select></div></div>' +
      '<button class="block" onclick="SFS.savePantry()">Save</button></div>';
  }

  function runCard(s, v) {
    var opts = s.products.filter(function (p) { return p.active; }).map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) +
        (p.variant ? ' · ' + esc(p.variant) : '') + '</option>';
    }).join('') || '<option value="">Add a product first</option>';

    return '<div class="card"><h2>I made a ' + esc(v.run) + '</h2>' +
      '<div class="sub">Put in everything it cost and how many it made. ' +
        'The cost per ' + esc(v.unit) + ' works itself out.</div>' +
      '<div class="row"><div class="field" style="flex:2"><label for="rp">Which product</label>' +
        '<select id="rp" onchange="SFS.answer()">' + opts + '</select></div>' +
      '<div class="field"><label for="rn">How many it made</label>' +
        '<input id="rn" type="number" inputmode="decimal" min="0" step="0.001" ' +
        'placeholder="24" oninput="SFS.answer()"></div></div>' +
      '<label>What it cost</label><div id="runlines"></div>' +
      '<button class="ghost sm" onclick="SFS.addLine()">+ Add another cost</button>' +
      '<div id="runanswer"></div>' +
      '<div class="field" style="margin-top:12px"><label for="rnote">Note (optional)</label>' +
        '<input id="rnote" placeholder="Made 14 March, fruit from the Saturday market"></div>' +
      '<button class="block" onclick="SFS.saveRun()">Add this ' + esc(v.run) + '</button></div>';
  }

  function drawRunLines() {
    var box = SF.el('runlines');
    if (!box) return;
    box.innerHTML = runLines.map(function (l, i) {
      return '<div class="costline">' +
        '<input class="lbl" placeholder="Fruit, sugar, jars, gas, wool…" value="' +
          esc(l.label) + '" oninput="SFS.setLine(' + i + ',\'label\',this.value)">' +
        '<input class="amt num" type="number" inputmode="decimal" min="0" step="0.01" ' +
          'placeholder="0.00" value="' + esc(l.amount) + '" ' +
          'oninput="SFS.setLine(' + i + ',\'amount\',this.value);SFS.answer()">' +
        (runLines.length > 1
          ? '<button class="x" onclick="SFS.dropLine(' + i + ')" aria-label="Remove">×</button>'
          : '<button class="x" style="visibility:hidden" tabindex="-1">×</button>') + '</div>';
    }).join('');
    SFS.answer();
  }

  window.SFS = {
    setLine: function (i, k, v) { runLines[i][k] = v; },
    addLine: function () { runLines.push({ label: '', amount: '' }); drawRunLines(); },
    dropLine: function (i) { runLines.splice(i, 1); drawRunLines(); },

    answer: function () {
      var box = SF.el('runanswer');
      if (!box) return;
      var s = SF.state.data.stock, v = SF.state.vocab;
      var total = runLines.reduce(function (a, l) { return a + (Number(l.amount) || 0); }, 0);
      var made = Number((SF.el('rn') || {}).value) || 0;
      var per = made > 0 ? total / made : 0;
      var p = SF.find(s.products, (SF.el('rp') || {}).value);
      var price = p ? p.price : 0;

      var verdict = '';
      if (made > 0 && total > 0 && price > 0) {
        var margin = price - per;
        verdict = margin <= 0
          ? '<div class="warnline">⚠ At ' + money(price) + ' you would lose ' +
            money(Math.abs(margin)) + ' on every one. Put the price up, or make bigger ' +
            esc(v.runs) + '.</div>'
          : '<div class="warnline">You keep ' + money(margin) + ' each — ' +
            Math.round(margin / price * 100) + '% of the price. The whole ' + esc(v.run) +
            ' is worth ' + money(margin * made) + ' to you.</div>';
      }

      box.innerHTML = '<div class="answer">' +
        '<div class="r"><span>Everything it cost</span><b>' + money(total) + '</b></div>' +
        '<div class="r"><span>How many it made</span><b>' + (made || '—') + '</b></div>' +
        '<div class="r big"><span>Cost per ' + esc(v.unit) + '</span><b>' +
          (made > 0 && total > 0 ? money(per) : '—') + '</b></div>' + verdict + '</div>';
    },

    loadStocktake: function () {
      var b = SF.el('stgo');
      b.disabled = true; b.textContent = 'Loading…';
      var opId = SF.uid(), tries = 0;
      function done() {
        SF.toast('The stocktake is in.');
        SF.cache.clear && SF.cache.clear();
        SF.load('till'); SF.load('stock');
      }
      // A slow first run can outlast the phone's patience while it carries on
      // at Google, and a second tap then finds it busy. So instead of giving
      // up, check every 20 seconds whether it has landed, and ask again
      // (same opId, so it never runs twice) until it has.
      function check() {
        tries++;
        if (tries > 15) {
          b.disabled = false; b.textContent = 'Try again';
          SF.toast('Still not in after 5 minutes. Check your signal and try again.', true);
          return;
        }
        b.textContent = 'Working…';
        SF.post({ action: 'stock' }).then(function (res) {
          var st = res && res.data && res.data.stocktake;
          if (st && st.loaded) { done(); return; }
          attempt();
        }).catch(function () { setTimeout(check, 20000); });
      }
      function attempt() {
        SF.post({ action: 'loadStocktake', opId: opId }).then(function (res) {
          if (res && res.ok !== false) { done(); return; }
          setTimeout(check, 20000);
        }).catch(function () { setTimeout(check, 20000); });
      }
      attempt();
    },

    cookPick: function (name) {
      if (name === '__new') {
        var n = (window.prompt('What is the new jam called?') || '').trim();
        if (n.length < 2) { drawCook(); return; }
        cook = { isNew: true, pot: { name: n, expect: 6, sizes: [], lines: [] },
                 lines: [{ label: '', item: '', qty: 3, unit: 'kg', price: 25, fresh: true },
                         { label: 'Sugar', item: 'Sugar', qty: 2.5, unit: 'kg', price: 26 }], jars: {} };
        drawCook();
        return;
      }
      cookStart(name); drawCook();
    },
    cookSet: function (i, k, v) {
      cook.lines[i][k] = v;
      if (k === 'label') cook.lines[i].item = cook.lines[i].unit === 'pot' ? '' : v;
      if (k === 'unit') { if (v === 'pot') cook.lines[i].item = ''; else cook.lines[i].item = cook.lines[i].label; }
      cookAnswer();
    },
    cookAdd: function () {
      cook.lines.push({ label: '', item: '', qty: 1, unit: 'kg', price: 0, fresh: true }); drawCook();
      var all = document.querySelectorAll('.cookline input.lbl');
      if (all.length) all[all.length - 1].focus();
    },
    cookDrop: function (i) {
      var l = cook.lines[i];
      if (l.label && !window.confirm('Take ' + l.label + ' out of this pot?')) return;
      cook.lines.splice(i, 1); drawCook();
    },
    cookKeep: function () {
      var lines = cook.lines.filter(function (l) { return String(l.label).trim() && Number(l.qty) > 0; })
        .map(function (l) { return { label: String(l.label).trim(), item: l.item, qty: Number(l.qty),
                                     unit: l.unit, price: Number(l.price) || 0 }; });
      if (!lines.length) { SF.toast('Add at least one ingredient.', true); return; }
      var name = cook.pot.name, isNew = cook.isNew || !cook.pot.sizes.length;
      SF.write('saveRecipe', { name: name, makes: cook.pot.expect, lines: lines }, function () {
        var s = SF.state.data.stock;
        if (!s || isNew) return;
        s.pots.forEach(function (p) { if (p.name === name) p.lines = lines; });
      });
      SF.toast(isNew ? name + ' is saved. It will be ready to cook in a moment.'
                     : 'Saved. Next time ' + name + ' starts with this recipe.');
      if (isNew) { cook = null; setTimeout(function () { SF.load('stock'); }, 2500); }
    },
    cookJar: function (id, d) {
      cook.jars[id] = Math.max(0, (cook.jars[id] || 0) + d); drawCook();
    },
    cookSave: function () {
      var t = cookSums();
      if (!t.count) return;
      var name = cook.pot.name, jars = Object.assign({}, cook.jars);
      var lines = cook.lines.map(function (l) {
        return { label: l.label, item: l.item, qty: Number(l.qty) || 0, unit: l.unit,
                 price: Number(l.price) || 0 };
      });
      SF.write('cookPot', { name: name, lines: lines, jars: jars }, function () {
        var s = SF.state.data.stock, till = SF.state.data.till;
        Object.keys(jars).forEach(function (id) {
          [s, till].forEach(function (d) {
            var p = d && SF.find(d.products, id);
            if (p && jars[id]) { p.onHand = (p.onHand || 0) + jars[id];
                                 if (p.available !== null && p.available !== undefined) p.available += jars[id]; }
          });
        });
        if (s && s.pantry) {
          var take = {};
          lines.forEach(function (l) { if (l.item) take[l.item.toLowerCase()] = [l.qty, l.unit]; });
          cook.pot.sizes.forEach(function (z) {
            if (jars[z.productId]) take[z.bottleItem.toLowerCase()] = [jars[z.productId], 'each']; });
          s.pantry.forEach(function (r) {
            var t2 = take[r.item.toLowerCase()];
            if (!t2) return;
            var q = t2[1] === 'kg' && r.unit === 'g' ? t2[0] * 1000
                  : t2[1] === 'g' && r.unit === 'kg' ? t2[0] / 1000 : t2[0];
            if (t2[1] === r.unit || q !== t2[0]) r.qty = Math.max(0, Math.round((r.qty - q) * 1000) / 1000);
          });
        }
      });
      cook = null;
      SF.toast(t.count + ' jars of ' + name + ' are on the shelf');
    },

    editPantry: function (item, qty, unit) {
      SF.el('pi').value = item; SF.el('pq').value = qty; SF.el('pu').value = unit;
      SF.el('pq').focus();
    },

    savePantry: function () {
      var item = SF.el('pi').value.trim(), qty = Number(SF.el('pq').value), unit = SF.el('pu').value;
      if (item.length < 2) { SF.toast('Say what it is, e.g. Sugar.', true); return; }
      if (!(qty >= 0) || SF.el('pq').value === '') { SF.toast('How much is there?', true); return; }
      SF.write('savePantry', { item: item, qty: qty, unit: unit }, function () {
        var s = SF.state.data.stock;
        if (!s) return;
        s.pantry = (s.pantry || []).filter(function (r) {
          return r.item.toLowerCase() !== item.toLowerCase();
        }).concat([{ item: item, qty: qty, unit: unit, note: '', updated: 'now' }])
          .sort(function (a, b) { return a.item.localeCompare(b.item); });
      });
      SF.toast(item + ': ' + qty + ' ' + unit);
    },

    saveRun: function () {
      var pid = SF.el('rp').value, made = Number(SF.el('rn').value) || 0;
      if (!pid) { SF.toast('Choose which product this is.', true); return; }
      if (made <= 0) { SF.toast('How many did it make?', true); SF.el('rn').focus(); return; }
      var lines = runLines
        .filter(function (l) { return (Number(l.amount) || 0) > 0 || l.label.trim(); })
        .map(function (l) { return { label: l.label, amount: Number(l.amount) || 0 }; });
      if (!lines.length) { SF.toast('Add at least one cost.', true); return; }
      var total = lines.reduce(function (a, l) { return a + l.amount; }, 0);

      SF.write('addBatch', { productId: pid, made: made, lines: lines,
                             note: SF.el('rnote').value }, function () {
        var s = SF.state.data.stock;
        if (!s) return;
        var p = SF.find(s.products, pid);
        if (p && p.type !== 'made') { p.onHand += made; p.available += made; }
        s.batches.unshift({ id: 'pending', when: 'not sent yet', productId: pid, made: made,
                            lines: lines, totalCost: total, costPerUnit: total / made, note: '' });
      });
      runLines = [{ label: '', amount: '' }];
      SF.toast('Added — ' + money(total / made) + ' each');
    },

    setPrice: function (id, value) {
      var price = Math.round((Number(value) || 0) * 100) / 100;
      var box = SF.el('pp-' + id), note = SF.el('ps-' + id);
      if (box) box.value = price.toFixed(2);
      SF.write('setPrice', { productId: id, price: price }, function () {
        ['till', 'stock'].forEach(function (v) {
          var d = SF.state.data[v];
          if (!d) return;
          var p = SF.find(d.products, id);
          if (p) {
            p.price = price;
            if (p.cost !== undefined) {
              p.margin = price - p.cost;
              p.marginPct = price > 0 ? (price - p.cost) / price * 100 : 0;
            }
          }
        });
      });
      // The answer sits right under the price, where the eyes already are. A save
      // redraws the screen, so the note is kept and painted by the redraw as well.
      var p0 = SF.find((SF.state.data.stock || {}).products || [], id);
      var text = 'Saved \u2713' + (p0 && p0.cost > 0 ? ' \u00b7 you keep ' + money(price - p0.cost) + ' each' : '');
      justSaved[id] = { text: text, at: Date.now() };
      var paint = function () {
        var n = SF.el('ps-' + id);
        if (n) { n.textContent = text; n.className = 'saved on'; }
      };
      paint(); setTimeout(paint, 60);
      setTimeout(function () {
        var n = SF.el('ps-' + id);
        if (n && justSaved[id] && Date.now() - justSaved[id].at >= 2500) n.className = 'saved';
      }, 2700);
    },

    /** −5 / +5: change the box, then save once the taps stop. */
    nudge: function (btn) {
      var id = btn.getAttribute('data-id'), box = SF.el('pp-' + id);
      if (!box) return;
      var v = Math.max(0, Math.round(((Number(box.value) || 0) + Number(btn.getAttribute('data-d'))) * 100) / 100);
      box.value = v.toFixed(2);
      clearTimeout(box._t);
      box._t = setTimeout(function () { SFS.setPrice(id, box.value); }, 600);
    },

    toggle: function (id, on) { SF.write('setActive', { productId: id, active: on }); },

    /** Add every missing jam size. It can take a little while, so say so, then show the result. */
    addSizes: function () {
      var b = SF.el('addsizes');
      if (b) { b.disabled = true; b.textContent = 'Adding the sizes\u2026'; }
      SF.write('addJamSizes', {});
      SF.toast('Adding the sizes. This can take a minute.');
      var tries = 0;
      (function wait() {
        if (SF.outbox.pending().length && ++tries < 120) { setTimeout(wait, 1000); return; }
        SF.load('stock').then(function () {
          var d = SF.state.data.stock;
          SF.toast(d && d.sizesMissing === 0 ? 'Done. Every jam has all three sizes.' : 'Not finished yet. Open Stock again in a moment.');
        });
      })();
    },

    adjust: function (id) {
      var p = SF.find(SF.state.data.stock.products, id);
      var v = prompt('Adjust ' + (p ? p.name : 'stock') +
        '.\n\nHow many? Use a minus for breakages, e.g. -2');
      if (v === null) return;
      var n = Number(v);
      if (!n) { SF.toast('Enter a number like 3 or -2.', true); return; }
      var why = prompt('Why? (broke, gave away, miscounted)') || '';
      SF.write('adjustStock', { productId: id, qty: n, reason: why }, function () {
        ['till', 'stock'].forEach(function (view) {
          var d = SF.state.data[view];
          if (!d) return;
          var pp = SF.find(d.products, id);
          if (pp) { if (pp.onHand !== undefined) pp.onHand += n;
                    if (pp.available !== null) pp.available += n; }
        });
      });
      SF.toast('Stock adjusted');
    },

    newProduct: function () {
      var types = (SF.state.boot.profile.types || ['stocked']);
      // The categories already in use, so a new product goes under the right heading
      // with one tap and a typo cannot start a second "Resin".
      var seen = {}, cats = [];
      [SF.state.data.stock, SF.state.data.till, SF.state.data.labels].forEach(function (d) {
        ((d && d.products) || []).forEach(function (p) {
          var c = String(p.category || '').trim();
          if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = true; cats.push(c); }
        });
      });
      cats.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
      var last = SF.ls.get('sf.lastcat', '');
      SF.openSheet('<h2>New product</h2>' +
        '<div class="sub">You can change any of this later.</div>' +
        '<div class="field"><label for="pn">Name</label><input id="pn" placeholder="Lizard resin ornament"></div>' +
        '<div class="field"><label for="pc">Category</label><select id="pc" onchange="SFS.catChanged()">' +
          cats.map(function (c) {
            return '<option value="' + esc(c) + '"' + (c === last ? ' selected' : '') + '>' + esc(c) + '</option>';
          }).join('') + '<option value="__new__"' + (cats.length ? '' : ' selected') + '>New category\u2026</option></select>' +
          '<input id="pcn" placeholder="Name the new category" style="margin-top:8px;display:' +
            (cats.length ? 'none' : 'block') + '"></div>' +
        '<div class="row"><div class="field"><label for="pp">Price</label>' +
          '<input id="pp" type="number" inputmode="decimal" min="0" step="0.5" placeholder="105"></div>' +
        '<div class="field" id="qtywrap"><label for="pq">How many do you have?</label>' +
          '<input id="pq" type="number" inputmode="decimal" min="0" step="1" placeholder="0"></div></div>' +
        '<div class="row"><div class="field"><label for="pv">Size or variant (optional)</label>' +
          '<input id="pv" placeholder="340g"></div>' +
        '<div class="field"><label for="pu">Unit</label>' +
          '<select id="pu"><option value="each">each</option><option value="kg">per kg</option>' +
          '<option value="100g">per 100 g</option></select></div></div>' +
        '<div class="field"><label for="pt">How is it sold?</label><select id="pt" onchange="SFS.typeChanged()">' +
          types.map(function (t) {
            return '<option value="' + t + '">' + ({
              stocked: 'A finite number, made in advance',
              made: 'Made to order, limited by capacity',
              weighed: 'By weight'
            })[t] + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field" id="capwrap" style="display:none"><label for="pcap">How many can you make in a day?</label>' +
          '<input id="pcap" type="number" inputmode="numeric" min="0" placeholder="40"></div>' +
        '<button class="block" onclick="SFS.saveProduct()">Add it</button>');
    },

    catChanged: function () {
      var isNew = SF.el('pc').value === '__new__';
      SF.el('pcn').style.display = isNew ? 'block' : 'none';
      if (isNew) SF.el('pcn').focus();
    },

    typeChanged: function () {
      var t = SF.el('pt').value;
      SF.el('capwrap').style.display = t === 'made' ? '' : 'none';
      SF.el('qtywrap').style.display = t === 'made' ? 'none' : '';
      SF.el('pu').value = t === 'weighed' ? 'kg' : 'each';
    },

    /** Scan a jar on the Stock screen: show how many are in stock, and point at its row. */
    scanCheck: function () {
      SF.scan({ once: function (id) {
        var d = SF.state.data.stock, p = d && SF.find(d.products, id);
        if (!p) { SF.toast('That label is for a product that is not in the list.', true); return; }
        SF.filters.clear('shelf');
        var row = SF.el('shelf-' + id);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          row.classList.add('flash');
          setTimeout(function () { row.classList.remove('flash'); }, 2400);
        }
        var left = p.type === 'made' ? (p.available === null ? 'made to order' : p.available + ' left today')
          : qty(p.onHand, p.unit) + ' in stock';
        SF.toast(p.name + (p.variant ? ' ' + p.variant : '') + ': ' + left);
      } });
    },

    saveProduct: function () {
      var name = SF.el('pn').value;
      if (String(name).trim().length < 2) { SF.toast('Give it a name.', true); return; }
      if (!(Number(SF.el('pp').value) > 0)) { SF.toast('Set a selling price.', true); return; }
      var cat = SF.el('pc').value === '__new__' ? SF.el('pcn').value.trim() : SF.el('pc').value;
      if (SF.el('pc').value === '__new__' && cat.length < 2) { SF.toast('Name the new category.', true); return; }
      if (cat) SF.ls.set('sf.lastcat', cat);
      // Read everything first: closing the sheet removes the boxes from the page.
      var made = SF.el('pt').value === 'made';
      var item = {
        name: name, variant: SF.el('pv').value, category: cat,
        type: SF.el('pt').value, unit: SF.el('pu').value,
        qty: made ? 0 : Number(SF.el('pq').value) || 0,
        price: SF.el('pp').value, capacity: SF.el('pcap').value || 0
      };
      SF.closeSheet();
      SF.write('saveProduct', item);
      SF.toast('Added');
    }
  };

  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
    return out.sort();
  }

  var justSaved = {};   // product id -> what the Saved note says, kept across the redraw a save causes

  function priceTable(s) {
    var F = 'shelf';
    var cats = uniq(s.products.map(function (p) { return p.category; }));
    var types = uniq(s.products.map(function (p) { return p.type; }));
    var uncategorised = s.products.some(function (p) { return !p.category; });
    var rows = s.products.map(function (p) {
      var show = [p.active ? 'onsale' : 'hidden'];
      if (p.type !== 'made') show.push(p.onHand <= 0 ? 'out' : p.onHand <= 4 ? 'low' : 'instock');
      var left = p.type === 'made' ? (p.available === null ? 1e9 : p.available) : p.onHand;
      var state = !p.active ? '<span class="tag">Hidden</span>'
        : p.type === 'made'
          ? '<span class="tag ok">' + (p.available === null ? 'to order'
              : p.available + ' left today') + '</span>'
        : p.onHand <= 0 ? '<span class="tag bad">Sold out</span>'
        : p.onHand <= 4 ? '<span class="tag warn">' + qty(p.onHand, p.unit) + '</span>'
        : '<span class="tag ok">' + qty(p.onHand, p.unit) + '</span>';

      var kept = p.cost > 0
        ? 'Costs you <b>' + money(p.cost) + '</b> · you keep <b>' + money(p.margin) + '</b> <span class="muted">(' +
            Math.round(p.marginPct) + '%)</span>'
        : 'No ' + esc(SF.state.vocab.run) + ' yet: cost not known';
      var id = esc(p.id), js = justSaved[p.id];
      return '<div class="pcard' + (p.active ? '' : ' off') + '" id="shelf-' + id + '"' + SF.filters.row(F, {
          text: [p.name, p.variant, p.category, p.id, p.type].join(' '),
          cat: p.category || 'none', show: show.join(' '), type: p.type
        }, { name: p.name.toLowerCase() + ' ' + String(p.variant || '').toLowerCase(), left: left,
             type: p.type, cost: p.cost > 0 ? Math.round(p.cost * 100) / 100 : -1e9, price: p.price,
             keep: p.cost > 0 ? Math.round(p.margin * 100) / 100 : -1e9 }) + '>' +
        '<div class="ptop"><div class="pname"><b>' + esc(p.name) + '</b>' +
          (p.variant ? ' <span class="muted">' + esc(p.variant) + '</span>' : '') + '</div>' + state + '</div>' +
        '<div class="pprice"><label for="pp-' + id + '">Selling price (rand)</label>' +
          '<div class="pinput">' +
            '<button type="button" class="step" data-id="' + id + '" data-d="-5" aria-label="R5 less for ' + esc(p.name) +
              '" onclick="SFS.nudge(this)">&minus;5</button>' +
            '<input id="pp-' + id + '" type="number" min="0" step="0.5" inputmode="decimal" class="pricebox num" ' +
              'data-id="' + id + '" value="' + p.price.toFixed(2) + '" aria-label="Selling price of ' + esc(p.name) + '" ' +
              'onchange="SFS.setPrice(this.getAttribute(\'data-id\'),this.value)" onfocus="this.select()">' +
            '<button type="button" class="step" data-id="' + id + '" data-d="5" aria-label="R5 more for ' + esc(p.name) +
              '" onclick="SFS.nudge(this)">+5</button>' +
          '</div><div class="saved' + (js && Date.now() - js.at < 2600 ? ' on' : '') + '" id="ps-' + id +
          '" aria-live="polite">' + (js && Date.now() - js.at < 2600 ? esc(js.text) : '') + '</div></div>' +
        '<div class="pmeta">' + kept + '</div>' +
        '<div class="pacts"><button class="quiet" data-id="' + id + '" data-on="' + (p.active ? 'false' : 'true') +
          '" onclick="SFS.toggle(this.getAttribute(\'data-id\'),this.getAttribute(\'data-on\')===\'true\')">' +
          (p.active ? 'hide' : 'show') + '</button>' +
          (p.type !== 'made'
            ? '<button class="quiet" data-id="' + id + '" onclick="SFS.adjust(this.getAttribute(\'data-id\'))">adjust stock</button>' : '') +
        '</div></div>';
    }).join('');

    return '<div class="card"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<h2 style="flex:1">Prices and what is left</h2>' +
      '<button class="ghost sm" onclick="SFS.scanCheck()">Scan a jar</button>' +
      '<button class="ghost sm" onclick="SFS.newProduct()">Add product</button></div>' +
      '<div class="sub">Type a new price, or tap <b>−5</b> / <b>+5</b>. It saves by itself and takes ' +
        'effect at once: the order page and the till both follow.</div>' +
      SF.filters.bar(F, {
        search: 'Search products', count: s.products.length, noun: 'products',
        facets: [
          { key: 'cat', label: 'Category', options: [['all', 'All']].concat(cats.map(function (c) {
              return [c, c]; }), cats.length && uncategorised ? [['none', 'No category']] : []) },
          { key: 'show', label: 'Show', options: [['all', 'All'], ['onsale', 'On sale'],
              ['low', 'Running low'], ['out', 'Sold out'], ['hidden', 'Hidden']] },
          { key: 'type', label: 'Sold as', options: [['all', 'All']].concat(types.map(function (t) {
              return [t, t]; })) }
        ],
        sorts: [['', 'Shelf order'], ['name', 'A–Z'], ['-name', 'Z–A'], ['type', 'Sold as'],
                ['left', 'Least left first'], ['-left', 'Most left first'],
                ['cost', 'Cheapest to make'], ['-cost', 'Dearest to make'],
                ['price', 'Lowest price'], ['-price', 'Highest price'],
                ['-keep', 'Most kept each'], ['keep', 'Least kept each']]
      }) +
      '<div class="plist">' +
      (rows || '<div class="empty">Nothing here yet.</div>') +
      '<div class="empty" data-fempty="' + F + '" style="display:none">Nothing matches. ' +
        '<button class="quiet" onclick="SF.filters.clear(\'' + F + '\')">Show all</button></div>' +
      '</div></div>';
  }

  function runHistory(s, v) {
    var names = {};
    s.products.forEach(function (p) { names[p.id] = p.name; });
    var list = s.batches.slice(0, 300);
    var body = list.length ? SF.filters.bar('runs', { search: 'Search what you made', count: list.length,
        noun: 'entries', sorts: [['', 'Newest first'], ['-each', 'Dearest each'], ['each', 'Cheapest each'],
                                 ['-made', 'Most made']] }) +
      list.map(function (b) {
      return '<div class="runrow"' + SF.filters.row('runs', {
          text: [names[b.productId] || b.productId, b.productId, b.when, b.note].concat(
            (b.lines || []).map(function (l) { return l.label; })).join(' ') },
          { each: b.costPerUnit, made: b.made }) + '><div class="hd"><b>' +
        esc(names[b.productId] || b.productId) + ' — ' + b.made + '</b>' +
        '<span class="num"><b>' + money(b.costPerUnit) + '</b> ' +
        '<span class="muted small">each</span></span></div>' +
        '<div class="det">' + esc(b.when) + ' · ' + money(b.totalCost) + ' total · ' +
        b.lines.map(function (l) { return esc(l.label) + ' ' + money(l.amount); }).join(' · ') +
        (b.note ? ' · ' + esc(b.note) : '') + '</div></div>';
    }).join('') + '<div class="empty" data-fempty="runs" style="display:none">Nothing matches.</div>'
      : '<div class="empty">Nothing recorded yet.</div>';

    return '<div class="card"><h2>' + esc(v.runs.charAt(0).toUpperCase() + v.runs.slice(1)) +
      ' you have made</h2><div class="sub">Cost per ' + esc(v.unit) +
      ' above is the average across all of them.</div>' + body + '</div>';
  }
})();
