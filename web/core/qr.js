/**
 * QR encoder — byte mode, versions 1-10, EC levels L/M/Q/H.
 *
 * Verified module-for-module against the segno reference library across
 * 8 payloads x 8 masks (versions 1, 2, 3, 5 and 8; all four EC levels).
 * Mask selection is a readability heuristic only — any mask scans.
 */
var QR = (function () {
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] by [version][L,M,Q,H]
  var ECB = {
    1:  [[7,1,19,0,0],[10,1,16,0,0],[13,1,13,0,0],[17,1,9,0,0]],
    2:  [[10,1,34,0,0],[16,1,28,0,0],[22,1,22,0,0],[28,1,16,0,0]],
    3:  [[15,1,55,0,0],[26,1,44,0,0],[18,2,17,0,0],[22,2,13,0,0]],
    4:  [[20,1,80,0,0],[18,2,32,0,0],[26,2,24,0,0],[16,4,9,0,0]],
    5:  [[26,1,108,0,0],[24,2,43,0,0],[18,2,15,2,16],[22,2,11,2,12]],
    6:  [[18,2,68,0,0],[16,4,27,0,0],[24,4,19,0,0],[28,4,15,0,0]],
    7:  [[20,2,78,0,0],[18,4,31,0,0],[18,2,14,4,15],[26,4,13,1,14]],
    8:  [[24,2,97,0,0],[22,2,38,2,39],[22,4,18,2,19],[26,4,14,2,15]],
    9:  [[30,2,116,0,0],[22,3,36,2,37],[20,4,16,4,17],[24,4,12,4,13]],
    10: [[18,2,68,2,69],[26,4,43,1,44],[24,6,19,2,20],[28,6,15,2,16]]
  };
  var ALIGN = {
    1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30],
    6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50]
  };
  var ECBITS = { L: 1, M: 0, Q: 3, H: 2 };
  var ECIDX  = { L: 0, M: 1, Q: 2, H: 3 };

  function genPoly(n) {
    var p = [1];
    for (var i = 0; i < n; i++) {
      var q = [], k;
      for (k = 0; k <= p.length; k++) q.push(0);
      for (var j = 0; j < p.length; j++) { q[j] ^= p[j]; q[j + 1] ^= mul(p[j], EXP[i]); }
      p = q;
    }
    return p;
  }
  function remainder(data, n) {
    var gen = genPoly(n), res = data.slice(), i, j;
    for (i = 0; i < n; i++) res.push(0);
    for (i = 0; i < data.length; i++) {
      var c = res[i];
      if (c !== 0) for (j = 1; j < gen.length; j++) res[i + j] ^= mul(gen[j], c);
    }
    return res.slice(data.length);
  }
  function utf8(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        i++;
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }
  function dataCapacity(v, ec) { var b = ECB[v][ECIDX[ec]]; return b[1] * b[2] + b[3] * b[4]; }
  function pickVersion(len, ec) {
    for (var v = 1; v <= 10; v++) {
      if (len * 8 + 4 + (v <= 9 ? 8 : 16) <= dataCapacity(v, ec) * 8) return v;
    }
    throw new Error('Too much data for this QR encoder (max version 10).');
  }

  function buildCodewords(bytes, version, ec) {
    var bits = [], i, j;
    function push(val, len) { for (var k = len - 1; k >= 0; k--) bits.push((val >> k) & 1); }
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capBits = dataCapacity(version, ec) * 8;
    var term = Math.min(4, capBits - bits.length);
    for (i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (data.length < dataCapacity(version, ec)) { data.push(pad[p]); p ^= 1; }

    var spec = ECB[version][ECIDX[ec]], ecLen = spec[0];
    var blocks = [], ecBlocks = [], pos = 0, n;
    for (n = 0; n < spec[1]; n++) { blocks.push(data.slice(pos, pos + spec[2])); pos += spec[2]; }
    for (n = 0; n < spec[3]; n++) { blocks.push(data.slice(pos, pos + spec[4])); pos += spec[4]; }
    for (n = 0; n < blocks.length; n++) ecBlocks.push(remainder(blocks[n], ecLen));

    var out = [], maxData = Math.max(spec[2], spec[4]);
    for (i = 0; i < maxData; i++)
      for (n = 0; n < blocks.length; n++) if (i < blocks[n].length) out.push(blocks[n][i]);
    for (i = 0; i < ecLen; i++)
      for (n = 0; n < ecBlocks.length; n++) out.push(ecBlocks[n][i]);
    return out;
  }

  function newMatrix(size) {
    var m = [], i, j;
    for (i = 0; i < size; i++) { m.push([]); for (j = 0; j < size; j++) m[i].push(null); }
    return m;
  }
  function placeFinder(m, r, c) {
    for (var i = -1; i <= 7; i++) for (var j = -1; j <= 7; j++) {
      var rr = r + i, cc = c + j;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      var on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
               (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
               (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  }
  function placeAlignment(m, version) {
    var pos = ALIGN[version], size = m.length;
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var r = pos[a], c = pos[b];
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++)
        m[r + i][c + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
    }
  }
  function placeTiming(m) {
    var size = m.length;
    for (var i = 8; i < size - 8; i++) {
      var v = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }
  }
  function reserveFormat(m) {
    var size = m.length, i;
    for (i = 0; i <= 8; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;
  }
  function versionBits(version) {
    var rem = version << 12;
    for (var i = 0; i < 12; i++) {
      var top = 0, t = rem;
      while (t) { top++; t >>= 1; }
      if (top >= 13) rem ^= 0x1F25 << (top - 13); else break;
    }
    return (version << 12) | rem;
  }
  function placeVersion(m, version) {
    if (version < 7) return;
    var bits = versionBits(version), size = m.length;
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1, r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }
  function formatBits(ec, mask) {
    var d = (ECBITS[ec] << 3) | mask, rem = d << 10;
    for (var i = 0; i < 10; i++) {
      var top = 0, t = rem;
      while (t) { top++; t >>= 1; }
      if (top >= 11) rem ^= 0x537 << (top - 11); else break;
    }
    return (((d << 10) | rem) ^ 0x5412);
  }
  function placeFormat(m, ec, mask) {
    var bits = formatBits(ec, mask), size = m.length, i;
    function bit(n) { return (bits >> (14 - n)) & 1; }
    for (i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6);
    m[8][8] = bit(7);
    m[7][8] = bit(8);
    for (i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
    for (i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
    for (i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);
    m[size - 8][8] = 1;
  }
  function maskFn(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }
  function penalty(m) {
    var size = m.length, score = 0, i, j, k;
    for (i = 0; i < size; i++) {
      var runR = 1, runC = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) runR++; else { if (runR >= 5) score += runR - 2; runR = 1; }
        if (m[j][i] === m[j - 1][i]) runC++; else { if (runC >= 5) score += runC - 2; runC = 1; }
      }
      if (runR >= 5) score += runR - 2;
      if (runC >= 5) score += runC - 2;
    }
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
    var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    for (i = 0; i < size; i++) for (j = 0; j + 11 <= size; j++) {
      var r1 = true, r2 = true, c1 = true, c2 = true;
      for (k = 0; k < 11; k++) {
        if (m[i][j + k] !== pat1[k]) r1 = false;
        if (m[i][j + k] !== pat2[k]) r2 = false;
        if (m[j + k][i] !== pat1[k]) c1 = false;
        if (m[j + k][i] !== pat2[k]) c2 = false;
      }
      if (r1) score += 40; if (r2) score += 40; if (c1) score += 40; if (c2) score += 40;
    }
    var dark = 0;
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return score;
  }

  function make(text, ec) {
    ec = ec || 'M';
    var bytes = utf8(String(text));
    var version = pickVersion(bytes.length, ec);
    var cw = buildCodewords(bytes, version, ec);
    var size = version * 4 + 17, i, j;

    var base = newMatrix(size);
    placeFinder(base, 0, 0);
    placeFinder(base, 0, size - 7);
    placeFinder(base, size - 7, 0);
    placeAlignment(base, version);
    placeTiming(base);
    placeVersion(base, version);
    reserveFormat(base);

    var reserved = [];
    for (i = 0; i < size; i++) { reserved.push([]); for (j = 0; j < size; j++) reserved[i].push(base[i][j] !== null); }

    var bitIdx = 0, total = cw.length * 8;
    function nextBit() {
      if (bitIdx >= total) return 0;
      var b = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
      bitIdx++;
      return b;
    }
    var dm = newMatrix(size), up = true, col = size - 1;
    while (col > 0) {
      if (col === 6) col--;
      for (var n = 0; n < size; n++) {
        var row = up ? size - 1 - n : n;
        for (var s = 0; s < 2; s++) {
          var c = col - s;
          if (!reserved[row][c]) dm[row][c] = nextBit();
        }
      }
      up = !up;
      col -= 2;
    }

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = newMatrix(size);
      for (i = 0; i < size; i++) for (j = 0; j < size; j++)
        m[i][j] = reserved[i][j] ? base[i][j] : (dm[i][j] ^ (maskFn(mask, i, j) ? 1 : 0));
      placeFormat(m, ec, mask);
      var sc = penalty(m);
      if (sc < bestScore) { bestScore = sc; best = m; }
    }
    return { size: size, version: version, modules: best };
  }

  /** Returns a standalone <svg> string. Scales to whatever box you put it in. */
  function svg(text, opts) {
    opts = opts || {};
    var q = make(text, opts.ec || 'M');
    var border = opts.border == null ? 4 : opts.border;
    var dim = q.size + border * 2;
    var path = '', r, c;
    for (r = 0; r < q.size; r++) {
      c = 0;
      while (c < q.size) {
        if (q.modules[r][c]) {
          var start = c;
          while (c < q.size && q.modules[r][c]) c++;
          path += 'M' + (start + border) + ' ' + (r + border) + 'h' + (c - start) + 'v1h-' + (c - start) + 'z';
        } else c++;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" style="width:100%;height:auto;display:block">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + path + '" fill="' + (opts.dark || '#000000') + '"/></svg>';
  }

  return { make: make, svg: svg };
})();
