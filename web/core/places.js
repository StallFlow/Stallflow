/**
 * StallFlow — place suggestions from Google Maps, inside the app.
 *
 * A "Where" box asks Google for matching places as it is typed and shows them
 * in a list under the box. Picking one fills the box. Nothing opens another
 * app or browser.
 *
 * Needs `mapsKey` in config.js (from stalls/platform.json). Without a key, with
 * no signal, or if Google refuses the key, the box is an ordinary text box and
 * nothing else changes. Google's script is only fetched the first time
 * somebody types in a Where box, so the till itself never waits for it.
 *
 * Markup, wherever a box should suggest places:
 *   <div class="field place">
 *     <input id="X" autocomplete="off" oninput="SFP.typed(this, event)"
 *            onkeydown="SFP.key(this, event)" onblur="SFP.blur(this)">
 *     <div class="sug" id="X-sug" role="listbox" hidden></div>
 *   </div>
 */
var SFP = (function () {
  var CFG = window.STALLFLOW || {};
  var KEY = CFG.mapsKey || '';
  var REGION = CFG.mapsRegion || 'za';
  var MAX = 160;                    // the Markets sheet keeps this much of the place

  var lib = null;                   // promise of Google's places library
  var off = !KEY;                   // switched off for good on a refused key
  var timer = null, seq = 0, token = null;
  var shown = {};                   // input id -> { list, at }

  // Google calls this when the key is wrong or not allowed on this site.
  window.gm_authFailure = function () { off = true; closeAll(); };

  function load() {
    if (lib) return lib;
    lib = new Promise(function (resolve, reject) {
      window.__sfPlacesReady = function () {
        google.maps.importLibrary('places').then(resolve, reject);
      };
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(KEY) +
        '&v=weekly&loading=async&callback=__sfPlacesReady';
      s.onerror = function () { reject(new Error('maps script did not load')); };
      document.head.appendChild(s);
    }).catch(function (e) {
      lib = null;                   // a lost signal is not forever: try again next time
      throw e;
    });
    return lib;
  }

  function box(input) { return document.getElementById(input.id + '-sug'); }

  function close(input) {
    var b = input && box(input);
    if (b) { b.hidden = true; b.innerHTML = ''; }
    if (input) { delete shown[input.id]; input.setAttribute('aria-expanded', 'false'); }
  }

  function closeAll() {
    Array.prototype.forEach.call(document.querySelectorAll('.sug'), function (b) {
      b.hidden = true; b.innerHTML = '';
    });
    shown = {};
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function draw(input, list) {
    var b = box(input);
    if (!b || document.activeElement !== input) return;
    if (!list.length) { close(input); return; }
    shown[input.id] = { list: list, at: -1 };
    b.innerHTML = list.map(function (p, i) {
      return '<button type="button" class="opt" role="option" id="' + input.id + '-o' + i + '" ' +
        // mousedown, not click: a click would blur the box first and close the list
        'onmousedown="event.preventDefault();SFP.pick(\'' + input.id + '\',' + i + ')">' +
        '<b>' + esc(p.main) + '</b>' + (p.rest ? '<span>' + esc(p.rest) + '</span>' : '') +
        '</button>';
    }).join('') + '<div class="by">Suggestions from Google</div>';
    b.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function ask(input) {
    var q = String(input.value || '').trim();
    if (off || q.length < 3 || navigator.onLine === false) { close(input); return; }
    var mine = ++seq;
    load().then(function (places) {
      if (!token) token = new places.AutocompleteSessionToken();
      return places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: q, includedRegionCodes: [REGION], sessionToken: token
      });
    }).then(function (res) {
      if (mine !== seq) return;     // they kept typing; a newer answer is on its way
      var list = ((res && res.suggestions) || []).map(function (s) {
        var p = s.placePrediction;
        if (!p) return null;
        return {
          main: p.mainText ? p.mainText.toString() : p.text.toString(),
          rest: p.secondaryText ? p.secondaryText.toString() : ''
        };
      }).filter(Boolean).slice(0, 5);
      draw(input, list);
    }).catch(function (e) {
      if (mine === seq) close(input);
      if (window.console) console.warn('[places]', e && e.message);
    });
  }

  function highlight(input, at) {
    var s = shown[input.id];
    if (!s) return;
    s.at = (at + s.list.length) % s.list.length;
    s.list.forEach(function (_, i) {
      var o = document.getElementById(input.id + '-o' + i);
      if (o) o.classList.toggle('on', i === s.at);
    });
    input.setAttribute('aria-activedescendant', input.id + '-o' + s.at);
  }

  return {
    /** On every keystroke. Ignores the app's own replays (a restored form). */
    typed: function (input, e) {
      if (e && e.isTrusted === false) return;
      clearTimeout(timer);
      if (off) return;
      timer = setTimeout(function () { ask(input); }, 250);
    },
    key: function (input, e) {
      var s = shown[input.id];
      if (!s) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(input, s.at + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(input, s.at - 1); }
      else if (e.key === 'Enter' && s.at >= 0) { e.preventDefault(); SFP.pick(input.id, s.at); }
      else if (e.key === 'Escape') { close(input); }
    },
    blur: function (input) { setTimeout(function () { close(input); }, 120); },
    pick: function (id, i) {
      var input = document.getElementById(id), s = shown[id];
      if (!input || !s || !s.list[i]) return;
      var p = s.list[i];
      input.value = (p.main + (p.rest ? ', ' + p.rest : '')).slice(0, MAX);
      token = null;                 // the next search is a new session
      seq++;
      clearTimeout(timer);
      close(input);
    },
    /** For the health check and tests. */
    on: function () { return !off; }
  };
})();
