/*
 * app.js — UI glue for EPS 10 Studio
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var fontObj = null;
  var records = []; // processed file records (kept across re-runs via record.rawFile)

  /* ---------- marketplace profiles ---------- */
  var profiles = Audit.PROFILES;
  var profileSel = $('profileSel');
  Object.keys(profiles).forEach(function (k) {
    var o = document.createElement('option');
    o.value = k;
    o.textContent = profiles[k].name;
    profileSel.appendChild(o);
  });
  function renderTips() {
    var p = profiles[profileSel.value];
    var ul = $('profileTips');
    ul.innerHTML = '';
    var li0 = document.createElement('li');
    li0.innerHTML = '<b style="color:var(--text)">' + p.name + ':</b> ' + p.desc;
    ul.appendChild(li0);
    p.tips.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
  }
  profileSel.onchange = renderTips;
  renderTips();

  /* ---------- master standard tree ---------- */
  var STD_TEXT = {
    document: 'EPSF-3.0 · PS Level 2 · RGB · no external refs · no scripts',
    artboard: 'design centered · balanced spacing · no overflow · consistent size',
    artwork: 'clean groups · no duplicates · no hidden · no stray objects',
    paths: 'clean anchors · smooth curves · correct compound paths · no junk overlaps',
    text: 'fonts outlined · no missing fonts · no font dependency',
    stroke: 'consistent · valid · no accidental hairlines',
    effects: 'no transparency · gradients OK · no live filters · no blend modes',
    masks: 'valid clip paths · no opacity masks · nothing trapped inside masks',
    cleanup: 'no stray points · no empty objects · no unpainted · no unused defs',
    export: 'EPS 10 · 7-bit clean · structure validated · preview · reopen test'
  };
  (function buildStd() {
    var wrap = $('standardTree');
    Audit.SECTIONS.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'std-item';
      d.innerHTML = '<b>' + s.no + '. ' + s.name + '</b><span>' + (STD_TEXT[s.id] || '') + '</span>';
      wrap.appendChild(d);
    });
  })();

  /* ---------- settings ---------- */
  function getSettings() {
    return {
      targetW: Math.max(50, parseInt($('setW').value, 10) || 1200),
      targetH: Math.max(50, parseInt($('setH').value, 10) || 1200),
      fitPct: parseInt($('setFit').value, 10) || 85,
      mode: document.querySelector('input[name=mode]:checked').value,
      bakeOpacity: $('optBake').checked,
      removeHidden: $('optHidden').checked,
      removeDuplicates: $('optDup').checked,
      removeUnpainted: $('optUnpaint').checked,
      removeCollinear: $('optCollinear').checked,
      outlineText: $('optText').checked
    };
  }
  $('setFit').oninput = function (e) { $('fitVal').textContent = e.target.value + '%'; };
  document.querySelectorAll('input[name=mode]').forEach(function (r) {
    r.addEventListener('change', markSettingsDirty);
  });
  ['setW', 'setH', 'optBake', 'optHidden', 'optDup', 'optUnpaint', 'optCollinear', 'optText'].forEach(function (id) {
    $(id).addEventListener('change', markSettingsDirty);
  });
  function markSettingsDirty() {
    if (records.length) $('btnRerun').disabled = false;
  }

  /* ---------- font ---------- */
  $('fontInput').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        fontObj = window.opentype.parse(reader.result);
        $('fontName').textContent = '✓ ' + f.name;
      } catch (err) {
        fontObj = null;
        $('fontName').textContent = '✗ ' + f.name + ' (parse error)';
      }
    };
    reader.readAsArrayBuffer(f);
  };

  /* ---------- files in ---------- */
  var dz = $('dropzone');
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', function (e) {
    var fs = Array.prototype.slice.call(e.dataTransfer.files).filter(function (f) {
      return /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
    });
    if (fs.length) addFiles(fs);
    else alert('Please drop .svg files only.');
  });
  $('fileInput').onchange = function (e) {
    var fs = Array.prototype.slice.call(e.target.files);
    if (fs.length) addFiles(fs);
    e.target.value = '';
  };

  /* ---------- image preprocessing (PNG data → JPEG) ---------- */
  function pngToJpeg(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width || 100;
          c.height = img.naturalHeight || img.height || 100;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/jpeg', 0.92));
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }
  async function preprocessImages(svgText) {
    var imgRe = /data:image\/(?:png|gif);base64,([A-Za-z0-9+\/=]+)/g;
    var m, seen = {}, out = svgText;
    while ((m = imgRe.exec(svgText))) {
      if (seen[m[1]]) continue;
      seen[m[1]] = true;
      var jpeg = await pngToJpeg(m[0]);
      if (jpeg) out = out.split(m[0]).join(jpeg);
    }
    return out;
  }

  /* ---------- thumbnail ---------- */
  function svgSizeOf(svgText, fallback) {
    var w = null, h = null;
    var m = svgText.match(/<svg[^>]*viewBox\s*=\s*["']([^"']+)["']/i);
    if (m) {
      var p = m[1].split(/[\s,]+/).map(parseFloat);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) { w = p[2]; h = p[3]; }
    }
    var mw = svgText.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
    var mh = svgText.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
    if (mw) w = parseFloat(mw[1]);
    if (mh) h = parseFloat(mh[1]);
    if (!w || !h) { w = fallback && fallback.w ? fallback.w : 1000; h = fallback && fallback.h ? fallback.h : 1000; }
    return { w: w, h: h };
  }
  function renderThumb(svgText, fallback) {
    return new Promise(function (resolve) {
      try {
        var size = 124;
        var blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          try {
            var dim = svgSizeOf(svgText, fallback);
            var c = document.createElement('canvas');
            c.width = size; c.height = size;
            var ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
            var s = Math.min(size / dim.w, size / dim.h) * 0.94;
            var dw = dim.w * s, dh = dim.h * s;
            ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL('image/png'));
          } catch (e) { URL.revokeObjectURL(url); resolve(null); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- processing ---------- */
  async function processOne(rec, settings) {
    rec.status = 'work';
    renderRows();
    try {
      var svgText = (typeof rec.rawFile.text === 'function')
        ? await rec.rawFile.text()
        : await new Promise(function (res, rej) {
            var r = new FileReader();
            r.onload = function () { res(r.result); };
            r.onerror = function () { rej(new Error('FileReader failed')); };
            r.readAsText(rec.rawFile);
          });
      svgText = await preprocessImages(svgText);
      rec.original = svgText;
      var pr = SvgFix.process(svgText, Object.assign({}, settings, {
        font: (settings.outlineText && fontObj) ? fontObj : null
      }));
      rec.process = pr;
      if (!pr.ok) {
        rec.status = 'error';
        rec.error = (pr.findings || []).map(function (f) { return f.msg; }).join(' · ');
        renderRows();
        return;
      }
      var er = null;
      try {
        er = Eps10.generateEPS({
          svg: pr.svg,
          name: rec.base,
          width: settings.targetW,
          height: settings.targetH
        });
      } catch (e) {
        er = { ok: false, findings: [{ section: 'export', item: 'eps-gen', status: 'fail', msg: 'EPS generation error: ' + e.message, autoFixed: false }], checks: { ok: false, checks: [] } };
      }
      rec.eps = er;
      var before = await renderThumb(svgText);
      var after = await renderThumb(pr.svg, { w: settings.targetW, h: settings.targetH });
      rec.thumbs = { before: before, after: after };
      rec.report = Audit.buildReport(pr, er.ok ? er : null, !!after);
      // ---- preflight state (items 36-54): versions + geometry analysis ----
      rec.artboard = { w: settings.targetW, h: settings.targetH };
      rec.currentSvg = pr.svg;
      rec.versions = [
        { v: 1, name: 'Original upload', svg: svgText, time: Date.now() },
        { v: 2, name: 'Artboard + auto-fix (centered)', svg: pr.svg, time: Date.now() }
      ];
      rec.pf = { silhouette: false, ipOk: false, tol: 1, snap: 2, compareV: null, cmpUrls: null,
        previewSvg: null, previewKind: null, previewAfterUrl: null, note: '' };
      refreshGeometry(rec);
    } catch (e) {
      rec.status = 'error';
      rec.error = e.message;
    }
    renderRows();
  }

  async function addFiles(fileList) {
    $('btnRerun').disabled = true;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rec = {
        rawFile: f,
        name: f.name,
        base: f.name.replace(/\.svg$/i, ''),
        size: f.size,
        status: 'pending'
      };
      records.push(rec);
    }
    $('batchCard').hidden = false;
    renderRows();
    var settings = getSettings();
    for (var j = 0; j < records.length; j++) {
      if (records[j].status === 'pending') {
        await processOne(records[j], settings);
      }
    }
    $('btnRerun').disabled = records.length === 0;
  }

  $('btnRerun').onclick = async function () {
    var settings = getSettings();
    for (var i = 0; i < records.length; i++) {
      await processOne(records[i], settings);
    }
    $('btnRerun').disabled = true;
  };

  /* ---------- rendering ---------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
  function statusOf(rec) {
    if (rec.status === 'work') return '<span class="status-pill status-work">PROCESSING…</span>';
    if (rec.status === 'pending') return '<span class="status-pill status-work">QUEUED</span>';
    if (rec.status === 'error') return '<span class="status-pill status-error">ERROR</span>';
    if (rec.status === 'ready') return '<span class="status-pill status-ready">✓ UPLOAD READY</span>';
    return '<span class="status-pill status-fix">⚠ MANUAL FIX</span>';
  }
  function renderRows() {
    var tbody = $('batchBody');
    tbody.innerHTML = '';
    var ready = 0, total = records.length;
    records.forEach(function (rec, idx) {
      if (rec.status === 'ready') ready++;
      var tr = document.createElement('tr');
      var thumbHtml = '<div class="thumbs"><div class="thumb">' +
        (rec.thumbs && rec.thumbs.before ? '<img alt="before" src="' + rec.thumbs.before + '">' : '<span class="hint">–</span>') +
        '</div><span class="thumb-arrow">→</span><div class="thumb">' +
        (rec.thumbs && rec.thumbs.after ? '<img alt="after" src="' + rec.thumbs.after + '">' : '<span class="hint">–</span>') +
        '</div></div>';
      var sub;
      if (rec.status === 'error') {
        sub = '<div class="file-sub" style="color:#ff9089">' + esc(rec.error || 'unknown error') + '</div>';
      } else if (rec.status === 'fix' && rec.report) {
        var blocking = [];
        rec.report.sections.forEach(function (s) {
          s.items.forEach(function (i) {
            if (i.status === 'fail' && i.msgs && i.msgs[0]) blocking.push(i.label);
          });
        });
        sub = '<div class="file-sub">' + kb(rec.size) + (rec.eps && rec.eps.bytes ? ' → EPS ' + kb(rec.eps.bytes.length) : '') +
          (blocking.length ? ' · blocking: ' + esc(blocking.slice(0, 2).join(', ') + (blocking.length > 2 ? '…' : '')) : '') + '</div>';
      } else {
        sub = '<div class="file-sub">' + kb(rec.size) + (rec.eps && rec.eps.bytes ? ' → EPS ' + kb(rec.eps.bytes.length) : '') + '</div>';
      }
      var art = '–';
      if (rec.process && rec.process.ok) {
        var st = rec.process.stats;
        art = rec.process.artboard.w + '×' + rec.process.artboard.h + ' px<br>' + st.elements + ' elements · ' + st.anchors + ' anchors';
      }
      var score = '–';
      if (rec.report) {
        var t = rec.report.totals;
        score = '<div class="score"><span class="chip pass">' + t.pass + ' pass</span>' +
          (t.warn ? '<span class="chip warn">' + t.warn + ' warn</span>' : '') +
          (t.fail ? '<span class="chip fail">' + t.fail + ' fail</span>' : '') + '</div>';
      }
      var actions = '<div class="actions-cell">' +
        '<button class="btn btn-sm" data-act="report" data-i="' + idx + '">Report</button>' +
        (rec.analysis ? '<button class="btn btn-sm btn-acc" data-act="pf" data-i="' + idx + '">Preflight</button>' : '') +
        (rec.eps && rec.eps.bytes ? '<button class="btn btn-sm btn-acc" data-act="eps" data-i="' + idx + '">EPS ⬇</button>' : '') +
        (rec.process && rec.process.ok ? '<button class="btn btn-sm btn-ghost" data-act="svg" data-i="' + idx + '">SVG ⬇</button>' : '') +
        '</div>';
      tr.innerHTML =
        '<td>' + thumbHtml + '</td>' +
        '<td><div class="file-name">' + esc(rec.name) + '</div>' + sub + '</td>' +
        '<td class="art-cell">' + art + '</td>' +
        '<td>' + score + '</td>' +
        '<td>' + statusOf(rec) + '</td>' +
        '<td>' + actions + '</td>';
      tbody.appendChild(tr);
    });
    var rc = $('readyCount');
    rc.textContent = ready + ' / ' + total + ' ready';
    rc.style.color = ready === total && total > 0 ? '#7ee292' : '';
    $('btnZip').disabled = ready === 0;
  }

  /* ---------- downloads ---------- */
  function downloadBytes(bytes, name) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  $('btnZip').onclick = function () {
    var parts = [];
    records.forEach(function (rec) {
      if (rec.eps && rec.eps.bytes) parts.push({ name: rec.base + '.eps', data: rec.eps.bytes });
    });
    records.forEach(function (rec) {
      if (rec.process && rec.process.ok) {
        parts.push({ name: 'fixed-svg/' + rec.base + '.svg', data: new TextEncoder().encode(rec.process.svg) });
      }
    });
    var zip = VLib.makeZip(parts);
    downloadBytes(zip, 'eps10-batch-' + stamp() + '.zip');
  };
  $('batchBody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var rec = records[parseInt(btn.getAttribute('data-i'), 10)];
    var act = btn.getAttribute('data-act');
    if (act === 'report') openReport(rec);
    else if (act === 'eps' && rec.eps && rec.eps.bytes) downloadBytes(rec.eps.bytes, rec.base + '.eps');
    else if (act === 'svg' && rec.process) downloadBytes(new TextEncoder().encode(rec.currentSvg || rec.process.svg), rec.base + '-fixed.svg');
  });

  /* ---------- report dialog ---------- */
  var ICONS = { pass: '✓', warn: '!', fail: '✕', info: 'ℹ' };
  function openReport(rec) {
    if (!rec.report) return;
    $('reportTitle').textContent = 'Audit report — ' + rec.name;
    var t = rec.report.totals;
    $('reportSummary').innerHTML =
      '<span class="chip pass">' + t.pass + ' pass</span>' +
      '<span class="chip warn">' + t.warn + ' warn</span>' +
      '<span class="chip fail">' + t.fail + ' fail</span>' +
      '<span class="chip info">' + (rec.report.ready ? 'READY FOR UPLOAD' : 'NOT READY — fix the failing items') + '</span>';
    var body = $('reportBody');
    body.innerHTML = '';
    rec.report.sections.forEach(function (sec) {
      if (!sec.items.length) return;
      var div = document.createElement('div');
      div.className = 'rep-section';
      var h4 = document.createElement('h4');
      h4.innerHTML = '<span class="sec-no">' + sec.no + '</span> ' + esc(sec.name) +
        ' <span class="chip ' + (sec.status === 'fail' ? 'fail' : sec.status === 'warn' ? 'warn' : 'pass') + '">' +
        (sec.status === 'fail' ? 'FAIL' : sec.status === 'warn' ? 'WARN' : 'PASS') + '</span>';
      div.appendChild(h4);
      sec.items.forEach(function (it) {
        var d = document.createElement('div');
        d.className = 'rep-item';
        var msg = (it.msgs || []).filter(Boolean).map(esc).join('<br>');
        d.innerHTML =
          '<span class="ic ' + it.status + '">' + (ICONS[it.status] || '·') + '</span>' +
          '<div class="body"><div class="label">' + esc(it.label) +
          (it.autoFixed ? '<span class="autofix-tag">auto-fixed</span>' : '') + '</div>' +
          (msg ? '<div class="msg">' + msg + '</div>' : '') +
          '</div>';
        div.appendChild(d);
      });
      body.appendChild(div);
    });
    $('reportOverlay').hidden = false;
  }
  $('reportClose').onclick = function () { $('reportOverlay').hidden = true; };
  $('reportOverlay').addEventListener('click', function (e) {
    if (e.target === $('reportOverlay')) $('reportOverlay').hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { $('reportOverlay').hidden = true; $('preflightOverlay').hidden = true; }
  });

  /* ================= PREFLIGHT (items 36–54) ================= */
  var pfRec = null; // record currently open in the preflight dialog

  var PIPELINE_STEPS = [
    { label: 'Upload SVG' },
    { label: 'Validate' },
    { label: 'Artboard' },
    { label: 'Measure BBox' },
    { label: 'Auto-center' },
    { label: 'Structure' },
    { label: 'Cleanup' },
    { label: 'Text outline' },
    { label: 'EPS 10 compat' },
    { label: 'Generate + reopen test' },
    { label: 'Marketplace rules' },
    { label: 'Final report' }
  ];

  function refreshGeometry(rec) {
    if (!rec.currentSvg || !rec.artboard) return;
    var g = Analyze.parseGeometry(rec.currentSvg, rec.artboard);
    rec.shapes = g.shapes;
    rec.analysis = Analyze.analyze(g.shapes, rec.artboard, { silhouette: !!(rec.pf && rec.pf.silhouette), clips: g.clips });
    refreshStatus(rec);
  }

  function refreshStatus(rec) {
    var a = rec.analysis;
    rec.mkt = Audit.marketplaceStatus(profileSel.value, {
      report: rec.report,
      exportOk: !!(rec.eps && rec.eps.ok && rec.eps.checks && rec.eps.checks.ok),
      epsCounts: rec.eps && rec.eps.counts ? rec.eps.counts : null,
      stats: rec.process ? rec.process.stats : null,
      analysis: a,
      artboard: rec.artboard
    });
    rec.final = Audit.finalStatus(rec.report, rec.mkt, !!(rec.pf && rec.pf.ipOk));
    rec.status = rec.report.ready ? (rec.final.final === 'NEEDS FIX' ? 'fix' : 'ready') : 'fix';
  }

  function pipelineState(rec) {
    var a = rec.analysis, st = rec.report, ok = rec.process && rec.process.ok;
    var epsOk = rec.eps && rec.eps.ok && rec.eps.checks && rec.eps.checks.ok;
    function sec(id) {
      var s = st && st.sections.filter(function (x) { return x.id === id; })[0];
      return s ? s.status : null;
    }
    return [
      rec.original ? 1 : 0,
      ok ? 1 : (rec.status === 'error' ? 2 : 0),
      ok ? 1 : 0,
      ok && a ? 1 : 0,
      ok && a ? (a.offsets.status === 'Centered' ? 1 : 2) : 0,
      ok ? 1 : 0,
      ok ? 1 : 0,
      ok ? (sec('text') === 'fail' ? 2 : 1) : 0,
      ok ? (sec('effects') === 'fail' ? 2 : 1) : 0,
      epsOk ? 1 : (ok ? 2 : 0),
      rec.mkt ? (rec.mkt.pass ? 1 : 2) : 0,
      a && rec.final ? 1 : 0
    ];
  }

  /* ---- non-destructive shape operations (Original → Preview → Apply) ---- */
  function artworkEls(doc) {
    return Array.prototype.slice.call(doc.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon'))
      .filter(function (el) { return !(el.closest && el.closest('defs, clipPath, marker, symbol, pattern, mask')); });
  }
  function applyShapeOps(svg, ab, passes) {
    var out = svg;
    passes.forEach(function (p) {
      var doc = new DOMParser().parseFromString(out, 'image/svg+xml');
      var g = Analyze.parseGeometry(out, ab);
      var els = artworkEls(doc);
      els.forEach(function (el, i) {
        var s = g.shapes[i];
        if (!s) return;
        if (p.kind === 'repair') el.setAttribute('d', Analyze.repairShape(s, p.opts || { snapTol: 2 }).d);
        else if (p.kind === 'simplify') el.setAttribute('d', Analyze.rdpSimplify(s, p.tol).d);
      });
      out = new XMLSerializer().serializeToString(doc);
    });
    return out;
  }

  async function regenerateEps(rec) {
    try {
      rec.eps = Eps10.generateEPS({ svg: rec.currentSvg, name: rec.base, width: rec.artboard.w, height: rec.artboard.h });
    } catch (e) {
      rec.eps = { ok: false, findings: [{ section: 'export', item: 'eps-gen', status: 'fail', msg: 'EPS generation error: ' + e.message, autoFixed: false }], checks: { ok: false, checks: [] } };
    }
    rec.report = Audit.buildReport(rec.process, rec.eps.ok ? rec.eps : null, !!(rec.thumbs && rec.thumbs.after));
    var after = await renderThumb(rec.currentSvg, rec.artboard);
    if (after) rec.thumbs.after = after;
  }

  function opPasses(rec, kind) {
    return kind === 'simplify' ? [{ kind: 'simplify', tol: rec.pf.tol }] : [{ kind: 'repair', opts: { snapTol: rec.pf.snap } }];
  }

  async function previewOp(rec, kind) {
    var newSvg = applyShapeOps(rec.currentSvg, rec.artboard, opPasses(rec, kind));
    rec.pf.previewSvg = newSvg;
    rec.pf.previewKind = kind;
    rec.pf.previewAfterUrl = await renderThumb(newSvg, rec.artboard);
    renderPreflight(rec);
  }

  async function applyOp(rec, kind) {
    var passes = opPasses(rec, kind);
    var newSvg = applyShapeOps(rec.currentSvg, rec.artboard, passes);
    var name = kind === 'simplify' ? 'Smart Simplify (tol ' + r1(rec.pf.tol) + 'px)' : 'Path Repair (snap ' + r1(rec.pf.snap) + 'px)';
    rec.currentSvg = newSvg;
    rec.versions.push({ v: rec.versions.length + 1, name: name, svg: newSvg, time: Date.now() });
    rec.pf.previewSvg = null; rec.pf.previewKind = null; rec.pf.previewAfterUrl = null;
    await regenerateEps(rec);
    refreshGeometry(rec);
    renderRows();
    renderPreflight(rec);
  }

  async function translateArtwork(rec, dx, dy, name) {
    var doc = new DOMParser().parseFromString(rec.currentSvg, 'image/svg+xml');
    var root = doc.documentElement;
    var wrap = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    wrap.setAttribute('transform', 'translate(' + VLib.fmt(dx) + ' ' + VLib.fmt(dy) + ')');
    Array.prototype.slice.call(root.children).forEach(function (ch) {
      if (ch.localName !== 'defs') wrap.appendChild(ch);
    });
    root.appendChild(wrap);
    var newSvg = new XMLSerializer().serializeToString(doc);
    rec.currentSvg = newSvg;
    rec.versions.push({ v: rec.versions.length + 1, name: name, svg: newSvg, time: Date.now() });
    rec.pf.note = '';
    await regenerateEps(rec);
    refreshGeometry(rec);
    renderRows();
    renderPreflight(rec);
  }

  async function recenter(rec) {
    var a = rec.analysis, bb = a.artworkBBox, ab = rec.artboard;
    var dx = (ab.w - bb.w) / 2 - bb.x, dy = (ab.h - bb.h) / 2 - bb.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      rec.pf.note = 'Artwork is already centered (X/Y offset < 0.5 px).';
      renderPreflight(rec);
      return;
    }
    await translateArtwork(rec, dx, dy, 'Re-centered (dx ' + VLib.fmt(dx) + ', dy ' + VLib.fmt(dy) + ')');
  }

  async function nudgeArtwork(rec, dx, dy) {
    if (!dx && !dy) {
      rec.pf.note = 'Enter a non-zero X or Y offset, then click Nudge.';
      renderPreflight(rec);
      return;
    }
    await translateArtwork(rec, dx, dy, 'Fine-adjust (dx ' + VLib.fmt(dx) + ', dy ' + VLib.fmt(dy) + ')');
  }

  async function restoreVersion(rec, i) {
    var v = rec.versions[i];
    if (!v) return;
    rec.currentSvg = v.svg;
    rec.versions.push({ v: rec.versions.length + 1, name: 'Restored Version ' + v.v + ' (' + v.name + ')', svg: v.svg, time: Date.now() });
    rec.pf.note = '';
    await regenerateEps(rec);
    refreshGeometry(rec);
    renderRows();
    renderPreflight(rec);
  }

  async function compareVersions(rec, vIdx) {
    var vr = rec.versions[vIdx];
    rec.pf.compareV = vIdx;
    var urlA = await renderThumb(vr.svg, rec.artboard);
    rec.pf.cmpUrls =
      '<div class="pp"><span class="tag">Version ' + vr.v + ' — ' + esc(vr.name) + '</span>' + (urlA ? '<img src="' + urlA + '">' : '') + '</div>' +
      '<div class="pp"><span class="tag">Current — Version ' + rec.versions.length + '</span>' + (rec.thumbs.after ? '<img src="' + rec.thumbs.after + '">' : '') + '</div>';
    renderPreflight(rec);
  }

  function r1(x) { return Math.round(x * 10) / 10; }
  function kpi(k, v, s) {
    return '<div class="pf-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  }

  function pipeHtml(rec) {
    var st = pipelineState(rec);
    return '<div class="pipeline">' + PIPELINE_STEPS.map(function (s, i) {
      var cls = st[i] === 1 ? 'done' : st[i] === 2 ? 'fail' : '';
      var ic = st[i] === 1 ? '✓' : st[i] === 2 ? '✗' : String(i + 1);
      return '<span class="pipe-step ' + cls + '"><span class="dot">' + ic + '</span>' + esc(s.label) + '</span>';
    }).join('') + '</div>';
  }

  function finalHtml(rec) {
    var f = rec.final;
    var cls = f.final === 'READY TO SUBMIT' ? 'ready' : f.final === 'NEEDS REVIEW' ? 'review' : 'fix';
    return '<div class="pf-sec"><h4>Final status — 3-tier marketplace check</h4>' +
      '<div class="pf-grid c3">' +
      '<div class="tier ' + (f.technical.ok ? 'ok' : 'bad') + '"><div class="tic">' + (f.technical.ok ? '🟢' : '🔴') + '</div><div><div class="tl">' + f.technical.label + '</div><div class="tv">' + f.technical.status + '</div><div class="ts">' + f.technical.fails + ' fail · ' + f.technical.warns + ' open warn</div></div></div>' +
      '<div class="tier ' + (f.marketplace.ok ? 'ok' : 'bad') + '"><div class="tic">' + (f.marketplace.ok ? '🟢' : '🔴') + '</div><div><div class="tl">' + f.marketplace.label + '</div><div class="tv">' + f.marketplace.status + '</div><div class="ts">' + esc(f.marketplace.profile) + ' — ' + esc(f.marketplace.detail) + '</div></div></div>' +
      '<div class="tier ' + (f.contentIp.ok ? 'ok' : 'warn') + '"><div class="tic">' + (f.contentIp.ok ? '🟢' : '⚠️') + '</div><div><div class="tl">' + f.contentIp.label + '</div><div class="tv">' + (f.contentIp.ok ? 'Acknowledged' : 'Manual review required') + '</div><div class="ts">' + esc(f.contentIp.status) + '</div></div></div>' +
      '</div>' +
      '<div style="margin-top:10px"><label class="checkbox-line"><input type="checkbox" id="pfIp" ' + (rec.pf.ipOk ? 'checked' : '') + '> I have manually reviewed this artwork for content/IP issues (trademarks, brands, copyrighted characters, real people)</label></div>' +
      '<div class="final-banner ' + cls + '" style="margin-top:12px">' + f.finalIcon + ' ' + f.final + '</div></div>';
  }

  function alignHtml(rec) {
    var a = rec.analysis, o = a.offsets, m = a.margins;
    return '<div class="pf-sec"><h4>Artwork-to-Artboard alignment <span class="pf-muted">mode 1: Auto Center · mode 2: Manual fine-adjust — adaptive balance threshold ' + m.thresholds.balance + 'px (5% of artboard) · tight = ' + m.thresholds.tight + 'px</span></h4>' +
      '<div class="pf-grid c4">' +
      kpi('X Offset', o.x + ' px', o.x === 0 ? 'perfect' : 'off-center') +
      kpi('Y Offset', o.y + ' px', o.y === 0 ? 'perfect' : 'off-center') +
      kpi('Status', o.status === 'Centered' ? '🟢 Centered' : '🟡 ' + o.status, 'fine-adjust via Re-center') +
      kpi('Min margin', m.minMargin + ' px', m.tight ? '⚠️ close to edge' : 'within safe zone') +
      '</div>' +
      '<div class="margin-map" style="margin-top:10px">' +
      '<div></div><div class="mm">Top<b>' + m.top + ' px</b></div><div></div>' +
      '<div class="mm">Left<b>' + m.left + ' px</b></div><div class="mm-center">Artwork ' + Math.round(a.artworkBBox.w) + ' × ' + Math.round(a.artworkBBox.h) + ' px<br>' + m.icon + ' ' + m.status.toUpperCase() + '</div><div class="mm">Right<b>' + m.right + ' px</b></div>' +
      '<div></div><div class="mm">Bottom<b>' + m.bottom + ' px</b></div><div></div>' +
      '</div>' +
      (rec.pf.note ? '<p class="pf-note" style="margin-top:8px">' + esc(rec.pf.note) + '</p>' : '') +
      '<div class="op-row" style="margin-top:12px;flex-wrap:wrap">' +
      '<label class="pf-muted">Manual fine-adjust: X <input type="number" id="pfNudgeX" value="0" step="1" style="width:76px"> px &nbsp; Y <input type="number" id="pfNudgeY" value="0" step="1" style="width:76px"> px</label>' +
      '<button class="btn btn-sm" data-pfop="nudge">Nudge artwork</button>' +
      '<span class="pf-muted">— or use <b>Auto Center</b> (Re-center) in the overflow section. Every move is saved as a new version.</span>' +
      '</div></div>';
  }

  function ovMarkStyle(b, rec) {
    var size = 124; // matches renderThumb canvas
    var dim = rec.artboard;
    var s = Math.min(size / dim.w, size / dim.h) * 0.94;
    var offX = (size - dim.w * s) / 2, offY = (size - dim.h * s) / 2;
    return 'left:' + ((offX + b.x * s) / size * 100) + '%;top:' + ((offY + b.y * s) / size * 100) + '%;width:' + (b.w * s / size * 100) + '%;height:' + (b.h * s / size * 100) + '%;';
  }

  function overflowHtml(rec) {
    var ov = rec.analysis.overflow;
    var body;
    if (ov.count === 0) {
      body = '<p class="pf-list"><span class="ok">🟢 No objects extend beyond the artboard</span> — auto-center ran in the pipeline; placement below is the final one.</p>';
    } else {
      var marks = ov.items.map(function (it) { return '<div class="ov-mark" style="' + ovMarkStyle(it.bbox, rec) + '"></div>'; }).join('');
      body = '<p class="pf-list"><span class="bad">' + ov.count + ' object(s) extend beyond the artboard:</span></p>' +
        '<ul class="pf-list">' + ov.items.map(function (it) { return '<li class="bad">object ' + (it.index + 1) + ': beyond ' + esc(it.beyond) + '</li>'; }).join('') + '</ul>' +
        '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-top:10px">' +
        '<div class="ov-prev">' + (rec.thumbs.after ? '<img src="' + rec.thumbs.after + '">' : '') + marks + '</div>' +
        '<div><button class="btn btn-sm btn-primary" data-pfop="recenter">⬦ Re-center artwork (auto-fix)</button>' +
        '<p class="pf-note">The preview marks every overflowing object <b style="color:#ff3b30">red</b>. The fix is applied only after you click — and saved as a new version, so you can always compare/undo.</p></div></div>';
    }
    return '<div class="pf-sec"><h4>Clipping / overflow detection <span class="pf-muted">preview before any auto-fix</span></h4>' + body + '</div>';
  }

  function flagsHtml(rec) {
    var q = rec.analysis.quality;
    return '<div class="pf-sec"><h4>Quality flags <span class="pf-muted">per-dimension flags — not a single score</span></h4>' +
      '<div class="flag-grid">' + Object.keys(q).map(function (k) {
        var f = q[k];
        return '<div class="flag ' + f.level + '"><div class="fhead">' + f.icon + ' ' + esc(k) + '</div><div class="fmsg">' + esc(f.msg) + '</div></div>';
      }).join('') + '</div></div>';
  }

  function overlapHtml(rec) {
    var ov = rec.analysis.overlaps;
    return '<div class="pf-sec"><h4>Overlap analysis <span class="pf-muted">' + ov.checked + ' filled shapes compared' + (ov.capReached ? ' (capped at 350)' : '') + '</span></h4>' +
      '<div class="pf-grid c3">' +
      kpi('Normal overlaps', String(ov.normal), 'typical layered art — OK') +
      kpi('Suspicious', String(ov.suspicious.length), 'identical / near-identical paths') +
      kpi('Critical', String(ov.critical.length), 'unexpected filled regions (containment)') +
      '</div>' +
      (ov.suspicious.length ? '<ul class="pf-list" style="margin-top:10px">' + ov.suspicious.map(function (s) {
        return '<li class="warn">object ' + (s.a + 1) + ' ↔ object ' + (s.b + 1) + ' — ' + s.similarity + '% similar → near-duplicate detected</li>';
      }).join('') + '</ul>' : '') +
      (ov.critical.length ? '<ul class="pf-list" style="margin-top:10px">' + ov.critical.map(function (c) {
        return '<li class="bad">' + esc(c.note) + ' (inner ≈ ' + Math.round(c.areaRatio * 100) + '% of outer area)</li>';
      }).join('') + '</ul>' : '') +
      '</div>';
  }

  function geomHtml(rec) {
    var a = rec.analysis, li = [];
    var si = a.selfIntersection;
    li.push('<li class="' + (si.crossings ? 'bad' : 'ok') + '">Self-intersecting paths: ' + (si.crossings
      ? '<b>' + si.crossings + ' crossing(s)</b> on ' + si.contours + ' contour(s)' + (si.worst ? ' — worst: object ' + (si.worst.index + 1) + ' (' + si.worst.crossings + ' crossings)</b>' : '')
      : 'none detected') + '</li>');
    var za = a.zeroArea;
    li.push('<li class="' + (za.zeroCount || za.tinyCount ? 'bad' : 'ok') + '">Zero-area objects: ' + za.zeroCount + ' · tiny (&lt;2px) objects: ' + za.tinyCount + '</li>');
    li.push('<li class="' + (a.openPaths ? 'warn' : 'ok') + '">Open paths: ' + a.openPaths + '</li>');
    var cl = a.clipping || { masks: 0, note: '' };
    li.push(cl.masks
      ? '<li class="' + (cl.clipped ? 'bad' : 'ok') + '">Clipping masks: ' + cl.masks + ' — ' + esc(cl.note) + '</li>'
      : '<li class="ok">Clipping masks: none in current version (report tracks masks removed from the original).</li>');
    var nd = a.nearDuplicates;
    li.push(nd.pairs.length
      ? '<li class="warn">Near-duplicates (≥95%): ' + nd.pairs.map(function (p) { return 'object ' + (p.a + 1) + ' ↔ ' + (p.b + 1) + ' = ' + p.similarity + '%'; }).join(' · ') + '</li>'
      : '<li class="ok">Near-duplicates (≥95%): none</li>');
    var cf = a.colors.flagged;
    li.push(cf.length
      ? '<li class="warn">Color consistency: ' + cf.map(function (c) { return c.variants + ' near-identical values of rgb(' + c.rgb.join(',') + ') across ' + c.objects + ' objects'; }).join(' · ') + ' — consolidate to a single color value</li>'
      : '<li class="ok">Color consistency: ' + a.colors.distinctColors + ' distinct fill color(s), no near-identical clusters</li>');
    li.push('<li class="' + (a.holes.tiny ? 'warn' : 'ok') + '">Negative space: ' + esc(a.holes.note) + '</li>');
    var sm = a.smoothness;
    li.push('<li class="' + (sm.flag.level === 'ok' ? 'ok' : sm.flag.level) + '">Contour smoothness: ' + sm.nodeDensity + ' anchors/100px · corner points ' + Math.round(sm.cornerRatio * 100) + '% · high-frequency ' + Math.round(sm.irregularRatio * 100) + '% — ' + esc(sm.flag.msg) + '</li>');
    return '<div class="pf-sec"><h4>Geometry details</h4><ul class="pf-list">' + li.join('') + '</ul></div>';
  }

  function silhouetteHtml(rec) {
    var a = rec.analysis.silhouette;
    var box;
    if (a) {
      box = '<div class="pf-grid c4">' +
        kpi('Result', a.icon, '') +
        kpi('Primary fill', a.primaryFill, 'fill colors: ' + a.colorCount) +
        kpi('Strokes', a.strokeShapes + ' shape(s)', a.strokeWidths.length ? 'widths: ' + a.strokeWidths.join(', ') + 'px' : 'none') +
        kpi('Holes (negative space)', String(a.holes), a.tinyHoles ? a.tinyHoles + ' tiny — verify intentional' : 'none suspicious') +
        '</div>' +
        '<ul class="pf-list" style="margin-top:10px">' +
        '<li class="' + (a.transparentShapes ? 'warn' : 'ok') + '">Transparency: ' + (a.transparentShapes ? a.transparentShapes + ' shape(s) with fill-opacity' : 'none') + '</li>' +
        '<li class="' + (a.hasFullBackground ? 'warn' : 'ok') + '">Full-bleed background: ' + (a.hasFullBackground ? 'present' : 'absent') + '</li>' +
        a.issues.map(function (iss) { return '<li class="warn">' + esc(iss) + '</li>'; }).join('') +
        '</ul>';
    } else {
      box = '<p class="pf-muted">Enable to run the dedicated silhouette checks: primary fill, background, strokes, holes / negative space, color count, transparency → target “🟢 Clean Silhouette”.</p>';
    }
    return '<div class="pf-sec"><h4>Silhouette mode <label class="checkbox-line"><input type="checkbox" id="pfSil" ' + (rec.pf.silhouette ? 'checked' : '') + '> run silhouette checks</label></h4>' + box + '</div>';
  }

  function previewHtml(rec) {
    if (!rec.pf.previewSvg) return '';
    return '<div class="op-preview">' +
      '<div class="pp"><span class="tag">Current — Version ' + rec.versions.length + '</span>' + (rec.thumbs.after ? '<img src="' + rec.thumbs.after + '">' : '') + '</div>' +
      '<div class="pp"><span class="tag">Preview (NOT applied)</span>' + (rec.pf.previewAfterUrl ? '<img src="' + rec.pf.previewAfterUrl + '">' : '…') + '</div></div>';
  }

  function repairSummary(rep) {
    if (!rep.total) return 'No repairs needed (no duplicate anchors, tiny gaps, or isolated points).';
    var names = { 'duplicate-anchors': 'duplicate anchor(s)', 'closed-tiny-gap': 'tiny gap(s) closed', 'snapped-endpoint': 'endpoint(s) snapped to start', 'isolated-points': 'isolated point(s) removed' };
    return 'Will apply: ' + Object.keys(rep.counts).map(function (k) { return (names[k] || k) + ' ×' + rep.counts[k]; }).join(', ');
  }

  function simplifyHtml(rec) {
    var est = Analyze.simplifyAll(rec.shapes, rec.pf.tol);
    return '<div class="pf-sec"><h4>Smart simplify <span class="pf-muted">Ramer–Douglas–Peucker · preview only — never automatic</span></h4>' +
      '<div class="op-panel"><div class="op-row">' +
      '<label class="pf-muted">Tolerance <input type="range" id="pfTol" min="0.1" max="5" step="0.1" value="' + r1(rec.pf.tol) + '"><b id="pfTolVal">' + r1(rec.pf.tol) + 'px</b></label>' +
      '<div class="op-est" id="pfSimpEst">Current: ' + est.nodesBefore + ' nodes → estimated <b>' + est.nodesAfter + '</b> after (−' + (est.nodesBefore - est.nodesAfter) + ') · shape deviation ' + est.deviationPct + '%</div>' +
      '<button class="btn btn-sm" data-pfop="simp-preview">Preview</button>' +
      '<button class="btn btn-sm btn-primary" data-pfop="simp-apply">Apply → new version</button>' +
      '</div>' + previewHtml(rec) +
      '<p class="pf-note">Workflow: choose tolerance → Preview → Apply. Applying saves a new version; compare or revert anytime in Version History.</p></div></div>';
  }

  function repairHtml(rec) {
    var rep = Analyze.repairAll(rec.shapes, { snapTol: rec.pf.snap });
    return '<div class="pf-sec"><h4>Intelligent path repair <span class="pf-muted">join nearby endpoints · close tiny gaps · remove isolated/duplicate points</span></h4>' +
      '<div class="op-panel"><div class="op-row">' +
      '<label class="pf-muted">Snap tolerance <input type="range" id="pfSnap" min="0.5" max="10" step="0.5" value="' + r1(rec.pf.snap) + '"><b id="pfSnapVal">' + r1(rec.pf.snap) + 'px</b></label>' +
      '<div class="op-est" id="pfRepEst">' + esc(repairSummary(rep)) + '</div>' +
      '<button class="btn btn-sm" data-pfop="rep-preview">Preview</button>' +
      '<button class="btn btn-sm btn-primary" data-pfop="rep-apply">Apply → new version</button>' +
      '</div>' + previewHtml(rec) +
      '<p class="pf-note">Each repair is Original → Preview → Apply — nothing is changed until you click Apply, and every apply is a new version.</p></div></div>';
  }

  function versionsHtml(rec) {
    var lis = rec.versions.map(function (vr, i) {
      var isCur = i === rec.versions.length - 1;
      var restoreBtn = isCur ? '' : '<button class="btn btn-sm btn-ghost" data-pfv="' + i + '" title="Set this version back as current">↩ Restore</button>';
      return '<li class="' + (isCur ? 'current' : '') + '"><span class="vn">Version ' + vr.v + '</span><span class="vname">' + esc(vr.name) + (isCur ? ' <span class="hint">(current → EPS 10 exported from this)</span>' : '') + '</span>' + restoreBtn + '<span class="vtime">' + new Date(vr.time).toLocaleTimeString() + '</span></li>';
    }).join('');
    var cmp = '';
    if (rec.versions.length > 1) {
      var opts = rec.versions.slice(0, -1).map(function (vr, i) {
        return '<option value="' + i + '"' + (rec.pf.compareV === i ? ' selected' : '') + '>Version ' + vr.v + ' — ' + esc(vr.name) + '</option>';
      }).join('');
      cmp = '<div class="pf-muted" style="margin-top:10px">Before / after comparison (side-by-side):</div>' +
        '<div class="op-row" style="margin-top:6px"><select id="pfCmp" class="pf-select">' + opts + '</select></div>' +
        (rec.pf.cmpUrls ? '<div class="cmp-wrap">' + rec.pf.cmpUrls + '</div>' : '');
    }
    return '<div class="pf-sec"><h4>Undo / version history (per file) <span class="pf-muted">Version 1 Original → … → Version ' + rec.versions.length + ' (EPS 10 export source) — use ↩ Restore to go back to any previous version</span></h4>' +
      '<ul class="ver-list">' + lis + '</ul>' + cmp + '</div>';
  }

  function renderPreflight(rec) {
    if (!rec.final) { try { refreshStatus(rec); } catch (e2) { /* shown below if analysis missing */ } }
    pfRec = rec;
    $('pfTitle').textContent = 'Preflight — ' + rec.name;
    try {
      $('pfBody').innerHTML =
        '<div class="pf-sec"><h4>Pipeline <span class="pf-muted">upload → validate → artboard → bbox → center → structure → cleanup → … → final report</span></h4>' + pipeHtml(rec) + '</div>' +
        finalHtml(rec) +
        alignHtml(rec) +
        overflowHtml(rec) +
        flagsHtml(rec) +
        overlapHtml(rec) +
        geomHtml(rec) +
        silhouetteHtml(rec) +
        simplifyHtml(rec) +
        repairHtml(rec) +
        versionsHtml(rec);
    } catch (e) {
      $('pfBody').innerHTML = '<div class="pf-sec"><h4>⚠ Preflight could not be rendered for this file</h4>' +
        '<p class="pf-list bad">' + esc(e && e.message ? e.message : String(e)) + '</p>' +
        '<p class="pf-note">Open the Report dialog for per-section details, or re-upload the file. If the problem persists, send this SVG file to the developer for debugging.</p></div>';
    }
  }

  function openPreflight(rec) {
    if (!rec) return;
    if (!rec.analysis) { try { refreshGeometry(rec); } catch (e) { /* handled below */ } }
    if (!rec.analysis) {
      pfRec = rec;
      $('pfTitle').textContent = 'Preflight — ' + rec.name;
      $('pfBody').innerHTML = '<div class="pf-sec"><p class="pf-list bad">Analysis unavailable for this file.</p>' +
        '<p class="pf-note">Check the Report dialog for details, or re-upload the file. If the problem persists, send this SVG file to the developer for debugging.</p></div>';
      $('preflightOverlay').hidden = false;
      return;
    }
    renderPreflight(rec);
    $('preflightOverlay').hidden = false;
  }

  function updateSimplifyEst(rec) {
    var el = document.getElementById('pfSimpEst');
    if (!el || !rec.shapes) return;
    var est = Analyze.simplifyAll(rec.shapes, rec.pf.tol);
    el.innerHTML = 'Current: ' + est.nodesBefore + ' nodes → estimated <b>' + est.nodesAfter + '</b> after (−' + (est.nodesBefore - est.nodesAfter) + ') · shape deviation ' + est.deviationPct + '%';
  }
  function updateRepairEst(rec) {
    var el = document.getElementById('pfRepEst');
    if (!el || !rec.shapes) return;
    el.textContent = repairSummary(Analyze.repairAll(rec.shapes, { snapTol: rec.pf.snap }));
  }

  $('preflightOverlay').addEventListener('click', function (e) { if (e.target === $('preflightOverlay')) $('preflightOverlay').hidden = true; });
  $('pfClose').onclick = function () { $('preflightOverlay').hidden = true; };
  $('pfTxt').onclick = function () {
    var rec = pfRec;
    if (!rec || !rec.analysis) return;
    var txt = Audit.preflightText({
      fileName: rec.base + '.eps',
      versionNo: rec.versions.length,
      versionName: rec.versions[rec.versions.length - 1].name,
      artboard: rec.artboard,
      epsCounts: rec.eps && rec.eps.counts ? rec.eps.counts : null,
      stats: rec.process ? rec.process.stats : null,
      analysis: Object.assign({}, rec.analysis, { artworkAnchors: rec.analysis.smoothness.anchors }),
      finalStatus: rec.final,
      dateStr: new Date().toLocaleString()
    });
    downloadBytes(new TextEncoder().encode(txt), rec.base + '-preflight.txt');
  };
  $('pfBody').addEventListener('click', async function (e) {
    // restore a previous version (item 50)
    var rb = e.target.closest('[data-pfv]');
    if (rb && pfRec) {
      rb.disabled = true;
      try { await restoreVersion(pfRec, parseInt(rb.getAttribute('data-pfv'), 10)); } finally { rb.disabled = false; }
      return;
    }
    var btn = e.target.closest('[data-pfop]');
    if (!btn || !pfRec) return;
    var rec = pfRec, op = btn.getAttribute('data-pfop');
    btn.disabled = true;
    try {
      if (op === 'simp-preview') await previewOp(rec, 'simplify');
      else if (op === 'simp-apply') await applyOp(rec, 'simplify');
      else if (op === 'rep-preview') await previewOp(rec, 'repair');
      else if (op === 'rep-apply') await applyOp(rec, 'repair');
      else if (op === 'recenter') await recenter(rec);
      else if (op === 'nudge') {
        var nx = parseFloat(document.getElementById('pfNudgeX').value) || 0;
        var ny = parseFloat(document.getElementById('pfNudgeY').value) || 0;
        await nudgeArtwork(rec, nx, ny);
      }
    } finally { btn.disabled = false; }
  });
  $('pfBody').addEventListener('change', async function (e) {
    if (!pfRec) return;
    var rec = pfRec;
    if (e.target.id === 'pfSil') {
      rec.pf.silhouette = e.target.checked;
      refreshGeometry(rec);
      renderRows();
      renderPreflight(rec);
    } else if (e.target.id === 'pfIp') {
      rec.pf.ipOk = e.target.checked;
      refreshStatus(rec);
      renderRows();
      renderPreflight(rec);
    } else if (e.target.id === 'pfCmp') {
      var vIdx = parseInt(e.target.value, 10);
      if (!isNaN(vIdx)) await compareVersions(rec, vIdx);
    }
  });
  $('pfBody').addEventListener('input', function (e) {
    if (!pfRec) return;
    var rec = pfRec;
    if (e.target.id === 'pfTol') {
      rec.pf.tol = parseFloat(e.target.value) || 1;
      var lab = document.getElementById('pfTolVal');
      if (lab) lab.textContent = r1(rec.pf.tol) + 'px';
      updateSimplifyEst(rec);
    } else if (e.target.id === 'pfSnap') {
      rec.pf.snap = parseFloat(e.target.value) || 2;
      var lab2 = document.getElementById('pfSnapVal');
      if (lab2) lab2.textContent = r1(rec.pf.snap) + 'px';
      updateRepairEst(rec);
    }
  });

  /* batch row click: open preflight */
  $('batchBody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act="pf"]');
    if (!btn) return;
    var rec = records[parseInt(btn.getAttribute('data-i'), 10)];
    if (rec) openPreflight(rec);
  });

  /* automation/test hook */
  window.__eps10 = {
    addFiles: addFiles,
    records: records,
    openPreflight: openPreflight,
    applyOp: applyOp,
    previewOp: previewOp,
    recenter: recenter,
    nudgeArtwork: nudgeArtwork,
    restoreVersion: restoreVersion,
    refreshGeometry: refreshGeometry,
    getSettings: getSettings
  };
})();
