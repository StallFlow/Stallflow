/**
 * StallFlow — QR labels as image files, for a separate label printer
 * (Brother, Dymo, Zebra, Niimbot and the like).
 *
 * Each label is drawn on a canvas at 300 dpi to an exact size in millimetres
 * and saved as a PNG that says it is 300 dpi, so the printer's own app prints
 * it at the right size. Several labels can go out together as one .zip.
 * Nothing here needs signal.
 */
var SFL = (function () {
  var DPI = 300;
  var SIZES = [
    ['50x30', '50 × 30 mm', 50, 30],
    ['62x29', '62 × 29 mm (Brother DK)', 62, 29],
    ['57x32', '57 × 32 mm (Dymo)', 57, 32],
    ['40x30', '40 × 30 mm', 40, 30],
    ['50x50', '50 × 50 mm, square', 50, 50],
    ['38x90', '38 × 90 mm, tall', 38, 90]
  ];
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

  function size(key) {
    for (var i = 0; i < SIZES.length; i++) if (SIZES[i][0] === key) return SIZES[i];
    return SIZES[0];
  }
  function px(mm) { return Math.round(mm / 25.4 * DPI); }

  function money(v) {
    var n = Math.abs(Number(v) || 0), p = n.toFixed(2).split('.');
    return 'R ' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + p[1];
  }

  /** Break text into at most `max` lines that fit `width`, shrinking the type until it does. */
  function fit(ctx, text, width, big, small, max, weight) {
    for (var s = big; s >= small; s -= 2) {
      ctx.font = weight + ' ' + s + 'px ' + FONT;
      var words = String(text).split(/\s+/), lines = [], line = '';
      for (var i = 0; i < words.length; i++) {
        var t = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(t).width <= width) line = t;
        else { if (line) lines.push(line); line = words[i]; }
      }
      if (line) lines.push(line);
      var wide = lines.some(function (l) { return ctx.measureText(l).width > width; });
      if (lines.length <= max && !wide) return { size: s, lines: lines };
    }
    ctx.font = weight + ' ' + small + 'px ' + FONT;
    var all = String(text), cut = all;
    while (cut.length > 1 && ctx.measureText(cut + '…').width > width) cut = cut.slice(0, -1);
    return { size: small, lines: [cut === all ? all : cut + '…'] };
  }

  function drawQR(ctx, text, x, y, side) {
    var q = QR.make(text, 'M'), border = 2, n = q.size + border * 2;
    var cell = Math.floor(side / n), used = cell * n;
    var ox = x + Math.floor((side - used) / 2), oy = y + Math.floor((side - used) / 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, side, side);
    ctx.fillStyle = '#000';
    for (var r = 0; r < q.size; r++) {
      for (var c = 0; c < q.size; c++) {
        if (q.modules[r][c]) ctx.fillRect(ox + (c + border) * cell, oy + (r + border) * cell, cell, cell);
      }
    }
  }

  function lines(ctx, f, x, y, colour) {
    ctx.fillStyle = colour;
    f.lines.forEach(function (l, i) { ctx.fillText(l, x, y + i * f.size * 1.08); });
    return y + f.lines.length * f.size * 1.08;
  }

  /** One product's label, as a canvas. */
  function canvas(p, key, shop) {
    var s = size(key), W = px(s[2]), H = px(s[3]), m = px(2);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    var code = 'SF:' + p.id, price = money(p.price) + (p.unit && p.unit !== 'each' ? ' / ' + p.unit : '');
    var shopName = String(shop || '').toUpperCase();

    if (W > H * 1.25) {
      // Landscape: the code on the left, the words on the right.
      var side = H - m * 2;
      drawQR(ctx, code, m, m, side);
      var tx = m + side + px(1.5), tw = W - tx - m, y = m + px(0.5);
      if (shopName) y = lines(ctx, fit(ctx, shopName, tw, Math.round(H * 0.09), Math.round(H * 0.07), 1, '700'), tx, y, '#555') + px(0.6);
      y = lines(ctx, fit(ctx, p.name, tw, Math.round(H * 0.2), Math.round(H * 0.11), 2, '800'), tx, y, '#000');
      if (p.variant) y = lines(ctx, fit(ctx, p.variant, tw, Math.round(H * 0.12), Math.round(H * 0.08), 1, '600'), tx, y + px(0.4), '#333');
      var pf = fit(ctx, price, tw, Math.round(H * 0.19), Math.round(H * 0.11), 1, '800');
      var cf = fit(ctx, p.id, tw, Math.round(H * 0.08), Math.round(H * 0.07), 1, '700');
      lines(ctx, pf, tx, H - m - pf.size - cf.size * 1.2, '#000');
      lines(ctx, cf, tx, H - m - cf.size, '#666');
    } else {
      // Square or tall: words above and below the code, centred.
      ctx.textAlign = 'center';
      var cx = W / 2, w = W - m * 2, y2 = m;
      if (shopName) y2 = lines(ctx, fit(ctx, shopName, w, Math.round(W * 0.06), Math.round(W * 0.05), 1, '700'), cx, y2, '#555') + px(0.5);
      y2 = lines(ctx, fit(ctx, p.name, w, Math.round(W * 0.11), Math.round(W * 0.07), 2, '800'), cx, y2, '#000');
      if (p.variant) y2 = lines(ctx, fit(ctx, p.variant, w, Math.round(W * 0.07), Math.round(W * 0.05), 1, '600'), cx, y2, '#333');
      var pf2 = fit(ctx, price, w, Math.round(W * 0.11), Math.round(W * 0.07), 1, '800');
      var bottom = H - m - pf2.size;
      var q2 = Math.max(px(8), Math.min(w, bottom - y2 - px(2)));
      drawQR(ctx, code, cx - q2 / 2, y2 + px(1) + (bottom - y2 - px(2) - q2) / 2, q2);
      lines(ctx, pf2, cx, bottom, '#000');
    }
    return cv;
  }

  /* ---- bytes: CRC-32, a 300 dpi PNG, a stored .zip ---------------------- */
  var TABLE = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF;
    for (var i = start || 0, e = end == null ? bytes.length : end; i < e; i++) {
      c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function u32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

  /** Add a pHYs chunk (pixels per metre) after IHDR, so apps know the print size. */
  function withDpi(png) {
    var ppm = Math.round(DPI / 0.0254);
    var body = [0x70, 0x48, 0x59, 0x73].concat(u32(ppm), u32(ppm), [1]);   // "pHYs"
    var chunk = u32(9).concat(body, u32(crc32(body)));
    var at = 8 + 25;                                   // signature + IHDR
    var out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, at), 0);
    out.set(chunk, at);
    out.set(png.subarray(at), at + chunk.length);
    return out;
  }

  function pngBytes(cv) {
    return new Promise(function (ok, fail) {
      cv.toBlob(function (b) {
        if (!b) { fail(new Error('could not draw the label')); return; }
        b.arrayBuffer().then(function (buf) { ok(withDpi(new Uint8Array(buf))); }, fail);
      }, 'image/png');
    });
  }

  function zip(files) {
    var enc = new TextEncoder(), parts = [], dir = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.bytes, crc = crc32(data);
      var head = new Uint8Array(30 + name.length), v = new DataView(head.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
      v.setUint16(8, 0, true); v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true);
      head.set(name, 30);
      var cd = new Uint8Array(46 + name.length), w = new DataView(cd.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true);
      w.setUint16(8, 0x0800, true); w.setUint32(16, crc, true);
      w.setUint32(20, data.length, true); w.setUint32(24, data.length, true);
      w.setUint16(28, name.length, true); w.setUint32(42, offset, true);
      cd.set(name, 46);
      parts.push(head, data); dir.push(cd);
      offset += head.length + data.length;
    });
    var dirLen = dir.reduce(function (a, d) { return a + d.length; }, 0);
    var end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, dirLen, true); e.setUint32(16, offset, true);
    return new Blob(parts.concat(dir, [end]), { type: 'application/zip' });
  }

  function fileName(p, key) {
    var slug = String(p.name + (p.variant ? ' ' + p.variant : '')).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return p.id + '-' + slug + '-' + key + '.png';
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  return {
    sizes: SIZES, size: size, canvas: canvas, fileName: fileName, save: save, zip: zip,
    png: function (p, key, shop) {
      return pngBytes(canvas(p, key, shop)).then(function (b) { return new Blob([b], { type: 'image/png' }); });
    },
    pngBytes: function (p, key, shop) { return pngBytes(canvas(p, key, shop)); },
    /** True where the phone can hand files straight to another app (a printer's app). */
    canShare: function () {
      try {
        return !!(navigator.canShare && navigator.canShare({
          files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] }));
      } catch (e) { return false; }
    }
  };
})();
