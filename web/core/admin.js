/**
 * StallFlow — the market view, labels, settings, health and the failed queue.
 * Everything an operator needs occasionally rather than every thirty seconds.
 */
(function () {
  'use strict';

  var esc = SF.esc, money = SF.money, moneyShort = SF.moneyShort, qty = SF.qty;

  function figure(k, v, n, lead, colour) {
    return '<div class="figure' + (lead ? ' lead' : '') + '"><div class="k">' + esc(k) + '</div>' +
      '<div class="v"' + (colour ? ' style="color:' + colour + '"' : '') + '>' + v + '</div>' +
      '<div class="n">' + esc(n) + '</div></div>';
  }

  /* ==================================================================
     NUMBERS — one market at a time
     ================================================================== */

  SF.screen({
    id: 'numbers', title: 'Numbers', cap: 'reports',
    render: function (ctx) {
      var d = ctx.data, s = d.summary, v = SF.state.vocab;
      var opts = d.markets.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === d.marketId ? ' selected' : '') + '>' +
          esc(m.name) + (m.date ? ' · ' + esc(m.date) : '') + '</option>';
      }).join('') || '<option>No markets yet</option>';

      return '<div class="wrap wide">' +
        '<div class="card flat" style="padding:12px"><div class="row" style="align-items:flex-end">' +
          '<div class="field" style="margin:0;flex:2"><label for="mk">Market</label>' +
            '<select id="mk" onchange="SFA.pickMarket(this.value)">' + opts + '</select></div>' +
          '<div style="flex:none"><button class="ghost" onclick="SFA.makeLive()">Make live</button></div>' +
        '</div></div>' +

        '<div class="toggle"><div><div class="t">Pre-orders are ' +
          (d.preordersOpen ? 'open' : 'closed') + '</div><div class="s">' +
          (d.preordersOpen ? 'Customers can reserve right now.'
                           : 'The order page turns people away politely.') + '</div></div>' +
          '<button class="' + (d.preordersOpen ? 'bad' : 'ok') + ' sm" onclick="SFA.togglePre(' +
          (d.preordersOpen ? 'false' : 'true') + ')">' +
          (d.preordersOpen ? 'Close' : 'Open') + '</button></div>' +
        (d.marketPassed ? '<div class="notice warn" style="border-radius:10px;margin-bottom:14px">' +
          'This market\'s date has passed, so the order page is closed. Add the next market ' +
          'below and make it live.</div>' : '') +
        (d.summary.outstanding > 0 ? '<button class="ghost block" style="margin-bottom:14px" ' +
          'onclick="SFA.askRelease()">Release unpaid reservations (' +
          moneyShort(d.summary.outstanding) + ')</button>' : '') +

        '<div class="grid g4" style="margin-bottom:14px">' +
          figure('Taken', moneyShort(s.revenue),
                 s.orders + ' sales · ' + qty(s.units, 'each') + ' ' + v.units, true) +
          figure('Cost of what sold', moneyShort(s.cogs), 'what it cost to make') +
          figure('Cost of being there', moneyShort(s.expenses), 'stall, petrol, the rest') +
          figure('Left in your pocket', moneyShort(s.profit), 'after everything', false,
                 s.profit >= 0 ? 'var(--ok)' : 'var(--bad)') +
        '</div>' +
        breakEven(s, v) +
        '<div class="grid g2">' + expenses(d) + best(d) + '</div>' +
        history(d, v) + newMarket() +
        SF.slot('numbers.after', ctx) +
        '<div class="foot">StallFlow · market view</div></div>';
    }
  });

  function breakEven(s, v) {
    var pct = s.expenses > 0 ? Math.min(100, Math.max(0, s.gross / s.expenses * 100)) : 100;
    var done = s.expenses > 0 ? s.gross >= s.expenses : true;
    var head;
    if (s.expenses <= 0) head = 'Add what the day costs you and this works out break-even.';
    else if (done) head = 'You are past break-even. Everything from here is profit.';
    else if (s.unitsToBreakEven != null) {
      head = s.unitsToBreakEven + ' more ' +
        (s.unitsToBreakEven === 1 ? v.unit : v.units) + ' and the day has paid for itself.';
    } else head = 'Sell one or two and this will tell you how far off break-even you are.';

    return '<div class="card"><div class="behead">' + esc(head) + '</div>' +
      '<div class="muted small">Break-even is when what you make on the goods covers what it ' +
      'cost to stand there.</div>' +
      '<div class="track"><div class="fill' + (done ? ' done' : '') + '" style="width:' +
        pct + '%"></div></div>' +
      '<div class="ends"><span>' + money(s.gross) + ' made on the goods</span>' +
        '<span>' + money(s.expenses) + ' to be there</span></div>' +
      '<div class="ledger">' +
        line('Taken at the table', money(s.revenue)) +
        line('Less what those cost to make', '− ' + money(s.cogs)) +
        line('Made on the goods', money(s.gross), 'sum') +
        line('Less the cost of being there', '− ' + money(s.expenses)) +
        line('Profit for the day', money(s.profit), 'sum',
             s.profit >= 0 ? 'var(--ok)' : 'var(--bad)') +
        (s.contributionPerUnit > 0
          ? '<div class="muted small" style="margin-top:8px">Each ' + esc(v.unit) +
            ' puts about ' + money(s.contributionPerUnit) + ' towards the day' +
            (s.breakEvenUnits ? ' — so ' + s.breakEvenUnits + ' covers it' : '') + '.</div>' : '') +
        (s.outstanding > 0
          ? '<div class="muted small" style="margin-top:6px">' + money(s.outstanding) +
            ' is reserved but not paid for — not counted above.</div>' : '') +
      '</div></div>';
  }

  function line(k, v, cls, colour) {
    return '<div class="' + (cls || '') + '"><span>' + esc(k) + '</span>' +
      '<b class="num"' + (colour ? ' style="color:' + colour + '"' : '') + '>' + v + '</b></div>';
  }

  function expenses(d) {
    var rows = d.expenses.length ? d.expenses.map(function (x) {
      return '<div class="rowitem"><div class="who"><b>' + esc(x.description) + '</b>' +
        '<span>' + esc(x.category) + '</span></div>' +
        '<span class="amt">' + money(x.amount) + '</span>' +
        '<button class="quiet" onclick="SFA.dropExpense(\'' + x.id + '\')">remove</button></div>';
    }).join('') : '<div class="empty">Nothing yet. Stall fee, petrol, a gazebo — whatever it ' +
      'costs to be there.</div>';

    return '<div class="card"><h2>What it costs to be there</h2>' +
      '<div class="sub">Costs that happen whether you sell one thing or a hundred.</div>' +
      rows + '<div class="hr"></div>' +
      '<div class="row"><div class="field" style="flex:2;margin:0"><label for="ed">What for</label>' +
        '<input id="ed" placeholder="Stall fee"></div>' +
        '<div class="field" style="margin:0"><label for="ea">Amount</label>' +
        '<input id="ea" type="number" inputmode="decimal" min="0" placeholder="250"></div></div>' +
      '<div class="field" style="margin-top:10px"><label for="ec">Type</label>' +
        '<select id="ec"><option>Stall</option><option>Travel</option><option>Setup</option>' +
        '<option>Packaging</option><option>Marketing</option><option>Other</option></select></div>' +
      '<button class="ghost block" onclick="SFA.addExpense()">Add this cost</button></div>';
  }

  function best(d) {
    var max = d.best.length ? d.best[0].value : 1;
    var rows = d.best.length ? d.best.map(function (b) {
      return '<div style="padding:9px 0;border-bottom:1px solid var(--rule)">' +
        '<div style="display:flex;justify-content:space-between;font-size:15px">' +
        '<b>' + esc(b.name) + '</b><span class="num">' + qty(b.qty, b.unit) + ' · ' +
        money(b.value) + '</span></div>' +
        '<div class="bar" style="width:' + Math.max(3, b.value / max * 100) + '%"></div></div>';
    }).join('') : '<div class="empty">Nothing sold at this market yet.</div>';

    return '<div class="card"><h2>What actually sold</h2>' +
      '<div class="sub">Ranked by what it brought in, not by how many left the table.</div>' +
      rows + '</div>';
  }

  function history(d, v) {
    var rows = d.history.length ? d.history.map(function (h) {
      return '<tr' + (h.id === d.marketId ? ' class="here"' : '') + '>' +
        '<td><b>' + esc(h.name) + '</b>' +
        (h.location ? '<div class="muted small">' + esc(h.location) + '</div>' : '') + '</td>' +
        '<td>' + esc(h.date || '—') + '</td><td class="r">' + qty(h.units, 'each') + '</td>' +
        '<td class="r">' + money(h.revenue) + '</td><td class="r">' + money(h.expenses) + '</td>' +
        '<td class="r"><b style="color:' + (h.profit >= 0 ? 'var(--ok)' : 'var(--bad)') + '">' +
        money(h.profit) + '</b></td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">No markets recorded yet.</td></tr>';

    return '<div class="card"><h2>Every market so far</h2>' +
      '<div class="sub">The record that tells you which ones are worth going back to.</div>' +
      '<div class="scroll"><table><tr><th>Market</th><th>Date</th><th class="r">' +
      esc(v.units.charAt(0).toUpperCase() + v.units.slice(1)) + '</th><th class="r">Taken</th>' +
      '<th class="r">Costs</th><th class="r">Profit</th></tr>' + rows + '</table></div>' +
      '<div class="muted small" style="margin-top:10px">' + qty(d.stock.units, 'each') +
      ' in stock, worth ' + money(d.stock.value) + ' in what it cost to make.</div></div>';
  }

  function newMarket() {
    return '<div class="card"><h2>Add a market</h2>' +
      '<div class="sub">Each one keeps its own takings, costs and break-even.</div>' +
      '<div class="row"><div class="field" style="flex:2"><label for="mn">Name</label>' +
        '<input id="mn" placeholder="Spring Craft Market"></div>' +
        '<div class="field"><label for="md">Date</label><input id="md" type="date"></div>' +
        '<div class="field"><label for="ml">Where</label><input id="ml" placeholder="Church hall"></div>' +
      '</div><button class="ghost" onclick="SFA.addMarket()">Add market</button></div>';
  }

  /* ==================================================================
     LABELS
     ================================================================== */

  var labelMode = 'labels';

  SF.screen({
    id: 'labels', title: 'QR labels', cap: 'labels',
    render: function (ctx) {
      var d = ctx.data;
      setTimeout(SFA.drawLabels, 0);
      return '<div class="wrap wide"><div id="controls">' +
        '<div class="card"><h2>QR labels</h2>' +
          '<div class="sub">One per item. Stick it on the lid or the tag — at the till you ' +
            'scan it instead of hunting through the screen.</div>' +
          '<div class="row" style="margin-bottom:12px">' +
            '<button id="tabL" onclick="SFA.labelMode(\'labels\')">Item labels</button>' +
            '<button id="tabP" class="ghost" onclick="SFA.labelMode(\'poster\')">Order poster</button>' +
          '</div><div id="picker">' + d.products.map(function (p) {
            return '<div class="pick"><input type="checkbox" id="c-' + p.id + '"' +
              (p.active ? ' checked' : '') + ' onchange="SFA.drawLabels()">' +
              '<div class="info"><b>' + esc(p.name) + '</b><span>' + esc(p.id) +
              (p.variant ? ' · ' + esc(p.variant) : '') + ' · ' + money(p.price) + '</span></div>' +
              '<input type="number" min="1" max="60" id="n-' + p.id + '" value="' +
              Math.max(1, Math.min(24, Math.round(p.onHand) || 1)) +
              '" onchange="SFA.drawLabels()"></div>';
          }).join('') +
          '<div class="row" style="margin-top:12px">' +
            '<button class="ghost sm" onclick="SFA.tickAll(true)">Tick all</button>' +
            '<button class="ghost sm" onclick="SFA.tickAll(false)">Tick none</button>' +
            '<button class="ghost sm" onclick="SFA.each(1)">1 each</button>' +
          '</div></div><div class="hr"></div>' +
          '<button class="block" onclick="window.print()">Print / save as PDF</button>' +
          '<p class="muted small" style="margin-top:9px;text-align:center">Choose ' +
            '<b>Save as PDF</b> as the printer. On a phone it is under the share button.</p>' +
        '</div></div><div id="out"></div>' +
        '<div class="foot">StallFlow · labels</div></div>';
    }
  });

  /* ==================================================================
     SETTINGS
     ================================================================== */

  SF.screen({
    id: 'settings', title: 'Settings', cap: 'reports',
    render: function () {
      var b = SF.state.boot, p = b.profile;
      var plugins = (b.plugins || []).map(function (pl) {
        var vals = SF.settingsOf(pl.id);
        return '<div class="card flat" style="border:1px solid var(--rule);margin-bottom:10px">' +
          '<div style="display:flex;gap:10px;align-items:baseline">' +
          '<h3 style="flex:1">' + esc(pl.name) + '</h3>' +
          '<span class="tag">v' + esc(pl.version) + '</span></div>' +
          (pl.settings || []).map(function (s) {
            return '<div class="field" style="margin-top:10px"><label for="ps-' + pl.id + '-' +
              s.key + '">' + esc(s.label) + '</label>' +
              '<input id="ps-' + pl.id + '-' + s.key + '" type="' +
              (s.type === 'number' ? 'number' : 'text') + '" step="any" value="' +
              esc(vals[s.key]) + '">' +
              (s.help ? '<div class="muted small" style="margin-top:4px">' + esc(s.help) +
                '</div>' : '') + '</div>';
          }).join('') +
          ((pl.settings || []).length
            ? '<button class="ghost sm" onclick="SFA.savePlugin(\'' + pl.id + '\')">Save</button>'
            : '<div class="muted small">Nothing to configure.</div>') +
          '</div>';
      }).join('');

      return '<div class="wrap">' +
        '<div class="card"><h2>The stall</h2>' +
          '<div class="sub">What customers see on the order page and the labels.</div>' +
          '<div class="field"><label for="sn">Name</label>' +
            '<input id="sn" value="' + esc(p.name) + '"></div>' +
          '<div class="field"><label for="st">Tagline</label>' +
            '<input id="st" value="' + esc(p.tagline || '') + '"></div>' +
          '<div class="field"><label for="sw">WhatsApp</label>' +
            '<input id="sw" value="' + esc(p.whatsapp || '') + '"></div>' +
          '<div class="field"><label for="sc">Colour</label>' +
            '<input id="sc" type="color" value="' + esc(p.colour) + '" style="height:52px"></div>' +
          '<button class="block" onclick="SFA.saveProfile()">Save</button></div>' +

        (b.auth && b.auth.google
          ? '<div class="card"><h2>Who can do what</h2>' +
              '<div class="sub">Everyone signs in with their own Google account.</div>' +
              '<button class="ghost block" onclick="SF.go(\'people\')">Manage people</button></div>'
          : '<div class="card"><h2>Who can do what</h2>' +
          '<div class="sub">A PIN each. The server checks the role on every change, so a ' +
            'cashier cannot change prices even with the link.</div>' +
          ['owner', 'manager', 'cashier', 'viewer'].map(function (r) {
            return '<div class="row" style="align-items:flex-end;margin-bottom:8px">' +
              '<div class="field" style="margin:0"><label for="pin-' + r + '">' + r + '</label>' +
              '<input id="pin-' + r + '" type="tel" inputmode="numeric" placeholder="new PIN"></div>' +
              '<div style="flex:none"><button class="ghost" onclick="SFA.setPin(\'' + r +
              '\')">Set</button></div></div>';
          }).join('') +
          '<div class="muted small">owner: everything · manager: everything but PINs · ' +
            'cashier: sell and hand over · viewer: numbers only</div></div>') +

        '<div class="card"><h2>Plugins</h2>' +
          '<div class="sub">Switched on by the market type. Each one adds behaviour the ' +
            'core does not have.</div>' + (plugins || '<div class="empty">None on.</div>') +
        '</div>' +

        '<div class="card"><h2>This phone</h2>' +
          '<div class="row"><button class="ghost" onclick="SF.toggleTheme()">Light / dark</button>' +
          '<button class="ghost" onclick="SFA.density()">Comfortable / compact</button></div>' +
          '<div class="hr"></div>' +
          '<button class="ghost block" onclick="SFA.forget()">Clear this phone\'s cache</button>' +
          '<div class="muted small" style="margin-top:8px">Only clears what is stored here. ' +
            'Anything still waiting to sync is kept.</div></div>' +
        '<div class="foot">StallFlow ' + esc(b.version) + '</div></div>';
    }
  });

  /* ==================================================================
     PEOPLE — who may sign in, and as what
     ================================================================== */

  var ROLE_HELP = {
    owner: 'Everything, including adding people. This is an admin.',
    manager: 'Selling, stock, prices, costs and the numbers.',
    cashier: 'Selling and handing over orders.',
    viewer: 'Sees the numbers only.'
  };

  SF.screen({
    id: 'people', title: 'People', cap: 'people',
    render: function () {
      if (!(SF.state.boot.auth && SF.state.boot.auth.google)) {
        return '<div class="wrap"><div class="card"><h2>People</h2>' +
          '<div class="sub">This stall still uses PINs. People appears once Google ' +
          'sign-in is switched on.</div></div></div>';
      }
      setTimeout(SFA.loadPeople, 0);
      return '<div class="wrap"><div id="peoplebox">' +
        '<div class="card"><div class="loading">Fetching the list…</div></div></div>' +
        '<div class="foot">StallFlow · people</div></div>';
    }
  });

  function roleSelect(id, current) {
    return '<select id="' + id + '">' + ['owner', 'manager', 'cashier', 'viewer'].map(function (r) {
      return '<option value="' + r + '"' + (r === current ? ' selected' : '') + '>' +
        (r === 'owner' ? 'owner (admin)' : r) + '</option>';
    }).join('') + '</select>';
  }

  function drawPeople(d) {
    var me = SF.state.user;
    var rows = d.people.map(function (p, i) {
      var self = p.email === me;
      return '<div class="card flat" style="border:1px solid var(--rule);margin-bottom:10px">' +
        '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">' +
          '<b style="flex:1;min-width:0;word-break:break-all">' + esc(p.email) + '</b>' +
          '<span class="tag' + (p.active ? ' ok' : '') + '">' + (p.active ? 'can sign in' : 'off') +
          '</span></div>' +
        '<div class="muted small" style="margin:2px 0 10px">' + esc(p.name || '') +
          (p.lastSeen ? ' · last in ' + esc(p.lastSeen) : ' · not signed in yet') + '</div>' +
        (self ? '<div class="muted small">This is you.</div>' :
          '<div class="row" style="align-items:flex-end">' +
            '<div class="field" style="margin:0"><label for="pr-' + i + '">Role</label>' +
              roleSelect('pr-' + i, p.role) + '</div>' +
            '<div style="flex:none"><button class="ghost" onclick="SFA.savePerson(' + i +
              ', true)">Save</button></div>' +
            '<div style="flex:none"><button class="' + (p.active ? 'bad' : 'ok') +
              ' sm" onclick="SFA.savePerson(' + i + ', ' + (p.active ? 'false' : 'true') + ')">' +
              (p.active ? 'Switch off' : 'Switch on') + '</button></div>' +
          '</div>') +
        '</div>';
    }).join('');

    SF.el('peoplebox').innerHTML =
      '<div class="card"><h2>Add someone</h2>' +
        '<div class="sub">They sign in with Google using exactly this address. It does not ' +
          'have to be Gmail: any email they have made a Google account with works.</div>' +
        '<div class="field"><label for="pe">Their Google account email</label>' +
          '<input id="pe" type="email" autocomplete="off" placeholder="name@example.com"></div>' +
        '<div class="field"><label for="prole">Role</label>' + roleSelect('prole', 'cashier') +
        '</div>' +
        '<button class="block" onclick="SFA.addPerson()">Add</button>' +
        '<div class="muted small" style="margin-top:10px">' +
          Object.keys(ROLE_HELP).map(function (r) {
            return '<b>' + r + '</b>: ' + esc(ROLE_HELP[r]);
          }).join('<br>') + '</div></div>' +
      '<div class="card"><h2>Who has access</h2>' +
        '<div class="sub">Changes apply on their next tap. Nobody needs to sign in again.</div>' +
        d.admins.map(function (a) {
          return '<div class="rowitem"><div class="who"><b>' + esc(a) + '</b>' +
            '<span>StallFlow admin · owner on every stall</span></div>' +
            '<span class="tag ok">always</span></div>';
        }).join('') +
        (rows || '<div class="empty" style="margin-top:10px">Nobody else yet.</div>') +
      '</div>';
    SFA.people = d;
  }

  /* ==================================================================
     HEALTH
     ================================================================== */

  SF.screen({
    id: 'health', title: 'Health check', cap: 'reports',
    render: function () {
      setTimeout(SFA.loadHealth, 0);
      return '<div class="wrap"><div id="healthbox">' +
        '<div class="card"><div class="loading">Checking…</div></div></div>' +
        '<div class="foot">StallFlow · health</div></div>';
    }
  });

  /* ==================================================================
     FAILED QUEUE
     ================================================================== */

  var WHAT = {
    sell: 'A sale', markPaid: 'Marking an order paid', markCollected: 'Handing an order over',
    addBatch: 'A costing run', setPrice: 'A price change', adjustStock: 'A stock adjustment',
    saveProduct: 'A product', addExpense: 'A cost', deleteExpense: 'Removing a cost',
    setActive: 'Hiding or showing a product', addMarket: 'A new market',
    savePerson: 'A change to who has access',
    setActiveMarket: 'Changing the live market', setPreordersOpen: 'Opening or closing pre-orders',
    'cashup.record': 'A cash-up'
  };

  SF.screen({
    id: 'failed', title: 'Did not go through', cap: 'sell',
    render: function () {
      var failed = SF.outbox.failed();
      if (!failed.length) {
        return '<div class="wrap"><div class="card"><div class="empty">' +
          'Nothing outstanding. Everything you did has gone up.</div>' +
          '<button class="ghost block" onclick="SF.go(\'till\')">Back to the till</button>' +
          '</div></div>';
      }
      return '<div class="wrap"><div class="card"><h2>These did not go through</h2>' +
        '<div class="sub">The server refused them — usually because something changed while ' +
          'you had no signal. Nothing was lost and nothing was applied.</div>' +
        failed.map(function (o) {
          return '<div class="rowitem"><div class="who"><b>' +
            esc(WHAT[o.action] || o.action) + '</b><span>' + esc(o.message || 'Refused') +
            ' · ' + SF.clock(o.at) + '</span></div>' +
            '<button class="ghost sm" onclick="SFA.forget1(\'' + o.opId + '\')">Clear</button>' +
            '</div>';
        }).join('') +
        '<div class="hr"></div>' +
        '<button class="ghost block" onclick="SF.go(\'till\')">Back to the till</button>' +
        '</div></div>';
    }
  });

  /* ==================================================================
     Behaviour
     ================================================================== */

  window.SFA = {
    askRelease: function () {
      SF.openSheet('<h2>Release unpaid reservations?</h2>' +
        '<div class="sub" style="margin-bottom:14px">Every order for this market that has not ' +
        'been paid is cancelled and its stock goes back on the shelf. Use it for no-shows or ' +
        'fake orders.</div>' +
        '<div class="row"><button class="ghost" onclick="SF.closeSheet()">Keep them</button>' +
        '<button class="bad" style="flex:2" onclick="SFA.release()">Release them</button></div>');
    },
    release: function () {
      SF.closeSheet();
      SF.post({ action: 'releaseUnpaid', opId: SF.uid('op') }).then(function (res) {
        if (!res || res.ok === false) { SF.toast((res && res.message) || 'That did not work.', true); return; }
        SF.toast(res.released + ' released');
        SF.load('numbers');
      }).catch(function () { SF.toast('No signal. Try again when you have some.', true); });
    },
    people: null,
    loadPeople: function () {
      SF.get('people').then(function (res) {
        if (!SF.el('peoplebox')) return;
        if (!res || res.ok === false) {
          SF.el('peoplebox').innerHTML = '<div class="card"><div class="empty">' +
            esc((res && res.message) || 'Could not fetch the list. This needs signal.') +
            '</div></div>';
          return;
        }
        drawPeople(res.data);
      }).catch(function () {
        if (SF.el('peoplebox')) SF.el('peoplebox').innerHTML = '<div class="card"><div class="empty">' +
          'Could not fetch the list. This needs signal.</div></div>';
      });
    },
    addPerson: function () {
      var email = String(SF.el('pe').value || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        SF.toast('Type their full email address.', true); return;
      }
      SFA.sendPerson({ email: email, role: SF.el('prole').value, active: true }, 'Added ' + email);
    },
    savePerson: function (i, active) {
      var p = SFA.people && SFA.people.people[i];
      if (!p) return;
      var role = SF.el('pr-' + i) ? SF.el('pr-' + i).value : p.role;
      SFA.sendPerson({ email: p.email, role: role, active: active },
        active ? 'Saved' : p.email + ' is switched off');
    },
    sendPerson: function (payload, done) {
      // Sent directly, not through the outbox: access changes need an answer now,
      // and a refusal (e.g. changing your own access) must be shown, not queued.
      SF.post({ action: 'savePerson', opId: SF.uid('op'), email: payload.email,
                role: payload.role, active: payload.active }).then(function (res) {
        if (!res || res.ok === false) {
          SF.toast((res && res.message) || 'That did not save.', true); return;
        }
        SF.toast(done);
        SFA.loadPeople();
      }).catch(function () { SF.toast('No signal. Try again when you have some.', true); });
    },
    pickMarket: function (id) { SF.state.marketId = id; SF.load('numbers'); },
    makeLive: function () {
      SF.write('setActiveMarket', { marketId: SF.state.marketId });
      SF.toast('This is the live market now.');
    },
    togglePre: function (open) {
      SF.write('setPreordersOpen', { open: open }, function () {
        var d = SF.state.data.numbers;
        if (d) d.preordersOpen = open;
      });
      SF.toast(open ? 'Pre-orders open' : 'Pre-orders closed');
    },
    addExpense: function () {
      var desc = SF.el('ed').value, amt = SF.el('ea').value;
      if (String(desc).trim().length < 2) { SF.toast('What was the money for?', true); return; }
      if (!(Number(amt) > 0)) { SF.toast('Enter the amount.', true); return; }
      SF.write('addExpense', { marketId: SF.state.marketId, description: desc,
                               amount: amt, category: SF.el('ec').value });
      SF.toast('Added');
    },
    dropExpense: function (id) { SF.write('deleteExpense', { expenseId: id }); },
    addMarket: function () {
      var n = SF.el('mn').value;
      if (String(n).trim().length < 2) { SF.toast('Give the market a name.', true); return; }
      SF.write('addMarket', { name: n, date: SF.el('md').value, location: SF.el('ml').value });
      SF.toast('Market added');
    },

    labelMode: function (m) {
      labelMode = m;
      SF.el('tabL').className = m === 'labels' ? '' : 'ghost';
      SF.el('tabP').className = m === 'poster' ? '' : 'ghost';
      SF.el('picker').style.display = m === 'labels' ? '' : 'none';
      SFA.drawLabels();
    },
    tickAll: function (on) {
      SF.state.data.labels.products.forEach(function (p) {
        var c = SF.el('c-' + p.id); if (c) c.checked = on;
      });
      SFA.drawLabels();
    },
    each: function (n) {
      SF.state.data.labels.products.forEach(function (p) {
        var i = SF.el('n-' + p.id); if (i) i.value = n;
      });
      SFA.drawLabels();
    },
    drawLabels: function () {
      var d = SF.state.data.labels, out = SF.el('out');
      if (!d || !out) return;
      if (labelMode === 'poster') {
        out.innerHTML = '<div class="card noprint" style="padding:12px"><b>The poster QR</b> ' +
          '<span class="muted small">— opens your order page. Put it at the entrance, or ' +
          'hand it out the week before.</span></div>' +
          '<div class="poster"><h1>' + esc(d.profile.name) + '</h1>' +
          '<div class="tag2">' + esc(d.profile.tagline || '') + '</div>' +
          '<div class="qr">' + QR.svg(SF.site, { ec: 'H', border: 2 }) + '</div>' +
          '<div class="cta">SCAN TO ORDER AHEAD</div>' +
          '<div class="sub2">Reserve now — pay at the stall.<br>No app, no account.</div>' +
          '<div class="url">' + esc(SF.site) + '</div></div>';
        return;
      }
      var cards = [], n = 0;
      d.products.forEach(function (p) {
        var c = SF.el('c-' + p.id);
        if (!c || !c.checked) return;
        var many = Math.max(1, Math.min(60, Math.floor(Number(SF.el('n-' + p.id).value) || 1)));
        var svg = QR.svg('SF:' + p.id, { ec: 'M', border: 2 });
        for (var i = 0; i < many; i++) {
          cards.push('<div class="label"><div class="shopname">' + esc(d.profile.name) +
            '</div><div class="nm">' + esc(p.name) + '</div>' +
            '<div class="vr">' + esc(p.variant || ' ') + '</div>' +
            '<div class="qr">' + svg + '</div>' +
            '<div class="code">' + esc(p.name.toUpperCase()) + ' · ' + esc(p.id) + '</div>' +
            '<div class="pr">' + money(p.price) +
            (p.unit !== 'each' ? ' / ' + esc(p.unit) : '') + '</div></div>');
          n++;
        }
      });
      out.innerHTML = n
        ? '<div class="card noprint" style="padding:12px"><b>' + n + ' labels</b> ' +
          '<span class="muted small">— ' + Math.ceil(n / 24) + ' A4 page' +
          (Math.ceil(n / 24) === 1 ? '' : 's') + '. Each names the product under its code, ' +
          'so a sheet of a hundred cannot get mixed up.</span></div>' +
          '<div id="sheet"><div class="labels">' + cards.join('') + '</div></div>'
        : '<div class="card"><div class="empty">Tick at least one product.</div></div>';
    },

    saveProfile: function () {
      SF.write('saveProfile', { name: SF.el('sn').value, tagline: SF.el('st').value,
                                whatsapp: SF.el('sw').value, colour: SF.el('sc').value });
      SF.state.boot.profile.name = SF.el('sn').value;
      SF.state.boot.profile.colour = SF.el('sc').value;
      document.documentElement.style.setProperty('--brand', SF.el('sc').value);
      SF.toast('Saved');
    },
    setPin: function (role) {
      var pin = SF.el('pin-' + role).value;
      if (String(pin).replace(/\D/g, '').length < 4) {
        SF.toast('A PIN needs at least 4 digits.', true); return;
      }
      SF.write('setPin', { role: role, pin: pin });
      SF.el('pin-' + role).value = '';
      SF.toast('PIN set for ' + role);
    },
    savePlugin: function (id) {
      var values = {};
      (SF.state.boot.plugins || []).forEach(function (p) {
        if (p.id !== id) return;
        (p.settings || []).forEach(function (s) {
          var input = SF.el('ps-' + id + '-' + s.key);
          values[s.key] = s.type === 'number' ? Number(input.value) : input.value;
        });
      });
      SF.state.boot.settings = SF.state.boot.settings || {};
      SF.state.boot.settings[id] = values;
      SF.write('savePluginSettings', { plugin: id, values: values });
      SF.toast('Saved');
    },
    density: function () {
      var now = document.documentElement.getAttribute('data-density');
      var next = now === 'compact' ? 'comfortable' : 'compact';
      document.documentElement.setAttribute('data-density', next);
      SF.ls.set('sf.density', next);
    },
    forget: function () {
      SF.cache.clear();
      SF.toast('Cache cleared — pulling fresh numbers');
      SF.load(SF.state.view);
    },
    forget1: function (opId) { SF.outbox.remove(opId); SF.render(); },

    loadHealth: function () {
      SF.get('health').then(function (res) {
        var box = SF.el('healthbox');
        if (!box) return;
        if (!res || res.ok === false) {
          box.innerHTML = '<div class="card"><div class="empty">Could not reach the shop. ' +
            'This check needs signal.</div></div>';
          return;
        }
        var h = res.data;
        box.innerHTML =
          '<div class="card"><h2>Health check</h2>' +
            '<div class="sub">What to look at before you trust the numbers.</div>' +
            '<div class="grid g2" style="margin-bottom:12px">' +
              figure('Version', esc(h.version), 'schema ' + h.schema.at + ' of ' + h.schema.expected) +
              figure('Market type', esc(h.preset), (h.plugins.filter(function (p) {
                return p.on; }).length) + ' plugins on') +
            '</div>' +
            (h.schema.at !== h.schema.expected
              ? '<div class="notice warn" style="border-radius:10px;margin-bottom:12px">' +
                'The sheet is on an older schema. Run <b>StallFlow &rsaquo; Set up / upgrade</b> ' +
                'in the spreadsheet.</div>' : '') +
            (!h.locked
              ? '<div class="notice bad" style="border-radius:10px;margin-bottom:12px">' +
                'No PINs are set. Anyone with the link has owner access. Set them under ' +
                'Settings.</div>' : '') +
            (h.problems.length
              ? '<div class="notice warn" style="border-radius:10px;margin-bottom:12px;' +
                'text-align:left;display:block">' + h.problems.map(function (x) {
                  return '• ' + esc(x); }).join('<br>') + '</div>'
              : '<div class="notice" style="background:var(--ok-bg);color:var(--ok);' +
                'border-radius:10px;margin-bottom:12px">No problems found.</div>') +
            '<h3 style="margin-bottom:8px">Plugins</h3>' +
            h.plugins.map(function (p) {
              return '<div class="rowitem"><div class="who"><b>' + esc(p.name) + '</b>' +
                '<span>' + esc(p.id) + ' · v' + esc(p.version) + '</span></div>' +
                '<span class="tag ' + (p.on ? 'ok' : '') + '">' + (p.on ? 'on' : 'off') +
                '</span></div>';
            }).join('') +
            '<h3 style="margin:16px 0 8px">Rows stored</h3><div class="scroll"><table>' +
            Object.keys(h.counts).map(function (k) {
              return '<tr><td>' + esc(k) + '</td><td class="r">' + h.counts[k] + '</td></tr>';
            }).join('') + '</table></div>' +
          '</div>';
      });
    }
  };
})();
