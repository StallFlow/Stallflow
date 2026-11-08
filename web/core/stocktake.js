/**
 * StallFlow — the stocktake (Stock › Stocktake).
 *
 * An owner or manager starts it. Anyone signed in picks a location and counts
 * what is there: scan each jar, or use − and +. The count is kept on the phone
 * while it is going, so a lost signal or a closed app loses nothing, and is
 * sent when they tap Done. The owner sees counted against expected for every
 * product and approves; the stock follows the count and any loss is recorded.
 */
var SFCount = (function () {
  'use strict';
  var esc = SF.esc, money = SF.money, qty = SF.qty;
  var state = null;        // the last countState from the server
  var counting = null;     // { countId, location, lines: { id: qty } } while counting a location
  var viewing = null;      // a past stocktake being reviewed: { id, detail } (detail null while loading)
  var DRAFT = 'sf.countdraft';

  function find(id) {
    var list = (state && state.products) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function label(p) { return p.name + (p.variant ? ' ' + p.variant : ''); }
  function total(lines) {
    var n = 0;
    Object.keys(lines || {}).forEach(function (k) { n += Number(lines[k]) || 0; });
    return Math.round(n * 1000) / 1000;
  }
  function keepDraft() { SF.ls.set(DRAFT, counting); }

  function load() {
    if (!state) state = SF.ls.get('sf.countstate', null);
    if (!counting) {
      var d = SF.ls.get(DRAFT, null);
      if (d && d.countId) counting = d;
    }
    draw();
    return SF.get('countState').then(function (res) {
      if (!res || res.ok === false || !res.data) return;
      state = res.data;
      SF.ls.set('sf.countstate', state);
      // A count for a stocktake that has since closed has nowhere to go.
      if (counting && (!state.open || state.open.id !== counting.countId)) {
        SF.toast('That stocktake was closed. The count on this phone was not sent.', true);
        counting = null; SF.ls.del(DRAFT);
      }
      draw();
    }).catch(function () { draw(); });
  }

  function draw() {
    var box = SF.el('countbox');
    if (box) box.innerHTML = html();
  }

  function html() {
    if (!state) {
      return '<div class="card"><div class="empty">' + (SF.state.online === false
        ? 'The stocktake needs signal the first time. It will fill in when you are back on.'
        : 'Loading…') + '</div></div>';
    }
    if (counting) return countingHtml();
    if (viewing) return viewHtml();
    return state.open ? openHtml() : idleHtml();
  }

  /* ---- no stocktake going ------------------------------------------------ */
  function idleHtml() {
    return '<div class="card"><h2>Stocktake</h2>' +
      '<div class="sub">Count everything you have, location by location, so the app and the shelves ' +
        'agree. Everyone with the app can help; ' + (state.canApprove ? 'you' : 'the owner') +
        ' approves it at the end.</div>' +
      (state.canStart
        ? '<button class="block" id="ctstart" onclick="SFCount.start()">Start a stocktake</button>'
        : '<div class="empty">No stocktake is going. When a manager starts one, it appears here.</div>') +
      '</div>' + locationsEditor() + historyHtml();
  }

  function historyHtml() {
    var h = state.history || [];
    if (!h.length) return '';
    return '<div class="card"><h2>Earlier stocktakes</h2>' +
      (state.canManage ? '<div class="sub">Tap one to see every line that was counted.</div>' : '') +
      h.map(function (x) {
      var r = x.result || {};
      return '<div class="rowitem"' + (state.canManage ? ' role="button" tabindex="0" style="cursor:pointer" data-id="' + esc(x.id) +
          '" onclick="SFCount.view(this.getAttribute(\'data-id\'))"' : '') + '><div class="who"><b>' + esc(x.id) + ' · ' +
        (x.status === 'approved' ? 'approved' : 'cancelled') + '</b><span>' + esc(x.when) +
        (x.by ? ' · ' + esc(x.by) : '') + '</span></div>' +
        (x.status === 'approved'
          ? '<span class="amt" style="text-align:right">' + (r.lossUnits ? '<span style="color:var(--bad)">\u2212' +
              qty(r.lossUnits, 'each') + ' \u00b7 ' + money(r.lossValue) + '</span>' : 'No loss') +
            (r.foundUnits ? '<br><span class="muted small">+' + qty(r.foundUnits, 'each') + ' found</span>' : '') +
            (r.check ? '<br><span class="muted small">Counted ' + qty(r.check.counted, 'each') + ' \u00b7 app ' +
              qty(r.check.app, 'each') + (r.check.movedSince ? ' (' + qty(r.check.movedSince, 'each') + ' sold since)' : '') +
              '</span>' : '') + '</span>'
          : '') + (state.canManage ? '<span class="muted" aria-hidden="true">\u203a</span>' : '') + '</div>';
    }).join('') + '</div>';
  }

  /* ---- reviewing a past stocktake ----------------------------------------- */
  function viewHtml() {
    var back = '<button class="ghost sm" onclick="SFCount.closeView()">\u2039 Back to stocktakes</button>';
    var d = viewing.detail;
    if (!d) return '<div class="card">' + back + '<div class="loading" style="margin-top:12px">Loading ' + esc(viewing.id) + '\u2026</div></div>';
    var F = 'counthist', r = d.result || {};
    var counted = 0, moved = 0, differs = 0;
    d.lines.forEach(function (l) {
      counted += l.counted || 0; moved += l.applied || 0;
      if (l.counted !== null && l.diff !== l.applied) differs++;
    });
    return '<div class="card">' + back + '<h2 style="margin-top:12px">Stocktake ' + esc(d.id) + ' \u00b7 ' + esc(d.status) + '</h2>' +
      '<div class="sub">Started ' + esc(d.startedAt) + ' by ' + esc(d.startedBy) +
        (d.closedAt ? '. ' + (d.status === 'approved' ? 'Approved ' : 'Cancelled ') + esc(d.closedAt) + (d.closedBy ? ' by ' + esc(d.closedBy) : '') : '') + '.</div>' +
      d.locations.map(function (l) {
        return '<div class="rowitem"><div class="who"><b>' + esc(l.name) + '</b><span>counted ' + esc(l.at) +
          (l.by ? ' by ' + esc(l.by) : '') + '</span></div><span class="tag ok">' + qty(l.items, 'each') + '</span></div>';
      }).join('') +
      SF.snap([
        '<div class="figure"><div class="k">Counted</div><div class="v">' + qty(counted, 'each') + '</div><div class="n">in all</div></div>',
        '<div class="figure"><div class="k">Approval moved</div><div class="v">' + (moved > 0 ? '+' : '') + qty(moved, 'each') + '</div><div class="n">net, into the stock</div></div>',
        '<div class="figure"><div class="k">Lines that differ</div><div class="v">' + differs + '</div><div class="n">moved \u2260 counted</div></div>'
      ]) +
      (r.check ? '<div class="muted small" style="margin:8px 0">When approved: counted ' + qty(r.check.counted, 'each') +
        ', app ' + qty(r.check.app, 'each') + '.</div>' : '') + '</div>' +
      '<div class="card">' +
      SF.filters.bar(F, { search: 'Search products', count: d.lines.length, noun: 'products', min: 6,
        facets: [{ key: 'show', label: 'Show', options: [['all', 'All'], ['short', 'Short'], ['found', 'Found'],
          ['differs', 'Moved \u2260 counted'], ['missing', 'Not counted']] }] }) +
      '<div class="scroll"><table><tr>' + SF.filters.th(F, 'name', 'Product') +
        SF.filters.th(F, 'had', 'App had', 'r') + SF.filters.th(F, 'counted', 'Counted', 'r') +
        SF.filters.th(F, 'diff', 'Difference', 'r') + SF.filters.th(F, 'applied', 'Moved', 'r') + '</tr>' +
      d.lines.map(function (l) {
        var show = l.counted === null ? 'missing' : l.diff !== l.applied ? 'differs' : l.diff < 0 ? 'short' : l.diff > 0 ? 'found' : 'right';
        var odd = l.counted !== null && l.diff !== l.applied;
        return '<tr' + SF.filters.row(F, { text: label(l) + ' ' + l.id, show: show },
            { name: label(l).toLowerCase(), had: l.hadAtCount === null ? -1 : l.hadAtCount, counted: l.counted === null ? -1 : l.counted,
              diff: l.diff === null ? 0 : l.diff, applied: l.applied }) + '>' +
          '<td><b>' + esc(l.name) + '</b>' + (l.variant ? '<div class="muted small">' + esc(l.variant) + '</div>' : '') + '</td>' +
          '<td class="r num">' + (l.hadAtCount === null ? '<span class="muted">\u2014</span>' : qty(l.hadAtCount, l.unit)) + '</td>' +
          '<td class="r num">' + (l.counted === null ? '<span class="muted">\u2014</span>' : qty(l.counted, l.unit)) + '</td>' +
          '<td class="r num"' + (l.diff < 0 ? ' style="color:var(--bad)"' : '') + '>' +
            (l.diff === null ? '' : (l.diff > 0 ? '+' : '') + qty(l.diff, l.unit)) + '</td>' +
          '<td class="r num"' + (odd ? ' style="color:var(--warn);font-weight:700"' : '') + '>' +
            (l.applied ? (l.applied > 0 ? '+' : '') + qty(l.applied, l.unit) : '') + '</td></tr>';
      }).join('') +
      '<tr data-fempty="' + F + '" style="display:none"><td colspan="5" class="empty">Nothing matches.</td></tr>' +
      '</table></div>' +
      '<div class="muted small" style="margin-top:10px"><b>App had</b> is the stock when the product was counted. ' +
        '<b>Moved</b> is what approving actually put into the stock; where it differs from the difference it is shown in amber. ' +
        'Stocktakes approved before 8 Nov used the stock at the start, so they can differ.</div></div>';
  }

  function locationsEditor() {
    if (!state.canManage) return '';
    return '<details class="card lookedit"><summary>Locations to count</summary>' +
      '<div class="sub">One per line: wherever stock is kept. Everyone picks one when counting.</div>' +
      '<textarea id="ctlocs" rows="5">' + esc((state.locations || []).join('\n')) + '</textarea>' +
      '<button class="ghost" style="margin-top:8px" onclick="SFCount.saveLocations()">Save locations</button></details>';
  }

  /* ---- a stocktake is going ---------------------------------------------- */
  function openHtml() {
    var o = state.open, done = o.locations.filter(function (l) { return l.status === 'done'; }).length;
    var me = SF.state.user || SF.state.role;
    return '<div class="card"><h2>Stocktake ' + esc(o.id) + '</h2>' +
      '<div class="sub">Started ' + esc(o.startedAt) + ' by ' + esc(o.startedBy) + '. ' +
        done + ' of ' + o.locations.length + ' locations counted.</div>' +
      o.locations.map(function (l) {
        var chip = l.status === 'done' ? '<span class="tag ok">Done · ' + qty(l.items, 'each') + '</span>'
          : l.status === 'counting' ? '<span class="tag warn">Counting' + (l.by ? ': ' + esc(l.by) : '') + '</span>'
          : '<span class="tag">Not counted</span>';
        var mine = l.status === 'counting' && l.by === me;
        return '<div class="rowitem"><div class="who"><b>' + esc(l.name) + '</b><span>' +
          (l.status === 'done' && l.by ? 'by ' + esc(l.by) : '&nbsp;') + '</span></div>' + chip +
          '<button class="' + (l.status === 'todo' || mine ? 'ok' : 'ghost') + ' sm" data-loc="' + esc(l.name) + '" ' +
            'onclick="SFCount.count(this.getAttribute(\'data-loc\'))">' +
            (l.status === 'done' ? 'Count again' : mine ? 'Carry on' : 'Count here') + '</button></div>';
      }).join('') +
      '</div>' + (state.canApprove ? reviewHtml() : '') +
      (state.canManage ? '<button class="quiet block" onclick="SFCount.cancel()">Cancel this stocktake</button>' : '') +
      locationsEditor();
  }

  /** The owner's view: counted against expected, product by product, and the cost of the difference. */
  function reviewHtml() {
    var rows = state.open.review || [];
    var loss = 0, lossN = 0, found = 0, missing = 0;
    rows.forEach(function (r) {
      if (r.diff === null) { if (r.now > 0) missing++; return; }
      if (r.diff < 0) { lossN += -r.diff; loss += -r.diff * r.cost; } else found += r.diff;
    });
    var left = state.open.locations.filter(function (l) { return l.status !== 'done'; }).length;
    var F = 'countreview';
    return '<div class="card"><h2>Review and approve</h2>' +
      '<div class="sub">What was counted against what the app had at the moment it was counted. ' +
        'Approving moves the stock to the counted numbers as they were then. Sales made after a count ' +
        'stay: they are not taken off twice.</div>' +
      SF.snap([
        '<div class="figure"><div class="k">Short</div><div class="v" style="color:var(--bad)">' + qty(lossN, 'each') +
          '</div><div class="n">' + money(loss) + ' at cost</div></div>',
        '<div class="figure"><div class="k">Found</div><div class="v">' + qty(found, 'each') + '</div><div class="n">more than expected</div></div>',
        '<div class="figure"><div class="k">Not counted</div><div class="v">' + missing + '</div><div class="n">products</div></div>'
      ]) +
      (left ? '<div class="notice warn" style="border-radius:10px;margin:10px 0">' + left + ' location' +
        (left === 1 ? ' is' : 's are') + ' not counted yet.</div>' : '') +
      SF.filters.bar(F, { search: 'Search products', count: rows.length, noun: 'products',
        facets: [{ key: 'show', label: 'Show', options: [['all', 'All'], ['short', 'Short'], ['found', 'Found'],
          ['missing', 'Not counted'], ['right', 'Spot on']] }] }) +
      '<div class="scroll"><table><tr>' + SF.filters.th(F, 'name', 'Product') +
        SF.filters.th(F, 'expected', 'App had', 'r') + SF.filters.th(F, 'counted', 'Counted', 'r') +
        SF.filters.th(F, 'diff', 'Difference', 'r') + SF.filters.th(F, 'sold', 'Sold since', 'r') +
        SF.filters.th(F, 'value', 'Value', 'r') + '</tr>' +
      rows.map(function (r) {
        var show = r.diff === null ? 'missing' : r.diff < 0 ? 'short' : r.diff > 0 ? 'found' : 'right';
        var value = r.diff === null ? 0 : Math.round(r.diff * r.cost * 100) / 100;
        return '<tr' + SF.filters.row(F, { text: label(r) + ' ' + r.id, show: show },
            { name: label(r).toLowerCase(), expected: r.expected, counted: r.counted === null ? -1 : r.counted,
              diff: r.diff === null ? 0 : r.diff, sold: r.soldSince === null ? 0 : r.soldSince, value: value }) + '>' +
          '<td><b>' + esc(r.name) + '</b>' + (r.variant ? '<div class="muted small">' + esc(r.variant) + '</div>' : '') + '</td>' +
          '<td class="r num">' + qty(r.expected, r.unit) + '</td>' +
          '<td class="r num">' + (r.counted === null ? '<span class="muted">—</span>' : qty(r.counted, r.unit)) + '</td>' +
          '<td class="r num"' + (r.diff < 0 ? ' style="color:var(--bad)"' : '') + '>' +
            (r.diff === null ? '' : (r.diff > 0 ? '+' : '') + qty(r.diff, r.unit)) + '</td>' +
          '<td class="r num">' + (r.soldSince ? qty(r.soldSince, r.unit) : '') + '</td>' +
          '<td class="r num">' + (value ? money(value) : '') + '</td></tr>';
      }).join('') +
      '<tr data-fempty="' + F + '" style="display:none"><td colspan="6" class="empty">Nothing matches.</td></tr>' +
      '</table></div>' +
      (missing ? '<div class="field" style="margin-top:12px"><label for="ctmissing">Products nobody counted (' +
        missing + ')</label><select id="ctmissing"><option value="keep">Leave them as they are</option>' +
        '<option value="zero">None left: set them to 0</option></select></div>' : '') +
      '<button class="ok block" id="ctapprove" style="margin-top:12px" onclick="SFCount.approve()">Approve the stocktake</button></div>';
  }

  /* ---- counting one location --------------------------------------------- */
  function countingHtml() {
    var c = counting, F = 'countlist', products = (state.products || []).filter(function (p) {
      return p.active || c.lines[p.id];
    });
    return '<div class="card counthead"><h2>Counting: ' + esc(c.location) + '</h2>' +
      '<div class="sub">Scan each jar, or use − and +. The count stays on this phone until you tap Done.</div>' +
      '<div class="countsum"><b id="cttotal">' + qty(total(c.lines), 'each') + '</b> counted here</div>' +
      '<div class="row"><button class="block" onclick="SFCount.scan()">Scan jars</button></div>' +
      '<div class="row" style="margin-top:8px">' +
        '<button class="ok" id="ctdone" onclick="SFCount.done()">Done with ' + esc(c.location) + '</button>' +
        '<button class="ghost" onclick="SFCount.leave()">Back</button></div></div>' +
      '<div class="card">' +
      SF.filters.bar(F, { search: 'Search products', count: products.length, noun: 'products', min: 6,
        facets: [{ key: 'show', label: 'Show', options: [['all', 'All'], ['counted', 'Counted here'], ['none', 'Not yet']] }] }) +
      products.map(function (p) {
        var n = c.lines[p.id] || 0;
        return '<div class="rowitem countrow' + (n ? ' has' : '') + '" id="cr-' + esc(p.id) + '"' +
          SF.filters.row(F, { text: label(p) + ' ' + (p.category || '') + ' ' + p.id, show: n ? 'counted' : 'none' }) + '>' +
          '<div class="who"><b>' + esc(p.name) + '</b><span>' + esc(p.variant || p.category || '') + '</span></div>' +
          '<span class="qstep">' +
            '<button class="qb" aria-label="One less ' + esc(label(p)) + '" onclick="SFCount.bump(\'' + esc(p.id) + '\',-1)">&minus;</button>' +
            '<button class="qn num" aria-label="How many ' + esc(label(p)) + '" onclick="SFCount.type(\'' + esc(p.id) + '\')">' +
              qty(n, p.unit) + '</button>' +
            '<button class="qb" aria-label="One more ' + esc(label(p)) + '" onclick="SFCount.bump(\'' + esc(p.id) + '\',1)">+</button>' +
          '</span></div>';
      }).join('') +
      '<div class="empty" data-fempty="' + F + '" style="display:none">Nothing matches.</div></div>';
  }

  /** Change one product's count in place, without redrawing the list (and losing your place). */
  function setCount(id, n) {
    var p = find(id);
    if (!p || !counting) return;
    n = Math.max(0, Math.round(Number(n) * 1000) / 1000 || 0);
    if (n) counting.lines[id] = n; else delete counting.lines[id];
    keepDraft();
    var row = SF.el('cr-' + id);
    if (row) {
      row.querySelector('.qn').textContent = qty(n, p.unit);
      row.classList.toggle('has', !!n);
      row.setAttribute('data-f-show', n ? 'counted' : 'none');
    }
    var t = SF.el('cttotal');
    if (t) t.textContent = qty(total(counting.lines), 'each');
  }

  // Its own screen too (More › Stocktake), so everyone who counts can reach it,
  // not only those who can open Stock.
  SF.screen({
    id: 'stocktake', title: 'Stocktake', cap: 'count',
    render: function () {
      return '<div class="wrap">' + SFCount.render() + '<div class="foot">StallFlow · stocktake</div></div>';
    }
  });

  return {
    render: function () { setTimeout(load, 0); return '<div id="countbox">' + html() + '</div>'; },
    load: load,

    start: function () {
      var b = SF.el('ctstart'); if (b) { b.disabled = true; b.textContent = 'Starting…'; }
      SF.write('countStart', {}).then(load);
    },
    count: function (location) {
      var o = state && state.open;
      if (!o) return;
      var l = o.locations.filter(function (x) { return x.name === location; })[0];
      var me = SF.state.user || SF.state.role;
      if (l && l.status === 'counting' && l.by && l.by !== me &&
          !window.confirm(l.by + ' is counting ' + location + '. Count it too? Your count will replace theirs.')) return;
      counting = (SF.ls.get(DRAFT, null) || {});
      if (counting.countId !== o.id || counting.location !== location) counting = { countId: o.id, location: location, lines: {} };
      keepDraft();
      SF.write('countClaim', { countId: o.id, location: location });
      draw();
      window.scrollTo(0, 0);
    },
    bump: function (id, dir) { if (counting) setCount(id, (counting.lines[id] || 0) + dir); },
    type: function (id) {
      var p = find(id);
      if (!p || !counting) return;
      SF.openSheet('<h2>How many?</h2><div class="sub">' + esc(label(p)) + ' in ' + esc(counting.location) + '</div>' +
        '<div class="field"><input id="ctq" type="number" inputmode="decimal" min="0" step="1" value="' +
          (counting.lines[id] || '') + '" style="font-size:28px;text-align:center" ' +
          'onkeydown="if(event.key===\'Enter\'){event.preventDefault();SFCount.typed(\'' + esc(id) + '\')}"></div>' +
        '<button class="block" onclick="SFCount.typed(\'' + esc(id) + '\')">Done</button>');
      setTimeout(function () { var x = SF.el('ctq'); if (x) { x.focus(); x.select(); } }, 60);
    },
    typed: function (id) {
      var v = SF.el('ctq') ? SF.el('ctq').value : '';
      SF.closeSheet();
      if (String(v).trim() !== '') setCount(id, v);
    },
    scan: function () {
      SF.scan({ each: function (id) {
        var p = find(id);
        if (!p) return '';
        setCount(id, (counting.lines[id] || 0) + 1);
        return label(p) + ' · ' + qty(counting.lines[id], p.unit) + '   (' + qty(total(counting.lines), 'each') + ' here)';
      } });
    },
    done: function () {
      if (!counting) return;
      var c = counting, n = total(c.lines);
      var lines = Object.keys(c.lines).map(function (id) { return { id: id, qty: c.lines[id] }; });
      SF.write('countSave', { countId: c.countId, location: c.location, lines: lines }, function () {
        if (state && state.open) state.open.locations.forEach(function (l) {
          if (l.name === c.location) { l.status = 'done'; l.items = n; l.by = SF.state.user || SF.state.role; }
        });
      }).then(load);
      counting = null; SF.ls.del(DRAFT);
      SF.toast(c.location + ' counted: ' + qty(n, 'each'));
      draw();
      window.scrollTo(0, 0);
    },
    view: function (id) {
      viewing = { id: id, detail: null };
      draw(); window.scrollTo(0, 0);
      SF.get('countDetail', { countId: id }).then(function (res) {
        var d = res && res.data;
        if (!d || d.ok === false) { viewing = null; SF.toast((d && d.message) || 'Could not open that stocktake.', true); draw(); return; }
        if (viewing && viewing.id === id) { viewing.detail = d; draw(); }
      }).catch(function () { viewing = null; SF.toast('Needs signal to open an earlier stocktake.', true); draw(); });
    },
    closeView: function () { viewing = null; draw(); },
    leave: function () {
      // The count stays on the phone; "Carry on" picks it up again.
      counting = null;
      draw();
    },
    approve: function () {
      var o = state && state.open;
      if (!o) return;
      var m = SF.el('ctmissing');
      var b = SF.el('ctapprove'); if (b) { b.disabled = true; b.textContent = 'Approving…'; }
      SF.write('countApprove', { countId: o.id, uncounted: m ? m.value : 'keep' }).then(function () {
        SF.load('stock');
        return load();
      });
      SF.toast('Stocktake approved. The stock now follows the count.');
    },
    cancel: function () {
      var o = state && state.open;
      if (!o || !window.confirm('Cancel stocktake ' + o.id + '? The counts are kept in the sheet but nothing changes.')) return;
      SF.write('countCancel', { countId: o.id }).then(load);
    },
    saveLocations: function () {
      var list = String(SF.el('ctlocs').value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      SF.write('countLocationsSave', { locations: list }, function () { if (state) state.locations = list; }).then(load);
      SF.toast('Locations saved');
    }
  };
})();
