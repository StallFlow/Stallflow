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
  // [key, label, width mm, height mm, dots per inch, group]. Each printer's
  // own resolution, so every QR square lands on whole printer dots and stays
  // sharp. Most Niimbot printers (D11, D110, B21, B1) print at 203 dpi.
  var SIZES = [
    ['nb-50x30', 'Niimbot B21 / B1 · 50 × 30 mm', 50, 30, 203, 'Niimbot'],
    ['nb-40x30', 'Niimbot B21 / B1 · 40 × 30 mm', 40, 30, 203, 'Niimbot'],
    ['nb-30x20', 'Niimbot B21 / B1 · 30 × 20 mm', 30, 20, 203, 'Niimbot'],
    ['nb-50x50', 'Niimbot B21 / B1 · 50 × 50 mm', 50, 50, 203, 'Niimbot'],
    ['nb-60x40', 'Niimbot · 60 × 40 mm', 60, 40, 203, 'Niimbot'],
    ['nb-70x50', 'Niimbot · 70 × 50 mm', 70, 50, 203, 'Niimbot'],
    ['nd-40x12', 'Niimbot D11 / D110 · 40 × 12 mm', 40, 12, 203, 'Niimbot'],
    ['nd-30x14', 'Niimbot D11 / D110 · 30 × 14 mm', 30, 14, 203, 'Niimbot'],
    ['nd-40x14', 'Niimbot D11 / D110 · 40 × 14 mm', 40, 14, 203, 'Niimbot'],
    ['50x30', '50 × 30 mm', 50, 30, 300, 'Other printers'],
    ['62x29', '62 × 29 mm (Brother DK)', 62, 29, 300, 'Other printers'],
    ['57x32', '57 × 32 mm (Dymo)', 57, 32, 300, 'Other printers'],
    ['40x30', '40 × 30 mm', 40, 30, 300, 'Other printers'],
    ['50x50', '50 × 50 mm, square', 50, 50, 300, 'Other printers'],
    ['38x90', '38 × 90 mm, tall', 38, 90, 300, 'Other printers']
  ];
  var DPI = 300;
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

  /** The biggest type that fits `text` in a box `width` × `maxH`, whole; shortened only as a last resort. */
  function fitBox(ctx, text, width, maxH, big, small, maxLines, weight) {
    for (var sz = big; sz >= small; sz -= 1) {
      for (var n = 1; n <= maxLines; n++) {
        var f = fit(ctx, text, width, sz, sz, n, weight);
        var whole = f.lines.join(' ') === String(text).replace(/\s+/g, ' ').trim();
        if (whole && f.lines.length * f.size * 1.08 <= maxH) return f;
      }
    }
    var last = fit(ctx, text, width, small, small, 1, weight);
    return last;
  }

  function drawQR(ctx, text, x, y, side, ec) {
    var q = QR.make(text, ec || 'M'), border = 2, n = q.size + border * 2;
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

  /* ---- the stall's own look: an arched name, a logo, contact lines ------- */
  var logoImg = null, logoSrc = '';

  /** Get the stall's logo ready to draw. Resolves once it has loaded (or there is none). */
  function useLogo(src) {
    src = String(src || '');
    if (src === logoSrc) {
      return logoImg && !logoImg.complete
        ? new Promise(function (ok) { logoImg.onload = logoImg.onerror = function () { ok(); }; })
        : Promise.resolve();
    }
    logoSrc = src;
    if (!src) { logoImg = null; return Promise.resolve(); }
    logoImg = new Image();
    return new Promise(function (ok) {
      logoImg.onload = function () { ok(); };
      logoImg.onerror = function () { logoImg = null; ok(); };
      logoImg.src = src;
    });
  }

  /** The shop name curved over the top, like a stamp. Returns where the curve's ends sit. */
  function arc(ctx, text, cx, top, maxW, fs) {
    ctx.font = '700 ' + fs + 'px ' + FONT;
    var tw = ctx.measureText(text).width;
    while (tw > maxW && fs > 8) { fs -= 1; ctx.font = '700 ' + fs + 'px ' + FONT; tw = ctx.measureText(text).width; }
    var R = Math.max(tw / 1.15, maxW * 0.8), cy = top + fs + R, a = -tw / (2 * R);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    Array.prototype.forEach.call(text, function (ch) {
      var w = ctx.measureText(ch).width;
      a += w / (2 * R);
      ctx.save(); ctx.rotate(a); ctx.fillText(ch, 0, -R); ctx.restore();
      a += w / (2 * R);
    });
    ctx.restore();
    return { mid: top + fs, ends: cy - R * Math.cos(tw / (2 * R)) + fs * 0.2, size: fs };
  }

  function drawLogo(x, y, maxW, maxH, ctx, centre) {
    if (!logoImg || !logoImg.complete || !logoImg.naturalWidth) return 0;
    var r = Math.min(maxW / logoImg.naturalWidth, maxH / logoImg.naturalHeight);
    var w = Math.round(logoImg.naturalWidth * r), h = Math.round(logoImg.naturalHeight * r);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(logoImg, centre ? Math.round(x - w / 2) : x, y, w, h);
    return h;
  }

  /**
   * The label in the stall's own style (as on Duxie's jars): name arched over
   * the top, the logo under it, the product, contact lines bottom-left and the
   * QR bottom-right. Price only if the stall asks for it.
   */
  function classic(ctx, W, H, m, p, shop, look, code, price) {
    var contact = String(look.contact || '').split('\n').filter(Boolean).slice(0, 3);
    if (W > H * 1.25) {
      var qr = Math.round(H * 0.5);
      drawQR(ctx, code, W - m - qr, H - m - qr, qr, look.ec);
      var a = arc(ctx, shop, W / 2, m, W * 0.72, Math.round(H * 0.13));
      var y = a.mid + px(0.6);
      y += drawLogo(W / 2, y, W * 0.3, H * (contact.length ? 0.22 : 0.27), ctx, true);
      y = Math.max(y, a.ends) + px(0.6);
      ctx.textAlign = 'left';
      var cs = Math.round(H * 0.075), cTop = H - m - contact.length * cs * 1.12;
      var tx = m + px(1), tw = W - qr - m * 2 - px(2);
      // Whatever goes under the name is measured first; the name gets the room left
      // above the contact lines, so nothing ever runs into anything else.
      var vf = p.variant ? fit(ctx, p.variant, tw, Math.round(H * 0.09), Math.round(H * 0.07), 1, '700') : null;
      var pf = look.price ? fit(ctx, price, tw, Math.round(H * 0.1), Math.round(H * 0.08), 1, '800') : null;
      var below = (vf ? vf.size * 1.08 : 0) + (pf ? pf.size * 1.08 : 0);
      var nf = fitBox(ctx, p.name, tw, cTop - y - below - px(0.3), Math.round(H * 0.15), Math.round(H * 0.07), 2, '800');
      y = lines(ctx, nf, tx, y, '#000');
      if (vf) y = lines(ctx, vf, tx, y, '#000');
      if (pf) lines(ctx, pf, tx, y, '#000');
      contact.forEach(function (l, i) {
        lines(ctx, fit(ctx, l, tw, cs, Math.round(cs * 0.8), 1, '600'), tx, cTop + i * cs * 1.12, '#000');
      });
      return;
    }
    // Square or tall: everything stacked down the middle.
    ctx.textAlign = 'center';
    var cx = W / 2, w2 = W - m * 2;
    var a2 = arc(ctx, shop, cx, m, W * 0.8, Math.round(W * 0.09));
    var y2 = a2.mid + px(0.6);
    y2 += drawLogo(cx, y2, W * 0.35, H * 0.18, ctx, true);
    y2 = Math.max(y2, a2.ends) + px(0.6);
    y2 = lines(ctx, fit(ctx, p.name, w2, Math.round(W * 0.1), Math.round(W * 0.07), 2, '800'), cx, y2, '#000');
    if (p.variant) y2 = lines(ctx, fit(ctx, p.variant, w2, Math.round(W * 0.07), Math.round(W * 0.05), 1, '700'), cx, y2, '#000');
    if (look.price) y2 = lines(ctx, fit(ctx, price, w2, Math.round(W * 0.08), Math.round(W * 0.06), 1, '800'), cx, y2, '#000');
    var cs2 = Math.round(W * 0.05), bottom = H - m - contact.length * cs2 * 1.12;
    contact.forEach(function (l, i) {
      lines(ctx, fit(ctx, l, w2, cs2, Math.round(cs2 * 0.8), 1, '600'), cx, bottom + i * cs2 * 1.12, '#000');
    });
    var q2 = Math.max(px(10), Math.min(w2 * 0.6, bottom - y2 - px(2)));
    drawQR(ctx, code, cx - q2 / 2, y2 + px(1) + (bottom - y2 - px(2) - q2) / 2, q2, look.ec);
  }

  /** One product's label, as a canvas. */
  function canvas(p, key, shop, look) {
    var s = size(key);
    DPI = s[4] || 300;
    // Small labels (the D-series strips) get thin margins so the QR stays big enough to scan.
    var W = px(s[2]), H = px(s[3]), m = px(Math.min(s[2], s[3]) < 20 ? 0.8 : 2);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'top';
    look = look || {};
    var price = money(p.price) + (p.unit && p.unit !== 'each' ? ' / ' + p.unit : '');
    var shopName = String(shop || '').toUpperCase();
    var tiny = H < px(20);
    // The QR is a link to this product on the order page, so any phone camera
    // opens it, and the till's Scan reads it too. A thin strip has no room for a
    // link that scans well, so it carries the short till-only code instead.
    var code = look.base && !tiny ? look.base + '?p=' + encodeURIComponent(p.id) : 'SF:' + p.id;
    look = { style: look.style, contact: look.contact, price: look.price, ec: code.charAt(0) === 'h' ? 'L' : 'M' };

    if (look.style !== 'simple' && !tiny) {
      classic(ctx, W, H, m, p, String(shop || ''), look, code, price);
    } else if (W > H * 1.25) {
      // Landscape: the code on the left, the words on the right.
      var side = H - m * 2;
      drawQR(ctx, code, m, m, side, look.ec);
      var tx = m + side + px(1.5), tw = W - tx - m, y = m + px(0.5);
      // Pure black throughout: thermal printers (Niimbot and friends) turn grey into speckles.
      var tiny = H < px(20);
      if (shopName && !tiny) y = lines(ctx, fit(ctx, shopName, tw, Math.round(H * 0.09), Math.round(H * 0.07), 1, '700'), tx, y, '#000') + px(0.6);
      // On a thin strip the name gets one line (smaller type first, then shortened), so it never meets the price.
      y = lines(ctx, fit(ctx, p.name, tw, Math.round(H * (tiny ? 0.34 : 0.2)), Math.round(H * (tiny ? 0.22 : 0.11)),
                         tiny ? 1 : 2, '800'), tx, y, '#000');
      if (p.variant && !tiny) y = lines(ctx, fit(ctx, p.variant, tw, Math.round(H * 0.12), Math.round(H * 0.08), 1, '600'), tx, y + px(0.4), '#000');
      var pf = fit(ctx, price, tw, Math.round(H * (tiny ? 0.3 : 0.19)), Math.round(H * (tiny ? 0.22 : 0.11)), 1, '800');
      if (tiny) {
        lines(ctx, pf, tx, H - m - pf.size, '#000');
      } else {
        var cf = fit(ctx, p.id, tw, Math.round(H * 0.08), Math.round(H * 0.07), 1, '700');
        lines(ctx, pf, tx, H - m - pf.size - cf.size * 1.2, '#000');
        lines(ctx, cf, tx, H - m - cf.size, '#000');
      }
    } else {
      // Square or tall: words above and below the code, centred.
      ctx.textAlign = 'center';
      var cx = W / 2, w = W - m * 2, y2 = m;
      if (shopName) y2 = lines(ctx, fit(ctx, shopName, w, Math.round(W * 0.06), Math.round(W * 0.05), 1, '700'), cx, y2, '#000') + px(0.5);
      y2 = lines(ctx, fit(ctx, p.name, w, Math.round(W * 0.11), Math.round(W * 0.07), 2, '800'), cx, y2, '#000');
      if (p.variant) y2 = lines(ctx, fit(ctx, p.variant, w, Math.round(W * 0.07), Math.round(W * 0.05), 1, '600'), cx, y2, '#000');
      var pf2 = fit(ctx, price, w, Math.round(W * 0.11), Math.round(W * 0.07), 1, '800');
      var bottom = H - m - pf2.size;
      var q2 = Math.max(px(8), Math.min(w, bottom - y2 - px(2)));
      drawQR(ctx, code, cx - q2 / 2, y2 + px(1) + (bottom - y2 - px(2) - q2) / 2, q2, look.ec);
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
  function withDpi(png, dpi) {
    var ppm = Math.round((dpi || DPI) / 0.0254);
    var body = [0x70, 0x48, 0x59, 0x73].concat(u32(ppm), u32(ppm), [1]);   // "pHYs"
    var chunk = u32(9).concat(body, u32(crc32(body)));
    var at = 8 + 25;                                   // signature + IHDR
    var out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, at), 0);
    out.set(chunk, at);
    out.set(png.subarray(at), at + chunk.length);
    return out;
  }

  function pngBytes(cv, dpi) {
    return new Promise(function (ok, fail) {
      cv.toBlob(function (b) {
        if (!b) { fail(new Error('could not draw the label')); return; }
        b.arrayBuffer().then(function (buf) { ok(withDpi(new Uint8Array(buf), dpi)); }, fail);
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
    return p.id + '-' + slug + '-' + key.replace(/^n[bd]-/, 'niimbot-') + '.png';
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  return {
    sizes: SIZES, size: size, canvas: canvas, fileName: fileName, save: save, zip: zip,
    useLogo: useLogo,
    png: function (p, key, shop, look) {
      return pngBytes(canvas(p, key, shop, look), size(key)[4]).then(function (b) { return new Blob([b], { type: 'image/png' }); });
    },
    pngBytes: function (p, key, shop, look) { return pngBytes(canvas(p, key, shop, look), size(key)[4]); },
    /** True where the phone can hand files straight to another app (a printer's app). */
    canShare: function () {
      try {
        return !!(navigator.canShare && navigator.canShare({
          files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] }));
      } catch (e) { return false; }
    }
  };
})();
