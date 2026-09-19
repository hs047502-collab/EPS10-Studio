/*
 * vector-eps10.js — VectorPro-look batch UI: unlimited SVG upload,
 * before → after preview grid for every file, per-file + ZIP EPS 10 download.
 * Reuses the engine modules: VLib, SvgFix, Eps10, Analyze, Audit, opentype.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function downloadBytes(bytes, name) {
    var blob = bytes instanceof Uint8Array ? new Blob([bytes], { type: 'application/octet-stream' }) : new Blob([bytes]);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
  }
  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  var records = [];   // { name, base, original, fixed, eps, report, mkt, final, analysis, status, thumbB, thumbA, error }
  var fontObj = null;
  var busy = false;

  function getSettings() {
    return {
      targetW: Math.max(50, parseInt($('setW').value, 10) || 1200),
      targetH: Math.max(50, parseInt($('setH').value, 10) || 1200),
      fitPct: parseInt($('setFit').value, 10) || 85,
      mode: (document.querySelector('input[name=mode]:checked') || {}).value || 'fit',
      bakeOpacity: $('optBake').checked,
      removeHidden: $('optHidden').checked,
      removeDuplicates: $('optDup').checked,
      removeUnpainted: $('optUnpaint').checked,
      removeCollinear: $('optCollinear').checked,
      outlineText: $('optText').checked,
      profile: $('setProfile').value || 'universal'
    };
  }

  /* ---------- SVG thumbnail rendering (canvas) ---------- */
  function svgDims(svgText, fallback) {
    var m = /viewBox\s*=\s*["']?\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i.exec(svgText);
    var vb = m ? { w: parseFloat(m[3]), h: parseFloat(m[4]) } : null;
    var wm = /<svg[^>]*\bwidth\s*=\s*["']?\s*([-\d.]+)/i.exec(svgText);
    var hm = /<svg[^>]*\bheight\s*=\s*["']?\s*([-\d.]+)/i.exec(svgText);
    var w = vb ? vb.w : (wm ? parseFloat(wm[1]) : (fallback && fallback.w) || 1200);
    var h = vb ? vb.h : (hm ? parseFloat(hm[1]) : (fallback && fallback.h) || 1200);
    if (!(w > 0) || !(h > 0)) { w = 1200; h = 1200; }
    return { w: w, h: h };
  }
  function renderThumb(svgText, dims, px) {
    px = px || 260;
    return new Promise(function (resolve) {
      try {
        var dim = svgDims(svgText, dims);
        // ensure the image has concrete width/height so <img> sizing is deterministic
        var fixed = svgText.replace(/<svg([^>]*)>/i, function (all, attrs) {
          var a = attrs;
          if (!/\bwidth\s*=/i.test(a)) a += ' width="' + dim.w + '"';
          if (!/\bheight\s*=/i.test(a)) a += ' height="' + dim.h + '"';
          return '<svg' + a + '>';
        });
        var blob = new Blob([fixed], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = px; c.height = px;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, px, px);
            var s = Math.min((px - 14) / dim.w, (px - 14) / dim.h);
            var dw = dim.w * s, dh = dim.h * s;
            ctx.drawImage(img, (px - dw) / 2, (px - dh) / 2, dw, dh);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL('image/png'));
          } catch (e) { URL.revokeObjectURL(url); resolve(null); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- file reading ---------- */
  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('FileReader failed')); };
      r.readAsText(file);
    });
  }

  /* ---------- per-file pipeline ---------- */
  async function processOne(rec, settings) {
    rec.status = 'work';
    renderRows();
    try {
      var svgText = await readFileText(rec.file);
      rec.original = svgText;
      var pr = SvgFix.process(svgText, Object.assign({}, settings, { font: settings.outlineText ? fontObj : null }));
      rec.process = pr;
      rec.fixed = pr.svg;
      var er;
      try {
        er = Eps10.generateEPS({ svg: pr.svg, name: rec.base, width: settings.targetW, height: settings.targetH });
      } catch (e) {
        er = { ok: false, findings: [{ section: 'export', item: 'eps-gen', status: 'fail', msg: 'EPS generation error: ' + e.message, autoFixed: false }], checks: { ok: false, checks: [] } };
      }
      rec.eps = er;
      var g = Analyze.parseGeometry(pr.svg, { w: settings.targetW, h: settings.targetH });
      rec.analysis = Analyze.analyze(g.shapes, { w: settings.targetW, h: settings.targetH }, { clips: g.clips });
      rec.report = Audit.buildReport(pr, er.ok ? er : null, true);
      rec.mkt = Audit.marketplaceStatus(settings.profile, {
        report: rec.report,
        exportOk: !!(er.ok && er.checks && er.checks.ok),
        epsCounts: er.counts || null,
        stats: pr.stats || null,
        analysis: rec.analysis,
        artboard: { w: settings.targetW, h: settings.targetH }
      });
      // status badge: FIX if report not ready; REVIEW if marketplace rules fail; else READY FOR REVIEW
      if (!rec.report.ready) rec.status = 'fix';
      else if (!rec.mkt.pass) rec.status = 'review';
      else rec.status = 'ready';
    } catch (e) {
      rec.status = 'error';
      rec.error = e && e.message ? e.message : String(e);
    }
    // thumbnails (before / after)
    var dim = { w: settings.targetW, h: settings.targetH };
    var before = await renderThumb(rec.original, dim, 260);
    var after = rec.fixed ? await renderThumb(rec.fixed, dim, 260) : null;
    rec.thumbB = before; rec.thumbA = after;
    renderRows();
  }

  async function addFiles(fileList) {
    if (busy) return;
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /\.svg$/i.test(f.name) || (f.type && /svg/i.test(f.type));
    });
    if (!files.length) { alert('No SVG files found in the selection.'); return; }
    busy = true;
    $('btnRun').disabled = true;
    var settings = getSettings();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var rec = { name: f.name, base: f.name.replace(/\.svg$/i, ''), file: f, status: 'queued' };
      records.push(rec);
      await processOne(rec, settings);
    }
    busy = false;
    $('btnRun').disabled = false;
    updateBatchBar();
  }

  async function loadSamples() {
    if (busy) return;
    busy = true; $('btnRun').disabled = true;
    try {
      var names = ['01-eagle.svg', '02-leaf.svg', '03-mountain.svg', '04-star.svg', '05-heart.svg',
        '06-tree.svg', '07-fish.svg', '08-moon.svg', '09-flower.svg', '10-house.svg', 'kitchen-sink.svg'];
      var settings = getSettings();
      for (var i = 0; i < names.length; i++) {
        try {
          var resp = await fetch('samples/' + names[i]);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var text = await resp.text();
          var rec = { name: names[i], base: names[i].replace(/\.svg$/, ''), file: null, original: text, status: 'queued' };
          records.push(rec);
          // processOne expects rec.file — bypass by inlining the read
          rec.status = 'work'; renderRows();
          var pr = SvgFix.process(text, Object.assign({}, settings, { font: settings.outlineText ? fontObj : null }));
          rec.process = pr; rec.fixed = pr.svg;
          var er;
          try { er = Eps10.generateEPS({ svg: pr.svg, name: rec.base, width: settings.targetW, height: settings.targetH }); }
          catch (e) { er = { ok: false, findings: [], checks: { ok: false, checks: [] } }; }
          rec.eps = er;
          var g = Analyze.parseGeometry(pr.svg, { w: settings.targetW, h: settings.targetH });
          rec.analysis = Analyze.analyze(g.shapes, { w: settings.targetW, h: settings.targetH }, { clips: g.clips });
          rec.report = Audit.buildReport(pr, er.ok ? er : null, true);
          rec.mkt = Audit.marketplaceStatus(settings.profile, {
            report: rec.report, exportOk: !!(er.ok && er.checks && er.checks.ok),
            epsCounts: er.counts || null, stats: pr.stats || null, analysis: rec.analysis,
            artboard: { w: settings.targetW, h: settings.targetH }
          });
          rec.status = !rec.report.ready ? 'fix' : (!rec.mkt.pass ? 'review' : 'ready');
          var dim = { w: settings.targetW, h: settings.targetH };
          rec.thumbB = await renderThumb(text, dim, 260);
          rec.thumbA = await renderThumb(pr.svg, dim, 260);
          renderRows();
        } catch (e) {
          records.push({ name: names[i], base: names[i].replace(/\.svg$/, ''), status: 'error', error: 'fetch failed: ' + e.message });
          renderRows();
        }
      }
    } finally {
      busy = false; $('btnRun').disabled = false; updateBatchBar();
    }
  }

  /* ---------- rendering ---------- */
  var STATUS_META = {
    queued: { icon: '⏳', label: 'QUEUED', cls: 'work' },
    work: { icon: '⚙️', label: 'PROCESSING', cls: 'work' },
    ready: { icon: '🟢', label: 'READY FOR REVIEW', cls: 'ready' },
    review: { icon: '🟡', label: 'MARKETPLACE REVIEW', cls: 'review' },
    fix: { icon: '🔴', label: 'NEEDS FIX', cls: 'fix' },
    error: { icon: '✗', label: 'ERROR', cls: 'error' }
  };

  function paneHtml(url, tag, cls) {
    return '<div class="bf-pane ' + cls + '"><span class="tag">' + tag + '</span>' +
      (url ? '<img src="' + url + '" alt="' + tag + '">' : '<span class="ph">no preview</span>') + '</div>';
  }

  function cardHtml(rec, i) {
    var sm = STATUS_META[rec.status] || STATUS_META.work;
    var meta = '';
    if (rec.analysis) {
      var epsKb = rec.eps && rec.eps.bytes ? Math.max(1, Math.round(rec.eps.bytes.length / 1024)) : 0;
      meta = rec.analysis.shapeCount + ' objects · ' + rec.analysis.smoothness.anchors + ' anchors' +
        (epsKb ? ' · EPS ' + epsKb + ' KB' : '');
    }
    if (rec.status === 'error') {
      return '<div class="bf-card" data-i="' + i + '">' +
        '<div class="bf-head"><span class="fname">' + esc(rec.name) + '</span><span class="badge error">' + sm.icon + ' ' + sm.label + '</span></div>' +
        '<div class="bf-error">' + esc(rec.error || 'Unknown error') + '</div></div>';
    }
    return '<div class="bf-card" data-i="' + i + '">' +
      '<div class="bf-head"><span class="fname" title="' + esc(rec.name) + '">' + esc(rec.name) + '</span>' +
      '<span class="badge ' + sm.cls + '">' + sm.icon + ' ' + sm.label + '</span></div>' +
      '<div class="bf-pair">' +
      paneHtml(rec.thumbB, 'ORIGINAL', 'before') +
      '<div class="bf-arrow">→</div>' +
      paneHtml(rec.thumbA, 'EPS 10', 'after') +
      '</div>' +
      '<div class="bf-foot"><span class="meta">' + meta + '</span>' +
      '<button class="btn btn-sm btn-ghost" data-act="details">Details</button>' +
      (rec.eps && rec.eps.bytes ? '<button class="btn btn-sm btn-grad" data-act="eps">EPS ⬇</button>' : '<button class="btn btn-sm" disabled>EPS ⬇</button>') +
      '</div></div>';
  }

  function renderRows() {
    var grid = $('grid');
    grid.innerHTML = records.map(cardHtml).join('');
    updateBatchBar();
  }

  function updateBatchBar() {
    var n = records.length;
    var ready = records.filter(function (r) { return r.status === 'ready'; }).length;
    var review = records.filter(function (r) { return r.status === 'review'; }).length;
    var fix = records.filter(function (r) { return r.status === 'fix' || r.status === 'error'; }).length;
    $('barStat').innerHTML = n
      ? '<b>' + n + '</b> file' + (n > 1 ? 's' : '') + ' · <b style="color:var(--green)">' + ready + '</b> ready · <b style="color:var(--amber)">' + review + '</b> review · <b style="color:var(--red)">' + fix + '</b> fix/error'
      : 'Drop SVG files above — no limit on how many.';
    $('btnZip').disabled = !records.some(function (r) { return r.eps && r.eps.bytes; });
    $('btnClear').disabled = !n;
    $('emptyNote').hidden = n > 0;
  }

  /* ---------- details modal ---------- */
  var detailRec = null;
  function openDetails(rec) {
    detailRec = rec;
    if (!rec || !rec.analysis) return;
    var a = rec.analysis, rep = rec.report;
    var epsKb = rec.eps && rec.eps.bytes ? Math.max(1, Math.round(rec.eps.bytes.length / 1024)) : 0;
    var flags = a.quality;
    var findings = [];
    rep.sections.forEach(function (s) {
      s.items.forEach(function (it) {
        if (it.status === 'fail' || it.status === 'warn') {
          findings.push({ cls: it.status, label: s.label + ' — ' + it.label, msgs: it.msgs });
        }
      });
    });
    $('mTitle').textContent = rec.name;
    $('mStatus').innerHTML = (function () {
      var sm = STATUS_META[rec.status];
      return '<span class="badge ' + sm.cls + '">' + sm.icon + ' ' + sm.label + '</span>';
    })();
    $('mBody').innerHTML =
      '<div class="m-big">' +
      paneHtml(rec.thumbB, 'ORIGINAL', 'before') +
      '<div class="bf-arrow">→</div>' +
      paneHtml(rec.thumbA, 'EPS 10', 'after') +
      '</div>' +
      '<div class="kpis">' +
      '<div class="kpi"><div class="k">Artboard</div><div class="v">' + a.artboard.w + ' × ' + a.artboard.h + '</div><div class="s">px</div></div>' +
      '<div class="kpi"><div class="k">Vector objects</div><div class="v">' + a.shapeCount + '</div></div>' +
      '<div class="kpi"><div class="k">Anchor points</div><div class="v">' + a.smoothness.anchors + '</div></div>' +
      '<div class="kpi"><div class="k">EPS 10 file</div><div class="v">' + (epsKb ? epsKb + ' KB' : '—') + '</div><div class="s">' + (rec.eps && rec.eps.checks && rec.eps.checks.ok ? 'Illustrator 10 compatible ✓' : 'export check failed') + '</div></div>' +
      '<div class="kpi"><div class="k">Alignment</div><div class="v">' + (a.offsets.status === 'Centered' ? 'Centered' : 'X ' + a.offsets.x + ' / Y ' + a.offsets.y + ' px') + '</div></div>' +
      '<div class="kpi"><div class="k">Overflow</div><div class="v">' + a.overflow.count + ' object(s)</div></div>' +
      '</div>' +
      '<div class="m-sec">Quality flags</div>' +
      '<div class="flags">' + Object.keys(flags).map(function (k) {
        var f = flags[k];
        var cls = f.level === 'ok' ? 'ok' : f.level;
        return '<div class="flag ' + cls + '"><b>' + f.icon + ' ' + esc(k) + '</b>' + esc(f.msg) + '</div>';
      }).join('') + '</div>' +
      (findings.length
        ? '<div class="m-sec">Findings (fail / warn)</div><ul class="findings">' +
          findings.map(function (f) {
            return '<li class="' + f.cls + '"><b>' + esc(f.label) + '</b>' + (f.msgs && f.msgs.length ? ' — ' + f.msgs.map(esc).join('; ') : '') + '</li>';
          }).join('') + '</ul>'
        : '<div class="m-sec">Findings</div><div class="empty-note" style="padding:8px 0">No failures or warnings — clean pass.</div>') +
      '<div class="m-foot">' +
      (rec.eps && rec.eps.bytes ? '<button class="btn btn-grad" id="mEps">EPS 10 ⬇</button>' : '') +
      '<button class="btn btn-ghost" id="mClose">Close</button>' +
      '</div>';
    $('mEps').onclick = function () { downloadBytes(rec.eps.bytes, rec.base + '.eps'); };
    $('mClose').onclick = closeDetails;
    $('modalOverlay').hidden = false;
  }
  function closeDetails() { $('modalOverlay').hidden = true; }

  /* ---------- downloads ---------- */
  function downloadZip() {
    var parts = [];
    records.forEach(function (rec) {
      if (rec.eps && rec.eps.bytes) parts.push({ name: rec.base + '.eps', data: rec.eps.bytes });
    });
    records.forEach(function (rec) {
      if (rec.fixed) parts.push({ name: 'fixed-svg/' + rec.base + '.svg', data: new TextEncoder().encode(rec.fixed) });
    });
    if (!parts.length) return;
    downloadBytes(VLib.makeZip(parts), 'eps10-batch-' + stamp() + '.zip');
  }

  /* ---------- wiring ---------- */
  function wire() {
    var dz = $('dzInner');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    $('fileInput').addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    $('btnSelect').onclick = function () { $('fileInput').click(); };
    $('btnSamples').onclick = loadSamples;
    $('btnZip').onclick = downloadZip;
    $('btnClear').onclick = function () {
      if (!records.length) return;
      if (!confirm('Clear all ' + records.length + ' processed files?')) return;
      records = [];
      renderRows();
    };
    $('btnRun').onclick = function () { $('fileInput').click(); };

    // font loader
    $('fontBtn').onclick = function () { $('fontInput').click(); };
    $('fontInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          fontObj = opentype.parse(r.result);
          $('fontName').textContent = '✓ ' + f.name;
        } catch (err) {
          fontObj = null;
          $('fontName').textContent = '✗ failed to parse font (' + (err && err.message ? err.message : err) + ')';
          $('fontName').style.color = 'var(--red)';
        }
      };
      r.readAsArrayBuffer(f);
    });

    $('setFit').addEventListener('input', function (e) { $('fitVal').textContent = e.target.value + '%'; });

    // grid delegation
    $('grid').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var card = e.target.closest('.bf-card');
      if (!card) return;
      var rec = records[parseInt(card.getAttribute('data-i'), 10)];
      if (!rec) return;
      if (btn.getAttribute('data-act') === 'details') openDetails(rec);
      else if (btn.getAttribute('data-act') === 'eps' && rec.eps && rec.eps.bytes) downloadBytes(rec.eps.bytes, rec.base + '.eps');
    });

    $('mCloseX').onclick = closeDetails;
    $('modalOverlay').addEventListener('click', function (e) { if (e.target === $('modalOverlay')) closeDetails(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetails(); });
  }

  // automation hook
  window.__vectorEps10 = { addFiles: addFiles, loadSamples: loadSamples, records: records, getSettings: getSettings };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
