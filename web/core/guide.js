/**
 * StallFlow — More › How-to videos.
 *
 * Short captioned videos of the app in use (web/guide/, made by
 * tools/guide/). Open to everyone signed in, whatever their role. Videos are
 * not kept for offline use: each is fetched when it is played, so they never
 * fill the phone or slow down the app's updates.
 */
(function () {
  'use strict';

  var CHAPTERS = [
    ['01-till', 'Selling at the till', 'Tap products, change amounts, take cash and give change.'],
    ['02-scan', 'Scanning a jar', 'Scan the QR code on a jar to put it on the bill.'],
    ['03-preorder', 'Pre-orders and WhatsApp', 'How customers order ahead, and how you take their payment.'],
    ['04-stock', 'Stock', 'What is on the shelf, searching, and scanning a jar to see how many are left.'],
    ['05-labels', 'Printing QR labels', 'Making labels for the Niimbot.'],
    ['06-stocktake', 'Stocktake', 'Counting everything, spot by spot, and approving the count.'],
    ['07-markets', 'Markets and numbers', 'Takings and profit per market, and adding a new market.']
  ];

  SF.screen({
    id: 'guide', title: 'How-to videos', cap: null,
    render: function () {
      return '<div class="wrap"><div class="card"><h2>How-to videos</h2>' +
        '<div class="sub">Short videos of the app in use, with captions, so they work with the ' +
          'sound off. Each is under a minute. They need signal to play.</div></div>' +
        CHAPTERS.map(function (c, i) {
          return '<div class="card guidevid">' +
            '<h3>' + (i + 1) + ' · ' + SF.esc(c[1]) + '</h3>' +
            '<div class="sub">' + SF.esc(c[2]) + '</div>' +
            '<video controls playsinline preload="none" poster="../guide/' + c[0] + '.jpg" ' +
              'src="../guide/' + c[0] + '.mp4" aria-label="' + SF.esc(c[1]) + '"></video>' +
          '</div>';
        }).join('') +
        '<div class="foot">StallFlow · how-to</div></div>';
    }
  });

  /** Only one video plays at a time. */
  document.addEventListener('play', function (e) {
    if (!e.target || e.target.tagName !== 'VIDEO') return;
    Array.prototype.forEach.call(document.querySelectorAll('.guidevid video'), function (v) {
      if (v !== e.target && !v.paused) v.pause();
    });
  }, true);
})();
