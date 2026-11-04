/**
 * StallFlow — filter bars for long lists (Stock, Numbers › All markets, QR
 * labels, Collect, the cupboard).
 *
 * A screen draws a bar with SF.filters.bar(id, opts) above its list and tags
 * each row with SF.filters.row(id, match, sortBy). Filtering happens on the
 * rows already on screen, so typing in the search box never redraws the page
 * or loses the keyboard. Dropdown choices and the sort are remembered on this
 * phone; the search text lasts until the app is closed.
 *
 *   opts = {
 *     search: 'Search products',
 *     facets: [{ key: 'cat', label: 'Category', options: [['all', 'All'], ['Jams', 'Jams']] }],
 *     sorts:  [['', 'Shelf order'], ['name', 'A–Z'], ['-keep', 'Most kept']],  // '-' = high first
 *     count:  12,          // rows in the list; the bar only shows from `min`
 *     min:    6,
 *     noun:   'products'
 *   }
 *   match  = { text: 'apricot jam 340 g jams', cat: 'Jams', show: 'onsale low' }
 *            (a facet matches when its chosen value is one of the space-separated words)
 *   sortBy = { name: 'apricot jam', keep: 39.5 }
 *
 * A row the screen marks with data-fempty="<id>" is shown when nothing matches.
 */
