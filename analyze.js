/*
 * analyze.js — professional-grade preflight analysis engine (items 36–54)
 *
 * Pure geometry/analysis module. No DOM writes, no side effects.
 * Input: fixed SVG string + veclib (V). Output: plain data objects.
 *
 * API:
 *   Analyze.parseGeometry(svg)            -> { shapes, openPaths, totalAnchors }
 *   Analyze.analyze(shapes, artboard)     -> full preflight analysis
 *   Analyze.rdpSimplify(shape, tolerance) -> { d, segs, nodesBefore, nodesAfter, maxDeviation, deviationPct }
 *   Analyze.repairShape(shape, opts)      -> { d, segs, applied }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./veclib.js'));
  else root.Analyze = factory(root.VLib || root.V);
}(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  var MAX_PAIR_SHAPES = 350;   // cap for pairwise overlap / duplicate analysis
  var MAX_SEG_PER_CONT = 1500; // cap for self-intersection sampling

  /* ================= geometry helpers ================= */

  function dist(ax, ay, bx, by) { return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }

  function splitSubpaths(segs) {
    var out = [], cur = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M') {
        if (cur && cur.length) out.push(cur);
        cur = [s];
      } else if (cur) {
        cur.push(s);
      }
    }
    if (cur && cur.length) out.push(cur);
    return out;
  }

  function isClosedContour(segs) {
    if (!segs.length) return false;
    var last = segs[segs.length - 1];
    return last.c === 'Z' || (function () {
      var first = segs[0].pts, end = last.pts;
      return Math.abs(end[0] - first[0]) < 1e-6 && Math.abs(end[1] - first[1]) < 1e-6;
    })();
  }

  function cubicPoint(p, t) {
    var mt = 1 - t;
    var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [
      a * p[0] + b * p[2] + c * p[4] + d * p[6],
      a * p[1] + b * p[3] + c * p[5] + d * p[7]
    ];
  }

  /*
   * Normalized seg format (veclib.normalizeSegs):
   *   M: [x, y]            L: [x, y] (endpoint, start = current point)
   *   C: [c1x, c1y, c2x, c2y, x, y]
   *   Q: [cx, cy, x, y]    Z: []
   */
  function segStartEnd(s, cur) {
    if (s.c === 'M') return { start: [s.pts[0], s.pts[1]], end: [s.pts[0], s.pts[1]] };
    if (s.c === 'L') return { start: cur.slice(), end: [s.pts[0], s.pts[1]] };
    if (s.c === 'C') return { start: cur.slice(), end: [s.pts[4], s.pts[5]] };
    if (s.c === 'Q') return { start: cur.slice(), end: [s.pts[2], s.pts[3]] };
    return { start: cur.slice(), end: cur.slice() };
  }

  // sample one segment into n+1 points (start .. end)
  function sampleSeg(s, n, cur) {
    var pts = [];
    if (s.c === 'M') return [[s.pts[0], s.pts[1]]];
    if (s.c === 'Z') return [];
    if (s.c === 'L') {
      var se = segStartEnd(s, cur);
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        pts.push([se.start[0] + (se.end[0] - se.start[0]) * t, se.start[1] + (se.end[1] - se.start[1]) * t]);
      }
      return pts;
    }
    if (s.c === 'C') {
      // normalized C pts = [c1x, c1y, c2x, c2y, x, y]; cubicPoint needs start point prepended
      var p8 = [cur[0], cur[1], s.pts[0], s.pts[1], s.pts[2], s.pts[3], s.pts[4], s.pts[5]];
      for (var j = 0; j <= n; j++) pts.push(cubicPoint(p8, j / n));
      return pts;
    }
    if (s.c === 'Q') {
      var c = [s.pts[0] + (2 / 3) * (s.pts[2] - s.pts[0]), s.pts[1] + (2 / 3) * (s.pts[3] - s.pts[1])];
      var p2 = [cur[0], cur[1], c[0], c[1], s.pts[2], s.pts[3], s.pts[2], s.pts[3]];
      for (var k = 0; k <= n; k++) pts.push(cubicPoint(p2, k / n));
      return pts;
    }
    return pts;
  }

  // sample a whole contour (single subpath) into a ring of points (closed: first point appended at end)
  function sampleContour(segs, perSeg) {
    var pts = [];
    var cur = [0, 0];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M') {
        if (!pts.length) pts.push([s.pts[0], s.pts[1]]);
        cur = [s.pts[0], s.pts[1]];
        continue;
      }
      if (s.c === 'Z') { cur = pts.length ? pts[0].slice() : cur; continue; }
      var sub = sampleSeg(s, perSeg, cur);
      for (var j = (pts.length ? 1 : 0); j < sub.length; j++) pts.push(sub[j]);
      cur = segStartEnd(s, cur).end;
    }
    if (pts.length < 3) return pts;
    if (isClosedContour(segs)) {
      var d0 = dist(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]);
      if (d0 < 1e-4) pts.pop();
      pts.push([pts[0][0], pts[0][1]]);
    }
    return pts;
  }

  // winding-number point-in-polygon (pts closed or not)
  function pointInPolygon(px, py, poly) {
    var inside = false;
    var n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function polygonArea(pts) {
    var a = 0;
    for (var i = 0, n = pts.length; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function orient(ax, ay, bx, by, cx, cy) {
    var v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
    if (v > 1e-9) return 1;
    if (v < -1e-9) return -1;
    return 0;
  }

  // proper segment intersection (excluding shared-endpoint adjacency handled by caller)
  function segsCross(p1, p2, p3, p4) {
    var a = p1[0], b = p1[1], c = p2[0], d = p2[1];
    var e = p3[0], f = p3[1], g = p4[0], h = p4[1];
    var o1 = orient(a, b, c, d, e, f);
    var o2 = orient(a, b, c, d, g, h);
    var o3 = orient(e, f, g, h, a, b);
    var o4 = orient(e, f, g, h, c, d);
    if (o1 !== o2 && o3 !== o4) return true;
    // collinear overlaps count as touching (rare in vector art) — ignore for our purposes
    return false;
  }

  function linesBBoxOverlap(l1, l2, pad) {
    pad = pad || 0;
    var a = l1[0][0], b = l1[0][1], c = l1[1][0], d = l1[1][1];
    var e = l2[0][0], f = l2[0][1], g = l2[1][0], h = l2[1][1];
    var min1x = Math.min(a, c), max1x = Math.max(a, c), min1y = Math.min(b, d), max1y = Math.max(b, d);
    var min2x = Math.min(e, g), max2x = Math.max(e, g), min2y = Math.min(f, h), max2y = Math.max(f, h);
    return min1x <= max2x + pad && max1x >= min2x - pad && min1y <= max2y + pad && max1y >= min2y - pad;
  }

  // symmetric Hausdorff distance between two point rings, normalized by diag
  function hausdorff(A, B, diag) {
    if (!A.length || !B.length || !diag) return 1;
    function minDist2(pt, ring) {
      var best = Infinity;
      for (var i = 0; i < ring.length; i++) {
        var dx = pt[0] - ring[i][0], dy = pt[1] - ring[i][1];
        var d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      return best;
    }
    var h1 = 0, h2 = 0;
    for (var i = 0; i < A.length; i++) h1 = Math.max(h1, minDist2(A[i], B));
    for (var j = 0; j < B.length; j++) h2 = Math.max(h2, minDist2(B[j], A));
    return Math.sqrt(Math.max(h1, h2)) / diag;
  }

  function bboxDiag(bb) { return Math.sqrt(bb.w * bb.w + bb.h * bb.h) || 1; }

  /* ================= SVG -> shapes ================= */

  // CTM of an element = own transform + all ancestor transforms (innermost first)
  function elementCTM(el) {
    var m = V.id();
    var node = el;
    while (node && node.nodeType === 1 && node.localName && node.localName !== 'svg') {
      var t = node.getAttribute('transform');
      if (t) m = V.compose(V.parseTransform(t), m);
      node = node.parentNode;
    }
    return m;
  }

  // maps svg root user units -> target artboard units (viewBox or width/height)
  function viewBoxMatrix(root, targetW, targetH) {
    var vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      var sx = targetW / vb[2], sy = targetH / vb[3];
      return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
    }
    var w = parseFloat(root.getAttribute('width')) || targetW;
    var h = parseFloat(root.getAttribute('height')) || targetH;
    var sx2 = w > 0 ? targetW / w : 1, sy2 = h > 0 ? targetH / h : 1;
    return [sx2, 0, 0, sy2, 0, 0];
  }

  function transformSegs(segs, m) {
    if (V.isIdentity(m)) return segs;
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'Z' || !s.pts.length) { out.push(s); continue; }
      var p = [];
      for (var j = 0; j + 1 < s.pts.length; j += 2) {
        var pt = V.applyM(m, s.pts[j], s.pts[j + 1]);
        p.push(pt[0], pt[1]);
      }
      out.push({ c: s.c, pts: p });
    }
    return out;
  }

  function parseColorVal(str) {
    if (!str) return null;
    var c = V.parseColor(str);
    if (Array.isArray(c)) return [c[0], c[1], c[2]];
    if (c && c.special) return [0, 0, 0]; // currentColor etc -> treat as black
    return null;
  }

  function parseGeometry(svg, artboard) {
    var doc;
    if (typeof DOMParser !== 'undefined') {
      doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    } else {
      var jsdom = require('jsdom');
      doc = new jsdom.JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
    }
    var root = doc.documentElement;
    var targetW = (artboard && artboard.w) || parseFloat(root.getAttribute('width')) || 1200;
    var targetH = (artboard && artboard.h) || parseFloat(root.getAttribute('height')) || 1200;
    var vbM = viewBoxMatrix(root, targetW, targetH);
    var shapes = [];
    var els = doc.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // skip defs/clipPath/marker/symbol content — not rendered artwork
      var inDefs = el.closest ? el.closest('defs, clipPath, marker, symbol, pattern, mask') : null;
      if (inDefs) continue;
      var name = el.localName;
      var d = el.getAttribute('d') || '';
      if (name !== 'path') {
        // safety: convert basic shapes to path d (shouldn't happen after svgfix)
        d = shapeToD(el);
      }
      if (!d) continue;
      var parsed = V.parsePathD(d);
      if (parsed.err || !parsed.segs.length) continue;
      var ctm = V.compose(vbM, elementCTM(el));
      var norm = transformSegs(V.normalizeSegs(parsed.segs), ctm);
      var bb = V.pathBBox(norm) || { x: 0, y: 0, w: 0, h: 0 };
      var fill = el.getAttribute('fill') || '#000000';
      var stroke = el.getAttribute('stroke');
      var shape = {
        segs: norm,
        contours: splitSubpaths(norm),
        bbox: bb,
        d: V.serializeSegs(norm),
        fill: fill,
        fillRGB: parseColorVal(fill),
        fillOpacity: numAttr(el, 'fill-opacity', 1),
        stroke: stroke && stroke !== 'none' ? stroke : null,
        strokeWidth: stroke ? numAttr(el, 'stroke-width', 1) : 0,
        closedCount: 0,
        openCount: 0,
        anchors: V.countAnchors(norm)
      };
      for (var c = 0; c < shape.contours.length; c++) {
        if (isClosedContour(shape.contours[c])) shape.closedCount++;
        else shape.openCount++;
      }
      shape.painted = shape.fillRGB || shape.stroke;
      shapes.push(shape);
    }
    var openPaths = 0, totalAnchors = 0;
    shapes.forEach(function (s) { openPaths += s.openCount; totalAnchors += s.anchors; });

    // item 38: clip masks — bbox of every clipPath's content, in artboard units
    var clips = [];
    var cps = doc.querySelectorAll('clipPath');
    for (var ci = 0; ci < cps.length; ci++) {
      var cp = cps[ci];
      var cpM = V.compose(vbM, elementCTM(cp));
      var allSegs = [];
      var cels = cp.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon');
      for (var cji = 0; cji < cels.length; cji++) {
        var cel = cels[cji];
        var cd = cel.getAttribute('d') || '';
        if (cel.localName !== 'path') cd = shapeToD(cel);
        if (!cd) continue;
        var cparsed = V.parsePathD(cd);
        if (cparsed.err || !cparsed.segs.length) continue;
        var cctm = cel.getAttribute('transform') ? V.compose(V.parseTransform(cel.getAttribute('transform')), cpM) : cpM;
        allSegs = allSegs.concat(transformSegs(V.normalizeSegs(cparsed.segs), cctm));
      }
      if (allSegs.length) {
        var cbb = V.pathBBox(allSegs);
        if (cbb) clips.push({ x: cbb.x, y: cbb.y, w: cbb.w, h: cbb.h });
      }
    }

    return { shapes: shapes, openPaths: openPaths, totalAnchors: totalAnchors, clips: clips };
  }

  function numAttr(el, name, dflt) {
    var v = parseFloat(el.getAttribute(name));
    return isFinite(v) ? v : dflt;
  }

  function shapeToD(el) {
    var n = el.localName, a = function (k) { return numAttr(el, k, 0); };
    if (n === 'rect') {
      var x = a('x'), y = a('y'), w = a('width'), h = a('height');
      return 'M' + x + ' ' + y + 'L' + (x + w) + ' ' + y + 'L' + (x + w) + ' ' + (y + h) + 'L' + x + ' ' + (y + h) + 'Z';
    }
    if (n === 'circle') {
      var cx = a('cx'), cy = a('cy'), r = a('r');
      return 'M' + (cx - r) + ' ' + cy + 'A' + r + ' ' + r + ' 0 1 0 ' + (cx + r) + ' ' + cy + 'A' + r + ' ' + r + ' 0 1 0 ' + (cx - r) + ' ' + cy + 'Z';
    }
    if (n === 'ellipse') {
      var ex = a('cx'), ey = a('cy'), rx = a('rx'), ry = a('ry');
      return 'M' + (ex - rx) + ' ' + ey + 'A' + rx + ' ' + ry + ' 0 1 0 ' + (ex + rx) + ' ' + ey + 'A' + rx + ' ' + ry + ' 0 1 0 ' + (ex - rx) + ' ' + ey + 'Z';
    }
    if (n === 'line') {
      return 'M' + a('x1') + ' ' + a('y1') + 'L' + a('x2') + ' ' + a('y2');
    }
    if (n === 'polyline' || n === 'polygon') {
      var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat);
      if (pts.length < 4) return '';
      var d2 = 'M' + pts[0] + ' ' + pts[1];
      for (var i = 2; i + 1 < pts.length; i += 2) d2 += 'L' + pts[i] + ' ' + pts[i + 1];
      if (n === 'polygon') d2 += 'Z';
      return d2;
    }
    return '';
  }

  /* ================= item 36/37: offsets + margins ================= */

  function artworkBBox(shapes) {
    if (!shapes.length) return { x: 0, y: 0, w: 0, h: 0 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shapes.forEach(function (s) {
      minX = Math.min(minX, s.bbox.x);
      minY = Math.min(minY, s.bbox.y);
      maxX = Math.max(maxX, s.bbox.x + s.bbox.w);
      maxY = Math.max(maxY, s.bbox.y + s.bbox.h);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function offsetsOf(bb, ab) {
    var ox = bb.w ? bb.x - (ab.w - bb.w) / 2 : 0;
    var oy = bb.h ? bb.y - (ab.h - bb.h) / 2 : 0;
    return {
      x: round2(ox),
      y: round2(oy),
      status: (Math.abs(ox) <= 1 && Math.abs(oy) <= 1) ? 'Centered' : 'Offset'
    };
  }

  function marginsOf(bb, ab) {
    var top = bb.y, left = bb.x, right = ab.w - (bb.x + bb.w), bottom = ab.h - (bb.y + bb.h);
    var m = Math.min(ab.w, ab.h);
    var balanceThresh = 0.05 * m;   // adaptive: 5% of the smaller artboard dimension
    var tightThresh = 0.02 * m;     // adaptive: 2% -> artwork hugging the edge
    var dTB = Math.abs(top - bottom), dLR = Math.abs(left - right);
    var status;
    if (dTB <= balanceThresh && dLR <= balanceThresh) status = 'balanced';
    else if (dTB <= 2 * balanceThresh && dLR <= 2 * balanceThresh) status = 'uneven';
    else status = 'bad';
    var minM = Math.min(top, right, bottom, left);
    return {
      top: round2(top), right: round2(right), bottom: round2(bottom), left: round2(left),
      status: status,
      icon: status === 'balanced' ? '🟢' : status === 'uneven' ? '🟡' : '🔴',
      minMargin: round2(minM),
      tight: minM < tightThresh,
      thresholds: { balance: round2(balanceThresh), tight: round2(tightThresh) }
    };
  }

  /* ================= item 38: overflow ================= */

  function overflowOf(shapes, ab) {
    var EPS = 0.5;
    var items = [];
    shapes.forEach(function (s, i) {
      var b = s.bbox;
      if (b.x < -EPS || b.y < -EPS || b.x + b.w > ab.w + EPS || b.y + b.h > ab.h + EPS) {
        var beyond = [
          b.x < -EPS ? 'left ' + round2(-b.x) + 'px' : null,
          b.y < -EPS ? 'top ' + round2(-b.y) + 'px' : null,
          b.x + b.w > ab.w + EPS ? 'right ' + round2(b.x + b.w - ab.w) + 'px' : null,
          b.y + b.h > ab.h + EPS ? 'bottom ' + round2(b.y + b.h - ab.h) + 'px' : null
        ].filter(Boolean).join(', ');
        items.push({ index: i, d: s.d, bbox: s.bbox, beyond: beyond });
      }
    });
    return { count: items.length, items: items };
  }

  /* ================= items 39/42: overlap classification + near duplicates ================= */

  var MAX_RING_POINTS = 4000; // perf guard for huge auto-traced contours

  function ringCache(shape) {
    if (!shape._ring) {
      shape._ring = [];
      var diag = bboxDiag(shape.bbox);
      shape.contours.forEach(function (ct) {
        if (!isClosedContour(ct)) return;
        var ring = sampleContour(ct, 6);
        if (ring.length > MAX_RING_POINTS) {
          // downsample — keeps pairwise similarity/containment analysis bounded
          var step = Math.ceil(ring.length / MAX_RING_POINTS);
          var sub = [];
          for (var i = 0; i < ring.length; i += step) sub.push(ring[i]);
          ring = sub;
        }
        if (ring.length >= 3) shape._ring.push({ ring: ring, area: Math.abs(polygonArea(ring)) });
      });
      shape._diag = diag;
    }
    return shape._ring;
  }

  function shapePerimeter(shape) {
    if (shape._perim) return shape._perim;
    var p = 0;
    shape.contours.forEach(function (ct) {
      var ring = sampleContour(ct, 4);
      for (var i = 1; i < ring.length; i++) p += dist(ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
    });
    shape._perim = p;
    return p;
  }

  function analyzeOverlaps(shapes) {
    var filled = [];
    shapes.forEach(function (s, idx) { if (s.painted && s.fillRGB && s.closedCount > 0) filled.push({ shape: s, idx: idx }); });
    var result = { normal: 0, suspicious: [], critical: [], checked: filled.length, capReached: false };
    var use = filled.slice(0, MAX_PAIR_SHAPES);
    if (filled.length > MAX_PAIR_SHAPES) result.capReached = true;
    for (var i = 0; i < use.length; i++) {
      var A = use[i].shape;
      var rA = ringCache(A);
      if (!rA.length) continue;
      for (var j = i + 1; j < use.length; j++) {
        var B = use[j].shape;
        if (!bboxOverlap(A.bbox, B.bbox)) continue;
        var rB = ringCache(B);
        if (!rB.length) continue;
        var diag = bboxDiag(unionBBox(A.bbox, B.bbox));
        // similarity via Hausdorff on dominant (largest-area) contours
        var sim = 1 - hausdorff(largest(rA).ring, largest(rB).ring, diag);
        if (sim >= 0.99) {
          result.suspicious.push({ a: use[i].idx, b: use[j].idx, similarity: Math.round(sim * 1000) / 10, note: 'Near-identical paths overlapping.' });
          continue;
        }
        // containment: is A's dominant ring fully inside B (or vice versa)?
        var insideAB = fullyInside(largest(rA).ring, largest(rB).ring);
        var insideBA = fullyInside(largest(rB).ring, largest(rA).ring);
        if (insideAB || insideBA) {
          var outerArea = Math.abs(polygonArea(insideAB ? largest(rB).ring : largest(rA).ring));
          var innerArea = Math.abs(polygonArea(insideAB ? largest(rA).ring : largest(rB).ring));
          result.critical.push({
            a: use[i].idx, b: use[j].idx,
            contains: insideAB ? 'b' : 'a',
            areaRatio: outerArea ? round4(innerArea / outerArea) : 0,
            note: (insideAB ? 'Object ' + (use[i].idx + 1) : 'Object ' + (use[j].idx + 1)) + ' lies entirely inside filled ' + (insideAB ? 'object ' + (use[j].idx + 1) : 'object ' + (use[i].idx + 1)) +
              ' — hole may be filled or region is unexpected.'
          });
          continue;
        }
        var overlapArea = approxOverlapArea(A.bbox, B.bbox);
        var smaller = Math.min(A.bbox.w * A.bbox.h, B.bbox.w * B.bbox.h);
        if (smaller > 0 && overlapArea / smaller > 0.2) result.normal++;
      }
    }
    return result;
  }

  function bboxOverlap(a, b) {
    return !(a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h);
  }
  function unionBBox(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    var x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x, y: y, w: x2 - x, h: y2 - y };
  }
  function approxOverlapArea(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return (w > 0 && h > 0) ? w * h : 0;
  }
  function largest(rings) {
    var best = rings[0];
    for (var i = 1; i < rings.length; i++) if (rings[i].area > best.area) best = rings[i];
    return best;
  }
  function fullyInside(inner, outer) {
    if (inner.length < 4) return false;
    // test every 3rd point + corners for speed
    var step = Math.max(1, Math.floor(inner.length / 24));
    for (var i = 0; i < inner.length; i += step) {
      if (!pointInPolygon(inner[i][0], inner[i][1], outer)) return false;
    }
    return true;
  }

  /* ================= item 40: self-intersection ================= */

  function countSelfIntersections(shape) {
    var total = 0, flaggedContours = 0;
    shape.contours.forEach(function (ct) {
      if (!isClosedContour(ct)) return;
      var ring = sampleContour(ct, 5);
      // build line list (closed ring)
      var lines = [];
      for (var i = 0; i < ring.length - 1; i++) lines.push([ring[i], ring[i + 1]]);
      if (lines.length > MAX_SEG_PER_CONT) return;
      var n = lines.length;
      var hits = 0;
      for (var a = 0; a < n; a++) {
        for (var b = a + 2; b < n; b++) {
          if (a === 0 && b === n - 1) continue; // adjacent (wrap)
          if (!linesBBoxOverlap(lines[a], lines[b])) continue;
          if (segsCross(lines[a][0], lines[a][1], lines[b][0], lines[b][1])) hits++;
        }
      }
      if (hits) { total += hits; flaggedContours++; }
    });
    return { crossings: total, contours: flaggedContours };
  }

  /* ================= item 41: zero area / tiny ================= */

  function analyzeZeroArea(shapes) {
    var EPS = 0.01;
    var zero = [], tiny = [];
    shapes.forEach(function (s, i) {
      if (s.bbox.w < EPS || s.bbox.h < EPS) zero.push({ index: i, reason: 'zero ' + (s.bbox.w < EPS ? 'width' : 'height') });
      else if (s.bbox.w < 2 && s.bbox.h < 2) tiny.push({ index: i, w: round2(s.bbox.w), h: round2(s.bbox.h) });
    });
    return { zeroCount: zero.length, zeroItems: zero, tinyCount: tiny.length, tinyItems: tiny };
  }

  /* ================= item 43: color consistency ================= */

  function analyzeColors(shapes) {
    var painted = shapes.filter(function (s) { return s.fillRGB; });
    var rawVals = {};
    painted.forEach(function (s) {
      var key = s.fillRGB[0] + ',' + s.fillRGB[1] + ',' + s.fillRGB[2];
      rawVals[key] = (rawVals[key] || 0) + 1;
    });
    // cluster near-identical colors (RGB distance < 24)
    var clusters = [];
    Object.keys(rawVals).forEach(function (k) {
      var parts = k.split(',').map(Number);
      var found = null;
      for (var i = 0; i < clusters.length; i++) {
        var c = clusters[i].base;
        if (Math.sqrt((c[0] - parts[0]) * (c[0] - parts[0]) + (c[1] - parts[1]) * (c[1] - parts[1]) + (c[2] - parts[2]) * (c[2] - parts[2])) < 24) { found = clusters[i]; break; }
      }
      if (found) { found.values.push(k); found.count += rawVals[k]; }
      else clusters.push({ base: parts, values: [k], count: rawVals[k] });
    });
    var flagged = clusters.filter(function (c) { return c.values.length >= 3; });
    return {
      distinctColors: Object.keys(rawVals).length,
      totalFillObjects: painted.length,
      clusters: clusters.map(function (c) { return { rgb: c.base, variants: c.values.length, objects: c.count }; }),
      flagged: flagged.map(function (c) { return { rgb: c.base, variants: c.values.length, objects: c.count }; })
    };
  }

  /* ================= item 45: negative space / holes ================= */

  function analyzeHoles(shapes) {
    var totalHoles = 0, tinyHoles = 0, jaggedHoles = 0;
    var details = [];
    shapes.forEach(function (s, i) {
      var rings = ringCache(s);
      if (rings.length < 2) return;
      rings.forEach(function (r, ri) {
        // is this ring fully inside any other ring of the same shape?
        for (var k = 0; k < rings.length; k++) {
          if (k === ri) continue;
          if (fullyInside(r.ring, rings[k].ring)) {
            totalHoles++;
            var outerArea = rings[k].area || 1;
            var ratio = r.area / outerArea;
            var jag = contourJag(r.ring);
            var tiny = ratio < 0.005;
            if (tiny) tinyHoles++;
            if (jag > 0.4) jaggedHoles++;
            details.push({ shape: i, hole: ri, areaRatio: round4(ratio), tiny: tiny, jagged: jag > 0.4, jaggedRatio: round2(jag) });
            break;
          }
        }
      });
    });
    return {
      holes: totalHoles,
      tiny: tinyHoles,
      jagged: jaggedHoles,
      details: details,
      note: totalHoles === 0 ? 'No negative-space holes detected.' :
        totalHoles + ' hole(s) (negative space: eyes/mouth/gaps etc.).' +
        (tinyHoles ? ' ' + tinyHoles + ' tiny — verify they are intentional.' : '') +
        (jaggedHoles ? ' ' + jaggedHoles + ' jagged edge(s) — typical auto-trace artifact.' : '')
    };
  }

  /* ================= item 46: contour smoothness + node density ================= */

  function angleBetween(v1, v2) {
    // deflection angle 0 (smooth) .. 180 (reversal), in degrees; v1 = incoming direction reversed
    var a = Math.atan2(v1[1], v1[0]), b = Math.atan2(v2[1], v2[0]);
    var d = Math.abs(a - b) * 180 / Math.PI;
    if (d > 180) d = 360 - d;
    return d;
  }

  function contourSmoothness(ct, diag) {
    // anchors: n points; curve segs k=0..m-1: seg k starts at anchor k, ends at anchor k+1; optional Z closes m -> 0
    var anchors = [], curves = [];
    var cur = null;
    ct.forEach(function (s) {
      if (s.c === 'M') { cur = { x: s.pts[0], y: s.pts[1] }; anchors.push(cur); }
      else if (s.c === 'L') {
        var e = { x: s.pts[0], y: s.pts[1] };
        curves.push({ inC: null, outC: null, p1: e });
        anchors.push(e); cur = e;
      } else if (s.c === 'C') {
        var e2 = { x: s.pts[6], y: s.pts[7] };
        curves.push({ inC: { x: s.pts[4], y: s.pts[5] }, outC: { x: s.pts[2], y: s.pts[3] }, p1: e2 });
        anchors.push(e2); cur = e2;
      } else if (s.c === 'Q') {
        var e3 = { x: s.pts[4], y: s.pts[5] };
        var c3 = { x: s.pts[2], y: s.pts[3] };
        curves.push({ inC: c3, outC: c3, p1: e3 });
        anchors.push(e3); cur = e3;
      } else if (s.c === 'Z') {
        // closure: tangent into anchor 0 from last curve; no new anchor
      }
    });
    var n = anchors.length, m = curves.length;
    if (n < 3) return { nodes: n, cornerRatio: 0, irregularRatio: 0, deflections: [] };
    var closed = m === n - 1 || isClosedContour(ct);
    var corners = 0, irregular = 0, deflections = [];
    var shortChord = 0.03 * (diag || 1);
    for (var i = 0; i < n; i++) {
      // incoming curve = the one ending at anchor i
      var inK = (i > 0) ? i - 1 : (closed ? m - 1 : -1);
      // outgoing curve = the one starting at anchor i
      var outK = (i < m) ? i : (closed ? -1 : -1);
      if (inK < 0 || (outK < 0 && closed === false)) continue;
      var P = anchors[i];
      var inDir = null, outDir = null;
      if (inK >= 0) {
        var ic = curves[inK];
        inDir = ic.inC ? [P.x - ic.inC.x, P.y - ic.inC.y] : [P.x - anchors[inK].x, P.y - anchors[inK].y];
      } else if (closed) {
        var lastC = curves[m - 1];
        inDir = lastC.inC ? [P.x - lastC.inC.x, P.y - lastC.inC.y] : [P.x - anchors[m - 1].x, P.y - anchors[m - 1].y];
      }
      if (outK >= 0) {
        var oc = curves[outK];
        outDir = oc.outC ? [oc.outC.x - P.x, oc.outC.y - P.y] : [oc.p1.x - P.x, oc.p1.y - P.y];
      } else if (closed) {
        // last anchor closes back to the first anchor (Z edge)
        outDir = [anchors[0].x - P.x, anchors[0].y - P.y];
      }
      if (!inDir || !outDir) continue;
      var il = Math.hypot(inDir[0], inDir[1]), ol = Math.hypot(outDir[0], outDir[1]);
      if (il < 1e-6 || ol < 1e-6) continue;
      var inRev = [-inDir[0] / il, -inDir[1] / il];
      var defl = angleBetween(inRev, [outDir[0] / ol, outDir[1] / ol]);
      deflections.push(defl);
      var endP = (outK >= 0 && curves[outK].p1) ? curves[outK].p1 : anchors[0];
      var chord = dist(P.x, P.y, endP.x, endP.y);
      if (defl > 75) corners++;
      if (defl > 45 && chord < shortChord) irregular++;
    }
    return {
      nodes: n,
      cornerRatio: deflections.length ? corners / deflections.length : 0,
      irregularRatio: deflections.length ? irregular / deflections.length : 0,
      deflections: deflections
    };
  }

  function contourJag(ring) {
    if (ring.length < 4) return 0;
    var jag = 0, n = 0;
    for (var i = 0; i < ring.length; i++) {
      var a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      var v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      var l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      n++;
      if (angleBetween([-v1[0] / l1, -v1[1] / l1], [v2[0] / l2, v2[1] / l2]) > 75) jag++;
    }
    return n ? jag / n : 0;
  }

  function analyzeSmoothness(shapes) {
    var totalNodes = 0, totalDefl = 0, totalCorners = 0, totalIrregular = 0, totalAnchors = 0, totalPerim = 0;
    shapes.forEach(function (s) {
      totalAnchors += s.anchors;
      totalPerim += shapePerimeter(s);
      s.contours.forEach(function (ct) {
        if (!isClosedContour(ct)) return;
        var sm = contourSmoothness(ct, bboxDiag(s.bbox));
        totalNodes += sm.nodes;
        totalDefl += sm.deflections.length;
        totalCorners += sm.cornerRatio * sm.deflections.length;
        totalIrregular += sm.irregularRatio * sm.deflections.length;
      });
    });
    var density = totalPerim > 0 ? (totalAnchors / totalPerim) * 100 : 0;
    return {
      anchors: totalAnchors,
      perimeter: round2(totalPerim),
      nodeDensity: round2(density),              // anchors per 100px of contour
      cornerRatio: totalDefl ? totalCorners / totalDefl : 0,
      irregularRatio: totalDefl ? totalIrregular / totalDefl : 0,
      flag: (function () {
        // High-frequency irregularity (short chord + sharp angle) = trace artifact.
        // Intentional corners (squares, logos) have long chords -> not flagged.
        if (totalDefl === 0) return { level: 'ok', msg: 'No closed contours to measure.' };
        var c = totalCorners / totalDefl, ir = totalIrregular / totalDefl;
        if (ir > 0.15) return { level: 'bad', msg: Math.round(ir * 100) + '% high-frequency irregularities — contour looks like an auto-trace artifact.' };
        if (ir > 0.08) return { level: 'warn', msg: Math.round(ir * 100) + '% high-frequency irregularities (short jagged segments). Consider Smart Simplify.' };
        return { level: 'ok', msg: 'Contours smooth; ' + Math.round(c * 100) + '% corner points (intentional geometry).' };
      })()
    };
  }

  /* ================= item 44: silhouette mode ================= */

  function silhouetteCheck(shapes, ab) {
    var fills = {}, withStroke = 0, strokeW = {}, transparent = 0, holes = analyzeHoles(shapes);
    var area = 0;
    shapes.forEach(function (s) {
      if (!s.fillRGB) return;
      var k = s.fillRGB[0] + ',' + s.fillRGB[1] + ',' + s.fillRGB[2];
      if (!fills[k]) fills[k] = 0;
      fills[k] += s.bbox.w * s.bbox.h;
      area += s.bbox.w * s.bbox.h;
      if (s.stroke) { withStroke++; strokeW[s.strokeWidth] = (strokeW[s.strokeWidth] || 0) + 1; }
      if (s.fillOpacity < 1) transparent++;
    });
    var colorKeys = Object.keys(fills);
    var primary = null;
    colorKeys.forEach(function (k) { if (!primary || fills[k] > fills[primary]) primary = k; });
    var hasBackground = shapes.some(function (s) {
      var b = s.bbox;
      return b.w >= ab.w * 0.98 && b.h >= ab.h * 0.98 && Math.abs(b.x) < 2 && Math.abs(b.y) < 2;
    });
    var issues = [];
    if (colorKeys.length > 1) issues.push(colorKeys.length + ' fill colors — silhouette should be a single color.');
    if (withStroke > 0) issues.push(withStroke + ' shape(s) carry strokes.');
    if (transparent > 0) issues.push(transparent + ' shape(s) use fill-opacity (transparency).');
    var clean = colorKeys.length === 1 && withStroke === 0 && transparent === 0;
    return {
      clean: clean,
      icon: clean ? '🟢 Clean Silhouette' : colorKeys.length <= 2 ? '🟡 Review silhouette' : '🔴 Not a clean silhouette',
      primaryFill: primary ? 'rgb(' + primary + ')' : 'none',
      colorCount: colorKeys.length,
      strokeShapes: withStroke,
      strokeWidths: Object.keys(strokeW).map(parseFloat),
      transparentShapes: transparent,
      holes: holes.holes,
      tinyHoles: holes.tiny,
      hasFullBackground: hasBackground,
      issues: issues
    };
  }

  /* ================= item 47: quality flags ================= */

  function qualityFlags(a) {
    function flag(level, msg) { return { level: level, icon: level === 'ok' ? '🟢' : level === 'warn' ? '🟡' : '🔴', msg: msg }; }
    var selfInt = a.selfIntersection.crossings;
    var smooth = a.smoothness;
    var density = smooth.nodeDensity;
    var tiny = a.zeroArea;
    var dup = a.nearDuplicates;
    var holes = a.holes;
    var ov = a.overlaps;
    return {
      'Contour': selfInt > 0
        ? flag('bad', selfInt + ' self-intersection crossing(s) — path(s) cross themselves.')
        : smooth.irregularRatio > 0.08
          ? flag('warn', 'High-frequency irregularities along contour.')
          : flag('ok', 'No self-intersections; contour clean.'),
      'Node Density': density > 7
        ? flag('bad', density + ' anchors/100px — excessive nodes.')
        : density > 4
          ? flag('warn', density + ' anchors/100px — denser than needed.')
          : flag('ok', density + ' anchors/100px — reasonable.'),
      'Smoothness': smooth.flag.level === 'bad'
        ? flag('bad', smooth.flag.msg)
        : smooth.flag.level === 'warn'
          ? flag('warn', smooth.flag.msg)
          : flag('ok', smooth.flag.msg),
      'Tiny Artifacts': (tiny.zeroCount > 0 || tiny.tinyCount > 0 || dup.sameCount > 0)
        ? flag('bad', (tiny.zeroCount || 0) + ' zero-area, ' + (tiny.tinyCount || 0) + ' tiny (<2px), ' + (dup.sameCount || 0) + ' identical duplicate(s).')
        : flag('ok', 'No zero-area or sub-2px artifacts.'),
      'Negative Space': holes.tiny > 0
        ? flag('warn', holes.tiny + ' tiny hole(s) — verify intentional (eyes/gaps/holes).')
        : flag('ok', holes.holes + ' hole(s) — negative space consistent.'),
      'Overlap': ov.critical.length > 0
        ? flag('bad', ov.critical.length + ' critical containment overlap(s).')
        : ov.suspicious.length > 0
          ? flag('warn', ov.suspicious.length + ' suspicious near-identical overlap(s).')
          : flag('ok', 'Only normal layered overlaps (or none).')
    };
  }

  /* ================= item 48: smart simplify (RDP) ================= */

  function rdp(points, eps) {
    // points: closed ring [p0..pn, p0]. Returns simplified ring (start point appended).
    if (points.length < 4) return points.slice();
    var n = points.length - 1; // unique points
    var maxDev = 0;
    function perp(px, py, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.hypot(dx, dy);
      if (len < 1e-9) return dist(px, py, a[0], a[1]);
      return Math.abs(dy * px - dx * py + b[0] * a[1] - b[1] * a[0]) / len;
    }
    var keep = new Array(n + 1).fill(false);
    keep[0] = keep[n] = true;
    var stack = [[0, n]];
    while (stack.length) {
      var seg = stack.pop();
      var i0 = seg[0], i1 = seg[1];
      var dmax = 0, idx = -1;
      for (var i = i0 + 1; i < i1; i++) {
        var d = perp(points[i][0], points[i][1], points[i0], points[i1]);
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > eps && idx > 0) {
        keep[idx] = true;
        stack.push([i0, idx], [idx, i1]);
      } else {
        // every point in this sub-segment is removed; dmax is their worst deviation
        maxDev = Math.max(maxDev, dmax);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(points[j]);
    if (out.length < 3) out = [points[0], points[Math.floor(n / 2)], points[n - 1]];
    out.push(out[0]);
    return { pts: out, maxDev: maxDev };
  }

  function rdpSimplify(shape, tolerance) {
    var nodesBefore = shape.anchors;
    var newContours = [];
    var maxDev = 0;
    var nodesAfter = 0;
    shape.contours.forEach(function (ct) {
      if (!isClosedContour(ct)) {
        // open contour: keep as-is (simplify only closed silhouettes safely)
        newContours.push(ct);
        nodesAfter += ct.filter(function (s) { return s.c !== 'Z'; }).length;
        return;
      }
      var ring = sampleContour(ct, 8);
      if (ring.length < 6) { newContours.push(ct); nodesAfter += ct.length; return; }
      var res = rdp(ring, tolerance);
      maxDev = Math.max(maxDev, res.maxDev);
      var segs = [];
      segs.push({ c: 'M', pts: [res.pts[0][0], res.pts[0][1]] });
      for (var i = 1; i < res.pts.length - 1; i++) segs.push({ c: 'L', pts: [res.pts[i][0], res.pts[i][1]] });
      segs.push({ c: 'Z', pts: [] });
      newContours.push(segs);
      nodesAfter += res.pts.length - 1;
    });
    var d = V.serializeSegs(newContours);
    var diag = bboxDiag(shape.bbox);
    return {
      d: d,
      segs: newContours,
      nodesBefore: nodesBefore,
      nodesAfter: nodesAfter,
      maxDeviation: round2(maxDev),
      deviationPct: round4((maxDev / diag) * 100),
      savings: nodesBefore - nodesAfter
    };
  }

  function simplifyAll(shapes, tolerance) {
    var per = [];
    var nb = 0, na = 0, md = 0;
    shapes.forEach(function (s) {
      var r = rdpSimplify(s, tolerance);
      per.push(r);
      nb += r.nodesBefore; na += r.nodesAfter; md = Math.max(md, r.maxDeviation);
    });
    var ab = artworkBBox(shapes);
    return {
      perShape: per,
      nodesBefore: nb,
      nodesAfter: na,
      maxDeviation: md,
      deviationPct: ab.w || ab.h ? round4((md / bboxDiag(ab)) * 100) : 0
    };
  }

  /* ================= item 49: intelligent path repair ================= */

  function repairShape(shape, opts) {
    opts = opts || {};
    var snapTol = opts.snapTol != null ? opts.snapTol : 2;
    var applied = [];
    var newContours = [];

    shape.contours.forEach(function (ct) {
      // 1) remove consecutive duplicate points
      var dedup = [];
      ct.forEach(function (s) {
        if (s.c === 'Z') { dedup.push(s); return; }
        var last = dedup.length ? dedup[dedup.length - 1] : null;
        var pt = s.c === 'M' ? [s.pts[0], s.pts[1]] : [s.pts[s.pts.length - 2], s.pts[s.pts.length - 1]];
        if (last) {
          var lp = last.c === 'M' ? [last.pts[0], last.pts[1]] : [last.pts[last.pts.length - 2], last.pts[last.pts.length - 1]];
          if (dist(pt[0], pt[1], lp[0], lp[1]) < 0.01) return; // drop duplicate
        }
        dedup.push(s);
      });
      if (dedup.length < ct.length) applied.push({ what: 'duplicate-anchors', count: ct.length - dedup.length });

      // 2) drop zero-length M-only contours (isolated points)
      if (dedup.length === 1 && dedup[0].c === 'M') {
        applied.push({ what: 'isolated-points', count: 1 });
        return;
      }

      // 3) close tiny gaps: open contour whose start≈end
      if (!isClosedContour(dedup)) {
        var first = dedup[0].pts, lastSeg = dedup[dedup.length - 1];
        var endP = [lastSeg.pts[lastSeg.pts.length - 2], lastSeg.pts[lastSeg.pts.length - 1]];
        if (dist(first[0], first[1], endP[0], endP[1]) <= snapTol) {
          dedup = dedup.concat([{ c: 'Z', pts: [] }]);
          applied.push({ what: 'closed-tiny-gap', count: 1 });
        } else {
          // snap endpoint onto start if within tolerance
          var ls = dedup[dedup.length - 1];
          if (ls.c === 'L' || ls.c === 'C' || ls.c === 'Q') {
            var ep = [ls.pts[ls.pts.length - 2], ls.pts[ls.pts.length - 1]];
            if (isFinite(ep[0]) && dist(ep[0], ep[1], first[0], first[1]) <= snapTol) {
              var np = ls.pts.slice();
              np[np.length - 2] = first[0];
              np[np.length - 1] = first[1];
              ls.pts = np;
              dedup = dedup.concat([{ c: 'Z', pts: [] }]);
              applied.push({ what: 'snapped-endpoint', count: 1 });
            }
          }
        }
      }
      newContours.push(dedup);
    });

    var d = V.serializeSegs(newContours);
    var counts = {};
    applied.forEach(function (a) { counts[a.what] = (counts[a.what] || 0) + a.count; });
    return {
      d: d,
      segs: newContours,
      applied: Object.keys(counts).map(function (k) { return { what: k, count: counts[k] }; })
    };
  }

  function repairAll(shapes, opts) {
    var per = shapes.map(function (s) { return repairShape(s, opts); });
    var counts = {};
    per.forEach(function (r) { r.applied.forEach(function (a) { counts[a.what] = (counts[a.what] || 0) + a.count; }); });
    return { perShape: per, counts: counts, total: Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0) };
  }

  /* ================= master analysis ================= */

  function analyze(shapes, artboard, opts) {
    opts = opts || {};
    var bb = artworkBBox(shapes);
    var near = nearDuplicates(shapes);
    var result = {
      artboard: { w: artboard.w, h: artboard.h },
      artworkBBox: { x: round2(bb.x), y: round2(bb.y), w: round2(bb.w), h: round2(bb.h) },
      shapeCount: shapes.length,
      offsets: offsetsOf(bb, artboard),
      margins: marginsOf(bb, artboard),
      overflow: overflowOf(shapes, artboard),
      clipping: (function () {
        var list = opts.clips || [];
        if (!list.length) return { masks: 0, clipped: false, note: 'No clipping masks in current version.' };
        var clipped = false;
        list.forEach(function (cb) {
          if (bb.x < cb.x - 1 || bb.y < cb.y - 1 || bb.x + bb.w > cb.x + cb.w + 1 || bb.y + bb.h > cb.y + cb.h + 1) clipped = true;
        });
        return {
          masks: list.length,
          clipped: clipped,
          note: clipped ? 'Artwork extends beyond a clipping mask — it will be cut in renderers that honor masks.' : 'Artwork fits within clip region(s).'
        };
      })(),
      nearDuplicates: near,
      overlaps: analyzeOverlaps(shapes),
      selfIntersection: countSelfIntersectionsAll(shapes),
      zeroArea: analyzeZeroArea(shapes),
      colors: analyzeColors(shapes),
      holes: analyzeHoles(shapes),
      smoothness: analyzeSmoothness(shapes),
      silhouette: opts.silhouette ? silhouetteCheck(shapes, artboard) : null,
      openPaths: shapes.reduce(function (a, s) { return a + s.openCount; }, 0)
    };
    result.quality = qualityFlags(result);
    return result;
  }

  function countSelfIntersectionsAll(shapes) {
    var crossings = 0, contours = 0, worst = null;
    shapes.forEach(function (s, i) {
      var r = countSelfIntersections(s);
      crossings += r.crossings;
      contours += r.contours;
      if (r.crossings && (!worst || r.crossings > worst.crossings)) worst = { index: i, crossings: r.crossings };
    });
    return { crossings: crossings, contours: contours, worst: worst };
  }

  function nearDuplicates(shapes) {
    var closed = shapes.filter(function (s) { return s.fillRGB && s.closedCount > 0; });
    var use = closed.slice(0, MAX_PAIR_SHAPES);
    var pairs = [], sameCount = 0;
    for (var i = 0; i < use.length; i++) {
      var A = use[i], rA = ringCache(A);
      if (!rA.length) continue;
      for (var j = i + 1; j < use.length; j++) {
        var B = use[j];
        if (!bboxOverlap(A.bbox, B.bbox)) continue;
        var rB = ringCache(B);
        if (!rB.length) continue;
        var sim = 1 - hausdorff(largest(rA).ring, largest(rB).ring, bboxDiag(unionBBox(A.bbox, B.bbox)));
        var pct = Math.round(sim * 1000) / 10;
        if (pct >= 99) { sameCount++; pairs.push({ a: i, b: j, similarity: pct }); }
        else if (pct >= 95) pairs.push({ a: i, b: j, similarity: pct });
      }
    }
    return { pairs: pairs, sameCount: sameCount };
  }

  function round2(x) { return Math.round(x * 100) / 100; }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  return {
    parseGeometry: parseGeometry,
    analyze: analyze,
    artworkBBox: artworkBBox,
    marginsOf: marginsOf,
    offsetsOf: offsetsOf,
    overflowOf: overflowOf,
    analyzeOverlaps: analyzeOverlaps,
    countSelfIntersections: countSelfIntersections,
    analyzeZeroArea: analyzeZeroArea,
    analyzeColors: analyzeColors,
    analyzeHoles: analyzeHoles,
    silhouetteCheck: silhouetteCheck,
    qualityFlags: qualityFlags,
    rdpSimplify: rdpSimplify,
    simplifyAll: simplifyAll,
    repairShape: repairShape,
    repairAll: repairAll,
    nearDuplicates: nearDuplicates,
    splitSubpaths: splitSubpaths,
    isClosedContour: isClosedContour,
    sampleContour: sampleContour,
    pointInPolygon: pointInPolygon,
    polygonArea: polygonArea,
    _debug: { hausdorff: hausdorff, rdp: rdp, contourSmoothness: contourSmoothness, shapePerimeter: shapePerimeter }
  };
}));
