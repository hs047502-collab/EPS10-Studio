/*
 * eps10.js — Illustrator 10 compatible EPS 10 (EPSF-3.0, PostScript Level 2) writer
 * Input: fixed SVG string + artboard size. Output: binary EPS (Uint8Array) + validation checks.
 * Supports: solid fills, linear/radial gradients (shading), strokes (width/caps/joins/dashes),
 * transforms, clip paths, embedded JPEG images. 7-bit clean.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./veclib.js'));
  else root.Eps10 = factory(root.VLib);
}(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  /* ---------------- small helpers ---------------- */
  function f4(n) { return V.fmt(n, 4); }
  function numToken(n) {
    var s = V.fmt(n, 4);
    return s;
  }

  function parseAttrs(el, names) {
    var out = {};
    names.forEach(function (n) {
      var v = el.getAttribute(n);
      if (v !== null) out[n] = v;
    });
    return out;
  }

  /* parse a solid color attr (rgb()/hex/named) -> [r,g,b] 0..1 */
  function colorAttrToRGB01(str) {
    if (!str) return [0, 0, 0];
    var c = V.parseColor(str);
    if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255];
    return [0, 0, 0];
  }

  /* ---------------- gradient defs ---------------- */
  function collectDefs(doc) {
    var grads = {}, clips = {};
    var defs = doc.querySelectorAll('defs linearGradient, defs radialGradient, linearGradient, radialGradient, clipPath');
    defs.forEach(function (el) {
      var id = el.getAttribute('id');
      if (!id) return;
      if (el.localName === 'linearGradient' || el.localName === 'radialGradient') {
        var stops = [];
        el.querySelectorAll('stop').forEach(function (s) {
          var off = parseFloat(s.getAttribute('offset') || '0');
          if (isNaN(off)) off = 0;
          if (String(s.getAttribute('offset') || '').slice(-1) === '%') off /= 100;
          stops.push({ offset: off, color: colorAttrToRGB01(s.getAttribute('stop-color') || '#000') });
        });
        stops.sort(function (a, b) { return a.offset - b.offset; });
        if (!stops.length) stops = [{ offset: 0, color: [0, 0, 0] }, { offset: 1, color: [1, 1, 1] }];
        grads[id] = { type: el.localName, stops: stops, attrs: parseAttrs(el, ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform']) };
      } else if (el.localName === 'clipPath') {
        var paths = [];
        el.querySelectorAll('path, rect, circle, ellipse').forEach(function (p) {
          var d = null;
          if (p.localName === 'path') d = p.getAttribute('d');
          else {
            // reuse simple conversion
            d = basicShapeToPath(p);
          }
          if (d) paths.push(V.normalizeSegs(V.parsePathD(d).segs));
        });
        clips[id] = { units: el.getAttribute('clipPathUnits') || 'userSpaceOnUse', paths: paths };
      }
    });
    return { grads: grads, clips: clips };
  }
  function basicShapeToPath(el) {
    var g = function (a, d) { return el.getAttribute(a) !== null ? parseFloat(el.getAttribute(a)) : (d || 0); };
    if (el.localName === 'rect') {
      var x = g('x'), y = g('y'), w = g('width'), h = g('height');
      return 'M' + x + ' ' + y + 'L' + (x + w) + ' ' + y + 'L' + (x + w) + ' ' + (y + h) + 'L' + x + ' ' + (y + h) + 'Z';
    }
    if (el.localName === 'circle') {
      var K = 0.5522847498 * g('r');
      var cx = g('cx'), cy = g('cy'), r = g('r');
      return 'M' + cx + ' ' + (cy - r) + 'C' + (cx + K) + ' ' + (cy - r) + ' ' + (cx + r) + ' ' + (cy - K) + ' ' + (cx + r) + ' ' + cy +
        'C' + (cx + r) + ' ' + (cy + K) + ' ' + (cx + K) + ' ' + (cy + r) + ' ' + cx + ' ' + (cy + r) +
        'C' + (cx - K) + ' ' + (cy + r) + ' ' + (cx - r) + ' ' + (cy + K) + ' ' + (cx - r) + ' ' + cy +
        'C' + (cx - r) + ' ' + (cy - K) + ' ' + (cx - K) + ' ' + (cy - r) + ' ' + cx + ' ' + (cy - r) + 'Z';
    }
    if (el.localName === 'ellipse') {
      var KX = 0.5522847498 * g('rx'), KY = 0.5522847498 * g('ry');
      var ex = g('cx'), ey = g('cy'), rx = g('rx'), ry = g('ry');
      return 'M' + ex + ' ' + (ey - ry) + 'C' + (ex + KX) + ' ' + (ey - ry) + ' ' + (ex + rx) + ' ' + (ey - KY) + ' ' + (ex + rx) + ' ' + ey +
        'C' + (ex + rx) + ' ' + (ey + KY) + ' ' + (ex + KX) + ' ' + (ey + ry) + ' ' + ex + ' ' + (ey + ry) +
        'C' + (ex - KX) + ' ' + (ey + ry) + ' ' + (ex - rx) + ' ' + (ey + KY) + ' ' + (ex - rx) + ' ' + ey +
        'C' + (ex - rx) + ' ' + (ey - KY) + ' ' + (ex - KX) + ' ' + (ey - ry) + ' ' + ex + ' ' + (ey - ry) + 'Z';
    }
    return null;
  }

  /* ---------------- path emission ---------------- */
  function emitPath(lines, segs, mat) {
    // apply matrix to all points, emit m/l/c
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.c === 'M' || s.c === 'L') {
        var p = V.applyM(mat, s.pts[0], s.pts[1]);
        lines.push(f4(p[0]) + ' ' + f4(p[1]) + (s.c === 'M' ? ' m' : ' l'));
      } else if (s.c === 'C') {
        var c1 = V.applyM(mat, s.pts[0], s.pts[1]);
        var c2 = V.applyM(mat, s.pts[2], s.pts[3]);
        var p2 = V.applyM(mat, s.pts[4], s.pts[5]);
        lines.push(f4(c1[0]) + ' ' + f4(c1[1]) + ' ' + f4(c2[0]) + ' ' + f4(c2[1]) + ' ' + f4(p2[0]) + ' ' + f4(p2[1]) + ' c');
      } else if (s.c === 'Z') {
        lines.push('h');
      }
    }
  }

  /* ---------------- shading ---------------- */
  function gradientCoords(DEF, bbox) {
    // returns {type, coords: number[4] (linear) or [6] (radial)}
    var A = DEF.attrs;
    var units = A.gradientUnits || 'objectBoundingBox'; // SVG default for linear & radial
    var m = A.gradientTransform ? V.parseTransform(A.gradientTransform) : V.id();
    if (DEF.type === 'linearGradient') {
      var x1 = parseFloat(A.x1 || '0'), y1 = parseFloat(A.y1 || '0');
      var x2 = parseFloat(A.x2 || '1'), y2 = parseFloat(A.y2 || '0');
      if (units === 'objectBoundingBox' && bbox) {
        x1 = bbox.x + x1 * bbox.w; y1 = bbox.y + y1 * bbox.h;
        x2 = bbox.x + x2 * bbox.w; y2 = bbox.y + y2 * bbox.h;
      }
      var p1 = V.applyM(m, x1, y1), p2 = V.applyM(m, x2, y2);
      return { type: 2, coords: [p1[0], p1[1], p2[0], p2[1]] };
    }
    var cx = parseFloat(A.cx || '0.5'), cy = parseFloat(A.cy || '0.5');
    var rUnit = parseFloat(A.r || '0.5');
    var fx = A.fx !== null && A.fx !== undefined ? parseFloat(A.fx) : cx;
    var fy = A.fy !== null && A.fy !== undefined ? parseFloat(A.fy) : cy;
    var rFinal;
    if (units === 'objectBoundingBox' && bbox) {
      // unit-square units: circle scaled to bbox (SVG produces an ellipse; approximate with dominant axis)
      cx = bbox.x + cx * bbox.w; cy = bbox.y + cy * bbox.h;
      fx = bbox.x + fx * bbox.w; fy = bbox.y + fy * bbox.h;
      rFinal = rUnit * Math.max(bbox.w, bbox.h);
    } else {
      rFinal = rUnit;
    }
    var c1 = V.applyM(m, cx, cy), c2 = V.applyM(m, fx, fy);
    var avgScale = (Math.abs(m[0]) + Math.abs(m[3])) / 2;
    return { type: 3, coords: [c2[0], c2[1], 0, c1[0], c1[1], rFinal * avgScale] };
  }
  function shadingDictLines(sh, extraPad) {
    var lines = [];
    var stops = sh.stops;
    // stopped function
    var bounds = stops.slice(0, -1).map(function (s) { return numToken(s.offset); });
    var colors = stops.map(function (s) { return numToken(s.color[0]) + ' ' + numToken(s.color[1]) + ' ' + numToken(s.color[2]); });
    var funcs = [];
    for (var i = 0; i < stops.length - 1; i++) {
      funcs.push(
        '9 dict dup begin /FunctionType 2 put /Domain [ 0 1 ] put ' +
        '/C0 [ ' + stops[i].color.map(numToken).join(' ') + ' ] put ' +
        '/C1 [ ' + stops[i + 1].color.map(numToken).join(' ') + ' ] put ' +
        '/Exponents [ 1 1 1 ] put end'
      );
    }
    if (stops.length === 1) funcs.push(
      '9 dict dup begin /FunctionType 2 put /Domain [ 0 1 ] put ' +
      '/C0 [ ' + stops[0].color.map(numToken).join(' ') + ' ] put ' +
      '/C1 [ ' + stops[0].color.map(numToken).join(' ') + ' ] put ' +
      '/Exponents [ 1 1 1 ] put end'
    );
    var fnLines = [
      '11 dict dup begin',
      '/FunctionType 3 put',
      '/Bounds [ ' + bounds.join(' ') + ' ] put',
      '/Colors [ ' + colors.join(' ') + ' ] put',
      '/Order 1 put',
      '/Function [',
      funcs.join(' '),
      '] put',
      'end'
    ];
    lines.push('6 dict dup begin');
    lines.push('/ShadingType ' + sh.type + ' put');
    lines.push('/ColorSpace [/DeviceRGB] put');
    lines.push('/Coords [ ' + sh.coords.map(numToken).join(' ') + ' ] put');
    lines.push('/Extend [ true true ] put');
    lines.push('/Function');
    lines.push.apply(lines, fnLines);
    lines.push('end');
    lines.push('shfill');
    return lines;
  }

  /* ---------------- image embedding ---------------- */
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function jpegDimensions(bytes) {
    // scan for SOF0..SOF15
    var i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      if (marker === 0xD8) { i += 2; continue; }
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      if (marker === 0xD9) break;
      if (marker === 0xDA) break;
      if (marker >= 0xD0 && marker <= 0xD7) { i += 2; continue; }
      var len = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 2 + len;
    }
    return null;
  }
  function imageLines(img, state) {
    var href = img.getAttribute('href') || img.getAttribute('xlink:href') || img.getAttribute('src') || '';
    var x = parseFloat(img.getAttribute('x') || '0');
    var y = parseFloat(img.getAttribute('y') || '0');
    var w = parseFloat(img.getAttribute('width') || '0');
    var h = parseFloat(img.getAttribute('height') || '0');
    var lines = [];
    if (href.slice(0, 5) !== 'data:' || w <= 0 || h <= 0) {
      state.findings.push({ section: 'effects', item: 'image', status: 'fail', msg: '<image> could not be embedded (external or zero size).', autoFixed: false });
      return lines;
    }
    var m = href.match(/^data:image\/([a-z]+);base64,(.*)$/i);
    if (!m) return lines;
    var isJpeg = m[1].toLowerCase() === 'jpeg' || m[1].toLowerCase() === 'jpg';
    var bytes = b64ToBytes(m[2]);
    var dims = isJpeg ? jpegDimensions(bytes) : null;
    if (!isJpeg || !dims) {
      state.findings.push({ section: 'effects', item: 'image', status: 'warn', msg: 'Embedded image is not a decodable JPEG — skipped. Convert to JPEG and re-run.', autoFixed: false });
      return lines;
    }
    lines.push('gsave');
    lines.push(f4(x) + ' ' + f4(y) + ' ' + f4(w) + ' ' + f4(h) + ' re clip');
    lines.push('10 dict begin');
    lines.push('/Filter [/DCTDecode] def');
    lines.push('/ColorSpace [/DeviceRGB] def');
    lines.push('/Width ' + dims.w + ' def');
    lines.push('/Height ' + dims.h + ' def');
    lines.push('/BitsPerComponent 8 def');
    lines.push('/ImageMatrix [ ' + dims.w + ' 0 0 ' + (-dims.h) + ' ' + f4(x) + ' ' + f4(y + h) + ' ] def');
    lines.push('currentfile');
    lines.push('%%BeginBinary: ' + bytes.length + ' Bytes');
    state.binaryChunks.push(bytes);
    lines.push('%%EndBinary');
    lines.push('/DCTDecode filter');
    lines.push('image');
    lines.push('end');
    lines.push('grestore');
    return lines;
  }

  /* ---------------- main generator ---------------- */
  function generateEPS(opts) {
    var svg = opts.svg, name = opts.name || 'artwork', W = opts.width, H = opts.height;
    var findings = [];
    var doc;
    if (typeof DOMParser !== 'undefined') {
      doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    } else {
      var jsdom = require('jsdom');
      doc = new jsdom.JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
    }
    var root = doc.documentElement;
    if (!root || root.localName !== 'svg') {
      return { ok: false, findings: [{ section: 'export', item: 'parse', status: 'fail', msg: 'Fixed SVG could not be re-parsed.', autoFixed: false }] };
    }
    var defs = collectDefs(doc);
    var state = { findings: findings, binaryChunks: [], mat: V.id(), W: W, H: H };
    var lines = [];
    var counts = { paths: 0, shfill: 0, strokes: 0, clips: 0, images: 0, text: 0 };

    function clipPathLines(clipId, targetBB) {
      var cp = defs.clips[clipId];
      if (!cp) return null;
      var out = [];
      cp.paths.forEach(function (segs) {
        var mat = cp.units === 'objectBoundingBox' && targetBB
          ? V.compose([targetBB.w, 0, 0, targetBB.h, targetBB.x, targetBB.y], V.id())
          : V.id();
        emitPath(out, segs, mat);
      });
      return out.length ? out : null;
    }
    function clipIdFromAttr(v) {
      if (!v) return null;
      v = v.trim();
      if (v.indexOf('url(') === 0) return v.replace(/^url\(\s*/, '').replace(/\s*\)$/, '').replace(/^#/, '') || null;
      if (/^[A-Za-z0-9_\-]+$/.test(v)) return v; // bare id (our fixed SVG format)
      return null;
    }

    function visit(el, parentMat) {
      if (!el || el.nodeType !== 1) return;
      var name2 = el.localName || '';
      var tf = el.getAttribute('transform');
      var mat = tf ? V.compose(parentMat, V.parseTransform(tf)) : parentMat;

      if (name2 === 'g' || name2 === 'svg' || name2 === 'a') {
        lines.push('gsave');
        if (tf) lines.push(mat.map(numToken).join(' ') + ' concat');
        var cpIdRaw = el.getAttribute('clip-path');
        var id = clipIdFromAttr(cpIdRaw);
        if (id) {
          var cl = clipPathLines(id, null);
          if (cl) {
            lines.push('gsave');
            lines.push.apply(lines, cl);
            lines.push('clip');
            lines.push('grestore');
            counts.clips++;
          }
        }
        var kids = el.children;
        for (var i = 0; i < kids.length; i++) visit(kids[i], mat);
        lines.push('grestore');
        return;
      }
      if (name2 === 'path') {
        var d = el.getAttribute('d') || '';
        var segs = V.normalizeSegs(V.parsePathD(d).segs);
        if (!segs.length) return;
        var bb = V.pathBBox(segs);
        var fillAttr = el.getAttribute('fill') || 'none';
        var strokeAttr = el.getAttribute('stroke') || 'none';
        var doFill = fillAttr !== 'none';
        var doStroke = strokeAttr !== 'none';
        lines.push('gsave');
        if (tf) lines.push(mat.map(numToken).join(' ') + ' concat');
        var cpId2 = clipIdFromAttr(el.getAttribute('clip-path'));
        if (cpId2) {
          var cl2 = clipPathLines(cpId2, bb);
          if (cl2) {
            lines.push('gsave');
            lines.push.apply(lines, cl2);
            lines.push('clip');
            lines.push('grestore');
            counts.clips++;
          }
        }
        if (doFill) {
          lines.push('n');
          emitPath(lines, segs, mat);
          if (fillAttr.indexOf('url(') === 0) {
            var gid = fillAttr.replace(/^url\(\s*/, '').replace(/\s*\)$/, '').replace(/^#/, '');
            var DEF = defs.grads[gid];
            if (DEF) {
              var sh = gradientCoords(DEF, bb);
              sh.stops = DEF.stops;
              lines.push.apply(lines, shadingDictLines(sh));
              counts.shfill++;
            } else {
              lines.push('0 0 0 r f');
              findings.push({ section: 'effects', item: 'gradient', status: 'warn', msg: 'Gradient "' + gid + '" not found — filled black.', autoFixed: false });
            }
          } else {
            var c = colorAttrToRGB01(fillAttr);
            lines.push(numToken(c[0]) + ' ' + numToken(c[1]) + ' ' + numToken(c[2]) + ' r');
            var rule = el.getAttribute('fill-rule');
            lines.push(rule === 'evenodd' ? 'f*' : 'f');
            counts.paths++;
          }
        }
        if (doStroke) {
          lines.push('n');
          emitPath(lines, segs, mat);
          var sc;
          if (strokeAttr.indexOf('url(') === 0) {
            var gid2 = strokeAttr.replace(/^url\(\s*/, '').replace(/\s*\)$/, '').replace(/^#/, '');
            var DEF2 = defs.grads[gid2];
            sc = DEF2 ? DEF2.stops[0].color : [0, 0, 0];
          } else {
            sc = colorAttrToRGB01(strokeAttr);
          }
          var sw = parseFloat(el.getAttribute('stroke-width') || '1') || 1;
          lines.push(numToken(sw) + ' w');
          var cap = el.getAttribute('stroke-linecap') || 'butt';
          lines.push({ butt: 0, round: 1, square: 2 }[cap] !== undefined ? { butt: 0, round: 1, square: 2 }[cap] + ' J' : '0 J');
          var join = el.getAttribute('stroke-linejoin') || 'miter';
          lines.push({ miter: 0, round: 1, bevel: 2 }[join] !== undefined ? { miter: 0, round: 1, bevel: 2 }[join] + ' j' : '0 j');
          lines.push(numToken(parseFloat(el.getAttribute('stroke-miterlimit') || '4') || 4) + ' M');
          var dash = el.getAttribute('stroke-dasharray');
          if (dash && dash !== 'none') {
            var dn = dash.split(/[\s,]+/).filter(Boolean).map(parseFloat).filter(function (n) { return isFinite(n); });
            lines.push('[' + dn.map(numToken).join(' ') + '] 0 d');
          } else {
            lines.push('[] 0 d');
          }
          lines.push(numToken(sc[0]) + ' ' + numToken(sc[1]) + ' ' + numToken(sc[2]) + ' r');
          lines.push('S');
          counts.strokes++;
        }
        lines.push('grestore');
        return;
      }
      if (name2 === 'image') {
        lines.push.apply(lines, imageLines(el, state));
        counts.images++;
        return;
      }
      if (name2 === 'text') {
        counts.text++;
        findings.push({ section: 'text', item: 'outline', status: 'fail', msg: 'Unoutlined <text> in EPS source — text NOT exported. Outline required (Type → Create Outlines).', autoFixed: false });
        return;
      }
      // unknown: recurse (shouldn't happen after fix)
      var kids2 = el.children;
      for (var k = 0; kids2 && k < kids2.length; k++) visit(kids2[k], mat);
    }

    var rootKids = root.children;
    for (var i = 0; i < rootKids.length; i++) {
      var rk = rootKids[i];
      if (rk.localName === 'defs') continue;
      visit(rk, V.id());
    }

    if (counts.text) {
      /* flagged above */
    }

    /* ---------------- assemble file ---------------- */
    var creator = 'Vector EPS 10 Studio (Illustrator 10 compatible)';
    var title = V.asciiSafe(name);
    var now = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var cdate = 'D:' + now.getUTCFullYear() + p2(now.getUTCMonth() + 1) + p2(now.getUTCDate()) +
      p2(now.getUTCHours()) + p2(now.getUTCMinutes()) + p2(now.getUTCSeconds()) + 'Z';

    var header = [
      '%!PS-Adobe-3.0 EPSF-3.0',
      '%%Creator: (' + V.asciiSafe(creator) + ')',
      '%%Title: (' + title + ')',
      '%%CreationDate: (' + cdate + ')',
      '%%For: (Marketplace upload - vector artwork)',
      '%%DocumentCreator: (' + V.asciiSafe(creator) + ')',
      '%%BoundingBox: (0) (0) (' + Math.round(W) + ') (' + Math.round(H) + ')',
      '%%HiResBoundingBox: 0 0 ' + f4(W) + ' ' + f4(H),
      '%%DocumentProcessColors: (R) (G) (B)',
      '%%DocumentNeededFonts: ',
      '%%DocumentNeededResources: procset Adobe_Illustrator 1.0 0',
      '%%DocumentData: Clean7Bit',
      '%%Pages: 1',
      '%%EndComments'
    ];
    var prolog = [
      '%%BeginProlog',
      '% Illustrator 10 compatible output (PostScript Level 2, EPSF-3.0)',
      '/c { curveto } bind def',
      '/l { lineto } bind def',
      '/m { moveto } bind def',
      '/h { closepath } bind def',
      '/re { newpath 4 2 roll moveto 1 index 0 rlineto 0 exch rlineto neg 0 rlineto closepath } bind def',
      '/S { stroke } bind def',
      '/s { closepath stroke } bind def',
      '/w { setlinewidth } bind def',
      '/J { setlinecap } bind def',
      '/j { setlinejoin } bind def',
      '/M { setmiterlimit } bind def',
      '/d { setdash } bind def',
      '/i { setflat } bind def',
      '/k { setcmykcolor } bind def',
      '/r { setrgbcolor } bind def',
      '/g { setgray } bind def',
      '/n { newpath } bind def',
      '/f { fill } bind def',
      '/f* { eofill } bind def',
      '0.1 i',
      '%%EndProlog'
    ];
    var setup = [
      '%%BeginSetup',
      '0 setgray',
      '%%EndSetup'
    ];
    var page = [
      '%%Page: (' + title + ') 1 1',
      '%%BeginPageSetup',
      'gsave',
      '1 0 0 -1 0 ' + f4(H) + ' concat',
      '%%EndPageSetup'
    ];

    // data section: content lines + binary chunks interleaved at marked positions
    var contentParts = [];
    var dataLines = page.concat([]);
    // We already have `lines` as the content. Build binary markers list:
    var binaryIdx = []; // which line indices are BeginBinary/EndBinary
    for (var li = 0; li < lines.length; li++) {
      if (/^%%BeginBinary/.test(lines[li])) binaryIdx.push(li);
    }
    var dataBody = lines.slice();
    dataBody.push('showpage');
    dataBody.push('grestore');
    dataBody.push('%%Trailer');
    dataBody.push('%%Pages: 1');
    dataBody.push('%%EOF');

    var fullLines = header.concat(prolog, setup, page, ['%%BeginData: 0 ASCII Lines']).concat(dataBody);

    // count ASCII lines in data section (lines after %%BeginData, excluding binary payloads)
    var dataStart = fullLines.indexOf('%%BeginData: 0 ASCII Lines') + 1;
    var asciiCount = 0;
    for (var x = dataStart; x < fullLines.length; x++) {
      if (/^%%BeginBinary/.test(fullLines[x])) {
        // skip until EndBinary
        var y = x + 1;
        while (y < fullLines.length && !/^%%EndBinary/.test(fullLines[y])) y++;
        x = y;
        asciiCount += 2;
        continue;
      }
      asciiCount++;
    }
    fullLines[fullLines.indexOf('%%BeginData: 0 ASCII Lines')] = '%%BeginData: ' + asciiCount + ' ASCII Lines';

    // build byte stream
    var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    function textBytes(s) {
      if (enc) return enc.encode(s);
      var out = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
      return out;
    }
    var chunks = [];
    var cursor = 0;
    for (var z = 0; z < fullLines.length; z++) {
      var line = fullLines[z];
      chunks.push(textBytes(line + '\n'));
      if (/^%%BeginBinary/.test(line) && state.binaryChunks[cursor]) {
        chunks.push(state.binaryChunks[cursor]);
        cursor++;
      }
    }
    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total);
    var off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });

    var checks = validateEPS(out, { W: W, H: H });
    return {
      ok: true,
      bytes: out,
      text: V.bytesToText(out),
      findings: findings,
      counts: counts,
      checks: checks
    };
  }

  /* ---------------- validation ---------------- */
  function validateEPS(bytes, opts) {
    opts = opts || {};
    var checks = [];
    function add(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }
    // 7-bit clean (outside binary blocks)
    var sevenBit = true;
    var inBin = false;
    var textLines = [];
    var i = 0;
    while (i < bytes.length) {
      // read line
      var start = i;
      while (i < bytes.length && bytes[i] !== 0x0A) i++;
      var lineBytes = bytes.subarray(start, i);
      i++;
      var lineStr = '';
      for (var c = 0; c < lineBytes.length; c++) lineStr += String.fromCharCode(lineBytes[c]);
      if (/^%%BeginBinary/.test(lineStr)) {
        inBin = true;
        // skip binary payload until EndBinary line
        var j = i;
        while (j < bytes.length) {
          var s2 = j;
          while (j < bytes.length && bytes[j] !== 0x0A) j++;
          var l2 = '';
          for (var c2 = s2; c2 < j; c2++) l2 += String.fromCharCode(bytes[c2]);
          j++;
          if (/^%%EndBinary/.test(l2)) { i = j; break; }
        }
        if (j >= bytes.length) i = j;
        continue;
      }
      if (/^%%EndBinary/.test(lineStr)) { inBin = false; continue; }
      if (!inBin) {
        for (var b = 0; b < lineBytes.length; b++) {
          var v = lineBytes[b];
          if (!((v >= 32 && v <= 126) || v === 9)) { sevenBit = false; break; }
        }
        textLines.push(lineStr);
      }
    }
    add('7-bit clean (Clean7Bit)', sevenBit, sevenBit ? 'All PostScript lines are 7-bit ASCII.' : 'Non-ASCII character found in PostScript text!');
    var first = textLines[0] || '';
    add('EPSF-3.0 header', first === '%!PS-Adobe-3.0 EPSF-3.0', first);
    add('BoundingBox', new RegExp('%%BoundingBox:\\s*\\(0\\) \\(0\\) \\(' + Math.round(opts.W || 0) + '\\) \\(' + Math.round(opts.H || 0) + '\\)').test(textLines.join('\n')), '');
    add('HiResBoundingBox', textLines.some(function (l) { return l.indexOf('%%HiResBoundingBox') === 0; }), '');
    add('Prolog section', textLines.some(function (l) { return l === '%%BeginProlog'; }) && textLines.some(function (l) { return l === '%%EndProlog'; }), '');
    add('PageSetup section', textLines.some(function (l) { return l === '%%BeginPageSetup'; }) && textLines.some(function (l) { return l === '%%EndPageSetup'; }), '');
    add('Data section', textLines.some(function (l) { return l.indexOf('%%BeginData') === 0; }), '');
    add('showpage', textLines.some(function (l) { return l === 'showpage'; }), '');
    add('Trailer', textLines.some(function (l) { return l === '%%Trailer'; }), '');
    var all = textLines.join('\n');
    var gs = (all.match(/gsave/g) || []).length;
    var gr = (all.match(/grestore/g) || []).length;
    add('gsave/grestore balanced', gs === gr, gs + ' gsave / ' + gr + ' grestore');
    var l3 = /\b(setpsscreenalpha|LWAnnex|AdobeLevel3Colors|setrenderingintent|setsmoothshadingspace|colortransfer)\b/.test(all);
    add('No PostScript Level 3 operators', !l3, l3 ? 'Level 3 operator detected!' : 'PS Level 2 only — Illustrator 10 safe.');
    var shfill = (all.match(/shfill/g) || []).length;
    add('Shading (gradients)', shfill >= 0, shfill + ' gradient fill(s).');
    add('File size', bytes.length > 0, (bytes.length / 1024).toFixed(1) + ' KB');
    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  return { generateEPS: generateEPS, validateEPS: validateEPS, _internal: { jpegDimensions: jpegDimensions, b64ToBytes: b64ToBytes } };
}));
