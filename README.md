# EPS 10 Studio — Batch SVG → EPS 10 (Illustrator 10) Marketplace Preflight

Offline, zero-CDN web app. Upload a batch of SVG files → each one is validated,
auto-fixed (artboard, centering, cleanup, text outlining), checked against the
**EPS 10 Marketplace Preflight System**, and exported as an Illustrator-10
compatible `.eps` — ready for Adobe Stock / Shutterstock / Dreamstime / VectorStock.

Everything runs in the browser (Node is only used for the test suite). No network
calls, no build step. The project is ready for GitHub Pages and works from a
repository subpath such as `username.github.io/repository-name/`.

## Deploy to GitHub Pages

1. Upload **all files and folders** to the repository root (do not upload only
   `index.html`).
2. Open **Settings → Pages**.
3. Select **Deploy from a branch → main → /(root)** and save.
4. Open `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

The included `.nojekyll` keeps every static asset untouched. All CSS, JavaScript,
page links, and sample-file paths are relative, so GitHub project pages work
without changing the repository name. See **`GITHUB-PAGES-SETUP-BN.md`** for the
complete Bengali guide.

## Run locally

```bash
cd eps10-studio
python3 -m http.server 8080 --bind 0.0.0.0
# open http://localhost:8080            -> full preflight studio (index.html)
# open http://localhost:8080/vector-eps10.html -> VectorPro-look batch tool
```

## Two entry points

- **`index.html`** — the full EPS 10 preflight studio: 10-section report,
  54-point preflight dialog (alignment, margins, overflow, overlaps,
  self-intersections, zero-area, near-dups, colors, silhouette mode, smoothness,
  quality flags, smart simplify, path repair, version history with restore,
  3-tier marketplace final check, downloadable preflight .txt).
- **`vector-eps10.html`** — VectorPro-styled batch tool: unlimited SVG upload,
  **before → after preview grid for every file**, status badges
  (READY FOR REVIEW / MARKETPLACE REVIEW / NEEDS FIX), per-file details modal
  (KPIs + 6 quality flags + findings), per-file EPS ⬇ and one ZIP of the whole batch.

Both share the same engine (`js/veclib.js`, `js/svgfix.js`, `js/eps10.js`,
`js/analyze.js`, `js/audit.js`) — 100% client-side, zero CDN.

## Test

```bash
cd eps10-studio-test
npm install jsdom       # once per session (node_modules is not persisted)
cd ../eps10-studio && ln -sfn ../eps10-studio-test/node_modules node_modules && cd ../eps10-studio-test
node test.js            # 114 unit/integration checks
node smoke-browser.js   # 51 browser E2E checks for index.html (jsdom)
node smoke-vector.js    # 29 browser E2E checks for vector-eps10.html (jsdom)
```

## Usage

1. **Load a TTF font** (once per session) — used to outline `<text>` elements
   (marketplaces reject live text). Any TTF works (e.g. DejaVu Sans).
2. **Drop N SVG files** (or use the sample in `samples/`).
3. For each file the pipeline runs: validate → artboard → measure bbox →
   auto-center → structure → cleanup (hidden/duplicates/stray/clip masks) →
   text outline → EPS 10 compat → generate + reopen test → marketplace rules →
   final report.
4. Row buttons:
   - **Report** — 10-section compliance report.
   - **Preflight** — the full preflight dialog (below).
   - **EPS ⬇** — download the final EPS 10 (always from the *current* version).
   - **SVG ⬇** — download the current fixed SVG.
   - **Download All (ZIP)** — all EPS files at once.

## Preflight dialog (per file)

| Section | What it does |
|---|---|
| Pipeline | 12-step status strip (✓/✗) — upload → … → final report |
| Final status | 3 tiers: TECHNICAL / MARKETPLACE (profile) / CONTENT-IP (manual checkbox) → FINAL: 🟢 READY TO SUBMIT / 🟡 NEEDS REVIEW / 🔴 NEEDS FIX |
| Alignment | X/Y offset + status; **Auto Center** (re-center) and **Manual fine-adjust** (X/Y px nudge) — every move = new version |
| Safe margins | Top/Right/Bottom/Left px, 🟢 Balanced / 🟡 Uneven, adaptive thresholds (5%/2% of artboard) |
| Clipping/overflow | N objects beyond artboard (red-box preview **before** any auto-fix); clipping-mask cut detection |
| Quality flags | Contour / Node Density / Smoothness / Tiny Artifacts / Negative Space / Overlap — flags, not a score |
| Overlap analysis | Normal / Suspicious (99%+ near-identical) / Critical (containment) |
| Geometry | self-intersections, zero-area/tiny objects, open paths, near-duplicates (similarity %), color clusters, holes, clip masks, smoothness |
| Silhouette mode | optional dedicated check: primary fill, background, stroke, holes, color count, transparency → "🟢 Clean Silhouette" |
| Smart Simplify | RDP, tolerance slider, live "N → M nodes, deviation X%" estimate, **Preview → Apply** (never automatic) |
| Path Repair | duplicate anchors, tiny-gap close, endpoint snap, isolated points — **Preview → Apply** |
| Undo / versions | Version 1 Original → … → Version N (EPS export source); **↩ Restore** any version; before/after side-by-side compare |
| Download | **Report (.txt)** in the standard preflight report format |

## Files

```
eps10-studio/
  index.html          single page (dropzone, settings, batch table, report + preflight dialogs)
  css/app.css
  js/veclib.js        vector math, SVG path parse/normalize/serialize, transforms, ZIP writer
  js/svgfix.js        SVG cleanup pipeline (artboard/center/cleanup/outline) — report findings
  js/eps10.js         EPS 10 writer + Illustrator-10 compatibility validator
  js/analyze.js       preflight geometry engine (items 36–49: offsets, margins, overflow,
                      clips, overlaps, self-int, zero-area, dups, colors, holes,
                      smoothness, silhouette, flags, RDP simplify, repair)
  js/audit.js         10-section report builder + marketplace rules DB (updateable via
                      Audit.updateMarketplaceRules) + 3-tier final status + preflight .txt
  js/app.js           UI wiring, batch processing, preflight dialog, versions, downloads
  js/opentype.min.js  vendored (offline) text→glyph outline
  samples/            kitchen-sink test SVG + font for a quick try
eps10-studio-test/
  test.js             114 checks (veclib, pipeline, eps10, analyze, audit)
  smoke-browser.js    51 jsdom E2E checks (real page load → full workflow)
  out-preflight.txt   sample generated preflight report
```

## Notes / honest limits

- Marketplace rules change over time — the rules DB is plain data (`MARKETPLACE_RULES`
  in `js/audit.js`) and stays updateable at runtime via `Audit.updateMarketplaceRules(profile, [checkIds])`.
- CONTENT/IP review is always manual (no software can verify trademarks/copyright).
- Self-intersections and unexpected containment are **detected and reported**;
  auto-repair of self-intersections / boolean union of overlapping shapes is
  intentionally **not** done automatically (destructive without a geometry kernel).
- All destructive operations follow **Original → Preview → Apply** with version
  history, so nothing is lost.
