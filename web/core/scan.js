/**
 * StallFlow — scanning a label at the till.
 *
 * Two readers, one behaviour:
 *  - the phone's own BarcodeDetector where it reads QR codes (Android Chrome);
 *  - otherwise jsQR (web/core/vendor/jsQR.js, Apache-2.0), which reads the
 *    camera picture itself. That is what makes iPhones work: no browser on an
 *    iPhone has BarcodeDetector. It is fetched the first time it is needed and
 *    kept offline with the rest of the app.
 * Either way the tiles still work, so the till is never stuck on the camera.
 */
(function () {
  'use strict';

  var stream = null, running = false, warned = false;

  function overlay() {
    var box = SF.el('scan');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'scan';
    box.innerHTML =
      '<video id="sfcam" playsinline muted autoplay></video><div class="box"></div>' +
      '<button class="x ghost sm" onclick="SF.stopScan()">Close</button>' +
      '<div class="hint" id="scanhint">Point at the label</div>';
    document.body.appendChild(box);
    return box;
  }

  /** The phone's own reader, if it can read QR codes. Resolves to a reader or null. */
  function nativeReader() {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    var check = window.BarcodeDetector.getSupportedFormats
      ? window.BarcodeDetector.getSupportedFormats() : Promise.resolve(['qr_code']);
    return check.then(function (formats) {
      if (formats.indexOf('qr_code') === -1) return null;
      var detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      return function (video) {
        return detector.detect(video).then(function (codes) {
          return codes && codes.length ? codes[0].rawValue : null;
        });
      };
    }).catch(function () { return null; });
  }

  var jsqrLoading = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (jsqrLoading) return jsqrLoading;
    jsqrLoading = new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = '../core/vendor/jsQR.js';
      s.onload = function () { window.jsQR ? ok(window.jsQR) : fail(new Error('jsQR missing')); };
      s.onerror = function () { jsqrLoading = null; fail(new Error('jsQR did not load')); };
      document.head.appendChild(s);
    });
    return jsqrLoading;
  }

  /** jsQR reads a frame drawn onto a small canvas — small is quick and plenty sharp. */
  function jsqrReader(jsQR) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    return function (video) {
      var w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return Promise.resolve(null);
      var scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      return Promise.resolve(code ? code.data : null);
    };
  }

  function reader() {
    return nativeReader().then(function (r) { return r || loadJsQR().then(jsqrReader); });
  }

  SF.scan = function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      SF.toast('This browser cannot use the camera. Tap the product instead.', true);
      return;
    }
    warned = false;
    // Ask for the camera straight from the tap (iPhones want that), and get
    // the reader ready at the same time.
    var cam = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    var ready = reader();
    cam.then(function (s) {
      stream = s;
      var box = overlay(), video = SF.el('sfcam');
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.srcObject = s;
      box.style.display = 'block';
      running = true;
      var played = video.play();
      if (played && played.catch) played.catch(function () {});
      return ready.then(function (read) {
        (function tick() {
          if (!running) return;
          read(video).then(function (value) {
            if (value) hit(value);
          }).catch(function () {}).then(function () {
            if (running) setTimeout(tick, 180);
          });
        })();
      }, function () {
        SF.stopScan();
        SF.toast('The scanner did not load. Tap the product instead.', true);
      });
    }).catch(function (e) {
      var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      SF.toast(denied
        ? 'Camera not allowed. On an iPhone: Settings › Safari › Camera › Allow. Tap the product for now.'
        : 'No camera found. Tap the product instead.', true);
    });
  };

  SF.stopScan = function () {
    running = false;
    var box = SF.el('scan');
    if (box) box.style.display = 'none';
    var video = SF.el('sfcam');
    if (video) video.srcObject = null;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  };

  function hit(value) {
    var m = String(value || '').match(/^SF:([A-Za-z0-9_-]+)$/);
    if (!m) {
      // A QR code, but not one of ours (the order poster, a payment code…).
      if (!warned) {
        warned = true;
        var h = SF.el('scanhint');
        if (h) h.textContent = 'That is not a product label. Point at the label on the jar.';
      }
      return;
    }
    var till = SF.state.data.till;
    if (!till) return;
    var product = SF.find(till.products, m[1]);
    if (!product) {
      var hint = SF.el('scanhint');
      if (hint) hint.textContent = 'That label is for a product that is not on sale here.';
      return;
    }
    SF.stopScan();
    // A scanned weighed product still needs its weight, so route it the same
    // way a tap does rather than guessing one of anything.
    window.SFT.tap(product.id);
    if (product.weighed) SF.toast('Weigh the ' + product.name);
  }
})();
