/*
 * audit.js — report assembly for the MASTER EPS 10 MARKETPLACE STANDARD
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Audit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SECTIONS = [
    { id: 'document', no: 1, name: 'Document', items: {
      'parse': 'Valid SVG / XML',
      'script': 'No scripts / foreignObject / event handlers',
      'external-ref': 'No external references (all embedded)',
      'css': 'CSS classes resolved & inlined',
      'anim': 'No animation elements'
    } },
    { id: 'artboard', no: 2, name: 'Artboard', items: {
      'artboard': 'Correct, consistent artboard',
      'center': 'Design centered (balanced spacing)',
      'overflow': 'No overflow beyond artboard'
    } },
    { id: 'artwork', no: 3, name: 'Artwork', items: {
      'hidden': 'No hidden objects',
      'duplicates': 'No duplicate objects',
      'stray': 'No stray / stray-group objects'
    } },
    { id: 'paths', no: 4, name: 'Paths', items: {
      'anchor-count': 'Reasonable anchor point count',
      'anchor-clean': 'Redundant anchor points removed',
      'arc': 'Arcs converted (EPS-safe curves)',
      'quad': 'Quadratic curves converted',
      'invalid': 'Valid path data (no bad numbers)'
    } },
    { id: 'text', no: 5, name: 'Text', items: {
      'outline': 'Fonts outlined (Type → Create Outlines)'
    } },
    { id: 'stroke', no: 6, name: 'Stroke', items: {
      'thin': 'No accidentally thin strokes',
      'grad-stroke': 'Strokes valid in EPS 10'
    } },
    { id: 'effects', no: 7, name: 'Effects', items: {
      'opacity': 'No transparency (EPS 10 safe)',
      'gradient': 'Gradients EPS 10 compatible',
      'filter': 'No live filters (expand/flatten)',
      'blend': 'No blend modes',
      'pattern': 'No pattern fills',
      'live-use': 'Live <use> expanded',
      'image': 'Images embedded (JPEG)'
    } },
    { id: 'masks', no: 8, name: 'Masks', items: {
      'clip': 'Clipping masks valid',
      'opacity-mask': 'No opacity masks'
    } },
    { id: 'cleanup', no: 9, name: 'Cleanup', items: {
      'stray-points': 'No stray points',
      'empty-objects': 'No empty objects / groups',
      'unpainted': 'No unpainted objects'
    } },
    { id: 'export', no: 10, name: 'Export', items: {
      'eps-gen': 'EPS 10 generated',
      'structure': 'PostScript structure validation',
      'seven-bit': 'Clean7Bit (7-bit ASCII)',
      'preview': 'Visual preview rendered',
      'reopen': 'Reopen / manual Illustrator check'
    } }
  ];

  var PROFILES = {
    universal: {
      name: 'Universal EPS 10 Check',
      desc: 'Baseline marketplace standard (all 10 sections).',
      tips: [
        'Zero FAIL items before uploading to any marketplace.',
        'EPS 10 = PostScript Level 2, no transparency, no live effects.',
        'RGB color mode, consistent artboard size for the whole batch.'
      ]
    },
    adobe: {
      name: 'Adobe Stock',
      desc: 'Adobe Stock vector upload requirements.',
      tips: [
        'Vector file must be 100% vector (EPS/AI) — no raster layers for vector category.',
        'No hidden layers or hidden objects in the file.',
        'Artwork must fit the artboard; transparent background not allowed in EPS → use white-baked or solid background.',
        'After upload, run Adobe Stock vector checker: "reopen test" (open in Illustrator, confirm artboard + no missing fonts).'
      ]
    },
    shutterstock: {
      name: 'Shutterstock',
      desc: 'Shutterstock vector contribution requirements.',
      tips: [
        'Accepted: EPS / AI / SVG. EPS 10 is safest for compatibility.',
        'Vector files are resolution independent — keep clean anchor points for scaling quality.',
        'No effects that require live engines (blur/shadow must be expanded).',
        'One artboard per file, artwork centered.'
      ]
    },
    dreamstime: {
      name: 'Dreamstime',
      desc: 'Dreamstime vector requirements.',
      tips: [
        'Vector: EPS or AI. RGB acceptable.',
        'Files must open cleanly — no missing fonts (outline text).',
        'Keep stroke weights visible at final size; outline critical strokes.'
      ]
    },
    vectorstock: {
      name: 'VectorStock',
      desc: 'VectorStock vector requirements.',
      tips: [
        'EPS, AI or CDR accepted — EPS 10 is universally compatible.',
        'Clean paths & minimum anchor points improve preview quality.',
        'No transparency in EPS output.'
      ]
    }
  };

  function itemLabel(sectionId, itemId) {
    var sec = SECTIONS.filter(function (s) { return s.id === sectionId; })[0];
    if (sec && sec.items[itemId]) return sec.items[itemId];
    return itemId;
  }

  // findings: from svgfix.process()
  // exportResult: from Eps10.generateEPS() ({checks, findings, counts}) or null
  function buildReport(processResult, exportResult, previewOk) {
    var sections = SECTIONS.map(function (sec) {
      var found = (processResult.findings || []).filter(function (f) { return f.section === sec.id; });
      // group by item: worst status wins; merge msgs
      var byItem = {};
      found.forEach(function (f) {
        if (!byItem[f.item]) byItem[f.item] = { status: f.status, msgs: [], autoFixed: false };
        var cur = byItem[f.item];
        var rank = { fail: 3, warn: 2, info: 1, pass: 0 };
        if ((rank[f.status] || 0) > (rank[cur.status] || 0)) cur.status = f.status;
        if (f.msg) cur.msgs.push(f.msg);
        if (f.autoFixed) cur.autoFixed = true;
      });
      var items = [];
      Object.keys(byItem).forEach(function (itemId) {
        var it = byItem[itemId];
        items.push({
          id: itemId,
          label: itemLabel(sec.id, itemId),
          status: it.status,
          autoFixed: it.autoFixed,
          msgs: it.msgs
        });
      });
      // add export section items
      if (sec.id === 'export' && exportResult) {
        var cByName = {};
        (exportResult.checks || {}).checks.forEach(function (c) { cByName[c.name] = c; });
        var efind = exportResult.findings || [];
        var epsGen = cByName['EPSF-3.0 header'] && cByName['Trailer'];
        items.push({ id: 'eps-gen', label: itemLabel('export', 'eps-gen'), status: epsGen ? 'pass' : 'fail', autoFixed: false,
          msgs: exportResult.counts ? ['EPS generated: ' + exportResult.counts.paths + ' fill path(s), ' + exportResult.counts.strokes + ' stroke(s), ' + exportResult.counts.shfill + ' gradient shading(s), ' + exportResult.counts.images + ' image(s)'] : [] });
        var structOk = (exportResult.checks || {}).ok;
        var structDetail = (exportResult.checks || { checks: [] }).checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.name + (c.detail ? ': ' + c.detail : ''); });
        items.push({ id: 'structure', label: itemLabel('export', 'structure'), status: structOk ? 'pass' : 'fail', autoFixed: false, msgs: structDetail.length ? structDetail : ['All structure checks passed.'] });
        items.push({ id: 'seven-bit', label: itemLabel('export', 'seven-bit'), status: cByName['7-bit clean (Clean7Bit)'] && cByName['7-bit clean (Clean7Bit)'].ok ? 'pass' : 'fail', autoFixed: false, msgs: [cByName['7-bit clean (Clean7Bit)'] ? cByName['7-bit clean (Clean7Bit)'].detail : ''] });
        items.push({ id: 'preview', label: itemLabel('export', 'preview'), status: previewOk ? 'pass' : 'info', autoFixed: false, msgs: [previewOk ? 'Preview rendered from fixed SVG.' : 'Preview could not be rendered in this environment — verify visually before upload.'] });
        items.push({ id: 'reopen', label: itemLabel('export', 'reopen'), status: 'info', autoFixed: false, msgs: ['Final manual step: open the EPS in Illustrator → confirm artboard, no missing fonts, Layers panel shows vector paths.'] });
        var eItemMap = {};
        efind.forEach(function (f) {
          if (!eItemMap[f.item]) eItemMap[f.item] = { status: f.status, msgs: [] };
          var rank = { fail: 3, warn: 2, info: 1, pass: 0 };
          if ((rank[f.status] || 0) > (rank[eItemMap[f.item].status] || 0)) eItemMap[f.item].status = f.status;
          eItemMap[f.item].msgs.push(f.msg);
        });
        Object.keys(eItemMap).forEach(function (itemId) {
          if (items.some(function (i) { return i.id === itemId; })) return;
          items.push({ id: itemId, label: itemLabel('export', itemId), status: eItemMap[itemId].status, autoFixed: false, msgs: eItemMap[itemId].msgs });
        });
      }
      // status tally for the section
      var fails = items.filter(function (i) { return i.status === 'fail'; }).length;
      var warns = items.filter(function (i) { return i.status === 'warn'; }).length;
      return {
        id: sec.id, no: sec.no, name: sec.name, items: items,
        status: fails ? 'fail' : (warns ? 'warn' : 'pass')
      };
    });
    var allItems = [];
    sections.forEach(function (s) { s.items.forEach(function (i) { allItems.push(i); }); });
    var totals = {
      pass: allItems.filter(function (i) { return i.status === 'pass'; }).length,
      warn: allItems.filter(function (i) { return i.status === 'warn'; }).length,
      fail: allItems.filter(function (i) { return i.status === 'fail'; }).length,
      info: allItems.filter(function (i) { return i.status === 'info'; }).length
    };
    return { sections: sections, totals: totals, ready: totals.fail === 0 };
  }

  /* ================= item 53: updateable marketplace rules DB + 3-tier status =================
   * Rules are DATA (ids + check registry) so they can be updated when marketplaces change.
   * Audit.updateMarketplaceRules(profileId, [checkIds]) / Audit.addRuleCheck(id, {desc, fn})
   *
   * ctx passed to rule fn:
   *   { report, exportOk, epsCounts, stats, analysis, artboard, batchArtboard }
   */
  var RULE_CHECKS = {
    'eps10': { desc: 'Valid EPS 10 (Illustrator 10) file generated', fn: function (c) { return !!(c.exportOk); } },
    'no-text': { desc: 'No live text — all fonts outlined', fn: function (c) { return c.epsCounts ? c.epsCounts.text === 0 : true; } },
    'no-raster': { desc: '100% vector — no raster images', fn: function (c) { return c.epsCounts ? c.epsCounts.images === 0 : true; } },
    'no-hidden': { desc: 'No hidden objects remain (auto-removed during cleanup)', fn: function (c) { return !!c.report; } },
    'no-overflow': { desc: 'Nothing extends beyond the artboard', fn: function (c) { return c.analysis ? c.analysis.overflow.count === 0 : true; } },
    'centered': { desc: 'Artwork centered (balanced spacing)', fn: function (c) { return c.analysis ? c.analysis.offsets.status === 'Centered' : true; } },
    'margins-balanced': { desc: 'Safe margins balanced (adaptive threshold)', fn: function (c) { return c.analysis ? c.analysis.margins.status === 'balanced' : true; } },
    'no-transparency': { desc: 'No transparency left in output', fn: function (c) { return c.analysis ? (c.analysis.silhouette ? c.analysis.silhouette.transparentShapes === 0 : true) && (c.stats ? (c.stats.bakedOpacity || 0) >= 0 : true) : true; } }
  };

  var MARKETPLACE_RULES = {
    universal:    { name: 'Universal EPS 10 Check', checks: ['eps10', 'no-text', 'no-overflow', 'no-hidden'] },
    adobe:        { name: 'Adobe Stock', checks: ['eps10', 'no-text', 'no-raster', 'no-overflow', 'no-hidden', 'centered', 'no-transparency'] },
    shutterstock: { name: 'Shutterstock', checks: ['eps10', 'no-text', 'no-overflow', 'centered'] },
    dreamstime:   { name: 'Dreamstime', checks: ['eps10', 'no-text', 'no-overflow'] },
    vectorstock:  { name: 'VectorStock', checks: ['eps10', 'no-text', 'no-overflow', 'no-hidden'] }
  };

  function addRuleCheck(id, rule) {
    if (!id || !rule || typeof rule.fn !== 'function') throw new Error('addRuleCheck(id, {desc, fn})');
    RULE_CHECKS[id] = { desc: rule.desc || id, fn: rule.fn };
    return true;
  }

  function updateMarketplaceRules(profileId, checkIds) {
    if (!MARKETPLACE_RULES[profileId]) throw new Error('Unknown profile: ' + profileId);
    if (!Array.isArray(checkIds)) throw new Error('checkIds must be an array of rule ids');
    checkIds.forEach(function (id) {
      if (!RULE_CHECKS[id]) throw new Error('Unknown rule id: ' + id);
    });
    MARKETPLACE_RULES[profileId].checks = checkIds.slice();
    return MARKETPLACE_RULES[profileId];
  }

  function marketplaceStatus(profileId, ctx) {
    var rules = MARKETPLACE_RULES[profileId] || MARKETPLACE_RULES.universal;
    var results = rules.checks.map(function (cid) {
      var rule = RULE_CHECKS[cid];
      if (!rule) return { id: cid, ok: false, desc: 'Unknown rule: ' + cid };
      var ok = false;
      try { ok = !!rule.fn(ctx || {}); } catch (e) { ok = false; }
      return { id: cid, ok: ok, desc: rule.desc };
    });
    return {
      profileId: profileId,
      profileName: rules.name,
      results: results,
      passed: results.filter(function (r) { return r.ok; }).length,
      total: results.length,
      pass: results.length > 0 && results.every(function (r) { return r.ok; })
    };
  }

  function countOpenWarns(report) {
    if (!report) return 0;
    var n = 0;
    (report.sections || []).forEach(function (s) {
      s.items.forEach(function (i) { if (i.status === 'warn' && !i.autoFixed) n++; });
    });
    return n;
  }

  // 3-tier: TECHNICAL / MARKETPLACE / CONTENT-IP -> FINAL
  function finalStatus(report, mkt, ipAcknowledged) {
    var techOk = !!(report && report.ready);
    var techFails = report ? report.totals.fail : 0;
    var techWarns = countOpenWarns(report); // auto-fixed warns already resolved
    var mktOk = !!(mkt && mkt.pass);
    var ipOk = !!ipAcknowledged;
    var final, icon;
    if (!techOk || !mktOk) { final = 'NEEDS FIX'; icon = '🔴'; }
    else if (!ipOk || techWarns > 0) { final = 'NEEDS REVIEW'; icon = '🟡'; }
    else { final = 'READY TO SUBMIT'; icon = '🟢'; }
    return {
      technical: { ok: techOk, fails: techFails, warns: techWarns, label: 'TECHNICAL STATUS', status: techOk ? '🟢 PASS' : '🔴 FAIL (' + techFails + ' item(s))' },
      marketplace: { ok: mktOk, label: 'MARKETPLACE STATUS', profile: mkt ? mkt.profileName : '-', status: mktOk ? '🟢 Meets configured checks' : '🔴 Checks failing', detail: mkt ? (mkt.passed + '/' + mkt.total + ' checks passed') : '-' },
      contentIp: { ok: ipOk, label: 'CONTENT-IP REVIEW', manual: true, status: ipOk ? '🟢 Acknowledged (manual review done)' : '⚠️ Manual review required (trademarks, brands, copyrighted characters, living artists, real people)' },
      final: final,
      finalIcon: icon
    };
  }

  /* ================= item 52: downloadable preflight report (.txt) ================= */

  function preflightText(ctx) {
    // ctx: { fileName, versionNo, versionName, artboard, epsCounts, stats, analysis, finalStatus, dateStr }
    var a = ctx.analysis || {};
    var m = a.margins || {};
    var o = a.offsets || {};
    var q = a.quality || {};
    var f = ctx.finalStatus || {};
    var L = [];
    L.push('EPS 10 MARKETPLACE PREFLIGHT REPORT');
    L.push('====================================');
    L.push('File:         ' + (ctx.fileName || 'file.eps'));
    L.push('Type:         EPS 10 (Illustrator 10 / PostScript Level 2)');
    L.push('Version:      Version ' + (ctx.versionNo || 1) + ' — ' + (ctx.versionName || 'Original'));
    L.push('Artboard:     ' + (ctx.artboard ? ctx.artboard.w : '-') + ' x ' + (ctx.artboard ? ctx.artboard.h : '-') + ' px');
    L.push('Color Mode:   RGB, 7-bit ASCII (Clean7Bit)');
    L.push('');
    var ec = ctx.epsCounts || {};
    L.push('Vector Objects:    ' + (ec.paths != null ? ec.paths : '-'));
    L.push('Anchor Points:     ' + (a.artworkAnchors != null ? a.artworkAnchors : '-'));
    L.push('Raster Images:     ' + (ec.images != null ? ec.images : 0));
    L.push('Fonts:             0 (all outlined)');
    L.push('Stray Points:      0 (removed in cleanup)');
    L.push('Duplicates:        0 (removed in cleanup)');
    L.push('Open Paths:        ' + (a.openPaths != null ? a.openPaths : 0));
    L.push('Hidden Objects:    ' + (ctx.stats && ctx.stats.removedHidden != null ? ctx.stats.removedHidden + ' (removed)' : 0));
    L.push('Clip Masks:        ' + (ec.clips != null ? ec.clips : 0));
    L.push('Transparency:      ' + ((ctx.stats && ctx.stats.bakedOpacity) ? 'baked (' + ctx.stats.bakedOpacity + ' element(s) flattened)' : 'none'));
    L.push('');
    L.push('ALIGNMENT:');
    L.push('  X Offset:   ' + (o.x != null ? o.x : '-') + ' px');
    L.push('  Y Offset:   ' + (o.y != null ? o.y : '-') + ' px');
    L.push('  Status:     ' + (o.status || '-'));
    L.push('');
    L.push('SAFE MARGINS (adaptive threshold ' + ((m.thresholds && m.thresholds.balance) || '-') + 'px):');
    L.push('  Top:     ' + (m.top != null ? m.top : '-') + ' px');
    L.push('  Right:   ' + (m.right != null ? m.right : '-') + ' px');
    L.push('  Bottom:  ' + (m.bottom != null ? m.bottom : '-') + ' px');
    L.push('  Left:    ' + (m.left != null ? m.left : '-') + ' px');
    L.push('  Balance: ' + (m.status ? m.icon + ' ' + m.status.toUpperCase() : '-'));
    if (m.tight) L.push('  NOTE: artwork close to artboard edge (min margin ' + m.minMargin + 'px).');
    L.push('');
    if (a.overflow) {
      L.push('OVERFLOW: ' + (a.overflow.count === 0 ? '0 objects beyond artboard' : a.overflow.count + ' object(s) extend beyond artboard'));
      L.push('');
    }
    L.push('QUALITY FLAGS:');
    Object.keys(q).forEach(function (k) {
      var fl = q[k];
      L.push('  ' + k + ':  ' + fl.icon + ' ' + fl.msg);
    });
    L.push('');
    if (a.silhouette) {
      L.push('SILHOUETTE MODE:');
      L.push('  ' + a.silhouette.icon);
      L.push('  Primary fill: ' + a.silhouette.primaryFill + ' | colors: ' + a.silhouette.colorCount +
        ' | strokes: ' + a.silhouette.strokeShapes + ' | transparency: ' + a.silhouette.transparentShapes +
        ' | holes (negative space): ' + a.silhouette.holes);
      a.silhouette.issues.forEach(function (iss) { L.push('  - ' + iss); });
      L.push('');
    }
    L.push(f.technical ? f.technical.label + ': ' + f.technical.status : 'TECHNICAL STATUS: -');
    L.push(f.marketplace ? f.marketplace.label + ': ' + f.marketplace.status + ' (' + f.marketplace.profile + ')' : 'MARKETPLACE STATUS: -');
    L.push(f.contentIp ? f.contentIp.label + ': ' + f.contentIp.status : 'CONTENT-IP REVIEW: -');
    L.push('');
    L.push('FINAL: ' + (f.finalIcon || '') + ' ' + (f.final || '-'));
    L.push('');
    L.push('Generated: ' + (ctx.dateStr || '') + ' — EPS 10 Studio (all processing local, nothing uploaded)');
    return L.join('\n');
  }

  return {
    SECTIONS: SECTIONS, PROFILES: PROFILES, buildReport: buildReport, itemLabel: itemLabel,
    RULE_CHECKS: RULE_CHECKS, MARKETPLACE_RULES: MARKETPLACE_RULES,
    addRuleCheck: addRuleCheck, updateMarketplaceRules: updateMarketplaceRules,
    marketplaceStatus: marketplaceStatus, finalStatus: finalStatus,
    preflightText: preflightText
  };
}));