(function () {
  var esc = SF.esc;
  var typedText = {};                         // id -> search text, until the app closes
  var live = {};                              // id -> opts of bars on screen now

  function key(id) { return 'sf.filter.' + id; }
  function saved(id) { return SF.ls.get(key(id), {}) || {}; }

  function rowsOf(id) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-frow="' + id + '"]'));
  }

  function row(id, match, sortBy) {
    match = match || {};
    var a = ' data-frow="' + esc(id) + '" data-ftext="' +
      esc(String(match.text || '').toLowerCase().replace(/\s+/g, ' ')) + '"';
    Object.keys(match).forEach(function (k) {
      if (k !== 'text') a += ' data-f-' + k + '="' + esc(String(match[k])) + '"';
    });
    Object.keys(sortBy || {}).forEach(function (k) {
      a += ' data-s-' + k + '="' + esc(String(sortBy[k])) + '"';
    });
    return a;
  }

  function bar(id, opts) {
    opts = opts || {};
    if ((opts.count || 0) < (opts.min == null ? 6 : opts.min)) { delete live[id]; return ''; }
    live[id] = opts;
    var st = saved(id);
    var facets = (opts.facets || []).filter(function (f) { return f.options.length > 2; });
    var selects = facets.map(function (f) {
      var on = st[f.key] || 'all';
      return '<label class="fsel"><span>' + esc(f.label) + '</span>' +
        '<select id="ff-' + id + '-' + f.key + '" onchange="SF.filters.pick(\'' + id + '\',\'' +
          f.key + '\',this.value)">' +
        f.options.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (o[0] === on ? ' selected' : '') + '>' +
            esc(o[1]) + '</option>';
        }).join('') + '</select></label>';
    }).join('');
    if (opts.sorts && opts.sorts.length > 1) {
      var by = st.sort || opts.sorts[0][0];
      selects += '<label class="fsel"><span>Sort</span><select id="ff-' + id + '-sort" ' +
        'onchange="SF.filters.pick(\'' + id + '\',\'sort\',this.value)">' +
        opts.sorts.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (o[0] === by ? ' selected' : '') + '>' +
            esc(o[1]) + '</option>';
        }).join('') + '</select></label>';
    }
    setTimeout(function () { apply(id); }, 0);
    return '<div class="fbar" role="search">' +
      '<input type="search" id="fq-' + id + '" class="fq" autocomplete="off" enterkeyhint="search" ' +
        'placeholder="' + esc(opts.search || 'Search') + '" aria-label="' + esc(opts.search || 'Search') + '" ' +
        'value="' + esc(typedText[id] || '') + '" oninput="SF.filters.typed(\'' + id + '\',this)">' +
      (selects ? '<div class="fsels">' + selects + '</div>' : '') +
      '<div class="fcount" id="fc-' + id + '" aria-live="polite"></div></div>';
  }

  /**
   * A table heading that sorts by its column: tap for low → high (A → Z),
   * again for high → low, a third time to go back to the list's own order.
   * Plain text when the list is too short to have a filter bar.
   */
  function th(id, field, label, cls) {
    var c = cls ? ' class="' + cls + '"' : '';
    if (!live[id]) return '<th' + c + '>' + esc(label) + '</th>';
    return '<th' + c + ' data-fsort="' + esc(id) + '" data-field="' + esc(field) + '">' +
      '<button type="button" class="sorthead" onclick="SF.filters.sortBy(\'' + id + '\',\'' + field + '\')">' +
      esc(label) + '<span class="arrow" aria-hidden="true"></span></button></th>';
  }

  function paintHeads(id, by) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-fsort="' + id + '"]'), function (h) {
      var f = h.getAttribute('data-field');
      var dir = by === f ? 'ascending' : by === '-' + f ? 'descending' : 'none';
      h.setAttribute('aria-sort', dir);
      var a = h.querySelector('.arrow');
      if (a) a.textContent = dir === 'ascending' ? ' ▲' : dir === 'descending' ? ' ▼' : '';
    });
  }

  function apply(id) {
    var opts = live[id];
    if (!opts) return;
    var st = saved(id), rows = rowsOf(id);
    var words = String(typedText[id] || '').toLowerCase().split(/\s+/).filter(Boolean);
    var facets = (opts.facets || []).filter(function (f) { return f.options.length > 2; });
    var shown = 0;

    rows.forEach(function (r, i) {
      if (r.getAttribute('data-forder') == null) r.setAttribute('data-forder', i);
      var text = r.getAttribute('data-ftext') || '';
      var ok = words.every(function (w) { return text.indexOf(w) !== -1; });
      facets.forEach(function (f) {
        var want = st[f.key] || 'all';
        if (ok && want !== 'all') {
          ok = (' ' + (r.getAttribute('data-f-' + f.key) || '') + ' ').indexOf(' ' + want + ' ') !== -1;
        }
      });
      r.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });

    // Sort within each list, keeping anything that is not a row (headings) where it is.
    var by = st.sort || (opts.sorts && opts.sorts[0] ? opts.sorts[0][0] : '');
    var desc = by.charAt(0) === '-', field = desc ? by.slice(1) : by;
    var groups = [];
    rows.forEach(function (r) { if (groups.indexOf(r.parentNode) === -1) groups.push(r.parentNode); });
    groups.forEach(function (parent) {
      var mine = rows.filter(function (r) { return r.parentNode === parent; });
      var anchor = mine.length ? mine[mine.length - 1].nextSibling : null;
      mine.sort(function (a, b) {
        if (!field) return a.getAttribute('data-forder') - b.getAttribute('data-forder');
        var x = a.getAttribute('data-s-' + field), y = b.getAttribute('data-s-' + field);
        var nx = parseFloat(x), ny = parseFloat(y), c;
        c = !isNaN(nx) && !isNaN(ny) && String(nx) === String(+x) && String(ny) === String(+y)
          ? nx - ny : String(x || '').localeCompare(String(y || ''));
        if (desc) c = -c;
        return c || a.getAttribute('data-forder') - b.getAttribute('data-forder');
      }).forEach(function (r) { parent.insertBefore(r, anchor); });
    });

    paintHeads(id, by);
    var sel = document.getElementById('ff-' + id + '-sort');
    if (sel && sel.value !== by) {
      // A heading picked a sort the dropdown has no line for: add it, so the two agree.
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === by; })) {
        var o = document.createElement('option');
        o.value = by; o.textContent = (desc ? 'High → low: ' : 'Low → high: ') + field;
        sel.appendChild(o);
      }
      sel.value = by;
    }
    var narrowed = shown !== rows.length;
    Array.prototype.forEach.call(document.querySelectorAll('[data-fempty="' + id + '"]'), function (e) {
      e.style.display = rows.length && !shown ? '' : 'none';
    });
    var c = document.getElementById('fc-' + id);
    if (c) {
      c.innerHTML = narrowed
        ? 'Showing ' + shown + ' of ' + rows.length + ' ' + esc(opts.noun || '') +
          ' · <button type="button" class="quiet" onclick="SF.filters.clear(\'' + id + '\')">Show all</button>'
        : '';
    }
  }

  window.SF.filters = {
    row: row,
    bar: bar,
    th: th,
    sortBy: function (id, field) {
      var st = saved(id), now = st.sort || '';
      st.sort = now === field ? '-' + field : now === '-' + field ? '' : field;
      SF.ls.set(key(id), st);
      apply(id);
    },
    apply: apply,
    typed: function (id, input) { typedText[id] = input.value; apply(id); },
    pick: function (id, k, v) {
      var st = saved(id);
      st[k] = v;
      SF.ls.set(key(id), st);
      apply(id);
    },
    clear: function (id) {
      typedText[id] = '';
      var st = saved(id), keepSort = st.sort;
      SF.ls.set(key(id), keepSort ? { sort: keepSort } : {});
      var q = document.getElementById('fq-' + id);
      if (q) q.value = '';
      Array.prototype.forEach.call(document.querySelectorAll('select[id^="ff-' + id + '-"]'), function (s) {
        if (!/-sort$/.test(s.id)) s.value = 'all';
      });
      apply(id);
    },
    /** Rows a person can see right now (for "Tick all" and friends). */
    visible: function (id) {
      return rowsOf(id).filter(function (r) { return r.style.display !== 'none'; });
    }
  };
})();
