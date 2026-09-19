/*
 * veclib.js — vector math + SVG path data utilities
 * Works in browser (window.VLib) and Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VLib = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- matrices [a b c d e f] ---------------- */
  var ID = [1, 0, 0, 1, 0, 0];
  function id() { return ID.slice(); }
  // compose(A, B): apply B first, then A  (matrix product A·B, row-vector convention)
  function compose(A, B) {
    return [
      A[0]*B[0] + A[2]*B[1],
      A[1]*B[0] + A[3]*B[1],
      A[0]*B[2] + A[2]*B[3],
      A[1]*B[2] + A[3]*B[3],
      A[0]*B[4] + A[2]*B[5] + A[4],
      A[1]*B[4] + A[3]*B[5] + A[5]
    ];
  }
  function applyM(m, x, y) { return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]; }
  function isIdentity(m) {
    return Math.abs(m[0]-1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 &&
           Math.abs(m[3]-1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;
  }
  function parseTransform(s) {
    if (!s || !s.trim()) return id();
    var m = id(), mm, re = /([a-zA-Z]+)\s*[\[\(]([^\]\)]*)[\]\)]/g;
    while ((mm = re.exec(s))) {
      var t = mm[1];
      var nums = mm[2].split(/[\s,]+/).filter(function (x) { return x !== ''; }).map(Number);
      if (t === 'matrix' && nums.length === 6) m = compose(m, nums);
      else if (t === 'translate') m = compose(m, [1, 0, 0, 1, nums[0] || 0, nums[1] || 0]);
      else if (t === 'scale') {
        var sx = nums[0] || 0, sy = nums.length > 1 ? nums[1] : sx;
        m = compose(m, [sx, 0, 0, sy, 0, 0]);
      } else if (t === 'rotate') {
        var a = (nums[0] || 0) * Math.PI / 180, cx = nums[1] || 0, cy = nums[2] || 0;
        var c = Math.cos(a), sn = Math.sin(a);
        m = compose(m, [1, 0, 0, 1, cx, cy]);
        m = compose(m, [c, sn, -sn, c, 0, 0]);
        m = compose(m, [1, 0, 0, 1, -cx, -cy]);
      } else if (t === 'skewX') m = compose(m, [1, 0, Math.tan((nums[0] || 0) * Math.PI / 180), 1, 0, 0]);
      else if (t === 'skewY') m = compose(m, [1, Math.tan((nums[0] || 0) * Math.PI / 180), 0, 1, 0, 0]);
    }
    return m;
  }

  /* ---------------- numbers ---------------- */
  function fmt(n, dp) {
    if (dp === undefined) dp = 4;
    if (!isFinite(n)) return '0';
    if (Math.abs(n) < 0.5 * Math.pow(10, -dp)) n = 0;
    var s = n.toFixed(dp);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '' || s === '-') s = '0';
    if (s === '-0') s = '0';
    return s;
  }

  /* ---------------- path data parsing ----------------
   * Returns { segs: [{c:'M'|'L'|'C'|'Q'|'A'|'Z', pts:[...]}], err:bool }
   * All segments absolute. S/T resolved to C/Q.
   */
  function parsePathD(d) {
    var segs = [], err = false;
    if (typeof d !== 'string') return { segs: segs, err: true };
    var re = /([MLCQTAZSmlcqtazs])([^MLCQTAZSmlcqtazs]*)/g;
    var m, cur = [0, 0], startPt = [0, 0];
    while ((m = re.exec(d))) {
      var cmd = m[1];
      var upper = cmd.toUpperCase();
      var isRel = cmd !== upper;
      var body = m[2];
      if (upper === 'Z') {
        segs.push({ c: 'Z', pts: [] });
        cur = startPt.slice();
        continue;
      }
      var nums = body.split(/[\s,]+/).filter(function (x) { return x !== ''; }).map(Number);
      if (nums.some(function (n) { return !isFinite(n); })) { err = true; continue; }
      var sz = { M: 2, L: 2, C: 6, Q: 4, A: 7, S: 4, T: 2 }[upper];
      var i = 0;
      var curUpper = upper;
      while (i + sz <= nums.length) {
        var p = nums.slice(i, i + sz);
        i += sz;
        if (isRel) {
          if (curUpper === 'M' || curUpper === 'L' || curUpper === 'T') {
            p[0] += cur[0]; p[1] += cur[1];
          } else if (curUpper === 'C' || curUpper === 'Q') {
            p[0] += cur[0]; p[1] += cur[1]; p[2] += cur[0]; p[3] += cur[1]; p[4] += cur[0]; p[5] += cur[1];
          } else if (curUpper === 'S') {
            p[0] += cur[0]; p[1] += cur[1]; p[2] += cur[0]; p[3] += cur[1];
          } else if (curUpper === 'A') {
            p[5] += cur[0]; p[6] += cur[1];
          }
        }
        if (curUpper === 'M') {
          segs.push({ c: 'M', pts: [p[0], p[1]] });
          cur = [p[0], p[1]];
          startPt = cur.slice();
          curUpper = 'L'; // implicit lineto
          sz = 2;
        } else if (curUpper === 'S') {
          var prev = segs.length ? segs[segs.length - 1] : null;
          var c1 = [p[0], p[1]];
          if (prev && prev.c === 'C') c1 = [2 * cur[0] - prev.pts[2], 2 * cur[1] - prev.pts[3]];
          else if (prev && prev.c === 'Q') c1 = [2 * cur[0] - prev.pts[0], 2 * cur[1] - prev.pts[1]];
          segs.push({ c: 'C', pts: [c1[0], c1[1], p[2], p[3], p[4], p[5]] });
          cur = [p[4], p[5]];
        } else if (curUpper === 'T') {
          var prev2 = segs.length ? segs[segs.length - 1] : null;
          var qc = [p[0], p[1]];
          if (prev2 && prev2.c === 'Q') qc = [2 * cur[0] - prev2.pts[0], 2 * cur[1] - prev2.pts[1]];
          else if (prev2 && prev2.c === 'C') qc = [2 * cur[0] - prev2.pts[4], 2 * cur[1] - prev2.pts[5]];
          segs.push({ c: 'Q', pts: [qc[0], qc[1], p[2], p[3]] });
          cur = [p[2], p[3]];
        } else {
          segs.push({ c: curUpper, pts: p });
          cur = [p[p.length - 2], p[p.length - 1]];
        }
      }
      if (i < nums.length) err = true;
    }
    return { segs: segs, err: err };
  }

  /* ---------------- arc -> cubic beziers ---------------- */
  function arcToCubics(x1, y1, rx, ry, phiDeg, fA, fS, x2, y2) {
    var out = [];
    if (rx === 0 || ry === 0) { out.push([x1, y1, x2, y2, x2, y2]); return out; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    var phi = (phiDeg * Math.PI) / 180;
    var cosP = Math.cos(phi), sinP = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p = cosP * dx + sinP * dy;
    var y1p = -sinP * dx + cosP * dy;
    var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) {
      var sc = Math.sqrt(lam);
      rx *= sc; ry *= sc;
      x1p = cosP * dx + sinP * dy;
      y1p = -sinP * dx + cosP * dy;
    }
    var rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p;
    var den = rx2 * y1p2 + ry2 * x1p2;
    var co = den < 1e-12 ? 0 : Math.sqrt(Math.max(0, (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / den));
    if (fA === fS) co = -co;
    var cxp = co * rx * y1p / ry;
    var cyp = -co * ry * x1p / rx;
    var cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    var cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
    var u1 = (x1p - cxp) / rx, v1 = (y1p - cyp) / ry;
    var u2 = (-x1p - cxp) / rx, v2 = (-y1p - cyp) / ry;
    var theta1 = Math.atan2(v1, u1);
    var dth = Math.atan2(u1 * v2 - v1 * u2, u1 * u2 + v1 * v2);
    if (!fS && dth > 0) dth -= 2 * Math.PI;
    if (fS && dth < 0) dth += 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
    var k = (4 / 3) * Math.tan(dth / (4 * n));
    for (var i = 0; i < n; i++) {
      var t0 = theta1 + i * dth / n;
      var t1 = theta1 + (i + 1) * dth / n;
      var c0 = Math.cos(t0), s0 = Math.sin(t0);
      var c1b = Math.cos(t1), s1b = Math.sin(t1);
      var p0x = cx + rx * c0 * cosP - ry * s0 * sinP;
      var p0y = cy + rx * c0 * sinP + ry * s0 * cosP;
      var p1x = cx + rx * c1b * cosP - ry * s1b * sinP;
      var p1y = cy + rx * c1b * sinP + ry * s1b * cosP;
      var d0x = -rx * s0 * cosP - ry * c0 * sinP;
      var d0y = -rx * s0 * sinP + ry * c0 * cosP;
      var d1x = -rx * s1b * cosP - ry * c1b * sinP;
      var d1y = -rx * s1b * sinP + ry * c1b * cosP;
      out.push([p0x + k * d0x, p0y + k * d0y, p1x - k * d1x, p1y - k * d1y, p1x, p1y]);
    }
    return out;
  }

  /* ---------------- normalize: only M/L/C/Z, absolute ---------------- */
  function normalizeSegs(segs) {
    var out = [];
    var cur = [0, 0], startPt = [0, 0];
    function qToC(p0, c, p1) {
      return [
        p0[0] + (2 / 3) * (c[0] - p0[0]), p0[1] + (2 / 3) * (c[1] - p0[1]),
        p1[0] + (2 / 3) * (c[0] - p1[0]), p1[1] + (2 / 3) * (c[1] - p1[1]),
        p1[0], p1[1]
      ];
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M') {
        out.push({ c: 'M', pts: [s.pts[0], s.pts[1]] });
        cur = [s.pts[0], s.pts[1]];
        startPt = cur.slice();
      } else if (s.c === 'L') {
        out.push({ c: 'L', pts: [s.pts[0], s.pts[1]] });
        cur = [s.pts[0], s.pts[1]];
      } else if (s.c === 'Q') {
        out.push({ c: 'C', pts: qToC(cur, [s.pts[0], s.pts[1]], [s.pts[2], s.pts[3]]) });
        cur = [s.pts[2], s.pts[3]];
      } else if (s.c === 'C') {
        out.push({ c: 'C', pts: s.pts.slice() });
        cur = [s.pts[4], s.pts[5]];
      } else if (s.c === 'A') {
        var p = s.pts;
        var cubs = arcToCubics(cur[0], cur[1], p[0], p[1], p[2], p[3] ? 1 : 0, p[4] ? 1 : 0, p[5], p[6]);
        for (var j = 0; j < cubs.length; j++) out.push({ c: 'C', pts: cubs[j] });
        cur = [p[5], p[6]];
      } else if (s.c === 'Z') {
        out.push({ c: 'Z', pts: [] });
        cur = startPt.slice();
      }
    }
    return out;
  }

  /* ---------------- cleanup: stray points, zero-len, collinear ----------------
   * Returns { segs, removedStray, removedZero, removedCollinear }
   */
  function cleanupSegs(segs, opts) {
    opts = opts || {};
    var tiny = opts.tiny !== undefined ? opts.tiny : 1e-4;
    var collinear = opts.removeCollinear !== false;
    var removedStray = 0, removedZero = 0, removedCollinear = 0;
    // split into subpaths
    var subpaths = [], cur = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M') {
        if (cur) subpaths.push(cur);
        cur = { start: [s.pts[0], s.pts[1]], chain: [], closed: false };
      } else {
        if (!cur) { removedStray++; continue; }
        if (s.c === 'Z') cur.closed = true;
        cur.chain.push(s);
      }
    }
    if (cur) subpaths.push(cur);

    var out = [];
    for (var sp = 0; sp < subpaths.length; sp++) {
      var sub = subpaths[sp];
      var chain = sub.chain.slice();
      // remove zero-length segments
      var prev = sub.start;
      var newChain = [];
      for (var c = 0; c < chain.length; c++) {
        var seg = chain[c];
        if (seg.c !== 'Z') {
          var ex = seg.pts[seg.pts.length - 2], ey = seg.pts[seg.pts.length - 1];
          var ddx = ex - prev[0], ddy = ey - prev[1];
          if (ddx * ddx + ddy * ddy < tiny * tiny) { removedZero++; prev = [ex, ey]; continue; }
        }
        newChain.push(seg);
        if (seg.c !== 'Z') prev = [seg.pts[seg.pts.length - 2], seg.pts[seg.pts.length - 1]];
      }
      // remove collinear L points (only within straight L runs)
      if (collinear) {
        var finalChain = [];
        var lpts = [sub.start]; // endpoints of the current consecutive-L run
        function endPt(s) { return [s.pts[s.pts.length - 2], s.pts[s.pts.length - 1]]; }
        for (var k = 0; k < newChain.length; k++) {
          var seg2 = newChain[k];
          if (seg2.c === 'L') {
            var ep = endPt(seg2);
            if (lpts.length === 2) {
              var ax = lpts[0][0], ay = lpts[0][1];
              var bx = lpts[1][0], by = lpts[1][1];
              var cxp = ep[0], cyp = ep[1];
              var cross = (bx - ax) * (cyp - by) - (by - ay) * (cxp - bx);
              var len1 = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
              var len2 = Math.sqrt((cxp - bx) * (cxp - bx) + (cyp - by) * (cyp - by));
              if (len1 * len2 > 0 && Math.abs(cross) < 1e-6 * len1 * len2) {
                // A-B-C collinear: drop segment A->B, keep segment to C
                removedCollinear++;
                finalChain.pop();
                finalChain.push(seg2);
                lpts = [lpts[0], ep];
                continue;
              }
            }
            finalChain.push(seg2);
            lpts = [lpts[lpts.length - 1], ep];
          } else {
            finalChain.push(seg2);
            if (seg2.c === 'Z') lpts = [sub.start];
            else lpts = [endPt(seg2)];
          }
        }
        chain = finalChain;
      }
      // a subpath with only M (and maybe Z) and nothing else = stray point
      var hasGeom = chain.some(function (s) { return s.c !== 'Z'; });
      if (!hasGeom) { removedStray++; continue; }
      out.push({ c: 'M', pts: [sub.start[0], sub.start[1]] });
      for (var q = 0; q < chain.length; q++) out.push(chain[q]);
    }
    return { segs: out, removedStray: removedStray, removedZero: removedZero, removedCollinear: removedCollinear };
  }

  function serializeSegs(segs, dp) {
    var s = '';
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg.c === 'M') s += 'M' + fmt(seg.pts[0], dp) + ' ' + fmt(seg.pts[1], dp);
      else if (seg.c === 'L') s += 'L' + fmt(seg.pts[0], dp) + ' ' + fmt(seg.pts[1], dp);
      else if (seg.c === 'C') {
        s += 'C';
        for (var j = 0; j < seg.pts.length; j++) s += (j ? ' ' : '') + fmt(seg.pts[j], dp);
      } else if (seg.c === 'Z') s += 'Z';
    }
    return s;
  }

  function countAnchors(segs) {
    var n = 0;
    for (var i = 0; i < segs.length; i++) {
      var c = segs[i].c;
      if (c === 'M' || c === 'L' || c === 'C') n++;
    }
    return n;
  }

  /* ---------------- bbox (sampled for curves) ---------------- */
  function cubicPoint(p0, c1, c2, p1, t) {
    var u = 1 - t;
    var x = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0];
    var y = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1];
    return [x, y];
  }
  function pathBBox(segs) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function addPoint(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    var cur = [0, 0];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M') { addPoint(s.pts[0], s.pts[1]); cur = [s.pts[0], s.pts[1]]; }
      else if (s.c === 'L') { addPoint(s.pts[0], s.pts[1]); cur = [s.pts[0], s.pts[1]]; }
      else if (s.c === 'C') {
        var p1 = [s.pts[4], s.pts[5]];
        for (var t = 1; t <= 8; t++) {
          var pt = cubicPoint(cur, [s.pts[0], s.pts[1]], [s.pts[2], s.pts[3]], p1, t / 8);
          addPoint(pt[0], pt[1]);
        }
        cur = p1;
      } else if (s.c === 'Z') {
        // find subpath start
        for (var j = i - 1; j >= 0; j--) { if (segs[j].c === 'M') { cur = [segs[j].pts[0], segs[j].pts[1]]; break; } }
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /* ---------------- colors ---------------- */
  var NAMED_COLORS = {
    black: [0, 0, 0, 1], silver: [192, 192, 192, 1], gray: [128, 128, 128, 1], white: [255, 255, 255, 1],
    maroon: [128, 0, 0, 1], red: [255, 0, 0, 1], purple: [128, 0, 128, 1], fuchsia: [255, 0, 255, 1],
    green: [0, 128, 0, 1], lime: [0, 255, 0, 1], olive: [128, 128, 0, 1], yellow: [255, 255, 0, 1],
    navy: [0, 0, 128, 1], blue: [0, 0, 255, 1], teal: [0, 128, 128, 1], aqua: [0, 255, 255, 1],
    orange: [255, 165, 0, 1], pink: [255, 192, 203, 1], brown: [165, 42, 42, 1], beige: [245, 245, 220, 1],
    white: [255, 255, 255, 1], transparent: [0, 0, 0, 0],
    currentcolor: null, none: null
  };
  function parseColor(str) {
    if (str === undefined || str === null) return null;
    var s = String(str).trim().toLowerCase();
    if (s === '' ) return null;
    if (s[0] === '#') {
      var h = s.slice(1);
      if (h.length === 3) {
        var r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16);
        return [r, g, b, 1];
      }
      if (h.length === 6) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
      }
      if (h.length === 8) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
      }
      return null;
    }
    var m = s.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
      var parts = m[1].split(/[\s,\/]+/).filter(Boolean).map(function (x) { return parseFloat(x); });
      var r = parts[0], g = parts[1], b = parts[2], a = parts.length > 3 ? parts[3] : 1;
      if (r === undefined || isNaN(r)) return null;
      if (r > 1 || g > 1 || b > 1) { /* 0-255 space */ }
      else { r = r * 255; g = g * 255; b = b * 255; } // percent / 0-1 space
      return [r, g, b, a === undefined || isNaN(a) ? 1 : a];
    }
    if (NAMED_COLORS[s] !== undefined) {
      if (NAMED_COLORS[s] === null) return { special: s };
      return NAMED_COLORS[s].slice();
    }
    if (s.indexOf('url(') === 0) return { gradient: s.replace(/^url\(\s*/i, '').replace(/\s*\)$/i, '').replace(/^#/, '') };
    return null;
  }
  // bake alpha onto white background (RGB)
  function bakeAlphaOnWhite(c) {
    if (!c || c.a === undefined || c.a >= 1) return c;
    return [c[0] * c.a + 255 * (1 - c.a), c[1] * c.a + 255 * (1 - c.a), c[2] * c.a + 255 * (1 - c.a), 1];
  }
  function mixWithWhite(c, t) {
    // t = fraction toward white
    if (!c) return c;
    return [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t, 1];
  }

  /* ---------------- zip (store method) ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // files: [{name, data: Uint8Array}]  -> Uint8Array zip
  function makeZip(files) {
    function dosDateTime(d) {
      var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      var date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      return { time: time, date: date };
    }
    var chunks = [], central = [];
    var offset = 0;
    var now = new Date();
    var dt = dosDateTime(now);
    function str16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
    function str32(v) { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nameBytes = [];
      for (var c2 = 0; c2 < f.name.length; c2++) {
        var code = f.name.charCodeAt(c2);
        if (code > 0x7F) code = 0x3F;
        nameBytes.push(code);
      }
      var crc = crc32(f.data);
      var size = f.data.length;
      var lfh = [];
      lfh = lfh.concat([0x50, 0x4B, 0x03, 0x04]).concat(str16(20), str16(0), str16(0))
        .concat(str16(dt.time), str16(dt.date)).concat(str32(crc)).concat(str32(size), str32(size))
        .concat(str16(nameBytes.length), str16(0));
      var head = new Uint8Array(lfh);
      central.push({
        name: nameBytes, crc: crc, size: size, offset: offset
      });
      chunks.push(head, new Uint8Array(nameBytes), f.data);
      offset += head.length + nameBytes.length + size;
    }
    var cdStart = offset;
    for (var j = 0; j < central.length; j++) {
      var e = central[j];
      var cdh = [];
      cdh = cdh.concat([0x50, 0x4B, 0x01, 0x02]).concat(str16(20), str16(20), str16(0), str16(0))
        .concat(str16(0), str16(dt.time), str16(dt.date)).concat(str32(e.crc)).concat(str32(e.size), str32(e.size))
        .concat(str16(e.name.length), str16(0), str16(0), str16(0), str16(0), str32(0)).concat(str32(e.offset));
      var cdArr = new Uint8Array(cdh.concat(e.name));
      chunks.push(cdArr);
      offset += cdArr.length;
    }
    var cdSize = offset - cdStart;
    var eocd = new Uint8Array([0x50, 0x4B, 0x05, 0x06, 0, 0, 0, 0].concat(str16(files.length), str16(files.length), str32(cdSize), str32(cdStart), [0, 0]));
    chunks.push(eocd);
    var total = offset + eocd.length;
    var out = new Uint8Array(total);
    var p = 0;
    for (var q = 0; q < chunks.length; q++) { out.set(chunks[q], p); p += chunks[q].length; }
    return out;
  }

  /* ---------------- misc ---------------- */
  function asciiSafe(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      out += (code >= 32 && code <= 126) ? s[i] : (code === ' ' ? ' ' : (code === '?' ? '?' : '?'));
    }
    return out;
  }
  function bytesToText(bytes) {
    var s = '';
    var CHUNK = 8192;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  return {
    id: id, compose: compose, applyM: applyM, isIdentity: isIdentity, parseTransform: parseTransform,
    fmt: fmt,
    parsePathD: parsePathD, arcToCubics: arcToCubics, normalizeSegs: normalizeSegs,
    cleanupSegs: cleanupSegs, serializeSegs: serializeSegs, countAnchors: countAnchors,
    pathBBox: pathBBox,
    parseColor: parseColor, bakeAlphaOnWhite: bakeAlphaOnWhite, mixWithWhite: mixWithWhite,
    crc32: crc32, makeZip: makeZip,
    asciiSafe: asciiSafe, bytesToText: bytesToText
  };
}));
