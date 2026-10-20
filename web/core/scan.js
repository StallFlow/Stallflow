/**
 * StallFlow — scanning a label.
 *
 * Uses the browser's own BarcodeDetector where it exists, which on a market
 * stall means Android Chrome. Everywhere else the tiles still work, so the
 * till is never blocked waiting for a camera.
 */
(function () {
  'use strict';

  var stream = null, running = false;

  function overlay() {
    var box = SF.el('scan');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'scan';
    box.innerHTML =
      '<video id="sfcam" playsinline muted></video><div class="box"></div>' +
      '<button class="x ghost sm" onclick="SF.stopScan()">Close</button>' +
      '<div class="hint">Point at the label</div>';
    document.body.appendChild(box);
    return box;
  }

  SF.scan = function () {
    if (!('BarcodeDetector' in window)) {
      SF.toast('This phone cannot scan — tap the product instead.', true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) {
        stream = s;
        var box = overlay(), video = SF.el('sfcam');
        video.srcObject = s;
        video.play();
        box.style.display = 'block';
        running = true;
        var detector = new BarcodeDetector({ formats: ['qr_code'] });
        (function tick() {
          if (!running) return;
          detector.detect(video).then(function (codes) {
            if (codes && codes.length) hit(codes[0].rawValue);
          }).catch(function () {});
          setTimeout(tick, 320);
        })();
      })
      .catch(function () { SF.toast('No camera access — tap the product instead.', true); });
  };

  SF.stopScan = function () {
    running = false;
    var box = SF.el('scan');
    if (box) box.style.display = 'none';
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  };

  function hit(value) {
    var m = String(value || '').match(/^SF:([A-Za-z0-9_-]+)$/);
    if (!m) return;
    var till = SF.state.data.till;
    if (!till) return;
    var product = SF.find(till.products, m[1]);
    if (!product) return;
    SF.stopScan();
    // A scanned weighed product still needs its weight, so route it the same
    // way a tap does rather than guessing one of anything.
    window.SFT.tap(product.id);
    SF.toast(product.weighed ? 'Weigh the ' + product.name : 'Added');
  }
})();
