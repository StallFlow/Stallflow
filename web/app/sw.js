/**
 * StallFlow — service worker.
 *
 * One job: make sure the app itself opens with no signal at all. It caches the
 * shell and serves it from cache first, so the till starts in a field the same
 * way it starts at home.
 *
 * It deliberately does NOT cache API responses. Trading data goes stale in
 * minutes, and a stale cache that looks live is worse than no cache — the app
 * keeps its own copy stamped with the time it arrived, so a screen can say how
 * old its numbers are instead of pretending.
 *
 * Every stall is served from the same origin, and caches are shared across an
 * origin. So each stall's cache is named after its own scope, and activate only
 * clears that stall's old caches; it never touches another stall's, or the
 * older apps that live beside this one on stallflow.github.io.
 *
 * __BUILD__ is replaced with the commit at deploy time, so every deploy gets a
 * fresh cache and phones pick up the change without anyone bumping a number.
 */
var PREFIX = 'stallflow:' + self.registration.scope + ':';
var CACHE = PREFIX + '__BUILD__';

var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  '../config.js',
  '../core/ui.css',
  '../core/components.css',
  '../core/qr.js',
  '../core/sf.js',
  '../core/screens.js',
  '../core/admin.js',
  '../core/scan.js',
  '../plugins/kitchen.js',
  '../plugins/scale.js',
  '../plugins/cashup.js'
];

/** The app's own files: the /app/ folder, plus /core/ and /plugins/ beside it. */
function isShell(url) {
  var base = new URL('./', self.location).pathname;          // …/app/
  var root = new URL('../', self.location).pathname;         // …/
  if (url.pathname.indexOf(base) === 0) return true;
  return url.pathname === root + 'config.js' ||
         url.pathname.indexOf(root + 'core/') === 0 ||
         url.pathname.indexOf(root + 'plugins/') === 0;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if one file 404s. Cache what we can and
      // let the rest fall through to the network, rather than shipping a
      // service worker that never activates.
      .then(function (c) {
        return Promise.all(SHELL.map(function (url) {
          // cache:'reload' forces a trip to the network. Without it the fetch
          // can be answered from the browser's ordinary HTTP cache, and a new
          // cache version quietly fills up with the OLD files — which is how
          // an update appears to install and change nothing.
          return c.add(new Request(url, { cache: 'reload' })).catch(function () {
            console.warn('[sw] could not cache', url);
          });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf(PREFIX) !== 0 || k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (windows) {
        // A page that is already open is still running the previous version's
        // scripts. Tell it a newer one is installed so it can pick a safe
        // moment to swap — the app decides, because mid-sale is not one.
        windows.forEach(function (w) { w.postMessage({ type: 'sf-updated' }); });
      })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // Anything not ours — the Apps Script API above all — goes straight to the
  // network. The app handles its own offline behaviour.
  if (url.origin !== self.location.origin) return;

  // Only the app's own files are ever cached. Never guess: a same-origin URL
  // that is not a shell asset may well be an API call, and serving a stale
  // answer to one of those is far worse than not caching it at all.
  if (!isShell(url)) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        // Refresh in the background so the next open has the newer file.
        fetch(req).then(function (fresh) {
          if (fresh && fresh.ok) caches.open(CACHE).then(function (c) { c.put(req, fresh); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (fresh) {
        if (fresh && fresh.ok && isShell(url)) {
          var copy = fresh.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return fresh;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline and not cached');
      });
    })
  );
});
