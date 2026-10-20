/**
 * Plugin — Cash-up
 * ---------------------------------------------------------------------------
 * The count at the end of the day: what the till says you took, what is
 * actually in the tin, and the difference written down before anyone goes
 * home. A short count with no explanation is refused by the server, which is
 * the whole point of doing it in an app rather than in your head.
 */
SF.plugin({
  id: 'cashup',
  name: 'Cash-up',
  version: '1.0.0',

  screens: [{
    id: 'cashup', title: 'Cash-up', cap: 'reports',
    render: function () {
      setTimeout(SFC.load, 0);
      return '<div class="wrap"><div id="cubox">' +
        '<div class="card"><div class="loading">Adding up the day…</div></div>' +
        '</div><div class="foot">StallFlow · cash-up</div></div>';
    }
  }],

  slots: {
    'numbers.after': function () {
      return '<div class="card"><h2>End of the day</h2>' +
        '<div class="sub">Count the tin against what the till says before you pack up.</div>' +
        '<button class="ghost block" onclick="SF.go(\'cashup\')">Do the cash-up</button></div>';
    }
  }
});

window.SFC = {
  data: null,

  load: function () {
    SF.get('cashup.expected').then(function (res) {
      SFC.data = res && res.ok !== false ? res : null;
      SFC.draw();
    }).catch(function () { SFC.draw(); });
  },

  draw: function () {
    var box = SF.el('cubox');
    if (!box) return;
    var d = SFC.data;
    if (!d) {
      box.innerHTML = '<div class="card"><div class="empty">The cash-up needs signal — it ' +
        'has to agree with the shop, not just with this phone.</div></div>';
      return;
    }
    box.innerHTML =
      '<div class="card"><h2>What should be in the tin</h2>' +
        '<div class="sub">Everything taken at this market, plus the float you started with.</div>' +
        '<div class="ledger">' +
          '<div><span>Taken today</span><b class="num">' + SF.money(d.cash) + '</b></div>' +
          '<div><span>Float you started with</span><b class="num">' + SF.money(d.float) + '</b></div>' +
          '<div class="sum"><span>Should be in the tin</span><b class="num">' +
            SF.money(d.expectedInTin) + '</b></div>' +
        '</div>' +
        '<div class="field" style="margin-top:16px"><label for="cuc">What you actually counted</label>' +
          '<input id="cuc" type="number" inputmode="decimal" step="0.01" min="0" ' +
          'style="font-size:28px;text-align:center" oninput="SFC.diff()"></div>' +
        '<div id="cudiff"></div>' +
        '<div class="field"><label for="cun">Note</label>' +
          '<input id="cun" placeholder="Gave R20 change short to the last customer"></div>' +
        '<button class="block" onclick="SFC.save()">Record the cash-up</button>' +
        '<p class="muted small" style="margin-top:9px">A difference bigger than ' +
          SF.money(d.tolerance) + ' needs a note before it will save.</p>' +
      '</div>' +
      (d.history.length
        ? '<div class="card"><h2>Last few cash-ups</h2>' + d.history.map(function (h) {
            return '<div class="rowitem"><div class="who"><b>' + SF.esc(h.marketId) + '</b>' +
              '<span>expected ' + SF.money(h.expected) + ' · counted ' + SF.money(h.counted) +
              '</span></div><span class="amt" style="color:' +
              (Math.abs(h.difference) < 0.005 ? 'var(--ok)' : 'var(--warn)') + '">' +
              (h.difference > 0 ? '+' : '') + SF.money(h.difference) + '</span></div>';
          }).join('') + '</div>'
        : '');
  },

  diff: function () {
    var d = SFC.data, box = SF.el('cudiff');
    if (!d || !box) return;
    var counted = Number(SF.el('cuc').value) || 0;
    var diff = Math.round((counted - d.expectedInTin) * 100) / 100;
    if (!counted) { box.innerHTML = ''; return; }
    var over = diff > 0, fine = Math.abs(diff) <= d.tolerance;
    box.innerHTML = '<div class="figure" style="margin-bottom:12px;border-color:' +
      (fine ? 'var(--ok)' : 'var(--warn)') + '">' +
      '<div class="k">' + (Math.abs(diff) < 0.005 ? 'Spot on'
        : over ? 'Over by' : 'Short by') + '</div>' +
      '<div class="v" style="color:' + (fine ? 'var(--ok)' : 'var(--warn)') + '">' +
      SF.money(Math.abs(diff)) + '</div>' +
      '<div class="n">' + (fine ? 'Within what you said is normal.'
        : 'Write a note saying why before you save.') + '</div></div>';
  },

  save: function () {
    var counted = Number(SF.el('cuc').value) || 0;
    if (counted <= 0) { SF.toast('Count the tin first.', true); return; }
    SF.post({ action: 'cashup.record', opId: SF.uid('cu'),
              counted: counted, note: SF.el('cun').value })
      .then(function (res) {
        if (!res || res.ok === false) {
          SF.toast((res && res.message) || 'Could not save.', true);
          return;
        }
        SF.toast('Cash-up recorded');
        SFC.load();
      })
      .catch(function () {
        SF.toast('No signal. A cash-up has to agree with the shop, so try again ' +
                 'when you are back on.', true);
      });
  }
};
