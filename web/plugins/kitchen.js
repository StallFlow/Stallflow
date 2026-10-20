/**
 * Plugin — Kitchen board
 * ---------------------------------------------------------------------------
 * For food carts. Adds a make-list screen and a "waiting to make" figure on
 * the till, and does it entirely from outside the core: a screen, a slot and
 * an event listener.
 */
SF.plugin({
  id: 'kitchen',
  name: 'Kitchen board',
  version: '1.0.0',

  screens: [{
    id: 'kitchen', title: 'Kitchen board', cap: 'sell',
    render: function () {
      setTimeout(SFK.load, 0);
      return '<div class="wrap"><div id="kboard">' +
        '<div class="card"><div class="loading">Reading the board…</div></div>' +
        '</div><div class="foot">StallFlow · kitchen</div></div>';
    }
  }],

  slots: {
    'till.figures': function () {
      var n = SFK.waiting;
      if (n === null) {
        // First time the till is drawn: fetch once, then redraw. Guarded so a
        // slot can never turn into a render/fetch loop.
        SFK.prime();
        return '';
      }
      return '<div class="figure"><div class="k">To make</div>' +
        '<div class="v"' + (n >= SFK.warnAt ? ' style="color:var(--warn)"' : '') + '>' + n +
        '</div><div class="n">' + (n ? 'tap Kitchen board' : 'all caught up') + '</div></div>';
    }
  },

  events: {
    // Every sale changes the board, so keep the till figure honest.
    'sale.taken': function () { SFK.refresh(); },
    'write.done': function (e) {
      if (e.action === 'markCollected' || e.action === 'markPaid') SFK.refresh();
    }
  }
});

window.SFK = {
  waiting: null,
  warnAt: 6,
  board: null,
  priming: false,

  /** Fetch the board once, then redraw so the till figure appears. */
  prime: function () {
    if (SFK.priming) return;
    SFK.priming = true;
    SFK.refresh().then(function () {
      if (SFK.waiting === null) SFK.waiting = 0;   // never ask again this session
      SF.render();
    });
  },

  refresh: function () {
    return SF.get('kitchen.board').then(function (res) {
      if (!res || res.ok === false) return;
      SFK.board = res;
      SFK.warnAt = res.warnAt || 6;
      SFK.waiting = res.tickets.length;
      SF.ls.set('sf.kitchen', res);
    }).catch(function () {
      if (SFK.board) return;
      var cached = SF.ls.get('sf.kitchen', null);
      if (cached) { SFK.board = cached; SFK.waiting = cached.tickets.length; }
    });
  },

  load: function () {
    SFK.refresh().then(SFK.draw);
    if (SFK.board) SFK.draw();
  },

  draw: function () {
    var box = SF.el('kboard');
    if (!box) return;
    var b = SFK.board;
    if (!b) {
      box.innerHTML = '<div class="card"><div class="empty">The board needs signal the ' +
        'first time. After that it is kept on the phone.</div></div>';
      return;
    }
    var totals = b.totals.length
      ? '<div class="card"><h2>Everything still to make</h2>' +
        '<div class="sub">Across every ticket, so you can cook in batches.</div>' +
        b.totals.map(function (t) {
          return '<div class="rowitem"><div class="who"><b>' + SF.esc(t.name) + '</b></div>' +
            '<span class="amt">' + t.qty + '</span></div>';
        }).join('') + '</div>'
      : '';

    var tickets = b.tickets.length
      ? b.tickets.map(function (t) {
          return '<div class="ticket' + (t.paid ? ' paid' : '') + '">' +
            '<div class="hd"><b>' + SF.esc(t.customer) + '</b>' +
            '<span class="tag ' + (t.paid ? 'ok' : 'warn') + '">' +
            (t.paid ? 'paid' : 'not paid') + '</span></div>' +
            '<div class="muted small">' + SF.esc(t.no) + ' · ordered ' + SF.esc(t.time) + '</div>' +
            t.items.map(function (i) {
              return '<div class="it"><span class="q">' + i.qty + ' ×</span> ' +
                SF.esc(i.name) +
                ((i.options || []).length
                  ? '<div class="opts">' + i.options.map(function (o) {
                      return SF.esc(o.choice); }).join(', ') + '</div>' : '') +
                '</div>';
            }).join('') +
            '<button class="ok block" style="margin-top:10px" onclick="SFT.collect(\'' +
              t.no + '\')"' + (t.paid ? '' : ' disabled') + '>' +
              (t.paid ? 'Made and handed over' : 'Waiting for payment') + '</button>' +
            '</div>';
        }).join('')
      : '<div class="card"><div class="empty">Nothing to make. Enjoy the quiet.</div></div>';

    box.innerHTML = totals + '<h2 style="margin:14px 0 10px">Tickets, oldest first</h2>' + tickets;
  }
};
