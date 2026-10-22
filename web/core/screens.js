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
      var groups = {};
      d.products.forEach(function (p) {
        var key = p.category || '';
        (groups[key] = groups[key] || []).push(p);
      });

      var tiles = Object.keys(groups).sort().map(function (cat) {
        return (cat ? '<div class="tag" style="margin:14px 0 8px">' + esc(cat) + '</div>' : '') +
          '<div class="tiles">' + groups[cat].map(tile).join('') + '</div>';
      }).join('');

      var unpaid = d.unpaid.length ? d.unpaid.map(function (o) {
        return '<div class="rowitem"><div class="who"><b>' + esc(o.customer) + '</b>' +
          '<span>' + esc(o.no) + ' · ' + SF.countOf(o.units) + ' · ordered ' + esc(o.time) +
          ' · <button class="quiet" onclick="SFT.cancel(\'' + o.no + '\')">cancel</button>' +
          '</span></div><span class="amt">' + money(o.total) + '</span>' +
          '<button class="ok sm" onclick="SFT.pay(\'' + o.no + '\')">Paid</button></div>';
      }).join('') : '<div class="empty">Nothing outstanding — every pre-order has paid.</div>';

      // Takings and the day's count deliberately live on Numbers, not here —
      // this screen faces the customer and is for ringing up, not reporting.
      return '<div class="wrap wide">' +
        '<div class="grid g2" style="margin-bottom:14px">' +
          figure('Pre-orders', moneyShort(t.preTotal), t.preCount + ' collected') +
          figure('Walk-ups', moneyShort(t.tillTotal), t.tillCount + ' at the table') +
          SF.slot('till.figures', ctx) +
        '</div>' +
        SF.slot('till.top', ctx) +
        '<div class="card"><div style="display:flex;gap:10px;align-items:center">' +
          '<h2 style="flex:1">Ring up a sale</h2>' +
          '<button class="ghost sm" onclick="SFT.scan()">Scan</button>' +
          SF.slot('till.actions', ctx) +
        '</div>' + whereSwitch() +
        '<div class="sub">Tap what they are buying.</div>' + tiles + '</div>' +
        '<div class="card"><h2>Pre-orders still to pay</h2>' +
          '<div class="sub">Already put aside. Tap <b>Paid</b> when the money is in.</div>' +
          unpaid + '</div>' +
        SF.slot('till.after', ctx) +
        '<div class="foot">StallFlow · till</div></div>' + cartBar();
    }
  });

  /* At a market, or a sale in between (at home, a friend, WhatsApp)?
     Remembered on this phone, so she sets it once when she gets home. */
  function where() { return SF.ls.get('sf.where', 'market'); }

  function whereSwitch() {
    var home = where() === 'home';
    var btn = function (v, label, on) {
      return '<button class="' + (on ? '' : 'ghost ') + 'sm" onclick="SFT.where(\'' + v + '\')">' +
        label + '</button>';
    };
    return '<div style="display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap">' +
      '<span class="muted small">Selling</span>' +
      btn('market', 'At the market', !home) + btn('home', 'Between markets', home) + '</div>' +
      (home ? '<div class="notice" style="border-radius:10px;margin-bottom:8px"><span>' +
        'These sales are kept under <b>Sales between markets</b> on Numbers, not the live market. ' +
        'Switch back before the next market.</span></div>' : '');
  }

  function tile(p) {
    var left = availableNow(p);
    var out = left !== null && left <= 0;
    var state = left === null ? '<span class="st">to order</span>'
      : out ? '<span class="st sold">SOLD OUT</span>'
      : '<span class="st' + (left <= 4 ? ' low' : '') + '">' + qty(left, p.unit) + ' left</span>';
    return '<button class="tile' + (out ? ' out' : '') + '"' + (out ? ' disabled' : '') +
      ' onclick="SFT.tap(\'' + p.id + '\')">' +
      '<span class="nm">' + esc(p.name) +
        (p.variant ? ' <span class="vr">' + esc(p.variant) + '</span>' : '') + '</span>' +
      '<span class="bot"><span class="pr">' + money(p.price) +
        (p.weighed ? '<span class="per">/' + esc(p.unit) + '</span>' : '') + '</span>' +
        state + '</span></button>';
  }

  function cartBar() {
    if (!cart.length) return '';
    var t = cartTotals();
    return '<div class="cart"><div class="lines">' + cart.map(function (l, i) {
      var what = l.type === 'weighed' ? qty(l.qty, l.unit) + ' × ' + esc(l.name)
        : l.qty + ' × ' + esc(l.name);
      var opts = (l.options || []).map(function (o) { return o.name || o.choice; }).join(', ');
      return '<div class="l"><span>' + what +
        (opts ? ' <span class="muted small">' + esc(opts) + '</span>' : '') +
        ' <button class="quiet" onclick="SFT.drop(' + i + ')">remove</button></span>' +
        '<span class="num">' + money(l.total) + '</span></div>';
    }).join('') + '</div>' +
      '<div class="tot"><span class="muted small">' + t.count + ' on the till</span>' +
      '<span class="amt">' + money(t.total) + '</span></div>' +
      '<div class="row"><button class="ghost" onclick="SFT.clear()">Clear</button>' +
      '<button class="ok" style="flex:2" onclick="SFT.take()">Take payment</button></div></div>';
  }

  /* Till behaviour, exposed for the inline handlers above. */
  window.SFT = {
    where: function (v) { SF.ls.set('sf.where', v); SF.render(); },
    tap: function (id) {
      var p = SF.find(SF.state.data.till.products, id);
      if (!p) return;
      if (p.weighed) return SFT.weigh(p);
      if ((p.options || []).length) return SFT.options(p);
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
        var line = { key: key, id: p.id, name: p.name, unit: p.unit, type: p.type,
                     qty: n, options: options || [] };
        var priced = priceOf(p, line);
        line.each = priced.each; line.total = priced.total; line.units = priced.units;
        cart.push(line);
      }
      SF.render();
    },

    /** True while a sale is being rung up — an update must not interrupt it. */
    busy: function () { return cart.length > 0; },

    drop: function (i) { cart.splice(i, 1); SF.render(); },
    clear: function () { cart = []; SF.render(); },

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
      tendered = 0;
      notes = [];
      var total = cartTotals().total;

      SF.openSheet(
        '<h2>Take payment</h2>' +
        '<div class="moneyrow"><span>Total</span><b>' + money(total) + '</b></div>' +
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
        '<button class="ok block" id="doSale" disabled onclick="SFT.recordSale()">' +
          'Record the sale</button>' +
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
      tendered = cartTotals().total;
      notes = [];
      SF.el('got').value = tendered;
      SFT.paintChange();
    },
    clearCash: function () {
      tendered = 0; notes = [];
      SF.el('got').value = 0;
      SFT.paintChange();
    },

    paintChange: function () {
      var box = SF.el('changeBox');
      if (!box) return;
      tendered = Number(SF.el('got').value) || 0;
      var total = cartTotals().total;
      var diff = Math.round((tendered - total) * 100) / 100;
      var short = diff < 0;
      box.className = 'change' + (short ? ' short' : '');
      SF.el('changeLbl').textContent = short ? 'Still short' : 'Change to give';
      SF.el('changeAmt').textContent = money(Math.abs(diff));
      SF.el('doSale').disabled = short;
    },

    recordSale: function () {
      if (!cart.length) return;
      var t = cartTotals();
      var change = Math.round((tendered - t.total) * 100) / 100;
      var lines = cart.map(function (l) {
        return { id: l.id, qty: l.qty, options: (l.options || []).map(function (o) {
          return { group: o.group, choice: o.choice }; }) };
      });
      var snapshot = cart.slice();
      cart = [];
      SF.write('sell', { lines: lines, where: where() }, function () {
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
          '<span>' + money(t.total) + ' sale · ' + money(tendered) + ' received</span></div>' +
          '<button class="block" onclick="SF.closeSheet()">Next sale</button>');
      } else {
        SF.closeSheet();
        SF.toast(SF.state.online ? 'Sold — ' + money(t.total)
                                 : 'Sold — will sync when signal returns');
      }
    },

    pay: function (no) {
      SF.write('markPaid', { orderNo: no }, function () {
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
              oo.status = 'paid';
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
        ? '<div class="serving"><div class="k">Now serving</div>' +
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

      return '<div class="wrap">' + head +
        '<div class="card"><h2>Next in line</h2>' +
          '<div class="sub">Oldest first — whoever ordered first gets served first.</div>' +
          (rest.length ? rest.map(function (o, i) {
            return row(i + 2, 'var(--ink)', o,
              '<button class="ghost sm" onclick="SFT.collect(\'' + o.no + '\')">Done</button>',
              true);
          }).join('') : '<div class="empty">No one else in the line.</div>') + '</div>' +
        '<div class="card"><h2>Still to pay</h2>' +
          '<div class="sub">They join the queue once the money is in.</div>' +
          (q.unpaid.length ? q.unpaid.map(function (o) {
            return row('!', 'var(--warn)', o,
              '<button class="ok sm" onclick="SFT.pay(\'' + o.no + '\')">Paid</button>', true);
          }).join('') : '<div class="empty">Everyone who ordered ahead has paid.</div>') + '</div>' +
        SF.slot('collect.after', ctx) +
        '<div class="card"><h2>Handed over</h2>' +
          (q.done.length ? '<div class="done">' + q.done.map(function (o) {
            return row('✓', 'var(--ok)', o, '');
          }).join('') + '</div>' : '<div class="empty">Nothing handed over yet.</div>') + '</div>' +
        '<div class="foot">StallFlow · collection</div></div>';
    }
  });

  function row(pos, colour, o, action, cancellable) {
    return '<div class="rowitem"><span class="pos" style="background:' + colour + '">' +
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
        ? '<div class="card" style="border:2px solid var(--brand)"><h2>' + esc(s.stocktake.ref) + '</h2>' +
          '<div class="sub">The jams, sizes, prices and counts are ready to go in. Old ' +
          'placeholder products are switched off, not deleted.</div>' +
          '<button class="block bigbtn" id="stgo" onclick="SFS.loadStocktake()">Load it now</button></div>'
        : '';
      return '<div class="wrap wide">' + st +
        // The snapshot stays put whichever tab is open.
        '<div class="snap">' +
          figure('On the shelf', qty(onShelf, 'each'), counted.length + ' products') +
          figure('What it cost', moneyShort(s.stockValue), 'in stock') +
          figure('If it all sells', moneyShort(ifSold), 'today’s prices') +
        '</div>' +
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
        '<span class="lbl">' + esc(l.label) + '</span>' +
        (fixed ? '<span class="muted">this pot</span>'
          : '<input class="q num" type="number" inputmode="decimal" min="0" step="0.1" value="' +
            esc(l.qty) + '" oninput="SFS.cookSet(' + i + ',\'qty\',this.value)" aria-label="How much">' +
            '<span class="muted">' + esc(l.unit) + ' at R</span>') +
        '<input class="p num" type="number" inputmode="decimal" min="0" step="0.5" value="' +
          esc(l.price) + '" oninput="SFS.cookSet(' + i + ',\'price\',this.value)" aria-label="Price">' +
        (fixed ? '' : '<span class="muted">a ' + esc(l.unit) + '</span>') + x + '</div>';
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
          'shelf list as 352 ml at R70 and 125 ml at R40, and then you can cook it.</span></div>'
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
      ['history', 'History']
    ];
    if (pots) tabs.splice(3, 0, ['other', 'Other']);
    var on = SF.ls.get('sf.stocktab', 'cook');
    if (!tabs.some(function (t) { return t[0] === on; })) on = 'cook';
    var body = on === 'cook' ? (pots ? '<div class="card" id="cookbox"></div>' : runCard(s, v))
      : on === 'other' ? '<div class="sub" style="margin:4px 2px 10px">Biscuits, crochet, anything ' +
          'that is not a pot of jam.</div>' + runCard(s, v)
      : on === 'shelf' ? priceTable(s)
      : on === 'cupboard' ? pantryCard(s)
      : runHistory(s, v);
    return '<div class="stabs" role="tablist">' + tabs.map(function (t) {
      return '<button role="tab" aria-selected="' + (t[0] === on) + '" class="' +
        (t[0] === on ? 'on' : '') + '" onclick="SFS.tab(\'' + t[0] + '\')">' + esc(t[1]) + '</button>';
    }).join('') + '</div>' + body;
  }

  function pantryCard(s) {
    var items = s.pantry || [];
    var units = ['kg', 'g', 'litre', 'each'];
    var rows = items.length ? items.map(function (r) {
      return '<tr><td>' + esc(r.item) + (r.note ? ' <span class="muted small">' + esc(r.note) + '</span>' : '') +
        '</td><td class="num"><b>' + esc(r.qty) + '</b> ' + esc(r.unit) + '</td>' +
        '<td class="muted small">' + esc(r.updated) + '</td>' +
        '<td><button class="quiet" onclick="SFS.editPantry(\'' + esc(r.item).replace(/'/g, '&#39;') +
        '\',' + r.qty + ',\'' + r.unit + '\')">change</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">Nothing yet. Add fruit, sugar, ' +
      'empty bottles — whatever is waiting to be cooked.</td></tr>';
    return '<div class="card"><h2>Uncooked stock</h2>' +
      '<div class="sub">Fruit, sugar, bottles and bags in the cupboard. Type the new amount ' +
        'whenever you check; set it to 0 when it is used up.</div>' +
      '<table><tbody>' + rows + '</tbody></table>' +
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

    tab: function (t) { SF.ls.set('sf.stocktab', t); SF.render(); window.scrollTo(0, 0); },

    loadStocktake: function () {
      var b = SF.el('stgo');
      b.disabled = true; b.textContent = 'Loading… this takes about a minute';
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
        b.textContent = 'Still working… (' + tries * 20 + ' seconds)';
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
      SF.toast('Price is now ' + money(price));
    },

    toggle: function (id, on) { SF.write('setActive', { productId: id, active: on }); },

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
      SF.openSheet('<h2>New product</h2>' +
        '<div class="sub">You can change any of this later.</div>' +
        '<div class="field"><label for="pn">Name</label><input id="pn" placeholder="Gooseberry jam"></div>' +
        '<div class="row"><div class="field"><label for="pv">Variant</label>' +
          '<input id="pv" placeholder="340g"></div>' +
        '<div class="field"><label for="pc">Category</label>' +
          '<input id="pc" placeholder="Jams"></div></div>' +
        '<div class="field"><label for="pt">How is it sold?</label><select id="pt" onchange="SFS.typeChanged()">' +
          types.map(function (t) {
            return '<option value="' + t + '">' + ({
              stocked: 'A finite number, made in advance',
              made: 'Made to order, limited by capacity',
              weighed: 'By weight'
            })[t] + '</option>';
          }).join('') + '</select></div>' +
        '<div class="row"><div class="field"><label for="pu">Unit</label>' +
          '<select id="pu"><option value="each">each</option><option value="kg">per kg</option>' +
          '<option value="100g">per 100 g</option></select></div>' +
        '<div class="field"><label for="pp">Price</label>' +
          '<input id="pp" type="number" inputmode="decimal" min="0" step="0.5" placeholder="65"></div>' +
        '</div>' +
        '<div class="field" id="capwrap" style="display:none"><label for="pcap">How many can you make in a day?</label>' +
          '<input id="pcap" type="number" inputmode="numeric" min="0" placeholder="40"></div>' +
        '<button class="block" onclick="SFS.saveProduct()">Add it</button>');
    },

    typeChanged: function () {
      var t = SF.el('pt').value;
      SF.el('capwrap').style.display = t === 'made' ? '' : 'none';
      SF.el('pu').value = t === 'weighed' ? 'kg' : 'each';
    },

    saveProduct: function () {
      var name = SF.el('pn').value;
      if (String(name).trim().length < 2) { SF.toast('Give it a name.', true); return; }
      if (!(Number(SF.el('pp').value) > 0)) { SF.toast('Set a selling price.', true); return; }
      SF.closeSheet();
      SF.write('saveProduct', {
        name: name, variant: SF.el('pv') ? SF.el('pv').value : '',
        category: SF.el('pc') ? SF.el('pc').value : '',
        type: SF.el('pt').value, unit: SF.el('pu').value,
        price: SF.el('pp').value, capacity: SF.el('pcap') ? SF.el('pcap').value : 0
      });
      SF.toast('Added');
    }
  };

  function priceTable(s) {
    var rows = s.products.map(function (p) {
      var state = !p.active ? '<span class="tag">Hidden</span>'
        : p.type === 'made'
          ? '<span class="tag ok">' + (p.available === null ? 'to order'
              : p.available + ' left today') + '</span>'
        : p.onHand <= 0 ? '<span class="tag bad">Sold out</span>'
        : p.onHand <= 4 ? '<span class="tag warn">' + qty(p.onHand, p.unit) + '</span>'
        : '<span class="tag ok">' + qty(p.onHand, p.unit) + '</span>';

      return '<tr><td><b>' + esc(p.name) + '</b>' +
        (p.variant ? '<div class="muted small">' + esc(p.variant) + '</div>' : '') + '</td>' +
        '<td><span class="tag">' + esc(p.type) + '</span></td>' +
        '<td>' + state + '</td>' +
        '<td class="r">' + (p.cost > 0 ? money(p.cost) : '—') + '</td>' +
        '<td><input type="number" min="0" step="0.5" inputmode="decimal" class="pricebox num" ' +
          'value="' + p.price.toFixed(2) + '" onchange="SFS.setPrice(\'' + p.id + '\',this.value)"></td>' +
        '<td class="r">' + (p.cost > 0
          ? money(p.margin) + ' <span class="muted small">(' + Math.round(p.marginPct) + '%)</span>'
          : '<span class="muted small">no ' + esc(SF.state.vocab.run) + ' yet</span>') + '</td>' +
        '<td class="r"><button class="quiet" onclick="SFS.toggle(\'' + p.id + '\',' +
          (p.active ? 'false' : 'true') + ')">' + (p.active ? 'hide' : 'show') + '</button>' +
          (p.type !== 'made'
            ? '<button class="quiet" onclick="SFS.adjust(\'' + p.id + '\')">adjust</button>' : '') +
        '</td></tr>';
    }).join('');

    return '<div class="card"><div style="display:flex;gap:10px;align-items:center">' +
      '<h2 style="flex:1">Prices and what is left</h2>' +
      '<button class="ghost sm" onclick="SFS.newProduct()">Add product</button></div>' +
      '<div class="sub">Change a price and it takes effect at once — the order page and the ' +
        'till both follow.</div>' +
      '<div class="scroll"><table><tr><th>Product</th><th>Sold as</th><th>Left</th>' +
      '<th class="r">Costs you</th><th>Sells for</th><th class="r">You keep</th><th></th></tr>' +
      (rows || '<tr><td colspan="7" class="empty">Nothing here yet.</td></tr>') +
      '</table></div></div>';
  }

  function runHistory(s, v) {
    var names = {};
    s.products.forEach(function (p) { names[p.id] = p.name; });
    var body = s.batches.length ? s.batches.slice(0, 12).map(function (b) {
      return '<div class="runrow"><div class="hd"><b>' +
        esc(names[b.productId] || b.productId) + ' — ' + b.made + '</b>' +
        '<span class="num"><b>' + money(b.costPerUnit) + '</b> ' +
        '<span class="muted small">each</span></span></div>' +
        '<div class="det">' + esc(b.when) + ' · ' + money(b.totalCost) + ' total · ' +
        b.lines.map(function (l) { return esc(l.label) + ' ' + money(l.amount); }).join(' · ') +
        (b.note ? ' · ' + esc(b.note) : '') + '</div></div>';
    }).join('') : '<div class="empty">Nothing recorded yet.</div>';

    return '<div class="card"><h2>' + esc(v.runs.charAt(0).toUpperCase() + v.runs.slice(1)) +
      ' you have made</h2><div class="sub">Cost per ' + esc(v.unit) +
      ' above is the average across all of them.</div>' + body + '</div>';
  }
})();
