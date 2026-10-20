/**
 * StallFlow — client kernel
 * ===========================================================================
 * Offline-first, plugin-hosted. Nothing here knows what a stall sells.
 *
 *   SF.api      talking to the server
 *   SF.store    what the phone remembers: cached reads, an outbox of writes
 *   SF.sync     draining the outbox, in order, exactly once
 *   SF.plugin   registering screens, slots, filters and events
 *   SF.ui       the small set of helpers every screen uses
 *
 * The whole app is one code path online and offline. The only difference is
 * how long a change sits in the outbox before the server hears about it.
 */
window.SF = (function () {
  'use strict';

  var CFG = window.STALLFLOW || { api: '' };
  var SITE = new URL('../', location.href).href;

  var S = {
    ready: false,
    view: 'till',
    online: navigator.onLine !== false,
    syncing: false,
    boot: null,
    token: null,
    role: null,
    device: null,
    data: {},
    at: {},
    marketId: '',
    vocab: { unit: 'item', units: 'items', run: 'batch', runs: 'batches' }
  };

  /* ==================================================================
     Small helpers
     ================================================================== */

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Rands the South African way: space thousands, point decimal. Written by
     hand — toLocaleString('en-ZA') uses a comma as the decimal separator, so
     swapping separators after the fact destroys the decimal point. */
  function money(v) {
    var n = Number(v) || 0, neg = n < 0; n = Math.abs(n);
    var p = n.toFixed(2).split('.');
    return (neg ? '-' : '') + 'R ' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + p[1];
  }
  function moneyShort(v) {
    var n = Math.round(Number(v) || 0), neg = n < 0; n = Math.abs(n);
    return (neg ? '-' : '') + 'R ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  var UNITS = {
    each: { label: '', step: 1, dp: 0, weighed: false },
    kg: { label: 'kg', step: 0.01, dp: 3, weighed: true },
    '100g': { label: '×100 g', step: 1, dp: 0, weighed: true },
    litre: { label: 'ℓ', step: 0.1, dp: 2, weighed: true }
  };

  /** Quantity written the way the product is actually sold. */
  function qty(n, unit) {
    var u = UNITS[unit] || UNITS.each;
    if (!u.weighed) return String(Math.round(Number(n) || 0));
    var v = Number(n) || 0;
    return (u.dp ? v.toFixed(u.dp).replace(/\.?0+$/, '') : String(Math.round(v))) +
      (u.label ? ' ' + u.label : '');
  }

  /** "3 jars" / "1 jar" — the noun comes from the market preset. */
  function countOf(n, one, many) {
    var v = Math.round(Number(n) || 0);
    return v + ' ' + (v === 1 ? (one || S.vocab.unit) : (many || S.vocab.units));
  }

  function clock(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function uid(prefix) {
    return (prefix || 'o') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  function find(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function toast(msg, bad) {
    var t = el('toast');
    if (!t) return;
    // Sit above whatever is docked at the bottom — the till cart is the tall
    // one — so a message never lands on top of the button she is reaching for.
    var docked = document.querySelector('.cart');
    var lift = docked ? Math.ceil(docked.getBoundingClientRect().height) : 0;
    t.style.bottom = 'calc(var(--tabbar) + ' + (20 + lift) + 'px + env(safe-area-inset-bottom))';
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.className = ''; }, bad ? 4500 : 2600);
  }

  /* ==================================================================
     Persistence
     ================================================================== */

  /**
   * Every stall is served from the same origin (stallflow.github.io), so they
   * all share one localStorage. Keys carry the stall's slug, or one stall's
   * sign-in, outbox and cached shop would be read by another stall's app.
   */
  var NS = CFG.stall ? 'stall:' + CFG.stall + ':' : '';

  var LS = {
    get: function (k, dflt) {
      try { var v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : dflt; }
      catch (e) { return dflt; }
    },
    set: function (k, v) {
      try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* full or blocked */ }
    },
    del: function (k) { try { localStorage.removeItem(NS + k); } catch (e) {} }
  };

  var Cache = {
    put: function (view, data) { LS.set('sf.cache.' + view, { data: data, at: Date.now() }); },
    get: function (view) { return LS.get('sf.cache.' + view, null); },
    clear: function () {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(NS + 'sf.cache.') === 0) {
          try { localStorage.removeItem(k); } catch (e) {}
        }
      });
    }
  };

  var Outbox = {
    all: function () { return LS.get('sf.outbox', []); },
    save: function (l) { LS.set('sf.outbox', l); },
    add: function (op) { var l = Outbox.all(); l.push(op); Outbox.save(l); },
    remove: function (id) {
      Outbox.save(Outbox.all().filter(function (o) { return o.opId !== id; }));
    },
    fail: function (id, message) {
      var l = Outbox.all();
      l.forEach(function (o) { if (o.opId === id) { o.failed = true; o.message = message; } });
      Outbox.save(l);
    },
    pending: function () { return Outbox.all().filter(function (o) { return !o.failed; }); },
    failed: function () { return Outbox.all().filter(function (o) { return o.failed; }); }
  };

  /* ==================================================================
     Server
     ================================================================== */

  function get(action, params) {
    var q = '?action=' + encodeURIComponent(action);
    if (S.token) q += '&token=' + encodeURIComponent(S.token);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') {
        q += '&' + k + '=' + encodeURIComponent(params[k]);
      }
    });
    return fetch(CFG.api + q, { method: 'GET' }).then(function (r) { return r.json(); });
  }

  function post(body) {
    // text/plain keeps this a "simple" cross-origin request. application/json
    // triggers a CORS preflight, which Apps Script cannot answer.
    var payload = {};
    Object.keys(body).forEach(function (k) { payload[k] = body[k]; });
    if (S.token) payload.token = S.token;
    return fetch(CFG.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  /* ==================================================================
     Plugin host
     ================================================================== */

  var registry = { plugins: [], screens: [], slots: {}, filters: {}, events: {} };

  function plugin(spec) {
    if (!spec || !spec.id) throw new Error('A plugin needs an id.');
    registry.plugins.push(spec);
    (spec.screens || []).forEach(function (sc) {
      registry.screens.push({
        id: sc.id, title: sc.title, icon: sc.icon, cap: sc.cap || 'sell',
        render: sc.render, plugin: spec.id, tab: !!sc.tab
      });
    });
    Object.keys(spec.slots || {}).forEach(function (name) {
      (registry.slots[name] = registry.slots[name] || [])
        .push({ fn: spec.slots[name], plugin: spec.id });
    });
    Object.keys(spec.filters || {}).forEach(function (name) {
      (registry.filters[name] = registry.filters[name] || [])
        .push({ fn: spec.filters[name], plugin: spec.id });
    });
    Object.keys(spec.events || {}).forEach(function (name) {
      (registry.events[name] = registry.events[name] || [])
        .push({ fn: spec.events[name], plugin: spec.id });
    });
  }

  function pluginOn(id) {
    if (!S.boot) return false;
    return (S.boot.plugins || []).some(function (p) { return p.id === id; });
  }

  /** All HTML contributed to a named slot, in registration order. */
  function slot(name, ctx) {
    return (registry.slots[name] || []).map(function (h) {
      if (!pluginOn(h.plugin)) return '';
      try { return h.fn(ctx) || ''; }
      catch (e) { console.warn('slot ' + name + ' in ' + h.plugin, e); return ''; }
    }).join('');
  }

  function apply(name, value, ctx) {
    (registry.filters[name] || []).forEach(function (h) {
      if (!pluginOn(h.plugin)) return;
      try { var out = h.fn(value, ctx); if (out !== undefined) value = out; }
      catch (e) { console.warn('filter ' + name + ' in ' + h.plugin, e); }
    });
    return value;
  }

  function fire(name, payload) {
    (registry.events[name] || []).forEach(function (h) {
      if (!pluginOn(h.plugin)) return;
      try { h.fn(payload); }
      catch (e) { console.warn('event ' + name + ' in ' + h.plugin, e); }
    });
  }

  function settingsOf(pluginId) {
    var stored = (S.boot && S.boot.settings && S.boot.settings[pluginId]) || {};
    var out = {};
    (S.boot.plugins || []).forEach(function (p) {
      if (p.id !== pluginId) return;
      (p.settings || []).forEach(function (s) {
        out[s.key] = stored[s.key] !== undefined ? stored[s.key] : s.default;
      });
    });
    return out;
  }

  /* ==================================================================
     Screens
     ================================================================== */

  var screens = {};      // id -> {id, title, icon, cap, render, tab}

  function screen(def) { screens[def.id] = def; }

  function allScreens() {
    var out = Object.keys(screens).map(function (k) { return screens[k]; });
    registry.screens.forEach(function (sc) { if (pluginOn(sc.plugin)) out.push(sc); });
    return out;
  }

  var CAPS = {
    owner: ['*'],
    manager: ['sell', 'orders', 'stock', 'price', 'labels', 'reports', 'expenses'],
    cashier: ['sell', 'orders', 'labels'],
    viewer: ['reports']
  };

  function can(cap) {
    var list = CAPS[S.role] || [];
    return list.indexOf('*') !== -1 || list.indexOf(cap) !== -1;
  }

  /* ==================================================================
     Reading
     ================================================================== */

  var SOURCE = {
    till: 'till', collect: 'queue', stock: 'stock',
    labels: 'labels', numbers: 'dashboard'
  };

  function load(view) {
    var action = SOURCE[view];
    if (!action) { render(); return Promise.resolve(); }

    var cached = Cache.get(view);
    if (cached) { S.data[view] = cached.data; S.at[view] = cached.at; }
    render();

    var params = view === 'numbers' && S.marketId ? { marketId: S.marketId } : {};
    return get(action, params).then(function (res) {
      if (res && res.code === 'auth') { signOut(true); return; }
      if (!res || res.ok === false) throw new Error((res && res.message) || 'refused');
      S.data[view] = res.data;
      S.at[view] = Date.now();
      Cache.put(view, res.data);
      if (view === 'numbers') S.marketId = res.data.marketId;
      S.online = true;
      render();
    }).catch(function () { S.online = false; render(); });
  }

  function fetchInto(view) {
    var action = SOURCE[view];
    if (!action) return Promise.resolve();
    var params = view === 'numbers' && S.marketId ? { marketId: S.marketId } : {};
    return get(action, params).then(function (res) {
      if (!res || res.ok === false) return;
      S.data[view] = res.data;
      S.at[view] = Date.now();
      Cache.put(view, res.data);
    });
  }

  /**
   * Pull every screen down while there is still signal, so a screen she has
   * not opened is not blank at the market. Skipped while writes are queued —
   * a fetch must never overwrite a change that has not gone up yet.
   */
  function warm() {
    if (Outbox.pending().length) return Promise.resolve();
    return Object.keys(SOURCE)
      .filter(function (v) { return can(screens[v] ? screens[v].cap : 'sell'); })
      .reduce(function (chain, v) {
        return chain.then(function () { return fetchInto(v); });
      }, Promise.resolve())
      .then(function () { S.online = true; render(); })
      .catch(function () { /* the caches we have will do */ });
  }

  /* ==================================================================
     Writing
     ================================================================== */

  /**
   * Queue a change and show it immediately. `optimistic` mutates the cached
   * data so the screen stays truthful with no signal.
   */
  function write(action, payload, optimistic) {
    var op = { opId: uid(), action: action, payload: payload || {}, at: Date.now() };
    if (optimistic) {
      try { optimistic(); } catch (e) { /* a stale cache must never block a sale */ }
      Object.keys(SOURCE).forEach(function (v) {
        if (S.data[v]) Cache.put(v, S.data[v]);
      });
    }
    Outbox.add(op);
    render();
    return sync();
  }

  var syncAgain = false;

  function sync() {
    // A write that lands mid-flush must not be forgotten: remember that
    // another pass is owed and run it as soon as this one finishes.
    if (S.syncing) { syncAgain = true; return Promise.resolve(); }
    var queue = Outbox.pending();
    if (!queue.length) return Promise.resolve();

    S.syncing = true;
    render();

    return queue.reduce(function (chain, op) {
      return chain.then(function () {
        var body = { action: op.action, opId: op.opId };
        Object.keys(op.payload).forEach(function (k) { body[k] = op.payload[k]; });
        return post(body).then(function (res) {
          if (res && res.code === 'auth') throw new Error('auth');
          // Only an explicit answer counts. Anything we cannot read — an empty
          // body, a captive-portal login page, a truncated reply — is treated
          // as "did not arrive" so the change stays queued and is retried.
          // Removing it here would lose a sale silently, which is the one
          // outcome this whole design exists to prevent.
          if (!res || typeof res.ok === 'undefined') throw new Error('unreadable');
          if (res.ok === false) {
            // The server refused on its own terms — not a signal problem.
            // Keep it and show why, rather than dropping it quietly.
            Outbox.fail(op.opId, res.message || 'The server would not accept this.');
          } else {
            Outbox.remove(op.opId);
            fire('write.done', { action: op.action, result: res });
          }
        });
      });
    }, Promise.resolve())
      .then(function () {
        S.syncing = false; S.online = true;
        if (syncAgain) { syncAgain = false; return sync(); }
        return load(S.view).then(warm);
      })
      .catch(function (err) {
        S.syncing = false;
        syncAgain = false;
        if (err && err.message === 'auth') { signOut(true); return; }
        S.online = false;               // out of signal: the rest stays queued, in order
        render();
      });
  }

  /* ==================================================================
     Identity
     ================================================================== */

  function device() {
    var d = LS.get('sf.device', null);
    if (!d) { d = uid('d'); LS.set('sf.device', d); }
    return d;
  }

  function signInWith(action, params) {
    params.device = device();
    return get(action, params).then(function (res) {
      var d = res && res.data;
      // A refusal comes back inside data; a server error comes back on the
      // outside. Show whichever message there is.
      if (!d || !d.ok) {
        return { ok: false, message: (d && d.message) || (res && res.message) || 'Could not sign in.' };
      }
      S.token = d.token; S.role = d.role; S.user = d.user || '';
      LS.set('sf.auth', { token: d.token, role: d.role, user: S.user });
      return { ok: true, role: d.role, unlocked: d.unlocked };
    });
  }

  function signIn(pin) { return signInWith('signIn', { pin: pin }); }

  /** Google's sign-in button script, loaded once and only when needed. */
  var gsi = null;
  function loadGoogle() {
    if (gsi) return gsi;
    gsi = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { gsi = null; reject(new Error('gsi')); };
      document.head.appendChild(s);
    });
    return gsi;
  }

  /**
   * Signing out has to close the sheet it was tapped from, or the sign-in
   * screen paints underneath it and nothing appears to happen.
   *
   * Anything still waiting to go up needs a token to send, so it cannot sync
   * while nobody is signed in. Say so rather than losing it quietly.
   */
  function signOut(expired) {
    closeSheet();
    var waiting = Outbox.pending().length;
    if (!expired && waiting) {
      openSheet(
        '<h2>Sign out?</h2>' +
        '<div class="notice warn" style="border-radius:10px;margin:10px 0 14px;' +
          'display:block;text-align:left">' + waiting + ' change' +
          (waiting === 1 ? '' : 's') + ' still needs to go up. It is kept on this ' +
          'phone, but nothing can be sent until somebody signs in again.</div>' +
        '<div class="row">' +
          '<button class="ghost" onclick="SF.closeSheet()">Stay signed in</button>' +
          '<button class="bad" style="flex:2" onclick="SF.forceSignOut()">' +
            'Sign out anyway</button>' +
        '</div>');
      return;
    }
    forceSignOut(expired);
  }

  function forceSignOut(expired) {
    closeSheet();
    LS.del('sf.auth');
    Cache.clear();                 // cached reads only — the outbox survives
    S.token = null; S.role = null; S.user = ''; S.ready = false;
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();   // so the next person picks their own account
    }
    S.data = {}; S.at = {};        // nothing of the last person left in memory
    if (expired) toast('Please sign in again.', true);
    paintSignIn();
  }

  /* ==================================================================
     Chrome
     ================================================================== */

  var ICONS = {
    till: '<path d="M3 8h18v11H3z"/><path d="M3 12h18"/><path d="M7.5 15.5h3"/>',
    collect: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h9"/>',
    stock: '<path d="M5 8.5 12 5l7 3.5v7L12 19l-7-3.5z"/><path d="M5 8.5 12 12l7-3.5M12 12v7"/>',
    labels: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    numbers: '<path d="M4 19V10"/><path d="M10 19V5"/><path d="M16 19v-6"/><path d="M21 19H3"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    kitchen: '<path d="M6 3v8a3 3 0 0 0 6 0V3"/><path d="M9 11v10"/><path d="M17 3c-1.5 2-2 4-2 6s.5 3 2 3 2-1 2-3-.5-4-2-6z"/><path d="M17 12v9"/>',
    scale: '<path d="M12 4v16"/><path d="M6 20h12"/><path d="M4 9h16"/><path d="M4 9 2 15h4zM20 9l-2 6h4z"/>',
    cashup: '<path d="M4 7h16v10H4z"/><circle cx="12" cy="12" r="2.5"/><path d="M7 10v4M17 10v4"/>'
  };

  var TABS = ['till', 'collect', 'stock', 'numbers'];

  function paintRail() {
    var p = S.boot.profile;
    var queued = Outbox.pending().length;
    // "Sending" only while there is something to send it over. An attempt that
    // is failing must not read as progress.
    var chip = (S.syncing && S.online)
      ? { cls: 'chip sync', text: 'Sending' + (queued ? ' ' + queued : '') + '…' }
      : !S.online
        ? { cls: 'chip off', text: queued ? queued + ' waiting' : 'No signal' }
        : { cls: 'chip', text: queued ? queued + ' waiting' : 'Online' };

    var market = '';
    var d = S.data.numbers;
    if (d && d.markets) {
      d.markets.forEach(function (m) { if (m.id === d.marketId) market = m.name; });
    }

    el('rail').innerHTML =
      '<div class="line">' +
        '<span class="shop">' + esc(p.name) + '</span>' +
        (market ? '<span class="meta">' + esc(market) + '</span>' : '') +
        '<span class="' + chip.cls + '"><span class="dot"></span>' + chip.text + '</span>' +
      '</div>';
  }

  /* ==================================================================
     Installing to the home screen
     ------------------------------------------------------------------
     Chrome fires beforeinstallprompt only when it decides the app is
     installable. We hold that event and offer it on the first open, because
     a till that lives behind a browser tab gets lost.
     ================================================================== */

  var installEvent = null;
  var updateReady = false;

  /**
   * A new version has installed underneath us. Reload straight away if she is
   * idle; otherwise wait and offer it, because reloading mid-sale would throw
   * away the till.
   */
  function updateArrived() {
    updateReady = true;
    var busy = (window.SFT && SFT.busy && SFT.busy()) || document.querySelector('.sheet');
    if (!busy) { applyUpdate(); return; }
    render();
  }

  function applyUpdate() {
    updateReady = false;
    location.reload();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'sf-updated') updateArrived();
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installEvent = e;
    if (S.ready) render();
  });

  window.addEventListener('appinstalled', function () {
    installEvent = null;
    LS.set('sf.installed', true);
    render();
  });

  function installable() {
    if (!installEvent) return false;
    if (LS.get('sf.installDismissed', false)) return false;
    // Already running as an installed app? Then there is nothing to offer.
    if (window.matchMedia('(display-mode: standalone)').matches) return false;
    return true;
  }

  function install() {
    if (!installEvent) return;
    installEvent.prompt();
    installEvent.userChoice.then(function () { installEvent = null; render(); });
  }

  function dismissInstall() {
    LS.set('sf.installDismissed', true);
    render();
  }

  function paintNotices() {
    var out = '';
    var failed = Outbox.failed();
    var at = S.at[S.view];

    if (updateReady) {
      out += '<div class="notice warn">A newer version is ready.' +
        '<button class="quiet" onclick="SF.applyUpdate()">Update now</button></div>';
    }
    if (installable()) {
      out += '<div class="install"><img src="icon-192.png" alt="">' +
        '<div class="t"><b>Put this on your home screen</b>' +
        '<span>It opens full screen and works without signal.</span></div>' +
        '<button class="sm" onclick="SF.install()">Install</button>' +
        '<button class="quiet" onclick="SF.dismissInstall()">Not now</button></div>';
    }

    if (!S.online) {
      var q = Outbox.pending().length;
      out += '<div class="notice warn">Working without signal.' +
        (q ? ' ' + q + ' change' + (q === 1 ? '' : 's') + ' will go up when it returns.' : '') +
        (at ? ' Numbers from ' + clock(at) + '.' : '') + '</div>';
    }
    if (failed.length) {
      out += '<div class="notice bad">' + failed.length + ' change' +
        (failed.length === 1 ? '' : 's') + ' could not go through' +
        '<button class="quiet" onclick="SF.go(\'failed\')">See why</button></div>';
    }
    el('notices').innerHTML = out;
  }

  function paintTabs() {
    var items = TABS.filter(function (id) {
      return screens[id] && can(screens[id].cap);
    }).map(function (id) {
      return { id: id, title: screens[id].title, icon: ICONS[id] };
    });
    items.push({ id: 'more', title: 'More', icon: ICONS.more });

    el('tabs').innerHTML = items.map(function (t) {
      var on = (t.id === S.view) || (t.id === 'more' && TABS.indexOf(S.view) === -1);
      return '<a href="#' + t.id + '" class="' + (on ? 'on' : '') + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + t.icon + '</svg>' +
        esc(t.title) + '</a>';
    }).join('');
  }

  function render() {
    if (!S.ready) return;
    paintRail();
    paintNotices();
    paintTabs();

    var def = screens[S.view] || registry.screens.filter(function (sc) {
      return sc.id === S.view && pluginOn(sc.plugin);
    })[0];

    if (!def) { el('view').innerHTML = notFound(); return; }
    if (!can(def.cap)) {
      el('view').innerHTML = '<div class="wrap"><div class="card"><div class="empty">' +
        'A ' + esc(S.role) + ' does not have this screen. Ask the owner.</div></div></div>';
      return;
    }
    var source = SOURCE[def.id];
    if (source && !S.data[def.id]) {
      el('view').innerHTML = '<div class="wrap"><div class="card"><div class="empty">' +
        (S.online ? 'Loading…'
          : 'Nothing saved for this screen yet, and no signal to fetch it. ' +
            'It will fill in the moment you are back on.') + '</div></div></div>';
      return;
    }
    try {
      el('view').innerHTML = def.render({ data: S.data[def.id], state: S });
    } catch (e) {
      console.error(e);
      el('view').innerHTML = '<div class="wrap"><div class="card"><div class="empty">' +
        'This screen could not draw itself. The rest of the app is fine.</div></div></div>';
    }
  }

  function notFound() {
    return '<div class="wrap"><div class="card"><div class="empty">' +
      'That screen is not here.</div></div></div>';
  }

  /* ==================================================================
     Router
     ================================================================== */

  function route() {
    var v = (location.hash || '#till').slice(1);
    if (v === 'more') { openMore(); location.replace('#' + S.view); return; }
    S.view = v;
    render();
    load(v);
    window.scrollTo(0, 0);
  }

  function go(id) { location.hash = '#' + id; }

  /* ==================================================================
     Sheets (the slide-up panel)
     ================================================================== */

  function openSheet(html) {
    closeSheet();                    // never stack two — the old one would win the tap
    var wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.innerHTML = '<div class="panel"><div class="grab"></div>' + html + '</div>';
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeSheet(); });
    document.body.appendChild(wrap);
    return wrap;
  }
  function closeSheet() {
    var s = document.querySelector('.sheet');
    if (s) s.remove();
  }

  function openMore() {
    var extra = registry.screens.filter(function (sc) {
      return pluginOn(sc.plugin) && can(sc.cap);
    });
    var core = ['labels', 'people', 'settings', 'health'].filter(function (id) {
      return screens[id] && can(screens[id].cap);
    }).map(function (id) { return screens[id]; });

    openSheet(
      '<h2>More</h2><div class="sub">Everything that is not the day-to-day.</div>' +
      core.concat(extra).map(function (sc) {
        return '<button class="ghost block" style="margin-bottom:8px;text-align:left" ' +
          'onclick="SF.closeSheet();SF.go(\'' + sc.id + '\')">' + esc(sc.title) + '</button>';
      }).join('') +
      '<div class="hr"></div>' +
      '<div class="row">' +
        '<button class="ghost" onclick="SF.toggleTheme()">Light / dark</button>' +
        '<button class="ghost" onclick="SF.signOut()">Sign out</button>' +
      '</div>' +
      '<div class="foot">StallFlow ' + esc((S.boot && S.boot.version) || '') +
        ' · signed in as ' + (S.user ? esc(S.user) + ' (' + esc(S.role) + ')' : esc(S.role)) +
        '</div>');
  }

  function toggleTheme() {
    var now = document.documentElement.getAttribute('data-theme');
    var next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    LS.set('sf.theme', next);
    closeSheet();
  }

  /* ==================================================================
     Boot
     ================================================================== */

  /**
   * Only the stall's own colour is taken from the profile.
   *
   * Its `ink` and `paper` are light-theme values. Setting them here wrote an
   * inline style on :root, which outranks the dark-mode block — so on a phone
   * set to dark the app kept near-black text and put it on dark cards. The
   * neutrals belong to the theme, never to the tenant.
   */
  function paintTheme(profile) {
    var r = document.documentElement.style;
    if (profile.colour) r.setProperty('--brand', profile.colour);
    var saved = LS.get('sf.theme', null);
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }

  /**
   * The server says whether this stall uses Google or PINs. The last answer
   * is kept on the phone so the right screen paints at once; a fresh answer
   * only repaints if it changed, so nobody loses a half-typed PIN.
   */
  function paintSignIn(message) {
    el('rail').innerHTML = '<div class="line"><span class="shop">StallFlow</span></div>';
    el('notices').innerHTML = '';
    el('tabs').innerHTML = '';
    var known = LS.get('sf.authcfg', null);
    if (known) drawSignIn(known, message);
    else el('view').innerHTML = '<div class="wrap" style="max-width:420px;padding-top:40px">' +
      '<div class="card"><div class="loading">Opening the shop…</div></div></div>';

    get('authConfig').then(function (res) {
      // A server from before Google sign-in does not know this action: that
      // simply means PINs, not an error.
      var d = res && res.ok !== false && res.data ? res.data : {};
      var cfg = { google: !!d.google, clientId: d.clientId || '' };
      LS.set('sf.authcfg', cfg);
      if (!known || JSON.stringify(known) !== JSON.stringify(cfg)) drawSignIn(cfg, message);
    }).catch(function () {
      if (!known) drawSignIn({ google: false }, message ||
        'Could not reach the shop. Sign in once with signal, then it works offline.');
    });
  }

  function drawSignIn(cfg, message) {
    if (cfg.google) { drawGoogleSignIn(cfg, message); return; }
    drawPinSignIn(message);
  }

  function drawGoogleSignIn(cfg, message) {
    el('view').innerHTML =
      '<div class="wrap" style="max-width:420px;padding-top:40px">' +
        '<div class="card">' +
          '<h2>Sign in</h2>' +
          '<div class="sub">Use the Google account the owner added to this stall.</div>' +
          (message ? '<div class="notice bad" style="border-radius:10px;margin-bottom:12px">' +
            esc(message) + '</div>' : '') +
          '<div id="gsi" style="display:flex;justify-content:center;min-height:44px">' +
            '<div class="loading">Loading Google sign-in…</div></div>' +
          '<p class="muted small" style="margin-top:12px;text-align:center">' +
            'Not on the list yet? Ask the owner to add your email address under ' +
            'More &rsaquo; People.</p>' +
        '</div>' +
      '</div>';

    loadGoogle().then(function () {
      var box = el('gsi');
      if (!box) return;
      box.innerHTML = '';
      google.accounts.id.initialize({
        client_id: cfg.clientId,
        callback: function (r) {
          box.innerHTML = '<div class="loading">Checking…</div>';
          signInWith('signInGoogle', { credential: r.credential }).then(function (res) {
            if (!res.ok) { drawGoogleSignIn(cfg, res.message); return; }
            start();
          }).catch(function () {
            drawGoogleSignIn(cfg, 'Could not reach the shop. Check your signal and try again.');
          });
        }
      });
      var dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.getAttribute('data-theme') &&
         window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      google.accounts.id.renderButton(box, {
        theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
        text: 'signin_with', width: Math.min(340, box.clientWidth || 340)
      });
    }).catch(function () {
      var box = el('gsi');
      if (box) box.innerHTML = '<div class="notice bad" style="border-radius:10px">' +
        'Google sign-in did not load. Check your signal and refresh.</div>';
    });
  }

  function drawPinSignIn(message) {
    el('view').innerHTML =
      '<div class="wrap" style="max-width:420px;padding-top:40px">' +
        '<div class="card">' +
          '<h2>Sign in</h2>' +
          '<div class="sub">Your PIN decides what you can do on this phone.</div>' +
          (message ? '<div class="notice bad" style="border-radius:10px;margin-bottom:12px">' +
            esc(message) + '</div>' : '') +
          '<div class="field"><label for="pin">PIN</label>' +
            '<input id="pin" type="tel" inputmode="numeric" autocomplete="one-time-code" ' +
            'placeholder="••••" style="font-size:24px;text-align:center;letter-spacing:.4em"></div>' +
          '<button class="block" id="signin">Sign in</button>' +
          '<p class="muted small" style="margin-top:12px;text-align:center">' +
            'No PIN set yet? Leave it blank and press sign in — then set one straight away ' +
            'under More &rsaquo; Settings.</p>' +
        '</div>' +
      '</div>';
    el('signin').onclick = function () {
      var btn = el('signin');
      btn.disabled = true; btn.textContent = 'Checking…';
      signIn(el('pin').value || '').then(function (r) {
        if (!r.ok) { drawPinSignIn(r.message); return; }
        start();
      }).catch(function () {
        drawPinSignIn('Could not reach the shop. Sign in once with signal, then it works offline.');
      });
    };
    el('pin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el('signin').click();
    });
  }

  function start() {
    return get('boot').then(function (res) {
      if (res && res.code === 'auth') { signOut(true); return; }
      if (!res || res.ok === false) throw new Error('boot refused');
      S.boot = res.data;
      LS.set('sf.boot', res.data);
      begin();
    }).catch(function () {
      var cached = LS.get('sf.boot', null);
      if (!cached) { paintSignIn('No signal, and this phone has not loaded the shop yet.'); return; }
      S.boot = cached;
      S.online = false;
      begin();
    });
  }

  function begin() {
    S.vocab = S.boot.profile.vocab || S.vocab;
    S.marketId = S.boot.marketId || '';
    paintTheme(S.boot.profile);
    document.title = S.boot.profile.name + ' — StallFlow';
    S.ready = true;
    route();
    sync().then(warm);
  }

  function init() {
    if (!CFG.api) {
      el('view').innerHTML = '<div class="wrap"><div class="card"><h2>Not connected yet</h2>' +
        '<p class="sub">The <b>api</b> address is still blank in <code>config.js</code>. ' +
        'In the spreadsheet choose <b>StallFlow &rsaquo; Show my web address</b> and paste ' +
        'it in.</p></div></div>';
      return;
    }
    var saved = LS.get('sf.theme', null);
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    var density = LS.get('sf.density', null);
    if (density) document.documentElement.setAttribute('data-density', density);

    var auth = LS.get('sf.auth', null);
    if (auth && auth.token) {
      S.token = auth.token; S.role = auth.role; S.user = auth.user || ''; start();
    }
    else paintSignIn();

    window.addEventListener('hashchange', route);
    window.addEventListener('online', function () {
      S.online = true; render(); sync().then(warm);
    });
    window.addEventListener('offline', function () { S.online = false; render(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && S.ready) { sync(); load(S.view); }
    });
    setInterval(function () { if (Outbox.pending().length) sync(); }, 30000);
  }

  return {
    // lifecycle
    init: init, start: start, render: render, load: load, go: go, route: route,
    signOut: signOut, forceSignOut: forceSignOut, toggleTheme: toggleTheme,
    // data
    state: S, write: write, sync: sync, get: get, post: post,
    cache: Cache, outbox: Outbox, site: SITE, ls: LS,
    // extension
    plugin: plugin, screen: screen, screens: screens, allScreens: allScreens,
    slot: slot, apply: apply, fire: fire, pluginOn: pluginOn, settingsOf: settingsOf,
    // helpers
    el: el, esc: esc, money: money, moneyShort: moneyShort, qty: qty, countOf: countOf,
    clock: clock, uid: uid, find: find, toast: toast, can: can, units: UNITS,
    openSheet: openSheet, closeSheet: closeSheet, openMore: openMore,
    install: install, dismissInstall: dismissInstall, applyUpdate: applyUpdate
  };
})();
