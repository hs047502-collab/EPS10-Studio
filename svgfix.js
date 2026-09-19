/*
 * svgfix.js — SVG audit + auto-fix pipeline (EPS 10 marketplace standard)
 * Operates on a parsed SVG Document (browser DOMParser or jsdom).
 * UMD: browser window.SvgFix / Node module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./veclib.js'));
  else root.SvgFix = factory(root.VLib);
}(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  var DRAW_TAGS = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, image: 1, text: 1 };
  var CONTAINER_TAGS = { g: 1, a: 1, svg: 1 };
  var INHERITABLE = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'fill-rule',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
    'color', 'visibility', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline'];
  var STYLE_PROPS = INHERITABLE.concat(['opacity', 'display', 'transform', 'clip-path']);

  /* ---------------- CSS in <style> ---------------- */
  function parseStyleRules(svgDoc) {
    var rules = [];
    var styles = svgDoc.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var txt = styles[i].textContent || '';
      var re = /([^{}]+)\{([^{}]*)\}/g, m;
      while ((m = re.exec(txt))) {
        var selList = m[1].split(',');
        var decls = {};
        m[2].split(';').forEach(function (d) {
          var idx = d.indexOf(':');
          if (idx < 0) return;
          var p = d.slice(0, idx).trim().toLowerCase();
          var val = d.slice(idx + 1).trim();
          if (p && val) decls[p] = val;
        });
        if (!Object.keys(decls).length) return;
        for (var s = 0; s < selList.length; s++) {
          var spec = parseSelector(selList[s].trim());
          if (spec) rules.push({ spec: spec, decls: decls, order: rules.length });
        }
      }
    }
    return rules;
  }
  function parseSelector(sel) {
    if (!sel || sel === '*') {
      if (sel === '*') return { tag: null, classes: [], id: null, spec: 0 };
      return null;
    }
    var spec = { tag: null, classes: [], id: null };
    var re = /([.#]?)([a-zA-Z0-9_\-]+)/g, m;
    var ok = false;
    while ((m = re.exec(sel))) {
      ok = true;
      if (m[1] === '.') spec.classes.push(m[2]);
      else if (m[1] === '#') spec.id = m[2];
      else spec.tag = m[2].toLowerCase();
    }
    if (!ok) return null;
    spec.spec = (spec.id ? 100 : 0) + spec.classes.length * 10 + (spec.tag ? 1 : 0);
    return spec;
  }
  function cssDeclsFor(el, rules) {
    var localName = el.localName || el.tagName || '';
    var classes = (el.getAttribute && (el.getAttribute('class') || '')).trim().split(/\s+/).filter(Boolean);
    var idAttr = el.getAttribute ? el.getAttribute('id') : null;
    var matched = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var sp = r.spec;
      if (sp.tag && sp.tag !== localName) continue;
      if (sp.id && sp.id !== idAttr) continue;
      var okCls = true;
      for (var c = 0; c < sp.classes.length; c++) {
        if (classes.indexOf(sp.classes[c]) < 0) { okCls = false; break; }
      }
      if (!okCls) continue;
      matched.push(r);
    }
    matched.sort(function (a, b) {
      return (a.spec.spec - b.spec.spec) || (a.order - b.order);
    });
    var out = {};
    matched.forEach(function (r) {
      Object.keys(r.decls).forEach(function (p) {
        if (STYLE_PROPS.indexOf(p) >= 0) out[p] = r.decls[p];
      });
    });
    return out;
  }

  /* ---------------- computed style resolution ---------------- */
  function numVal(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    var s = String(v).trim();
    if (s.slice(-2) === 'em') { var e = parseFloat(s); return isFinite(e) ? e : dflt; } // relative marker handled by caller
    var n = parseFloat(s);
    return isFinite(n) ? n : dflt;
  }

  function resolveStyles(svgDoc) {
    var rules = parseStyleRules(svgDoc);
    var root = svgDoc.documentElement;
    var findings = [];
    var results = {}; // el -> style map (use WeakMap if available)
    var store = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var inheritDefaults = {
      fill: '#000000', stroke: 'none', 'stroke-width': 1, 'fill-opacity': 1, 'stroke-opacity': 1,
      'fill-rule': 'nonzero', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': 4,
      'stroke-dasharray': 'none', 'stroke-dashoffset': 0, color: '#000000', visibility: 'visible',
      'font-family': 'sans-serif', 'font-size': 16, 'font-weight': 'normal', 'letter-spacing': 0,
      'text-anchor': 'start', 'dominant-baseline': 'auto'
    };
    function specMaps(el) {
      // [presentation attrs, css, inline style]
      var attrs = {};
      if (el.getAttributeNames) {
        el.getAttributeNames().forEach(function (n) {
          var p = n.toLowerCase();
          if (STYLE_PROPS.indexOf(p) >= 0) attrs[p] = el.getAttribute(n);
        });
      }
      var css = cssDeclsFor(el, rules);
      var inline = {};
      var styleAttr = el.getAttribute ? el.getAttribute('style') : null;
      if (styleAttr) {
        styleAttr.split(';').forEach(function (d) {
          var idx = d.indexOf(':');
          if (idx < 0) return;
          var p = d.slice(0, idx).trim().toLowerCase();
          if (STYLE_PROPS.indexOf(p) >= 0) inline[p] = d.slice(idx + 1).trim();
        });
      }
      return { attrs: attrs, css: css, inline: inline };
    }
    function compute(el, parentStyle) {
      var maps = specMaps(el);
      var st = {};
      // start from inherited (or defaults)
      INHERITABLE.forEach(function (p) { st[p] = parentStyle ? parentStyle[p] : inheritDefaults[p]; });
      ['opacity', 'display', 'transform', 'clip-path'].forEach(function (p) {
        st[p] = (p === 'opacity') ? 1 : (p === 'display') ? 'inline' : null;
      });
      // own specification: attrs < css < inline
      var priority = [maps.attrs, maps.css, maps.inline];
      priority.forEach(function (src) {
        Object.keys(src).forEach(function (p) { st[p] = src[p]; });
      });
      // normalize
      st['stroke-width'] = numVal(st['stroke-width'], 1);
      st['fill-opacity'] = clampNum(st['fill-opacity'], 1);
      st['stroke-opacity'] = clampNum(st['stroke-opacity'], 1);
      st.opacity = clampNum(st.opacity, 1);
      st['stroke-miterlimit'] = numVal(st['stroke-miterlimit'], 4);
      st['letter-spacing'] = numVal(st['letter-spacing'], 0);
      st['font-size'] = numVal(st['font-size'], 16);
      return st;
    }
    function clampNum(v, dflt) {
      var n = numVal(v, dflt);
      if (n < 0) n = 0;
      return n;
    }
    function walk(el, parentStyle) {
      if (!el || el.nodeType !== 1) return;
      var name = el.localName || el.tagName || '';
      if (name === 'defs' || name === 'title' || name === 'desc' || name === 'metadata') {
        // still resolve children? defs children don't inherit meaningfully; skip walk
        return;
      }
      var st = compute(el, parentStyle);
      if (store) store.set(el, st); else results[el] = st;
      var inheritForChildren = {};
      INHERITABLE.forEach(function (p) { inheritForChildren[p] = st[p]; });
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], inheritForChildren);
    }
    walk(root, null);
    return {
      rules: rules,
      get: function (el) { return store ? store.get(el) : (results[el] || null); }
    };
  }

  /* ---------------- helpers ---------------- */
  function getStyle(styleResolver, el) {
    var st = styleResolver.get(el);
    return st || null;
  }
  function isHidden(st) {
    if (!st) return false;
    return st.display === 'none' || st.visibility === 'hidden' || (typeof st.opacity === 'number' && st.opacity === 0);
  }
  function fillInfo(st) {
    // returns {kind:'none'|'solid'|'gradient'|'special', color:[r,g,b,a]|null, url:null|id, raw}
    var raw = st ? st.fill : '#000000';
    if (raw === undefined || raw === null || raw === '') raw = '#000000';
    var c = V.parseColor(raw);
    if (raw === 'none' || (c && c.special === 'none')) return { kind: 'none', raw: raw };
    if (c && c.special === 'currentColor') {
      var cc = V.parseColor(st.color) || [0, 0, 0, 1];
      return { kind: 'solid', color: cc, raw: raw };
    }
    if (c && c.gradient) return { kind: 'gradient', url: c.gradient, raw: raw };
    if (Array.isArray(c)) return { kind: 'solid', color: c, raw: raw };
    return { kind: 'solid', color: [0, 0, 0, 1], raw: String(raw) };
  }
  function strokeInfo(st) {
    var raw = st ? st.stroke : 'none';
    if (raw === undefined || raw === null || raw === '' || raw === 'none') return { kind: 'none', raw: 'none' };
    var c = V.parseColor(raw);
    if (c && c.special === 'currentColor') {
      var cc = V.parseColor(st.color) || [0, 0, 0, 1];
      return { kind: 'solid', color: cc, width: st['stroke-width'], raw: raw };
    }
    if (c && c.gradient) return { kind: 'gradient', url: c.gradient, width: st['stroke-width'], raw: raw };
    if (Array.isArray(c)) return { kind: 'solid', color: c, width: st['stroke-width'], raw: raw };
    return { kind: 'solid', color: [0, 0, 0, 1], width: st['stroke-width'], raw: String(raw) };
  }

  /* ---------------- shape -> path conversion ---------------- */
  function shapeToPath(el, st) {
    var name = el.localName || el.tagName;
    var g = function (a, d) { return el.getAttribute(a) !== null ? parseFloat(el.getAttribute(a)) : (d !== undefined ? d : 0); };
    var P = function (x, y) { return V.fmt(x) + ' ' + V.fmt(y); };
    if (name === 'path') {
      return el.getAttribute('d') || '';
    }
    if (name === 'rect') {
      var x = g('x'), y = g('y'), w = g('width'), h = g('height');
      var rx = g('rx', null), ry = g('ry', null);
      if (rx === null) rx = 0; if (ry === null) ry = rx;
      if (!w || !h) return '';
      if (rx === 0 && ry === 0) {
        return 'M' + P(x, y) + 'L' + P(x + w, y) + 'L' + P(x + w, y + h) + 'L' + P(x, y + h) + 'Z';
      }
      // rounded rect
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      var K = 0.5522847498;
      var c = [
        ['M', P(x + rx, y)],
        ['L', P(x + w - rx, y)],
        ['C', V.fmt(x + w - rx + rx * K) + ' ' + V.fmt(y) + ' ' + V.fmt(x + w) + ' ' + V.fmt(y + ry - ry * K) + ' ' + P(x + w, y + ry)],
        ['L', P(x + w, y + h - ry)],
        ['C', V.fmt(x + w) + ' ' + V.fmt(y + h - ry + ry * K) + ' ' + V.fmt(x + w - rx + rx * K) + ' ' + V.fmt(y + h) + ' ' + P(x + w - rx, y + h)],
        ['L', P(x + rx, y + h)],
        ['C', V.fmt(x + rx - rx * K) + ' ' + V.fmt(y + h) + ' ' + V.fmt(x) + ' ' + V.fmt(y + h - ry + ry * K) + ' ' + P(x, y + h - ry)],
        ['L', P(x, y + ry)],
        ['C', V.fmt(x) + ' ' + V.fmt(y + ry - ry * K) + ' ' + V.fmt(x + rx - rx * K) + ' ' + V.fmt(y) + ' ' + P(x + rx, y)]
      ];
      return c.map(function (s) { return s[0] + s[1]; }).join('') + 'Z';
    }
    if (name === 'circle') {
      var cx = g('cx'), cy = g('cy'), r = g('r');
      if (!r) return '';
      return circlePath(cx, cy, r);
    }
    if (name === 'ellipse') {
      var ex = g('cx'), ey = g('cy'), rx2 = g('rx'), ry2 = g('ry');
      if (!rx2 || !ry2) return '';
      return ellipsePath(ex, ey, rx2, ry2);
    }
    if (name === 'line') {
      return 'M' + P(g('x1'), g('y1')) + 'L' + P(g('x2'), g('y2'));
    }
    if (name === 'polyline' || name === 'polygon') {
      var pts = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean);
      if (pts.length < 4) return '';
      var nums = pts.map(parseFloat);
      var d = '';
      for (var i = 0; i + 1 < nums.length; i += 2) {
        d += (i === 0 ? 'M' : 'L') + V.fmt(nums[i]) + ' ' + V.fmt(nums[i + 1]);
      }
      if (name === 'polygon') d += 'Z';
      return d;
    }
    return null;
  }
  function circlePath(cx, cy, r) {
    var K = 0.5522847498 * r;
    return 'M' + V.fmt(cx) + ' ' + V.fmt(cy - r) +
      'C' + V.fmt(cx + K) + ' ' + V.fmt(cy - r) + ' ' + V.fmt(cx + r) + ' ' + V.fmt(cy - K) + ' ' + V.fmt(cx + r) + ' ' + V.fmt(cy) +
      'C' + V.fmt(cx + r) + ' ' + V.fmt(cy + K) + ' ' + V.fmt(cx + K) + ' ' + V.fmt(cy + r) + ' ' + V.fmt(cx) + ' ' + V.fmt(cy + r) +
      'C' + V.fmt(cx - K) + ' ' + V.fmt(cy + r) + ' ' + V.fmt(cx - r) + ' ' + V.fmt(cy + K) + ' ' + V.fmt(cx - r) + ' ' + V.fmt(cy) +
      'C' + V.fmt(cx - r) + ' ' + V.fmt(cy - K) + ' ' + V.fmt(cx - K) + ' ' + V.fmt(cy - r) + ' ' + V.fmt(cx) + ' ' + V.fmt(cy - r) + 'Z';
  }
  function ellipsePath(cx, cy, rx, ry) {
    var KX = 0.5522847498 * rx, KY = 0.5522847498 * ry;
    return 'M' + V.fmt(cx) + ' ' + V.fmt(cy - ry) +
      'C' + V.fmt(cx + KX) + ' ' + V.fmt(cy - ry) + ' ' + V.fmt(cx + rx) + ' ' + V.fmt(cy - KY) + ' ' + V.fmt(cx + rx) + ' ' + V.fmt(cy) +
      'C' + V.fmt(cx + rx) + ' ' + V.fmt(cy + KY) + ' ' + V.fmt(cx + KX) + ' ' + V.fmt(cy + ry) + ' ' + V.fmt(cx) + ' ' + V.fmt(cy + ry) +
      'C' + V.fmt(cx - KX) + ' ' + V.fmt(cy + ry) + ' ' + V.fmt(cx - rx) + ' ' + V.fmt(cy + KY) + ' ' + V.fmt(cx - rx) + ' ' + V.fmt(cy) +
      'C' + V.fmt(cx - rx) + ' ' + V.fmt(cy - KY) + ' ' + V.fmt(cx - KX) + ' ' + V.fmt(cy - ry) + ' ' + V.fmt(cx) + ' ' + V.fmt(cy - ry) + 'Z';
  }

  /* ---------------- <use> expansion ---------------- */
  function expandUse(el, svgDoc, depth, findings, count) {
    if (depth > 8) { findings.push(finding('effects', 'use-depth', 'warn', 'Deeply nested <use> — expanded up to depth 8')); return false; }
    var href = el.getAttribute('href');
    if (!href) href = el.getAttribute('xlink:href');
    if (!href || href.charAt(0) !== '#') {
      findings.push(finding('document', 'external-ref', 'fail', '<use> references external resource — removed'));
      return false; // remove
    }
    var target = svgDoc.getElementById ? svgDoc.getElementById(href.slice(1)) : null;
    if (!target) {
      findings.push(finding('document', 'external-ref', 'fail', '<use> target not found ("' + href + '") — removed'));
      return false;
    }
    var clone = target.cloneNode(true);
    // symbol with viewBox → wrap in transform
    var wrap = clone;
    var tAttr = el.getAttribute('transform') || '';
    var x = parseFloat(el.getAttribute('x')) || 0;
    var y = parseFloat(el.getAttribute('y')) || 0;
    if (target.localName === 'symbol' || (target.getAttributeNames && target.getAttributeNames().indexOf('viewBox') >= 0)) {
      var vb = parseViewBox(target.getAttribute('viewBox'));
      var w = parseFloat(el.getAttribute('width')) || vb.w;
      var h = parseFloat(el.getAttribute('height')) || vb.h;
      var m = V.compose([1, 0, 0, 1, x, y], [w / vb.w, 0, 0, h / vb.h, -vb.x * w / vb.w, -vb.y * h / vb.h]);
      var g = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', matrixToTransform(m));
      // move children
      while (clone.firstChild) g.appendChild(clone.firstChild);
      wrap = g;
    } else if (x || y) {
      var m2 = V.compose([1, 0, 0, 1, x, y], tAttr ? V.parseTransform(tAttr) : V.id());
      wrap.setAttribute('transform', matrixToTransform(m2));
    } else if (tAttr) {
      wrap.setAttribute('transform', tAttr);
    }
    if (wrap.getAttributeNames && wrap.getAttributeNames().length === 0 && wrap.localName !== 'g' && wrap.localName !== 'symbol') {
      // fine, no transform needed
    }
    var parent = el.parentNode;
    parent.insertBefore(wrap, el);
    parent.removeChild(el);
    count.n++;
    // recursively expand any nested use inside the clone
    var nested = wrap.querySelectorAll ? wrap.querySelectorAll('use') : [];
    for (var i = 0; i < nested.length; i++) expandUse(nested[i], svgDoc, depth + 1, findings, count);
    return true;
  }
  function parseViewBox(s) {
    var nums = (s || '0 0 100 100').split(/[\s,]+/).map(parseFloat);
    return { x: nums[0] || 0, y: nums[1] || 0, w: nums[2] || 100, h: nums[3] || 100 };
  }
  function matrixToTransform(m) {
    if (V.isIdentity(m)) return '';
    return 'matrix(' + m.map(function (n) { return V.fmt(n, 6); }).join(' ') + ')';
  }

  /* ---------------- text outlining ---------------- */
  function outlineTexts(svgDoc, resolver, findings, font) {
    var texts = svgDoc.querySelectorAll('text');
    var outlined = 0, chars = 0;
    for (var i = 0; i < texts.length; i++) {
      var el = texts[i];
      var st = resolver.get(el);
      if (!st) continue;
      if (!font) {
        findings.push(finding('text', 'outline', 'fail',
          'Text element found — needs outlining (Type → Create Outlines). Upload the font file (.ttf/.otf) in Settings for auto-outline.'));
        continue;
      }
      try {
        var fillRaw = st.fill || '#000000';
        var fillC = V.parseColor(fillRaw);
        var fillAttr = 'none';
        if (fillC && fillC.special === 'currentColor') fillAttr = colorToAttr(V.parseColor(st.color) || [0, 0, 0, 1], st['fill-opacity']);
        else if (Array.isArray(fillC)) fillAttr = colorToAttr(fillC, st['fill-opacity']);
        else if (fillC && fillC.gradient) fillAttr = 'url(#' + fillC.gradient + ')';
        else fillAttr = 'none';

        var size = st['font-size'] || 16;
        var anchor = st['text-anchor'] || 'start';
        var ls = st['letter-spacing'] || 0;
        var x0 = parseFloat(el.getAttribute('x')) || 0;
        var y0 = parseFloat(el.getAttribute('y')) || 0;
        var transform = el.getAttribute('transform') || '';

        // gather runs: base text + tspans
        var runs = [];
        var directText = Array.prototype.slice.call(el.childNodes || []).filter(function (n) { return n.nodeType === 3; })
          .map(function (n) { return n.nodeValue; }).join('').replace(/\s+/g, ' ').trim();
        var curX = x0, curY = y0;
        if (directText) {
          runs.push({ x: curX, y: curY, text: directText, newLine: false, size: size, ls: ls });
          curX += runWidth(font, directText, size, ls); // following tspan without x continues here
        }
        var tspans = el.querySelectorAll('tspan');
        for (var t = 0; t < tspans.length; t++) {
          var ts = tspans[t];
          var tsText = textOf(ts).replace(/\s+/g, ' ').trim();
          if (!tsText) continue;
          var tx = ts.getAttribute('x'), ty = ts.getAttribute('y'), tdx = ts.getAttribute('dx'), tdy = ts.getAttribute('dy');
          var newLine = false;
          var tSize = ts.getAttribute('font-size') ? numVal(ts.getAttribute('font-size'), size) : size;
          if (ty !== null) { curY = parseFloat(ty) + (tdy !== null ? parseLen(tdy, tSize) : 0); newLine = true; }
          else if (tdy !== null) { curY += parseLen(tdy, tSize); newLine = true; }
          if (tx !== null) { curX = parseFloat(tx) + (tdx !== null ? parseLen(tdx, tSize) : 0); }
          else if (tdx !== null) { curX += parseLen(tdx, tSize); }
          var run = {
            x: curX, y: curY, text: tsText, newLine: newLine,
            size: tSize,
            ls: ts.getAttribute('letter-spacing') ? numVal(ts.getAttribute('letter-spacing'), ls) : ls
          };
          runs.push(run);
          curX += runWidth(font, tsText, tSize, run.ls);
        }
        if (!runs.length) continue;
        // merge consecutive runs without a newline (same line) — keep separate for per-run measurement
        var d = layoutTextRuns(font, runs, anchor, findings, el);
        if (d) {
          var path = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', fillAttr);
          path.setAttribute('data-from-text', '1');
          if (transform) path.setAttribute('transform', transform);
          var p = el.parentNode;
          p.insertBefore(path, el);
          p.removeChild(el);
          outlined++;
          chars += runs.reduce(function (a, r) { return a + r.text.length; }, 0);
        }
      } catch (err) {
        findings.push(finding('text', 'outline', 'fail', 'Text outline failed: ' + err.message + ' — outline manually in Illustrator.'));
      }
    }
    if (outlined && font) {
      findings.push(finding('text', 'outline', 'pass', outlined + ' text element(s), ' + chars + ' character(s) auto-outlined to paths using the provided font.', true));
    }
    return outlined;
  }
  function textOf(el) {
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) s += textOf(n);
    }
    return s;
  }
  function parseLen(s, size) {
    s = String(s).trim();
    if (s.slice(-2) === 'em') return parseFloat(s) * size || 0;
    if (s.slice(-1) === '%') return (parseFloat(s) / 100) * size || 0;
    return parseFloat(s) || 0;
  }
  function runWidth(font, text, size, ls) {
    var glyphs = font.stringToGlyphs(text);
    var w = 0;
    for (var i = 0; i < glyphs.length; i++) {
      w += glyphs[i].advanceWidth;
      if (i < glyphs.length - 1) w += font.getKerningValue(glyphs[i], glyphs[i + 1]);
    }
    return w * size / font.unitsPerEm + ls * (text.length - (text.length ? 1 : 0));
  }
  function layoutTextRuns(font, runs, anchor, findings, el) {
    // group runs into lines
    var lines = [];
    var line = null;
    runs.forEach(function (r) {
      if (r.newLine || !line) {
        line = { x: r.x, runs: [] };
        lines.push(line);
      }
      line.runs.push(r);
    });
    var allSegs = [];
    lines.forEach(function (ln) {
      var width = 0;
      ln.runs.forEach(function (r) { width += runWidth(font, r.text, r.size, r.ls); });
      var startX = ln.x;
      if (anchor === 'middle') startX = ln.x - width / 2;
      else if (anchor === 'end') startX = ln.x - width;
      var curX = startX;
      ln.runs.forEach(function (r) {
        var glyphs = font.stringToGlyphs(r.text);
        for (var i = 0; i < glyphs.length; i++) {
          var g = glyphs[i];
          if (g.index === 0) continue;
          var gp = g.getPath(curX, r.y, r.size);
          gp.commands.forEach(function (cmd) {
            if (cmd.type === 'M') allSegs.push({ c: 'M', pts: [cmd.x, cmd.y] });
            else if (cmd.type === 'L') allSegs.push({ c: 'L', pts: [cmd.x, cmd.y] });
            else if (cmd.type === 'C') allSegs.push({ c: 'C', pts: [cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y] });
            else if (cmd.type === 'Q') allSegs.push({ c: 'Q', pts: [cmd.x1, cmd.y1, cmd.x, cmd.y] });
            else if (cmd.type === 'Z') allSegs.push({ c: 'Z', pts: [] });
          });
          var adv = (g.advanceWidth || 0) * r.size / font.unitsPerEm;
          if (i < glyphs.length - 1) adv += font.getKerningValue(g, glyphs[i + 1]) * r.size / font.unitsPerEm;
          curX += adv;
          if (i < glyphs.length - 1) curX += r.ls;
        }
      });
    });
    if (!allSegs.length) return '';
    return V.serializeSegs(V.normalizeSegs(allSegs));
  }

  /* ---------------- main pipeline ---------------- */
  function finding(section, item, status, msg, autoFixed) {
    return { section: section, item: item, status: status, msg: msg, autoFixed: autoFixed || false };
  }
  function colorToAttr(c, opacity) {
    if (!Array.isArray(c)) return 'none';
    c = V.bakeAlphaOnWhite(c);
    var o = typeof opacity === 'number' ? opacity : 1;
    if (o < 1) c = V.mixWithWhite(c, 1 - o);
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  function process(svgSource, options) {
    options = options || {};
    var settings = Object.assign({
      targetW: 1200, targetH: 1200,
      fitPct: 85,
      mode: 'fit', // 'fit' | 'keep'
      bakeOpacity: true,
      removeHidden: true,
      removeDuplicates: true,
      removeUnpainted: true,
      removeCollinear: true,
      outlineText: true
    }, options);
    var findings = [];
    var stats = {
      elements: 0, anchors: 0, removedHidden: 0, removedDuplicates: 0, removedStray: 0, removedZero: 0,
      removedZeroArea: 0, removedUnpainted: 0, removedCollinear: 0, arcsConverted: 0,
      quadsConverted: 0, bakedOpacity: 0, useExpanded: 0, textOutlined: 0,
      gradients: 0, clips: 0, images: 0, filters: 0, masks: 0, patterns: 0,
      originalBBox: null, finalBBox: null
    };

    var svgDoc;
    try {
      if (typeof DOMParser !== 'undefined') {
        svgDoc = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
      } else {
        var jsdom = require('jsdom');
        var dom = new jsdom.JSDOM(svgSource, { contentType: 'image/svg+xml' });
        svgDoc = dom.window.document;
      }
    } catch (e) {
      return { ok: false, findings: [finding('document', 'parse', 'fail', 'Cannot parse: ' + e.message)], stats: stats };
    }
    if (!svgDoc || typeof svgDoc.documentElement === 'undefined') {
      return { ok: false, findings: [finding('document', 'parse', 'fail', 'No SVG document')], stats: stats };
    }
    var parseErr = svgDoc.querySelector('parsererror');
    var root = svgDoc.documentElement;
    if (parseErr || !root || root.localName !== 'svg') {
      findings.push(finding('document', 'parse', 'fail', 'Invalid SVG / XML. File could not be parsed.'));
      return { ok: false, findings: findings, stats: stats };
    }
    findings.push(finding('document', 'parse', 'pass', 'SVG parsed OK'));

    /* ---- document-level checks ---- */
    var scripts = root.querySelectorAll('script, foreignObject, iframe, a[href]');
    if (scripts.length) {
      findings.push(finding('document', 'script', 'warn', scripts.length + ' script/foreignObject/iframe/link element(s) — will be removed.', true));
      for (var si = 0; si < scripts.length; si++) scripts[si].parentNode.removeChild(scripts[si]);
    }
    // strip event handlers
    var withHandlers = root.querySelectorAll('*');
    var handlerCount = 0;
    for (var hi = 0; hi < withHandlers.length; hi++) {
      var elh = withHandlers[hi];
      var names = elh.getAttributeNames ? elh.getAttributeNames() : [];
      for (var hj = 0; hj < names.length; hj++) {
        if (names[hj].indexOf('on') === 0) { elh.removeAttribute(names[hj]); handlerCount++; }
      }
    }
    if (handlerCount) findings.push(finding('document', 'script', 'info', handlerCount + ' event handler attribute(s) removed.', true));

    // external refs
    var extCount = 0;
    root.querySelectorAll('image').forEach(function (img) {
      var src = img.getAttribute('href') || img.getAttribute('xlink:href') || img.getAttribute('src');
      if (src && !src.indexOf) return;
      if (src && src.slice(0, 5) !== 'data:') extCount++;
    });
    if (extCount) findings.push(finding('document', 'external-ref', 'fail', extCount + ' external <image> reference(s) — cannot be embedded in EPS 10. Remove or embed the image.'));

    // styles / classes → resolve later
    var styleTags = root.querySelectorAll('style');
    var hasClasses = root.querySelectorAll('[class]');

    /* ---- features that break EPS 10 ---- */
    var filters = root.querySelectorAll('filter');
    stats.filters = filters.length;
    filters.forEach(function (f) {
      findings.push(finding('effects', 'filter', 'fail', 'Filter "' + (f.getAttribute('id') || '?') + '" (blur/shadow/etc.) is not EPS 10 compatible. Expand in Illustrator: Object → Expand (or Flatten).'));
    });
    var masks = root.querySelectorAll('mask');
    stats.masks = masks.length;
    masks.forEach(function (mk) {
      findings.push(finding('masks', 'opacity-mask', 'fail', 'Opacity <mask> is not EPS 10 compatible. Convert to solid paths (Object → Flatten Transparency) in Illustrator.'));
    });
    var patterns = root.querySelectorAll('pattern');
    stats.patterns = patterns.length;
    patterns.forEach(function (pt) {
      findings.push(finding('effects', 'pattern', 'fail', '<pattern> fill is not EPS 10 compatible. Expand pattern to real geometry in Illustrator.'));
    });
    var anims = root.querySelectorAll('animate, animateTransform, animateMotion, set');
    if (anims.length) findings.push(finding('document', 'anim', 'warn', anims.length + ' animation element(s) removed.', true));
    anims.forEach(function (a) { a.parentNode && a.parentNode.removeChild(a); });

    var gradients = root.querySelectorAll('linearGradient, radialGradient');
    stats.gradients = gradients.length;
    findings.push(finding('effects', 'gradient', 'pass', gradients.length + ' gradient(s) — EPS 10 compatible (shading dictionary).'));
    var blends = 0;
    root.querySelectorAll('*').forEach(function (elx) {
      var stl = elx.getAttribute('style');
      var cls = elx.getAttribute('class');
      if ((stl && /mix-blend-mode/i.test(stl)) || (cls && false)) blends++;
    });
    styleTags.forEach(function (s) {
      if (/mix-blend-mode/i.test(s.textContent || '')) blends += 1;
    });
    if (blends) findings.push(finding('effects', 'blend', 'fail', 'mix-blend-mode used — not EPS 10 compatible. Flatten in Illustrator.'));

    /* ---- expand <use> ---- */
    var useCount = { n: 0 };
    var uses = root.querySelectorAll('use');
    for (var ui = 0; ui < uses.length; ui++) {
      if (uses[ui].parentNode) expandUse(uses[ui], svgDoc, 0, findings, useCount);
    }
    stats.useExpanded = useCount.n;
    if (useCount.n) findings.push(finding('effects', 'live-use', 'pass', useCount.n + ' <use> reference(s) expanded to real geometry.', true));

    /* ---- resolve styles ---- */
    var resolver = resolveStyles(svgDoc);

    /* ---- text outlining ---- */
    if (settings.outlineText) {
      stats.textOutlined = outlineTexts(svgDoc, resolver, findings, options.font || null);
    } else {
      root.querySelectorAll('text').forEach(function (t) {
        findings.push(finding('text', 'outline', 'fail', 'Text element present — outline required (Type → Create Outlines).'));
      });
    }
    var remainingText = root.querySelectorAll('text').length;
    if (remainingText === 0 && stats.textOutlined === 0 && root.querySelectorAll('text').length === 0) {
      if (stats.textOutlined === 0) findings.push(finding('text', 'outline', 'pass', 'No text elements — nothing to outline.'));
    } else if (remainingText === 0 && stats.textOutlined > 0) {
      // already reported pass above
    }

    /* ---- images: convert non-JPEG data images ---- */
    root.querySelectorAll('image').forEach(function (img) {
      var src = img.getAttribute('href') || img.getAttribute('xlink:href') || img.getAttribute('src') || '';
      if (src.slice(0, 5) === 'data:') {
        stats.images++;
        if (src.indexOf('image/jpeg') < 0 && src.indexOf('image/png') >= 0) {
          if (typeof convertImageToJpeg === 'function') {
            var j = convertImageToJpeg(src, 0.92);
            if (j) { img.setAttribute('xlink:href', j); img.setAttribute('href', j); findings.push(finding('effects', 'image', 'pass', 'PNG image converted to embedded JPEG for EPS 10.', true)); return; }
          }
          findings.push(finding('effects', 'image', 'warn', 'Embedded PNG image — will be embedded as JPEG in EPS (auto in browser).'));
        }
      }
    });

    /* ---- walk & clean & inline styles ---- */
    var dupMap = {};
    var removedEmptyGroups = 0;
    var clipIdsUsed = {}, gradIdsUsed = {};

    function collectContent(el, isTop) {
      // returns array of elements that are "content" (drawing or groups), after cleaning
      var out = [];
      var kids = Array.prototype.slice.call(el.children || []);
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        var name = child.localName || '';
        if (name === 'defs' || name === 'title' || name === 'desc' || name === 'metadata' || name === 'style') { out.push({ keepDefs: name === 'defs' ? child : null }); continue; }
        var st = resolver.get(child);
        var hidden = st && isHidden(st);
        if (hidden && settings.removeHidden) {
          stats.removedHidden++;
          continue;
        }
        if (DRAW_TAGS[name]) {
          var okKeep = true;
          if (name === 'image') {
            var src2 = child.getAttribute('href') || child.getAttribute('xlink:href') || child.getAttribute('src') || '';
            if (!src2 || src2.slice(0, 5) !== 'data:') { okKeep = false; findings.push(finding('document', 'external-ref', 'fail', '<image> with external/missing source removed.')); }
          }
          if (name === 'text' && remainingText > 0) {
            // unoutlined text remains -> file not ready; keep element for report but EPS writer will flag
          }
          if (okKeep) out.push({ el: child, st: st, isTop: isTop });
        } else if (CONTAINER_TAGS[name]) {
          var sub = collectContent(child, false);
          var hasContent = sub.some(function (s) { return s.el || s.group; });
          if (!hasContent) {
            removedEmptyGroups++;
            continue;
          }
          // keep group
          out.push({ group: child, children: sub.filter(function (s) { return s.el || s.group; }), st: st, isTop: isTop });
        }
        // other unknown elements (marker, etc.) → skip
      }
      return out;
    }

    // First: gather all content tree
    var tree = collectContent(root, true).filter(function (s) { return s.el || s.group; });

    // Compute per-element: normalized path, dedupe key, bbox
    function analyze(el, st) {
      var name = el.localName || '';
      var d = shapeToPath(el, st);
      var segs = null, arcs = 0, quads = 0, pathErr = false;
      if (d !== null && d !== '' && d !== undefined) {
        var parsed = V.parsePathD(d);
        pathErr = parsed.err;
        parsed.segs.forEach(function (s) { if (s.c === 'A') arcs++; if (s.c === 'Q') quads++; });
        var norm = V.normalizeSegs(parsed.segs);
        var cl = V.cleanupSegs(norm, { removeCollinear: settings.removeCollinear });
        segs = cl.segs;
        stats.removedStray += cl.removedStray;
        stats.removedCollinear += cl.removedCollinear;
        stats.removedZero += cl.removedZero || 0;
      }
      var fill = fillInfo(st);
      var stroke = strokeInfo(st);
      var painted = (fill.kind !== 'none') || (stroke.kind !== 'none');
      return { d: d, segs: segs, arcs: arcs, quads: quads, pathErr: pathErr, fill: fill, stroke: stroke, painted: painted };
    }

    // duplicate detection over all drawing elements
    var dupSeen = {};
    var toRemove = []; // {el, reason}
    var contentEls = [];
    (function flatten(list) {
      list.forEach(function (item) {
        if (item.el) contentEls.push(item);
        if (item.children) flatten(item.children);
      });
    })(tree);

    contentEls.forEach(function (item) {
      var el = item.el, st = item.st;
      var name = el.localName || '';
      if (name === 'text' || name === 'image') return; // not dedup targets
      var info = analyze(el, st);
      item.info = info;
      stats.anchors += info.segs ? V.countAnchors(info.segs) : 0;
      stats.arcsConverted += info.arcs;
      stats.quadsConverted += info.quads;
      if (info.pathErr) findings.push(finding('paths', 'invalid', 'fail', 'Path data contains invalid numbers — path dropped/needs manual fix.', true));
      // opacity baking
      if (settings.bakeOpacity) {
        if (st && typeof st.opacity === 'number' && st.opacity < 1 && name !== 'g') {
          info.fill.baked = true;
          info.stroke.baked = true;
          stats.bakedOpacity++;
        }
        if (st && typeof st['fill-opacity'] === 'number' && st['fill-opacity'] < 1) {
          info.fill.baked = true;
          stats.bakedOpacity++;
        }
        if (st && typeof st['stroke-opacity'] === 'number' && st['stroke-opacity'] < 1) {
          info.stroke.baked = true;
          stats.bakedOpacity++;
        }
      } else {
        if (st && typeof st.opacity === 'number' && st.opacity < 1) {
          findings.push(finding('effects', 'opacity', 'fail', 'Group/element opacity ' + st.opacity + ' — EPS 10 has no transparency. Flatten in Illustrator or enable "bake opacity" in settings.'));
        }
        if (st && typeof st['fill-opacity'] === 'number' && st['fill-opacity'] < 1) {
          findings.push(finding('effects', 'opacity', 'fail', 'fill-opacity ' + st['fill-opacity'] + ' — will be baked onto white background (or flatten in Illustrator).'));
          info.fill.baked = true; stats.bakedOpacity++;
        }
        if (st && typeof st['stroke-opacity'] === 'number' && st['stroke-opacity'] < 1) {
          findings.push(finding('effects', 'opacity', 'fail', 'stroke-opacity ' + st['stroke-opacity'] + ' — will be baked onto white background (or flatten in Illustrator).'));
          info.stroke.baked = true; stats.bakedOpacity++;
        }
      }
      if (info.fill.kind === 'gradient' || info.stroke.kind === 'gradient') {
        if (info.fill.kind === 'gradient') gradIdsUsed[info.fill.url] = true;
        if (info.stroke.kind === 'gradient') {
          gradIdsUsed[info.stroke.url] = true;
          findings.push(finding('stroke', 'grad-stroke', 'warn', 'Gradient stroke detected — EPS 10 supports gradient fills only; stroke will be exported with first stop color.'));
        }
      }
      if (info.stroke.kind !== 'none') {
        var w = info.stroke.width || 1;
        if (w < 0.25) findings.push(finding('stroke', 'thin', 'warn', 'Very thin stroke (' + w + 'px) — verify it is intentional (may disappear at small sizes).'));
        var dash = st ? st['stroke-dasharray'] : 'none';
        if (dash && dash !== 'none' && dash !== '0') {
          /* dashes are EPS-compatible; info only */
        }
      }
      // duplicate key
      if (settings.removeDuplicates && info.segs) {
        var key = V.serializeSegs(info.segs, 2) + '|' + (el.getAttribute('transform') || '') + '|' +
          JSON.stringify([info.fill.raw, info.stroke.raw, info.stroke.width]);
        if (dupSeen[key]) {
          stats.removedDuplicates++;
          toRemove.push(el);
        } else {
          dupSeen[key] = 1;
        }
      }
      // unpainted
      if (settings.removeUnpainted && !info.painted && info.segs) {
        stats.removedUnpainted++;
        toRemove.push(el);
      }
      // zero-area closed shapes without stroke
      if (info.segs && info.stroke.kind === 'none') {
        var bb = V.pathBBox(info.segs);
        if (bb && (bb.w < 1e-3 || bb.h < 1e-3)) {
          // only count as zero-area if it was "closed" originally? keep simple: warn+remove
          stats.removedZeroArea++;
          toRemove.push(el);
        }
      }
    });
    if (stats.removedUnpainted) findings.push(finding('cleanup', 'unpainted', 'warn', stats.removedUnpainted + ' unpainted object(s) removed.', true));
    if (stats.removedZeroArea) findings.push(finding('cleanup', 'empty-objects', 'warn', stats.removedZeroArea + ' zero-area object(s) removed.', true));
    if (stats.removedStray) findings.push(finding('cleanup', 'stray-points', 'warn', stats.removedStray + ' stray point(s) removed.', true));
    if (stats.removedCollinear) findings.push(finding('paths', 'anchor-clean', 'pass', stats.removedCollinear + ' redundant collinear anchor point(s) removed.', true));
    if (stats.arcsConverted) findings.push(finding('paths', 'arc', 'pass', stats.arcsConverted + ' arc command(s) converted to cubic Béziers (EPS-safe).', true));
    if (stats.quadsConverted) findings.push(finding('paths', 'quad', 'pass', stats.quadsConverted + ' quadratic curve(s) converted to cubic Béziers.', true));
    if (stats.anchors > 2500) findings.push(finding('paths', 'anchor-count', 'warn', stats.anchors + ' anchor points — high for this size; consider simplifying if auto-traced.'));
    else findings.push(finding('paths', 'anchor-count', 'pass', stats.anchors + ' anchor points total.'));

    /* ---- build final tree (serialize) ---- */
    var usedClipPaths = {};
    function transformAttr(el) {
      return el.getAttribute('transform') || '';
    }
    function clipPathAttr(el) {
      var cp = el.getAttribute('clip-path');
      if (!cp) {
        var st = resolver.get(el);
        if (st && st['clip-path']) cp = st['clip-path'];
      }
      if (cp && cp.indexOf('url(') === 0) {
        var id = cp.replace(/^url\(\s*/, '').replace(/\s*\)$/, '').replace(/^#/, '');
        usedClipPaths[id] = true;
        return id;
      }
      return null;
    }
    var removedToDedup = new WeakSet();
    toRemove.forEach(function (el) { removedToDedup.add(el); });

    function serializeGroup(gEl, children, st) {
      var attrs = '';
      var tf = transformAttr(gEl);
      if (tf) attrs += ' transform="' + tf + '"';
      var cp = clipPathAttr(gEl);
      if (cp) attrs += ' clip-path="' + cp + '"';
      var stl = resolver.get(gEl);
      var opStr = '';
      if (stl && typeof stl.opacity === 'number' && stl.opacity < 1) {
        if (settings.bakeOpacity) {
          // group opacity cannot be safely baked per-child; mark fail
          findings.push(finding('effects', 'opacity', 'fail', 'Group opacity ' + stl.opacity + ' — EPS 10 has no transparency. Set to 100% or flatten in Illustrator (Object → Flatten Transparency).'));
        } else {
          findings.push(finding('effects', 'opacity', 'fail', 'Group opacity ' + stl.opacity + ' — not EPS 10 compatible.'));
        }
        opStr = ' opacity="' + stl.opacity + '"';
      }
      var inner = '';
      children.forEach(function (child) {
        if (child.el) inner += serializeElement(child.el, child.st, child.info);
        else if (child.children) inner += serializeGroup(child.group, child.children, child.st);
      });
      if (!inner) return '';
      return '<g' + attrs + opStr + '>' + inner + '</g>';
    }
    function serializeElement(el, st, info) {
      if (removedToDedup.has(el)) return '';
      var name = el.localName || '';
      var attrs = '';
      var tf = transformAttr(el);
      if (tf) attrs += ' transform="' + tf + '"';
      var cp = clipPathAttr(el);
      if (cp) attrs += ' clip-path="' + cp + '"';
      if (name === 'image') {
        var src = el.getAttribute('href') || el.getAttribute('xlink:href') || el.getAttribute('src') || '';
        return '<image href="' + src + '" x="' + (el.getAttribute('x') || 0) + '" y="' + (el.getAttribute('y') || 0) +
          '" width="' + (el.getAttribute('width') || 0) + '" height="' + (el.getAttribute('height') || 0) + '"' + attrs + '/>';
      }
      if (name === 'text') {
        return '<text' + attrs + '>' + textOf(el) + '</text>';
      }
      if (!info || !info.segs || !info.segs.length) {
        if (info && info.pathErr) return '';
        return '';
      }
      // mark gradient/clip usage
      if (info.fill.kind === 'gradient') gradIdsUsed[info.fill.url] = true;
      if (info.stroke.kind === 'gradient') gradIdsUsed[info.stroke.url] = true;

      var fillAttr;
      if (info.fill.kind === 'none') fillAttr = 'none';
      else if (info.fill.kind === 'gradient') fillAttr = 'url(#' + info.fill.url + ')';
      else {
        var fc = info.fill.color || [0, 0, 0, 1];
        if (info.fill.baked) fc = V.bakeAlphaOnWhite(fc);
        if (st && typeof st['fill-opacity'] === 'number' && st['fill-opacity'] < 1) fc = V.mixWithWhite(fc, 1 - st['fill-opacity']);
        fillAttr = colorToAttr(fc, 1);
      }
      var strokeAttr = 'none', swAttr = '';
      if (info.stroke.kind !== 'none') {
        var sc = info.stroke.color || [0, 0, 0, 1];
        if (info.stroke.baked) sc = V.bakeAlphaOnWhite(sc);
        if (st && typeof st['stroke-opacity'] === 'number' && st['stroke-opacity'] < 1) sc = V.mixWithWhite(sc, 1 - st['stroke-opacity']);
        strokeAttr = colorToAttr(sc, 1);
        swAttr = ' stroke-width="' + V.fmt(info.stroke.width || 1, 3) + '"';
        // gradient stroke → downgrade to solid first-stop handled by writer; keep url here
        if (info.stroke.kind === 'gradient') { strokeAttr = 'url(#' + info.stroke.url + ')'; }
        var dash = st ? String(st['stroke-dasharray'] || 'none') : 'none';
        if (dash && dash !== 'none' && dash !== '0') attrs += ' stroke-dasharray="' + dash + '"';
        var cap = st ? st['stroke-linecap'] : 'butt';
        if (cap && cap !== 'butt') attrs += ' stroke-linecap="' + cap + '"';
        var join = st ? st['stroke-linejoin'] : 'miter';
        if (join && join !== 'miter') attrs += ' stroke-linejoin="' + join + '"';
        var ml = st ? st['stroke-miterlimit'] : 4;
        if (join === 'miter' && ml !== 4) attrs += ' stroke-miterlimit="' + ml + '"';
      }
      var rule = st ? st['fill-rule'] : 'nonzero';
      var ruleAttr = (rule === 'evenodd') ? ' fill-rule="evenodd"' : '';
      var d = V.serializeSegs(info.segs);
      return '<path d="' + d + '" fill="' + fillAttr + '"' + ruleAttr + ' stroke="' + strokeAttr + '"' + swAttr + attrs + '/>';
    }

    var body = '';
    tree.forEach(function (item) {
      if (item.el) body += serializeElement(item.el, item.st, item.info);
      else if (item.children) body += serializeGroup(item.group, item.children, item.st);
    });

    /* ---- artboard ---- */
    // original artboard
    var origVB = parseViewBox(root.getAttribute('viewBox'));
    var origW = parseFloat(root.getAttribute('width')) || origVB.w;
    var origH = parseFloat(root.getAttribute('height')) || origVB.h;
    var hasViewBox = root.getAttribute('viewBox') !== null;
    if (!hasViewBox) findings.push(finding('artboard', 'artboard', 'warn', 'No viewBox — artboard inferred from content bbox.', true));

    // final bbox: recursive walk carrying ancestor transforms
    var finalBB = null;
    function expandBB(bb, m) {
      var corners = [
        V.applyM(m, bb.x, bb.y), V.applyM(m, bb.x + bb.w, bb.y),
        V.applyM(m, bb.x, bb.y + bb.h), V.applyM(m, bb.x + bb.w, bb.y + bb.h)
      ];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      corners.forEach(function (pt) {
        if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
      });
      if (!finalBB) finalBB = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      else {
        var nx = Math.min(finalBB.x, minX), ny = Math.min(finalBB.y, minY);
        finalBB = {
          x: nx, y: ny,
          w: Math.max(finalBB.x + finalBB.w, maxX) - nx,
          h: Math.max(finalBB.y + finalBB.h, maxY) - ny
        };
      }
    }
    function measure(items, mat) {
      items.forEach(function (item) {
        if (item.el) {
          if (removedToDedup && removedToDedup.has(item.el)) return;
          if (!item.info || !item.info.segs) return;
          var bb = V.pathBBox(item.info.segs);
          if (!bb) return;
          var tfa = transformAttr(item.el);
          var m = tfa ? V.compose(mat, V.parseTransform(tfa)) : mat;
          expandBB(bb, m);
        } else if (item.children) {
          var tfg = transformAttr(item.group);
          var gm = tfg ? V.compose(mat, V.parseTransform(tfg)) : mat;
          measure(item.children, gm);
        }
      });
    }
    measure(tree, V.id());
    if (!finalBB) finalBB = { x: 0, y: 0, w: origW, h: origH };
    stats.finalBBox = finalBB;
    stats.originalBBox = { x: origVB.x, y: origVB.y, w: origW, h: origH };

    var TW = settings.targetW, TH = settings.targetH;
    var scale = 1, tx = 0, ty = 0;
    var bbW = finalBB.w || 1, bbH = finalBB.h || 1;
    var overflow = false;
    if (settings.mode === 'fit') {
      var target = Math.min((TW * settings.fitPct / 100) / bbW, (TH * settings.fitPct / 100) / bbH);
      scale = target;
    } else {
      if (bbW > TW || bbH > TH) {
        // artwork bigger than artboard → must fit to avoid overflow
        scale = Math.min(TW / bbW, TH / bbH);
        overflow = true;
        findings.push(finding('artboard', 'overflow', 'warn', 'Original artwork larger than target artboard — auto-fitted to avoid overflow.', true));
      }
    }
    tx = (TW - bbW * scale) / 2 - finalBB.x * scale;
    ty = (TH - bbH * scale) / 2 - finalBB.y * scale;

    // original artboard checks (before fit)
    if (hasViewBox && settings.mode === 'keep') {
      var offX = Math.abs((origVB.x + origW / 2) - (finalBB.x + finalBB.w / 2));
      var offY = Math.abs((origVB.y + origH / 2) - (finalBB.y + finalBB.h / 2));
      var tol = Math.max(origW, origH) * 0.01;
      if (offX > tol || offY > tol) findings.push(finding('artboard', 'center', 'warn', 'Artwork not centered in original artboard — re-centered.', true));
      if (finalBB.x < origVB.x - 0.5 || finalBB.y < origVB.y - 0.5 ||
        finalBB.x + finalBB.w > origVB.x + origW + 0.5 || finalBB.y + finalBB.h > origVB.y + origH + 0.5) {
        findings.push(finding('artboard', 'overflow', 'fail', 'Artwork overflows original artboard — cannot be fixed in "keep" mode. Switch to Fit mode.'));
      }
    }
    findings.push(finding('artboard', 'artboard', 'pass', 'Artboard ' + TW + '×' + TH + ' px; artwork scaled ' + V.fmt(scale, 4) + '× and centered (fit ' + settings.fitPct + '%).', true));

    var gWrap = '<g transform="translate(' + V.fmt(tx, 4) + ' ' + V.fmt(ty, 4) + ') scale(' + V.fmt(scale, 5) + ')">';

    /* ---- defs: keep only used gradients & clips ---- */
    var defsOut = '';
    if (root.querySelector('defs')) {
      var defsEl = root.querySelector('defs');
      Array.prototype.slice.call(defsEl.children).forEach(function (def) {
        var dn = def.localName;
        var did = def.getAttribute('id') || '';
        if (dn === 'linearGradient' || dn === 'radialGradient') {
          if (gradIdsUsed[did]) {
            def.querySelectorAll('stop').forEach(function (stop) {
              var col = stop.getAttribute('stop-color') || 'black';
              var op = parseFloat(stop.getAttribute('stop-opacity'));
              var c = V.parseColor(col);
              if (Array.isArray(c)) {
                if (isFinite(op) && op < 1) c = V.bakeAlphaOnWhite(c);
                stop.setAttribute('stop-color', 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')');
                stop.setAttribute('stop-opacity', '1');
              }
            });
            defsOut += serializeGradient(def);
          }
        } else if (dn === 'clipPath') {
          if (usedClipPaths[did]) {
            // normalize clip content to path
            var clipOut = '<clipPath id="' + did + '"' + (def.getAttribute('clipPathUnits') ? ' clipPathUnits="' + def.getAttribute('clipPathUnits') + '"' : '') + '>';
            var cc = def.children;
            for (var ci = 0; ci < cc.length; ci++) {
              var cEl = cc[ci];
              var cn = cEl.localName;
              if (cn === 'path' || cn === 'rect' || cn === 'circle' || cn === 'ellipse' || cn === 'line' || cn === 'polygon' || cn === 'polyline') {
                var cd = shapeToPath(cEl, null);
                if (cd) {
                  var cl = V.cleanupSegs(V.normalizeSegs(V.parsePathD(cd).segs), {});
                  clipOut += '<path d="' + V.serializeSegs(cl.segs) + '"/>';
                }
              }
            }
            clipOut += '</clipPath>';
            defsOut += clipOut;
            stats.clips++;
          }
        }
      });
    }
    if (stats.clips) findings.push(finding('masks', 'clip', 'pass', stats.clips + ' clip path(s) kept — EPS 10 supports clipping.'));
    else findings.push(finding('masks', 'clip', 'pass', 'No clip paths.'));
    if (stats.masks === 0) findings.push(finding('masks', 'opacity-mask', 'pass', 'No opacity masks.'));

    /* ---- assemble final SVG ---- */
    var finalSvg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' +
      TW + ' ' + TH + '" width="' + TW + '" height="' + TH + '">' +
      (defsOut ? '<defs>' + defsOut + '</defs>' : '') +
      gWrap + body + '</g></svg>';

    stats.elements = contentEls.length;
    if (removedEmptyGroups) findings.push(finding('cleanup', 'empty-objects', 'info', removedEmptyGroups + ' empty group(s) removed.', true));
    if (styleTags.length && hasClasses.length) findings.push(finding('document', 'css', 'pass', 'CSS classes resolved and inlined to presentation attributes.', true));

    // final artwork summary
    findings.push(finding('artwork', 'hidden', stats.removedHidden ? 'warn' : 'pass',
      stats.removedHidden ? stats.removedHidden + ' hidden object(s) removed.' : 'No hidden objects.', stats.removedHidden > 0));
    findings.push(finding('artwork', 'duplicates', stats.removedDuplicates ? 'warn' : 'pass',
      stats.removedDuplicates ? stats.removedDuplicates + ' duplicate object(s) removed.' : 'No duplicate objects.', stats.removedDuplicates > 0));

    return {
      ok: true,
      svg: finalSvg,
      findings: findings,
      stats: stats,
      artboard: { w: TW, h: TH },
      warnings: {
        textRemaining: remainingText,
        filters: filters.length,
        masks: masks.length,
        patterns: patterns.length,
        blends: blends,
        externalImages: extCount
      }
    };
  }

  function serializeGradient(def) {
    var dn = def.localName;
    var id = def.getAttribute('id');
    var attrs = ' id="' + id + '"';
    if (dn === 'linearGradient') {
      ['x1', 'y1', 'x2', 'y2'].forEach(function (a) { if (def.getAttribute(a)) attrs += ' ' + a + '="' + def.getAttribute(a) + '"'; });
      if (!def.getAttribute('x1')) attrs += ' x1="0" y1="0" x2="1" y2="0"';
      if (def.getAttribute('gradientUnits')) attrs += ' gradientUnits="' + def.getAttribute('gradientUnits') + '"';
      if (def.getAttribute('gradientTransform')) attrs += ' gradientTransform="' + def.getAttribute('gradientTransform') + '"';
      if (def.getAttribute('spreadMethod') && def.getAttribute('spreadMethod') !== 'pad') attrs += ' spreadMethod="' + def.getAttribute('spreadMethod') + '"';
    } else {
      ['cx', 'cy', 'r', 'fx', 'fy'].forEach(function (a) { if (def.getAttribute(a)) attrs += ' ' + a + '="' + def.getAttribute(a) + '"'; });
      if (!def.getAttribute('cx')) attrs += ' cx="0.5" cy="0.5" r="0.5"';
      if (def.getAttribute('gradientUnits')) attrs += ' gradientUnits="' + def.getAttribute('gradientUnits') + '"';
      if (def.getAttribute('gradientTransform')) attrs += ' gradientTransform="' + def.getAttribute('gradientTransform') + '"';
      if (def.getAttribute('spreadMethod') && def.getAttribute('spreadMethod') !== 'pad') attrs += ' spreadMethod="' + def.getAttribute('spreadMethod') + '"';
    }
    var stops = '';
    def.querySelectorAll('stop').forEach(function (s) {
      stops += '<stop offset="' + (s.getAttribute('offset') || '0') + '" stop-color="' + (s.getAttribute('stop-color') || '#000') + '" stop-opacity="' + (s.getAttribute('stop-opacity') || '1') + '"/>';
    });
    return '<' + dn + attrs + '>' + stops + '</' + dn + '>';
  }

  // browser-only helper hook (set by app.js): data URL jpeg → data URL jpeg
  var convertImageToJpeg = null;
  function setJpegConverter(fn) { convertImageToJpeg = fn; }

  return {
    process: process,
    setJpegConverter: setJpegConverter,
    finding: finding,
    _internal: {
      parseStyleRules: parseStyleRules, resolveStyles: resolveStyles,
      fillInfo: fillInfo, strokeInfo: strokeInfo, shapeToPath: shapeToPath,
      textOf: textOf, runWidth: runWidth, numVal: numVal,
      V: V
    }
  };
}));
