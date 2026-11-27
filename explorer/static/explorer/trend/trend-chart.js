/*
 * trend-chart.js: interactive Trend Analysis tab
 * ===============================================
 * Every statistic is computed in the browser by stats.js (window.TrendStats),
 * so the chart responds while you drag. The server engine
 * (/api/trend/fit/, explorer/trend_engine.py) stays the reference:
 * explorer/static/explorer/trend/stats.selftest.html compares the two engines.
 *
 * What you can do on the chart
 *   Split the trend (B): click a year to add a piecewise breakpoint; drag a
 *                       dashed breakpoint line to move it. Fits update live.
 *   Zoom in (Z):        draw a box; double-click or Reset view zooms out.
 *   Policies:           click a ▲ marker to pin it as a vertical line; hover
 *                       the line for its description and Policy Timeline link.
 * State (series, model, breakpoints, pinned policies, options) is kept in the
 * URL hash, #trend/<state>, so a copied link reopens the same analysis.
 *
 * Exposes one global entry point, initTrendTab(), which the page's tab code
 * calls the first time the tab is opened. Plotly is loaded on demand then.
 */
(function () {
  "use strict";

  const PLOTLY_URL = "https://cdn.jsdelivr.net/npm/plotly.js-basic-dist-min@2.35.2/plotly-basic.min.js";
  const PLOTLY_FALLBACK = "/static/policies/vendor/plotly.min.js";
  const S = window.TrendStats;
  const UNITS = "kt CO₂-eq";
  const SEG_COLORS = ["#1b6ca8", "#c0392b", "#2e8b57", "#8e44ad", "#d68910", "#16a085", "#7f8c8d", "#2c3e50"];
  const POLICY_COLORS = { International: "#5b6b7a", EU: "#1f4e9e", National: "#00843D", Target: "#c0392b" };
  const MAX_BREAKS = 10;
  const HANDLE_PX = 8;
  // Plotly drag behaviour per tool (Breakpoint mode only reacts to clicks). The tools are toggles:
  // pressing the active one again leaves the chart with no tool ("none": it only shows hover values).
  const DRAGMODE = { breakpoint: false, zoom: "zoom", edit: false, none: false };

  const T = {
    inited: false, data: null, gd: null,
    gas: null, sector: null, method: "ols", conf: 0.95,
    bps: [2001],
    opt: { band: true, pred: false, bp: true, log: false, mk: true, pol: true },
    hidden: new Set(),        // series hidden from the legend: "obs", "seg:<n>", "bp", "pol:<group>"
    mode: "breakpoint", result: null, drag: null, raf: 0, hashTimer: 0,
    pins: new Set(),          // policies drawn on the chart: "c|<year>|<name>" or "s|<slug>"
    card: null, cardTimer: 0, cardKey: null,
    // policy panel: which list, sector override (null = follow the chart), filters
    // polTab: "relevant" (ranked for the chart's gas + sector, the default), "sector" or "core"
    // polSort: "strength" (importance and strength, the default), "new" or "old" (by start year)
    polData: null, polTab: "relevant", polSector: null, polCross: false, polAllGases: false,
    polSort: "strength", polRelAll: false, polPulse: false,
    polOpen: new Set(), polSeen: new Set(), colors: {}, palette: null,
    polFilter: { on: false, a: null, b: null, lo: null, hi: null },   // period filter on the policy lists   // open groups, group colour overrides
  };
  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const fmt = (v, d = 1) => isNum(v) ? v.toLocaleString("en-IE", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
  const fmtSig = (v, s = 4) => isNum(v) ? Number(v.toPrecision(s)).toLocaleString("en-IE", { maximumFractionDigits: 8 }) : "–";
  const fmtSigned = (v, d = 1) => isNum(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d) : "–";
  const fmtP = p => !isNum(p) ? "–" : p < 1e-4 ? "< 0.0001" : p.toFixed(4);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stars = p => !isNum(p) ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "";

  function setError(msg) {
    const box = $("trError");
    box.hidden = !msg;
    box.textContent = msg || "";
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Plotly) return resolve();
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error("Could not load the charting library (Plotly).")); };
      document.head.appendChild(s);
    });
  }
  // CDN build first (1 MB); the Policy Timeline's vendored full build if the CDN is unreachable
  const loadPlotly = () => loadScript(PLOTLY_URL).catch(() => loadScript(PLOTLY_FALLBACK));

  async function initTrendTab() {
    if (T.inited) return;
    T.inited = true;
    $("trLoading").hidden = false;
    try {
      const [bundle, pol] = await Promise.all([
        fetch("/api/trend/bundle/").then(r => r.json()),
        // policy overlay data; the chart still works if it cannot be loaded
        fetch("/api/trend/policies/").then(r => r.json()).catch(() => null),
        loadPlotly(),
      ]);
      if (!bundle.ok) throw new Error(bundle.detail || "Trend data unavailable.");
      T.data = bundle;
      readHash();
      if (pol && pol.ok) setPolicyData(pol);
      buildControls();
      bindPolicyPanel();
      mountPlotSettings();
      bindChart();
      recompute();
    } catch (err) {
      setError("Could not start Trend Analysis: " + err.message);
    } finally {
      $("trLoading").hidden = true;
    }
  }

  function seriesChanged() {
    T.polSector = null; T.polRelAll = false; T.polPulse = true;
    if (T.polTab === "core") T.polTab = "relevant";      // core milestones do not depend on the series
    hideCard(true); recompute();
  }

  function series() {
    const vals = (T.data.gases[T.gas] || {})[T.sector] || [];
    const x = [], y = [];
    T.data.years.forEach((yr, i) => { const v = vals[i]; if (isNum(v)) { x.push(yr); y.push(v); } });
    return { x, y };
  }

  // ------------------------------------------------------------------
  // URL hash state: #trend/<base64url(JSON)>
  // ------------------------------------------------------------------
  const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

  function readHash() {
    const gases = Object.keys(T.data.gases);
    T.gas = gases[0];
    T.sector = Object.keys(T.data.gases[T.gas])[0];
    const m = location.hash.match(/^#trend\/(.+)$/);
    if (!m) return;
    try {
      const st = JSON.parse(b64d(m[1]));
      if (T.data.gases[st.g]) T.gas = st.g;
      if (T.data.gases[T.gas][st.s]) T.sector = st.s;
      if (["ols", "huber", "theilsen"].includes(st.m)) T.method = st.m;
      if (isNum(st.c) && st.c >= 0.8 && st.c <= 0.99) T.conf = Math.round(st.c * 100) / 100;
      if (Array.isArray(st.p)) st.p.forEach(k => { if (typeof k === "string") T.pins.add(k); });
      if (["relevant", "sector", "core"].includes(st.t)) T.polTab = st.t;
      if (["strength", "new", "old"].includes(st.r)) T.polSort = st.r;
      if (Array.isArray(st.f) && isNum(st.f[0]) && isNum(st.f[1])) Object.assign(T.polFilter, { on: true, a: st.f[0], b: st.f[1] });
      if (st.k && typeof st.k === "object") for (const [g, c] of Object.entries(st.k)) if (/^#[0-9a-f]{6}$/i.test(c) || c === "transparent") T.colors[g] = c;
      if (Array.isArray(st.b)) T.bps = st.b.filter(isNum).slice(0, MAX_BREAKS);
      if (st.o && typeof st.o === "object") for (const k of Object.keys(T.opt)) if (k in st.o) T.opt[k] = st.o[k];
    } catch (e) { /* ignore a malformed link and start from defaults */ }
  }
  function writeHash() {
    clearTimeout(T.hashTimer);
    T.hashTimer = setTimeout(() => {
      if (!location.hash.startsWith("#trend") && !document.getElementById("tab-trend").classList.contains("active")) return;
      history.replaceState(null, "", location.pathname + location.search + "#trend/" + b64e(JSON.stringify(stateObj())));
    }, 250);
  }
  const stateObj = () => ({ g: T.gas, s: T.sector, m: T.method, c: T.conf, b: T.bps, o: T.opt, p: [...T.pins], k: T.colors,
    ...(T.polTab !== "relevant" ? { t: T.polTab } : {}), ...(T.polSort !== "strength" ? { r: T.polSort } : {}),
    ...(T.polFilter.on ? { f: [T.polFilter.a, T.polFilter.b] } : {}) });

  // ------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------
  function fillSectors() {
    const sel = $("trSector");
    const names = Object.keys(T.data.gases[T.gas] || {});
    sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join("");
    if (!names.includes(T.sector)) T.sector = names[0];
    sel.value = T.sector;
  }

  function buildControls() {
    const gasSel = $("trGas");
    gasSel.innerHTML = Object.keys(T.data.gases).map(g => `<option>${esc(g)}</option>`).join("");
    gasSel.value = T.gas;
    fillSectors();
    $("trMethod").value = T.method;
    const conf = $("trConf"), confOut = $("trConfOut");
    const showConf = () => { confOut.textContent = `${Math.round(T.conf * 100)}%`; conf.setAttribute("aria-valuetext", confOut.textContent); };
    conf.value = String(Math.round(T.conf * 100));
    showConf();
    // live while dragging: every step re-fits in the browser
    conf.addEventListener("input", () => { T.conf = parseInt(conf.value, 10) / 100; showConf(); scheduleRender(); });
    conf.addEventListener("dblclick", () => { conf.value = "95"; conf.dispatchEvent(new Event("input")); });
    const toggles = { trShowBand: "band", trShowPred: "pred", trShowBp: "bp", trLogY: "log", trEnableMk: "mk" };
    for (const [id, key] of Object.entries(toggles)) {
      const el = $(id);
      el.checked = !!T.opt[key];
      el.addEventListener("change", () => { T.opt[key] = el.checked; syncSettingsOpts(); recompute(); });
    }

    // a new gas or sector re-targets the policy panel: the sector list goes back to
    // "same as the chart" and the panel shows the policies ranked for the new series
    gasSel.addEventListener("change", () => { T.gas = gasSel.value; fillSectors(); seriesChanged(); });
    $("trSector").addEventListener("change", e => { T.sector = e.target.value; seriesChanged(); });
    $("trMethod").addEventListener("change", e => { T.method = e.target.value; recompute(); });

    const bpIn = $("trBpInput");
    const addFromInput = () => {
      bpIn.value.split(/[,;\s]+/).map(Number).filter(isNum).forEach(addBreakpoint);
      bpIn.value = "";
      recompute();
    };
    bpIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addFromInput(); } });
    $("trBpAdd").addEventListener("click", addFromInput);
    $("trBpClear").addEventListener("click", () => { T.bps = []; recompute(); });
    $("trBpAuto").addEventListener("click", autoDetect);
    $("trBpChips").addEventListener("click", e => {
      const b = e.target.closest("[data-bp]");
      if (b) { T.bps = T.bps.filter(v => v !== Number(b.dataset.bp)); recompute(); }
    });

    document.querySelectorAll("#trModes [data-mode]").forEach(b =>
      b.addEventListener("click", () => toggleMode(b.dataset.mode)));
    $("trResetView").addEventListener("click", () => window.Plotly.relayout(T.gd, { "xaxis.autorange": true, "yaxis.autorange": true }));
    // "Policies" button: hide / show every policy line (the ticks in the panel are kept)
    $("trPolToggle").addEventListener("click", () => { T.opt.pol = !T.opt.pol; if (!T.opt.pol) hideCard(true); recompute(); });
    // "Clear policies" button: remove every policy line (unticks them in the panel too)
    $("trPolClearChart").addEventListener("click", () => {
      if (!T.pins.size) return;
      T.pins.clear(); hideCard(true); recompute();
    });
    $("trLegend").addEventListener("click", e => {
      const b = e.target.closest("[data-lg]");
      if (!b || b.disabled) return;
      const k = b.dataset.lg;
      if (T.hidden.has(k)) T.hidden.delete(k); else T.hidden.add(k);
      if (k.startsWith("pol:")) hideCard(true);
      recompute();
    });

    $("trCsvBtn").addEventListener("click", downloadCsv);
    // PNG: the on-screen legend is HTML, so the export gets its own legend in three columns
    $("trPngBtn").addEventListener("click", () => window.Plotly.downloadImage({
      data: T.gd.data,
      layout: {
        ...T.gd.layout, showlegend: true,
        title: T.gd.layout.title && T.gd.layout.title.text ? T.gd.layout.title : { text: `${T.gas}: ${T.sector}`, x: 0.01, font: { size: 16 } },
        margin: { ...T.gd.layout.margin, t: 56, b: 130 },
        legend: { orientation: "h", x: 0, y: -0.1, yanchor: "top", traceorder: "normal", entrywidth: 0.33, entrywidthmode: "fraction", font: { size: 12 } },
        font: { ...T.gd.layout.font, family: (PSget().font.family || "Segoe UI, Helvetica, Arial, sans-serif") },
      },
    }, { format: "png", scale: 2, width: 1400, height: Math.max(600, (PSget().figure.height || 540) + 280), filename: slug(`trend_${T.gas}_${T.sector}`) }));
    $("trLinkBtn").addEventListener("click", copyLink);
    $("trAdvancedPanel").addEventListener("shown.bs.collapse", renderDiagnostics);

    document.addEventListener("keydown", e => {
      if (!$("tab-trend").classList.contains("active")) return;
      const el = e.target instanceof Element ? e.target : null;
      if ((el && el.closest("input, select, textarea, [contenteditable]")) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = { b: "breakpoint", z: "zoom", e: "edit" }[e.key.toLowerCase()];
      if (k) { toggleMode(k); e.preventDefault(); }
      if (e.key === "Escape") { hideCard(true); closePalette(); if (window.TrendPlotStyle) window.TrendPlotStyle.closeEdit(); }
    });
  }

  // Advanced Plot Settings (plot-style.js): visual options only. The Display
  // switches (bands, breakpoints, log scale) are shared with the sidebar.
  const OPT_INPUTS = { band: "trShowBand", pred: "trShowPred", bp: "trShowBp", log: "trLogY" };
  function mountPlotSettings() {
    if (!window.TrendPlotStyle) return;
    window.TrendPlotStyle.mount({
      root: $("trPlotSettingsBody"),
      onChange: () => scheduleRender(),
      getOpt: k => !!T.opt[k],
      setOpt: (k, v) => { T.opt[k] = !!v; if (OPT_INPUTS[k]) $(OPT_INPUTS[k]).checked = !!v; recompute(); },
      dynamic: () => {
        const R = T.result || {};
        const span = q => R.x && q.year >= R.x[0] && q.year <= R.x[R.x.length - 1];
        return {
          breakpoints: R.pw ? R.pw.used.slice() : [],
          policies: R.x ? pinnedInView(span).map(({ p }) => ({ key: p.key, name: p.name, color: p.color })) : [],
          legend: (T.legend || []).map(e => ({ key: e.key, label: e.label })),
        };
      },
      openSettings: () => {
        const c = $("trPlotSettings");
        if (window.bootstrap && !c.classList.contains("show")) window.bootstrap.Collapse.getOrCreateInstance(c).show();
        c.closest(".tr-ps").scrollIntoView({ behavior: "smooth", block: "start" });
      },
      onEditClose: () => { ED.sel = null; paintEdit(); },
    });
    $("trPlotSettings").addEventListener("shown.bs.collapse", () => window.TrendPlotStyle.refresh());
  }
  // keep the settings panel's copies of the Display switches in step with the sidebar
  const syncSettingsOpts = () => document.querySelectorAll("#trPlotSettingsBody [data-opt]").forEach(el => {
    if (el.type === "checkbox") el.checked = !!T.opt[el.dataset.opt]; else el.value = String(!!T.opt[el.dataset.opt]);
  });

  // a tool button (or its key) turns that tool on, or off when it is already on
  const toggleMode = mode => setMode(T.mode === mode ? "none" : mode);
  function setMode(mode) {
    T.mode = mode;
    document.querySelectorAll("#trModes [data-mode]").forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (T.gd && T.gd.layout) window.Plotly.relayout(T.gd, { dragmode: DRAGMODE[mode], hovermode: mode === "edit" ? false : "x unified" });
    $("trPlotWrap").toggleAttribute("data-edit", mode === "edit");
    if (mode === "edit") hideCard(true); else editDone();
    $("trModeHint").innerHTML = {
      breakpoint: '<i class="bi bi-hand-index"></i> <b>Split the trend:</b> click a year to add a breakpoint, or drag a dashed line to move it. Tick policies in the <b>Policy overlay</b> panel to draw them on the chart.',
      zoom: '<i class="bi bi-hand-index"></i> <b>Zoom in:</b> drag a box. Double-click the chart or press Reset view to zoom out.',
      edit: '<i class="bi bi-hand-index"></i> <b>Edit plot:</b> click any part of the chart (title, axes, a line, the background, the legend) to change its look. Esc closes the box. Press <b>Edit plot</b> again to finish.',
      none: '<i class="bi bi-info-circle"></i> No tool selected: hover the chart to read the values. Press <b>Split the trend</b>, <b>Zoom in</b> or <b>Edit plot</b> to use a tool; press it again to turn it off.',
    }[mode];
  }

  // ------------------------------------------------------------------
  // Model editing
  // ------------------------------------------------------------------
  function dataSpan() {
    const { x } = series();
    return { lo: x[0], hi: x[x.length - 1] };
  }
  function addBreakpoint(v) {
    v = Math.round(v);
    const { lo, hi } = dataSpan();
    if (!(v > lo && v < hi)) { setError(`Breakpoint ${v} is outside ${lo}–${hi} and was ignored.`); return; }
    if (T.bps.includes(v)) return;
    if (T.bps.length >= MAX_BREAKS) { setError(`At most ${MAX_BREAKS} breakpoints.`); return; }
    T.bps = [...T.bps, v].sort((a, b) => a - b);
  }
  function autoDetect() {
    const { x, y } = series();
    const maxB = parseInt($("trBpMax").value, 10) || 2;
    try {
      const res = S.detectBreaks(x, y, maxB, 4);
      T.bps = res.best.breaks.slice();
      T.detect = res;
      setError(res.best.breaks.length ? null : "No break improved the BIC; a single trend fits best.");
      recompute();
    } catch (e) { setError(e.message); }
  }

  // ------------------------------------------------------------------
  // Computation (pure stats.js calls; ~1 ms for an annual series)
  // ------------------------------------------------------------------
  function recompute() {
    if (!T.data) return;
    const { x, y } = series();
    const res = { x, y, pw: null, pwError: null, chow: [] };
    // Breakpoints outside this series' span are kept (not deleted) but not used:
    // piecewise() ignores them, so they come back when a longer series is chosen.
    if (x.length >= S.MIN_POINTS_PER_SEGMENT) {
      try {
        res.pw = S.piecewise(x, y, T.bps, { method: T.method, confidence: T.conf });
        res.pw.segments.forEach(seg => { seg.mk = S.mannKendall(seg.y); seg.sen = S.sensSlope(seg.x, seg.y, T.conf); });
        res.chow = res.pw.used.map(bp => S.chowTest(x, y, bp)).filter(Boolean);
        const notes = res.pw.segments.filter(s => s.warning).map(s => `Segment ${s.index}: ${s.warning}`);
        if (res.pw.skipped.length) notes.unshift("Skipped segment(s) with fewer than 3 points: " +
          res.pw.skipped.map(p => `${p.lo}–${p.hi}`).join(", ") + ". Move or remove a breakpoint.");
        setError(notes.join(" ") || null);
      } catch (e) { res.pwError = e.message; setError(e.message); }
    } else {
      res.pwError = `This series has only ${x.length} valid value(s); at least 3 are needed.`;
      setError(res.pwError);
    }
    T.result = res;
    render();
    writeHash();
  }
  function scheduleRender() {
    if (T.raf) return;
    T.raf = requestAnimationFrame(() => { T.raf = 0; recompute(); });
  }

  // ------------------------------------------------------------------
  // Chart
  // ------------------------------------------------------------------
  // "No colour" is stored as "transparent": whatever uses it is not drawn
  const rgba = (hex, a) => {
    if (!/^#[0-9a-f]{6}$/i.test(String(hex))) return "rgba(0,0,0,0)";
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };
  // meta: which part of the chart a trace is (Edit plot), e.g. "obs", "seg:0", "band:0"
  function bandTraces(lo, hi, xs, color, name, alpha, meta) {
    return [
      { x: xs, y: lo, type: "scatter", mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false, meta },
      { x: xs, y: hi, type: "scatter", mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: rgba(color, alpha),
        hoverinfo: "skip", name, showlegend: false, meta },
    ];
  }
  function lineGrid(a, b) { // dense x grid so bands curve smoothly
    const out = []; const steps = Math.max(2, Math.round((b - a) * 2));
    for (let i = 0; i <= steps; i++) out.push(a + (b - a) * i / steps);
    return out;
  }

  // Each series also yields a legend entry (drawn as HTML under the chart, in
  // columns) with a key; clicking an entry hides or shows that series (T.hidden).
  // Every visual property comes from the Advanced Plot Settings (plot-style.js);
  // the statistics in T.result are only read, never changed, here.
  const PSget = () => (window.TrendPlotStyle ? window.TrendPlotStyle.get() : null);
  const fontW = w => (w === "bold" ? 700 : 400);
  function fam(v, PS) { return v || PS.font.family || "inherit"; }

  function axisLayout(a, PS, isLog) {
    // custom tick positions: ignore blanks (Number("") would be 0)
    const vals = String(a.tick.vals || "").split(/[,;\s]+/).filter(t => t.trim() !== "").map(Number).filter(isNum);
    const lim = v => (v == null ? null : isLog ? (v > 0 ? Math.log10(v) : null) : v);
    const lo = lim(a.range.min), hi = lim(a.range.max);
    const box = PS.figure.box;
    const out = {
      title: { text: a.title.text, standoff: 8,
        font: { family: fam(a.title.family, PS), size: a.title.size, weight: fontW(a.title.weight), style: a.title.style, color: a.title.color || PS.font.color } },
      tickfont: { family: fam(a.tick.family, PS), size: a.tick.size, weight: fontW(a.tick.weight), color: a.tick.color || PS.font.color },
      tickangle: a.tick.angle === "auto" ? "auto" : +a.tick.angle,
      ticks: a.tick.dir, ticklen: a.tick.len, tickcolor: box ? PS.figure.boxColor : a.line.color,
      showgrid: a.grid.show, gridcolor: a.grid.color, gridwidth: a.grid.width, griddash: a.grid.dash,
      showline: a.line.show || box, linecolor: box ? PS.figure.boxColor : a.line.color,
      linewidth: box ? PS.figure.boxWidth : a.line.width, mirror: box ? "ticks" : false,
      zeroline: !!a.zeroline, automargin: true,
    };
    if (vals.length) { out.tickmode = "array"; out.tickvals = vals; }
    else if (isNum(a.tick.dtick) && a.tick.dtick > 0) { out.tickmode = "linear"; out.dtick = isLog ? Math.log10(a.tick.dtick) || 1 : a.tick.dtick; }
    if (a.tick.minor || a.grid.minor) out.minor = { ticks: a.tick.minor ? (a.tick.dir || "outside") : "", ticklen: Math.max(2, a.tick.len * 0.6),
      showgrid: !!a.grid.minor, gridcolor: a.grid.minorColor, gridwidth: Math.max(0.5, a.grid.width * 0.6) };
    if (lo != null && hi != null && hi > lo) { out.range = [lo, hi]; out.autorange = false; }
    else if (lo != null) { out.range = [lo, null]; out.autorange = "max"; }
    else if (hi != null) { out.range = [null, hi]; out.autorange = "min"; }
    return out;
  }

  function buildFigure() {
    const R = T.result, traces = [], shapes = [], annotations = [], legend = [];
    const PS = PSget() || window.TrendPlotStyle.DEFAULTS;
    const shown = key => !T.hidden.has(key);
    const L = (key, label) => PS.legend.labels[key] || label;            // custom legend labels
    const inLegend = key => !PS.legend.omit.includes(key);
    const segColor = i => PS.trend.palette[i % PS.trend.palette.length] || SEG_COLORS[i % SEG_COLORS.length];

    // Observations
    const O = PS.obs;
    legend.push({ key: "obs", label: L("obs", "Observed emissions"), color: O.marker.show ? O.marker.color : O.line.color,
      style: O.marker.show ? "marker" : O.line.dash, lineColor: O.line.color, symbol: O.marker.symbol });
    if (shown("obs") && (O.line.show || O.marker.show)) traces.push({
      x: R.x, y: R.y, type: "scatter", mode: [O.line.show && "lines", O.marker.show && "markers"].filter(Boolean).join("+"),
      name: L("obs", "Observed emissions"), showlegend: inLegend("obs"),
      line: { color: rgba(O.line.color, O.line.opacity), width: O.line.width, dash: O.line.dash },
      marker: { color: O.marker.color, size: O.marker.size, symbol: O.marker.symbol, opacity: O.marker.opacity,
        line: { color: O.marker.edge, width: O.marker.edgeWidth } },
      hovertemplate: `%{y:,.1f} ${UNITS}<extra>Observed</extra>`, meta: "obs",
    });

    // Piecewise segments (line + optional bands share one legend entry)
    if (R.pw) R.pw.segments.forEach((seg, i) => {
      const c = segColor(i), key = `seg:${seg.index}`;
      const label = L(key, `Trend ${seg.start}–${seg.end}`);
      legend.push({ key, label, sub: `${fmtSigned(seg.slope)} kt/yr`, color: c, style: PS.trend.dash, band: T.opt.band || T.opt.pred,
        bandColor: PS.band.color || c, bandOpacity: PS.band.opacity });
      if (!shown(key)) return;
      const g = lineGrid(seg.start, seg.end), bd = S.bands(seg, g, T.conf);
      if (T.opt.pred) traces.push(...bandTraces(bd.map(p => p.predLo), bd.map(p => p.predHi), g, PS.pred.color || c, "Prediction interval", PS.pred.opacity, `pred:${i}`));
      if (T.opt.band) traces.push(...bandTraces(bd.map(p => p.meanLo), bd.map(p => p.meanHi), g, PS.band.color || c, "Confidence band", PS.band.opacity, `band:${i}`));
      traces.push({
        x: [seg.start, seg.end], y: [seg.intercept + seg.slope * seg.start, seg.intercept + seg.slope * seg.end],
        type: "scatter", mode: "lines", line: { color: rgba(c, PS.trend.opacity), width: PS.trend.width, dash: PS.trend.dash },
        name: `${label} (${fmtSigned(seg.slope)} kt/yr)`, showlegend: inLegend(key),
        hovertemplate: `Seg ${seg.index} fit: %{y:,.1f}<extra>${fmtSigned(seg.slope)} /yr</extra>`, meta: `seg:${i}`,
      });
    });

    // Breakpoints (each one can hide its line or its year label)
    const B = PS.bp;
    if (T.opt.bp && R.pw && R.pw.used.length) {
      legend.push({ key: "bp", label: L("bp", R.pw.used.length > 1 ? "Breakpoints" : "Breakpoint"), sub: R.pw.used.join(", "),
        color: B.color, style: "vline", dash: B.dash });
      if (shown("bp")) R.pw.used.forEach(bp => {
        if (B.hidden.includes(bp)) return;
        const lab = B.label.show && !B.hiddenLabel.includes(bp);
        shapes.push({
          name: `bp:${bp}`, type: "line", xref: "x", yref: "y domain", x0: bp, x1: bp, y0: 0, y1: 1,
          line: { color: B.color, width: B.width, dash: B.dash }, opacity: B.opacity,
          label: lab ? { text: String(bp), textposition: B.label.position, textangle: +B.label.angle,
            font: { family: fam(B.label.family, PS), size: B.label.size, weight: fontW(B.label.weight), color: B.label.color },
            yanchor: B.label.position === "start" ? "bottom" : B.label.position === "end" ? "top" : "middle" } : undefined,
        });
      });
    }

    // Policies ticked in the overlay panel: vertical lines at their start year,
    // labelled; hover one for its full description. Core and sector policies use
    // the styles set in Advanced Plot Settings; each policy can be overridden.
    // The "Policies" button hides them all at once (T.opt.pol); the legend groups them.
    const PO = PS.pol;
    const inSpan = p => p.year >= R.x[0] && p.year <= R.x[R.x.length - 1];
    const pinned = pinnedInView(inSpan);
    const byGroup = new Map();
    pinned.forEach(({ p }) => byGroup.set(p.group, [...(byGroup.get(p.group) || []), p]));
    byGroup.forEach((ps, g) => {
      const key = `pol:${g}`;
      legend.push({ key, label: L(key, GROUP_LABEL[g] || (g === "Cross-sectoral" ? "Cross-sectoral laws" : `${g} policies`)),
        sub: `${ps.length} on chart`, color: colorOf(g), style: ps[0].kind === "sector" ? PO.sectorDash : PO.coreDash, off: !T.opt.pol });
    });
    if (T.opt.pol) pinned.forEach(({ p, x }) => {
      if (!shown(`pol:${p.group}`)) return;
      const o = PO.per[p.key] || {};
      if (o.show === false) return;
      const c = o.color || p.color, lc = PO.label.color || c;
      const txt = (o.text || "").trim() || p.name;
      const showLabel = PO.label.show && o.label !== false;
      const max = Math.max(8, PO.label.maxChars | 0);
      shapes.push({
        name: `pol:${p.key}`, type: "line", xref: "x", yref: "y domain", x0: x, x1: x, y0: 0, y1: 1,
        line: { color: c, width: PO.width, dash: p.kind === "sector" ? PO.sectorDash : PO.coreDash }, opacity: PO.opacity, layer: "above",
        label: showLabel ? { text: txt.length > max ? txt.slice(0, max - 1).trimEnd() + "…" : txt,
          textposition: PO.label.position, textangle: +PO.label.angle, xanchor: PO.label.anchor, padding: PO.label.padding,
          font: { family: fam(PO.label.family, PS), size: PO.label.size, weight: fontW(PO.label.weight), style: PO.label.style, color: lc } } : undefined,
      });
    });
    T.legend = legend;

    const F = PS.figure;
    const titleOn = F.title.show;
    const layout = {
      uirevision: T.gas + "|" + T.sector,
      height: F.height,
      margin: { l: F.margin.l, r: F.margin.r, t: titleOn ? Math.max(F.margin.t, F.title.size + 26) : F.margin.t, b: F.margin.b },
      dragmode: DRAGMODE[T.mode],
      hovermode: T.mode === "edit" ? false : "x unified",    // Edit plot: no hover labels
      hoverlabel: { bgcolor: "rgba(255,255,255,.96)", bordercolor: "#c9d3dc", font: { size: 12 } },
      showlegend: false,                       // replaced by the HTML legend (see renderLegend)
      plot_bgcolor: F.plot, paper_bgcolor: F.paperTransparent ? "rgba(0,0,0,0)" : F.paper,
      font: { family: fam("", PS), size: PS.font.size, color: PS.font.color },
      title: titleOn ? { text: (F.title.text || `${T.gas}: ${T.sector}`), x: 0.01, xanchor: "left",
        font: { size: F.title.size, weight: fontW(F.title.weight), family: fam("", PS), color: PS.font.color } } : undefined,
      xaxis: { ...axisLayout(PS.xaxis, PS, false), showspikes: true, spikemode: "across", spikesnap: "cursor",
        spikecolor: "#8a99a8", spikethickness: 1, spikedash: "dot", tickformat: "d", hoverformat: "d" },
      yaxis: { ...axisLayout(PS.yaxis, PS, !!T.opt.log), type: T.opt.log ? "log" : "linear", tickformat: ",~r" },
      shapes, annotations,
    };
    return { traces, layout };
  }

  // Legend swatch: a short line in the series' style (or a marker), with a band behind it when shown
  const DASH = { solid: "", dash: "6 4", dot: "1.5 3.5", dashdot: "7 3 1.5 3", longdash: "10 4" };
  const MARKER_SVG = {
    circle: c => `<circle cx="17" cy="7" r="3.6" fill="${c}"/>`, "circle-open": c => `<circle cx="17" cy="7" r="3.3" fill="#fff" stroke="${c}" stroke-width="1.5"/>`,
    square: c => `<rect x="13.5" y="3.5" width="7" height="7" fill="${c}"/>`, "square-open": c => `<rect x="13.7" y="3.7" width="6.6" height="6.6" fill="#fff" stroke="${c}" stroke-width="1.5"/>`,
    diamond: c => `<path d="M17 2.5 21.5 7 17 11.5 12.5 7z" fill="${c}"/>`, "triangle-up": c => `<path d="M17 2.5 21.5 11 12.5 11z" fill="${c}"/>`,
    cross: c => `<path d="M15.5 3h3v2.5H21v3h-2.5V11h-3V8.5H13v-3h2.5z" fill="${c}"/>`, x: c => `<path d="M13 4l8 6M21 4l-8 6" stroke="${c}" stroke-width="2"/>`,
  };
  function swatchSvg(e) {
    const c = e.color;
    if (e.style === "marker") return `<svg viewBox="0 0 34 14" aria-hidden="true"><line x1="1" y1="7" x2="33" y2="7" stroke="${e.lineColor || c}" stroke-opacity=".45" stroke-width="1.5"/>${(MARKER_SVG[e.symbol] || MARKER_SVG.circle)(c)}</svg>`;
    if (e.style === "vline") return `<svg viewBox="0 0 34 14" aria-hidden="true"><line x1="17" y1="0" x2="17" y2="14" stroke="${c}" stroke-width="2" stroke-dasharray="${DASH[e.dash] || ""}"/></svg>`;
    const band = e.band ? `<rect x="1" y="2" width="32" height="10" rx="2" fill="${rgba(e.bandColor || c, Math.max(0.12, e.bandOpacity || 0.18))}"/>` : "";
    return `<svg viewBox="0 0 34 14" aria-hidden="true">${band}<line x1="1" y1="7" x2="33" y2="7" stroke="${c}" stroke-width="${e.style === "solid" ? 2.8 : 2.2}" stroke-dasharray="${DASH[e.style] || ""}" stroke-linecap="round"/></svg>`;
  }
  function renderLegend() {
    const box = $("trLegend"), wrap = $("trPlotWrap");
    if (!box) return;
    const PS = PSget(), G = PS.legend;
    // position: below / above / right of the chart, or overlaid inside the plot
    const cls = `tr-plotwrap lg-${G.show ? G.position : "none"}`;
    if (wrap.className !== cls) {
      wrap.className = cls;
      // the chart's container changed width (legend moved beside it or back): let Plotly re-measure
      requestAnimationFrame(() => window.Plotly.Plots.resize(T.gd));
    }
    if (G.position === "top") wrap.insertBefore(box, wrap.firstChild); else wrap.appendChild(box);
    box.hidden = !G.show;
    const cols = G.position === "right" ? 1 : Math.max(1, Math.min(4, G.columns | 0));
    box.style.setProperty("--lg-cols", cols);
    box.style.setProperty("--lg-gap", `${G.gap}rem`);
    box.style.setProperty("--lg-size", `${G.size}px`);
    box.style.color = G.color || PS.font.color;
    box.style.fontFamily = PS.font.family || "";
    box.style.background = G.bgOpacity >= 1 ? G.bg : rgba(G.bg, G.bgOpacity);
    box.style.border = G.border ? `${G.borderWidth}px solid ${G.borderColor}` : "0";
    const entries = (T.legend || []).filter(e => !G.omit.includes(e.key));
    box.innerHTML = entries.map(e => {
      const hidden = T.hidden.has(e.key) || e.off;
      return `<button type="button" class="tr-lg-item${hidden ? " is-off" : ""}" data-lg="${esc(e.key)}"
          aria-pressed="${!hidden}" title="${hidden ? "Show" : "Hide"} ${esc(e.label)}"${e.off ? " disabled" : ""}>
        <span class="tr-lg-sw">${swatchSvg(e)}</span>
        <span class="tr-lg-txt"><span class="tr-lg-name">${esc(e.label)}</span>${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</span>
      </button>`;
    }).join("");
    if (!entries.length) box.hidden = true;
  }

  function renderPolicyToggle() {
    const b = $("trPolToggle");
    if (!b) return;
    const n = T.pins.size, on = T.opt.pol;
    b.classList.toggle("active", on && n > 0);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.disabled = !n;
    b.querySelector(".bi").className = `bi ${on ? "bi-eye" : "bi-eye-slash"}`;
    b.querySelector("small").textContent = !n ? "None ticked yet" : on ? `Hide ${n} line${n > 1 ? "s" : ""}` : `Show ${n} line${n > 1 ? "s" : ""}`;
    const c = $("trPolClearChart");
    c.disabled = !n;
    c.querySelector("small").textContent = n ? `Remove ${n} line${n > 1 ? "s" : ""}` : "Nothing to clear";
  }

  function render() {
    const { traces, layout } = buildFigure();
    // the chosen height, capped on small screens
    layout.height = Math.min(layout.height, window.innerWidth < 520 ? 380 : window.innerWidth < 900 ? 460 : Infinity);
    const h = layout.height + "px";
    if (T.gd.style.height !== h) T.gd.style.height = h;
    // No Plotly toolbar: the tool buttons above the chart replace it
    window.Plotly.react(T.gd, traces, layout, { responsive: true, displayModeBar: false, scrollZoom: false });
    renderLegend();
    renderPolicyToggle();
    renderSide();
    if (window.TrendPlotStyle) window.TrendPlotStyle.refresh();
    if (ED.sel) requestAnimationFrame(paintEdit);
    if ($("trAdvancedPanel").classList.contains("show")) renderDiagnostics();
  }

  // ------------------------------------------------------------------
  // Policy overlay: right-hand panel (core / sector policies), vertical
  // lines on the chart, and a detail card with a Policy Timeline link
  // ------------------------------------------------------------------
  // Data: /api/trend/policies/ -> core milestones (data/policies.csv) and the
  // Policy Timeline's sector series. Keys: "c|<year>|<name>" or "s|<slug>".
  let POLICY_LIST = [];
  // Each policy belongs to a group (core: its level; sector policy: its sector).
  // The group's colour is used for its panel box, its dots and its chart lines;
  // the user can change it from the colour swatch in the panel (T.colors).
  let DEFAULT_GROUP_COLORS = { ...POLICY_COLORS };
  const colorOf = g => T.colors[g] || DEFAULT_GROUP_COLORS[g] || "#666";
  function setPolicyData(d) {
    T.polData = d;
    DEFAULT_GROUP_COLORS = { ...POLICY_COLORS, ...(d.sector_colors || {}) };
    const withColor = o => Object.defineProperty(o, "color", { get() { return colorOf(this.group); }, enumerable: true });
    POLICY_LIST = [
      ...(d.core || []).map(p => withColor({ ...p, kind: "core", key: `c|${p.year}|${p.name}`, group: p.level })),
      ...(d.sector || []).map(p => withColor({ ...p, kind: "sector", key: `s|${p.slug}`, year: p.start, group: p.sector })),
    ];
    // period-filter bounds: every policy start year
    const yrs = POLICY_LIST.map(p => p.year).filter(isNum);
    const F = T.polFilter;
    F.lo = Math.min(...yrs); F.hi = Math.max(...yrs);
    F.a = isNum(F.a) ? Math.max(F.lo, Math.min(F.a, F.hi)) : F.lo;
    F.b = F.hi;                                            // no end year: up to the latest policy
    // links from before the panel existed stored core keys as "<year>|<name>"
    T.pins = new Set([...T.pins].map(k => /^[cs]\|/.test(k) ? k : `c|${k}`).filter(policyByKey));
  }
  const policies = () => POLICY_LIST;
  const policyByKey = k => POLICY_LIST.find(p => p.key === k);
  const shortName = s => s.length > 34 ? s.slice(0, 32).trimEnd() + "…" : s;
  /** Pinned policies inside the data span, with a small x offset when several share a year. */
  function pinnedInView(inSpan) {
    const perYear = {};
    return POLICY_LIST.filter(p => T.pins.has(p.key) && isNum(p.year) && inSpan(p)).map(p => {
      const k = perYear[p.year] = (perYear[p.year] ?? -1) + 1;
      return { p, x: p.year + k * 0.22 };
    });
  }

  // Core milestones that have a profile in the Policy Timeline. Several
  // profiles exist per sector; the one for the analysed sector is used.
  const PROFILE_MAP = [
    [/Emissions Trading System/i, { Electricity: "capmf-eu-ets--electricity", Industry: "capmf-eu-ets--industry", Transport: "capmf-eu-ets--transport", _: "capmf-eu-ets--electricity" }],
    [/^Carbon Tax/i, { Transport: "irl-p0005--transport", Industry: "irl-p0005--industry", _: "irl-p0005--buildings" }],
    [/\(Amendment\) Act 2021/i, "capmf-act-2021--cross-sectoral"],
    [/Low Carbon Development Act 2015/i, "capmf-act-2015--cross-sectoral"],
    [/Carbon Budgets/i, "capmf-carbon-budgets--cross-sectoral"],
    [/Climate-Neutral Ireland/i, "capmf-net-zero--cross-sectoral"],
  ];
  /** Policy Timeline sector that matches the chart's inventory sector, or null. */
  const matchedSector = () => (T.polData && T.polData.sector_map[T.sector]) || null;
  function policyLink(p) {
    let slugId = p.kind === "sector" ? p.slug : null;
    if (!slugId) for (const [re, target] of PROFILE_MAP) if (re.test(p.name)) {
      slugId = typeof target === "string" ? target : (target[matchedSector()] || target._);
      break;
    }
    return slugId
      ? { inApp: `#policy/policies/${slugId}/`, standalone: `/#policy/policies/${slugId}/`, profile: true }   // "new tab": the dashboard, on that page
      : { inApp: "#policy/timeline/", standalone: "/#policy/timeline/", profile: false };
  }

  function togglePin(key, on) {
    const want = on == null ? !T.pins.has(key) : on;
    if (want) T.pins.add(key); else T.pins.delete(key);
    recompute();
  }

  // ---- detail card (hover / click a policy line) ----
  function ensureCard() {
    if (T.card) return T.card;
    const c = T.card = document.createElement("div");
    c.className = "tr-pcard"; c.hidden = true; c.setAttribute("role", "dialog");
    c.addEventListener("mouseenter", () => clearTimeout(T.cardTimer));
    c.addEventListener("mouseleave", () => { if (!c.dataset.sticky) hideCard(); });
    c.addEventListener("click", e => {
      const pin = e.target.closest("[data-pin]");
      if (pin) { togglePin(pin.dataset.pin); hideCard(true); return; }
      if (e.target.closest(".pc-close")) hideCard(true);
    });
    T.gd.appendChild(c);
    document.addEventListener("mousedown", e => { if (!c.hidden && !c.contains(e.target) && !T.gd.contains(e.target)) hideCard(true); });
    return c;
  }
  function placeCard(c, xPx) {
    const fl = T.gd._fullLayout, w = T.gd.clientWidth, cw = Math.min(330, w - 16);
    let left = xPx + 14;
    if (left + cw > w - 8) left = Math.max(8, xPx - cw - 14);
    c.style.left = left + "px";
    c.style.top = (fl.yaxis._offset + 6) + "px";
  }
  const GAS_LABEL = { CO2: "CO₂", CH4: "CH₄", N2O: "N₂O", "F-gases": "F-gases", All: "All gases" };
  function policyCardHtml(p) {
    const link = policyLink(p), c = p.color;
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "";
    const tags = p.kind === "core"
      ? `<span class="pc-tag" style="background:${rgba(c, 0.15)};color:${c}"><b>${esc(p.level)}</b></span>
         <span class="pc-tag">${p.year}</span>${p.agency ? `<span class="pc-tag">${esc(p.agency)}</span>` : ""}`
      : `<span class="pc-tag" style="background:${rgba(c, 0.15)};color:${c}"><b>${esc(p.sector)}</b></span>
         <span class="pc-tag">${esc(p.mechanism)}</span><span class="pc-tag">${p.start}–${p.end || "ongoing"}</span>`;
    const details = p.kind === "core"
      ? row("Sector", p.sector) + row("Type", p.type) + row("Instrument", p.instrument) + row("Direction", p.direction) + row("Outcome", p.outcome)
      : row("Layer", p.layer) + row("Instrument", p.instrument) + row("Gases", (p.gases || []).map(g => GAS_LABEL[g] || g).join(", ")) +
        (isNum(p.peak) ? row("Policy strength", `peak intensity ${fmt(p.peak, 2)} of 1${isNum(p.i2023) ? ` · ${fmt(p.i2023, 2)} in 2023` : ""}`) : "") +
        (p.major ? row("Importance", "Key policy for its sector (anchor or material effect)") : "") +
        (isNum(p.effect_kt) ? row("Reported effect", `${fmt(p.effect_kt, 1)} kt CO₂-eq/yr${p.effect_year ? ` (${p.effect_year})` : ""}`) : "");
    return `<button type="button" class="pc-close" aria-label="Close">×</button>
      <h4>${esc(p.name)}</h4>
      <div class="pc-meta">${tags}</div>
      ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ""}
      <dl>${details}</dl>
      <div class="pc-actions">
        <a class="btn btn-success btn-sm py-0" href="${link.inApp}"><i class="bi bi-diagram-3"></i> ${link.profile ? "Open policy profile" : "Open the Policy Timeline"}</a>
        <a class="small" href="${link.standalone}" target="_blank" rel="noopener" title="Open in a new tab"><i class="bi bi-box-arrow-up-right"></i> new tab</a>
        <button type="button" class="btn btn-link btn-sm p-0 ms-auto" data-pin="${esc(p.key)}">${T.pins.has(p.key) ? "Remove line" : "Show on chart"}</button>
      </div>
      ${link.profile ? "" : `<div class="trend-hint mt-1">This policy has no profile of its own in the Policy Timeline; the link opens its timeline view.</div>`}`;
  }
  function showCard(key, xPx, sticky) {
    const p = policyByKey(key);
    if (!p) return;
    const c = ensureCard();
    clearTimeout(T.cardTimer);
    if (T.cardKey !== key || c.hidden) {
      c.innerHTML = policyCardHtml(p);
      c.style.setProperty("--pc", p.color);
      placeCard(c, xPx);
    }
    const sameOpen = T.cardKey === key && !c.hidden;
    if (sticky) c.dataset.sticky = "1"; else if (!sameOpen) delete c.dataset.sticky;
    T.cardKey = key; c.hidden = false;
    T.gd.classList.add("tr-card-open");
  }
  function hideCard(now) {
    const c = T.card;
    if (!c || c.hidden) return;
    clearTimeout(T.cardTimer);
    const go = () => { c.hidden = true; T.cardKey = null; delete c.dataset.sticky; T.gd.classList.remove("tr-card-open"); };
    if (now) go(); else T.cardTimer = setTimeout(go, 350);
  }
  /** Pinned policy line under the pointer, or null. */
  function pinnedLineHit(cx, cy) {
    if (!T.pins.size || !T.result || !T.opt.pol) return null;   // lines hidden by the Policies button
    const g = plotGeom();
    if (!g) return null;
    const px = cx - g.rect.left, py = cy - g.rect.top;
    if (py < g.top || py > g.bot) return null;
    const R = T.result;
    let best = null;
    for (const { p, x } of pinnedInView(q => q.year >= R.x[0] && q.year <= R.x[R.x.length - 1])) {
      if (T.hidden.has(`pol:${p.group}`)) continue;            // group hidden from the legend
      const lx = g.xa._offset + g.xa.c2p(x), d = Math.abs(lx - px);
      if (d <= 6 && (!best || d < best.d)) best = { d, key: p.key, xPx: lx };
    }
    return best;
  }

  // ---- right-hand panel ----
  // Groups (International / EU / National / Targets, or a sector) are coloured
  // boxes that open and close; core groups start closed, sector groups open.
  // The swatch beside a group's name opens a palette to change its colour.
  const PALETTE = ["#1f4e9e", "#00843D", "#5b6b7a", "#c0392b", "#8e44ad", "#d68910",
    "#16a085", "#2c3e50", "#e67e22", "#b03a6f", "#0f6e8c", "#7a6a00"];
  const HEX = /^#[0-9a-f]{6}$/i;
  const GROUP_LABEL = { International: "International policies", EU: "EU policies", National: "National policies", Target: "Targets" };

  /** Does a sector series affect the gas being analysed? */
  function affectsGas(p) {
    const code = T.polData && T.polData.gas_codes[T.gas];
    if (!code || T.polAllGases) return true;           // Total GHG: every series is relevant
    return (p.gases || []).some(g => g === code || g === "All");
  }
  function bindPolicyPanel() {
    const panel = $("trPolPanel");
    panel.querySelectorAll("[data-poltab]").forEach(b => b.addEventListener("click", () => {
      T.polTab = b.dataset.poltab; closePalette(); renderPolicyPanel(); writeHash();
    }));
    const sortSel = $("trPolSort");
    sortSel.value = T.polSort;
    sortSel.addEventListener("change", () => { T.polSort = sortSel.value; renderPolicyPanel(); writeHash(); });
    $("trPolSearch").addEventListener("input", renderPolicyPanel);
    $("trPolSector").addEventListener("change", e => { T.polSector = e.target.value || null; T.polRelAll = false; renderPolicyPanel(); });
    $("trPolCross").addEventListener("change", e => { T.polCross = e.target.checked; renderPolicyPanel(); });
    $("trPolAllGases").addEventListener("change", e => { T.polAllGases = e.target.checked; renderPolicyPanel(); });
    $("trPolClear").addEventListener("click", () => { T.pins.clear(); hideCard(true); recompute(); });
    bindPeriodFilter();
    panel.addEventListener("change", e => {
      const cb = e.target.closest("input[data-polkey]");
      if (cb) togglePin(cb.dataset.polkey, cb.checked);
    });
    panel.addEventListener("click", e => {
      const sw = e.target.closest("[data-colorgroup]");
      if (sw) { e.preventDefault(); openPalette(sw.dataset.colorgroup, sw); return; }
      const hd = e.target.closest("[data-togglegroup]");
      if (hd) {
        const g = hd.dataset.togglegroup;
        if (T.polOpen.has(g)) T.polOpen.delete(g); else T.polOpen.add(g);
        renderPolicyPanel();
        return;
      }
      if (e.target.closest("[data-relmore]")) { T.polRelAll = !T.polRelAll; renderPolicyPanel(); return; }
      const top = e.target.closest("[data-reltop]");
      if (top) {
        // "Top 5 on chart": draw the first five listed (in the current order)
        [...$("trPolBody").querySelectorAll(".tp-rel input[data-polkey]:not(:disabled)")].slice(0, 5)
          .forEach(cb => T.pins.add(cb.dataset.polkey));
        recompute();
        return;
      }
      const all = e.target.closest("[data-polall]");
      if (all) {
        const on = all.dataset.polall === "1";
        all.closest(".tp-group").querySelectorAll("input[data-polkey]:not(:disabled)").forEach(cb => {
          if (on) T.pins.add(cb.dataset.polkey); else T.pins.delete(cb.dataset.polkey);
        });
        recompute();
      }
    });
  }

  // ---- start-year filter: a slider and a year box that follow each other ----
  function bindPeriodFilter() {
    const F = T.polFilter, on = $("trPolFilterOn"), box = $("trPolFilterBox");
    const sl = $("trPolMin"), inp = $("trPolFromIn");
    if (!isNum(F.lo)) { on.disabled = true; return; }      // no policy data
    for (const el of [sl, inp]) { el.min = F.lo; el.max = F.hi; el.value = F.a; }
    $("trPolLo").textContent = F.lo; $("trPolHi").textContent = F.hi;
    on.checked = F.on; box.hidden = !F.on;
    on.addEventListener("change", () => { F.on = on.checked; box.hidden = !F.on; renderPolicyPanel(); writeHash(); });
    const set = (y, from) => {
      y = Math.max(F.lo, Math.min(F.hi, Math.round(y)));
      if (from !== sl) sl.value = y;
      if (from !== inp || +inp.value !== y) inp.value = y;
      inp.classList.remove("is-invalid");
      if (y === F.a) return paintPeriodFilter();
      F.a = y; F.b = F.hi;
      renderPolicyPanel(); writeHash();
    };
    sl.addEventListener("input", () => set(+sl.value, sl));
    // typing: applied as soon as a full year in range is entered; out-of-range values are corrected on leaving the box
    inp.addEventListener("input", () => {
      const v = inp.value.trim(), y = +v;
      const ok = /^\d{4}$/.test(v) && y >= F.lo && y <= F.hi;
      inp.classList.toggle("is-invalid", /^\d{4,}$/.test(v) && !ok);
      if (ok) { sl.value = y; if (y !== F.a) { F.a = y; renderPolicyPanel(); writeHash(); } }
    });
    inp.addEventListener("change", () => set(inp.value.trim() === "" ? F.a : +inp.value));
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
    $("trPolRangeReset").addEventListener("click", () => set(F.lo));
  }
  function paintPeriodFilter() {
    const F = T.polFilter;
    if (!isNum(F.lo)) return;
    const sl = $("trPolMin"), inp = $("trPolFromIn");
    if (+sl.value !== F.a) sl.value = F.a;
    if (document.activeElement !== inp && +inp.value !== F.a) inp.value = F.a;
    const span = Math.max(1, F.hi - F.lo);
    const fill = $("trPolFill");
    fill.style.left = ((F.a - F.lo) / span * 100) + "%";
    fill.style.width = ((F.hi - F.a) / span * 100) + "%";
  }
  const inPeriod = p => !T.polFilter.on || (isNum(p.year) && p.year >= T.polFilter.a && p.year <= T.polFilter.b);

  // ---- colour palette ----
  function setGroupColor(group, hex) {
    if (hex && (HEX.test(hex) || hex === "transparent")) T.colors[group] = hex.toLowerCase(); else delete T.colors[group];
    if (T.card && !T.card.hidden) hideCard(true);       // its colours would be stale
    recompute();                                         // redraws lines, panel and the link
  }
  function closePalette() {
    if (T.palette) { T.palette.remove(); T.palette = null; }
  }
  function openPalette(group, anchor) {
    const wasOpen = T.palette && T.palette.dataset.group === group;
    closePalette();
    if (wasOpen) return;                                 // second click on the swatch closes it
    const panel = $("trPolPanel"), cur = colorOf(group);
    const pop = T.palette = document.createElement("div");
    pop.className = "tp-palette"; pop.dataset.group = group;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", `Colour for ${GROUP_LABEL[group] || group}`);
    pop.innerHTML = `<div class="tp-pal-title">Colour for ${esc(GROUP_LABEL[group] || group + " policies")}</div>
      <div class="tp-pal-grid">${PALETTE.map(c => `<button type="button" class="tp-pal-sw${c === cur ? " on" : ""}" data-pick="${c}"
        style="background:${c}" aria-label="Use colour ${c}" title="${c}"></button>`).join("")}</div>
      <div class="tp-pal-foot">
        <label class="tp-pal-custom">Custom <input type="color" value="${HEX.test(cur) ? cur : "#666666"}" aria-label="Custom colour"></label>
        <button type="button" class="tp-pal-none${cur === "transparent" ? " on" : ""}" data-pick="transparent" title="Hide this group's lines on the chart">No colour</button>
        <button type="button" class="btn btn-link btn-sm p-0" data-pick="">Reset</button>
      </div>`;
    pop.addEventListener("click", e => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      setGroupColor(group, b.dataset.pick || null);
      closePalette();
    });
    pop.querySelector("input[type=color]").addEventListener("input", e => setGroupColor(group, e.target.value));
    panel.appendChild(pop);
    // place it under the swatch, inside the panel
    const pr = panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    pop.style.top = (ar.bottom - pr.top + 6) + "px";
    pop.style.left = Math.max(8, Math.min(ar.left - pr.left - 6, pr.width - pop.offsetWidth - 8)) + "px";
    pop.querySelector(".tp-pal-sw.on, .tp-pal-sw").focus();
  }
  document.addEventListener("mousedown", e => {
    if (T.palette && !T.palette.contains(e.target) && !e.target.closest("[data-colorgroup]")) closePalette();
  });

  // ---- ranking: importance and strength ----
  // A policy's relevance to the chart's series, on [0, 1]:
  //   55% strength   peak policy intensity (implementation x coverage x bindingness)
  //   30% importance reported effect (kt CO2-eq/yr, log scale)
  //   15% key policy anchor policy or material effect for its sector
  // each scaled to the best in its policy sector, then x0.85 when the policy only covers
  // the gas through "All gases" and x0.6 for a cross-sectoral law.
  function scorePolicies(list, opts = {}) {
    // scaled within each policy sector, so framework laws (intensity 1) do not set the scale for sector measures
    const eff = p => isNum(p.effect_kt) && p.effect_kt > 0 ? Math.log1p(p.effect_kt) : 0;
    const maxPeak = {}, maxEff = {};
    for (const p of list) {
      maxPeak[p.sector] = Math.max(maxPeak[p.sector] || 1e-9, isNum(p.peak) ? p.peak : 0);
      maxEff[p.sector] = Math.max(maxEff[p.sector] || 1e-9, eff(p));
    }
    const code = T.polData && T.polData.gas_codes[T.gas];
    const out = new Map();
    for (const p of list) {
      let v = 0.55 * (isNum(p.peak) ? p.peak / maxPeak[p.sector] : 0)
        + 0.30 * eff(p) / maxEff[p.sector]
        + 0.15 * (p.major ? 1 : 0);
      if (code && !(p.gases || []).includes(code)) v *= 0.85;
      // cross-sectoral laws frame every sector but act on none directly: ranked below the sector's own measures
      if (opts.cross && p.sector === "Cross-sectoral") v *= 0.6;
      out.set(p.key, v);
    }
    return out;
  }
  /** Sort in place by the panel's "Sort by" choice; `score` is a Map from scorePolicies. */
  function sortPolicies(list, score) {
    const yr = p => isNum(p.year) ? p.year : -Infinity;
    const sc = p => score.get(p.key) || 0;
    const byName = (a, b) => a.name.localeCompare(b.name);
    const cmp = {
      strength: (a, b) => sc(b) - sc(a) || yr(b) - yr(a) || byName(a, b),
      new: (a, b) => yr(b) - yr(a) || sc(b) - sc(a) || byName(a, b),
      old: (a, b) => yr(a) - yr(b) || sc(b) - sc(a) || byName(a, b),
    }[T.polSort] || (() => 0);
    return list.sort(cmp);
  }
  const REL_TOP = 10;
  function relevantItem(it, i, score, best) {
    const p = it.p, rel = Math.round((score.get(p.key) || 0) / best * 100);
    const title = it.inData ? "" : ` title="${p.year} is outside the years shown on the chart"`;
    const rank = T.polSort === "strength" ? `<span class="tp-rk" title="Rank ${i + 1}">${i + 1}</span>` : "";
    const meta = (p.sector === "Cross-sectoral" ? "Cross-sectoral · " : "") + esc(p.mechanism) +
      (isNum(p.effect_kt) && p.effect_kt > 0 ? ` · ${fmt(p.effect_kt, 0)} kt/yr` : "");
    const str = isNum(p.peak) ? `strength ${fmt(p.peak, 2)}` : "no strength data";
    return `<label class="tp-item${it.inData ? "" : " off"}"${title} style="--gc:${p.color}">
      <input type="checkbox" class="form-check-input" data-polkey="${esc(p.key)}" ${T.pins.has(p.key) ? "checked" : ""} ${it.inData ? "" : "disabled"}>
      ${rank}<span class="tp-yr">${p.year ?? "–"}</span>
      <span class="tp-txt"><span class="tp-nm">${esc(p.name)}</span><small>${meta}</small>
        <span class="tp-str" title="Relevance ${rel} of 100 · peak intensity ${isNum(p.peak) ? fmt(p.peak, 2) : "–"}">
          <span class="tp-str-bar"><span style="width:${rel}%"></span></span><small>${str}</small>
        </span>
      </span>
    </label>`;
  }
  function relevantBox(sector, items, score, opts) {
    const c = colorOf(sector);
    const best = Math.max(1e-9, ...items.map(it => score.get(it.p.key) || 0));
    const on = items.filter(it => T.pins.has(it.p.key)).length;
    const shown = T.polRelAll || opts.force ? items : items.slice(0, REL_TOP);
    const rows = shown.map((it, i) => relevantItem(it, i, score, best)).join("") ||
      `<div class="trend-hint py-1">${opts.empty}</div>`;
    const more = items.length > REL_TOP && !opts.force
      ? `<button type="button" class="btn btn-link btn-sm p-0 tp-more" data-relmore="1">${T.polRelAll ? `Show the top ${REL_TOP} only` : `Show all ${items.length}`}</button>` : "";
    const bar = items.some(it => it.inData)
      ? `<div class="tp-bar"><button type="button" class="btn btn-link btn-sm p-0" data-reltop="1">Top 5 on chart</button>
          <button type="button" class="btn btn-link btn-sm p-0" data-polall="0">Hide all</button></div>` : "";
    return `<div class="tp-group open tp-rel" style="--gc:${c};--gbg:${rgba(c, 0.07)};--gbd:${rgba(c, 0.35)}">
      <div class="tp-gh">
        <button type="button" class="tp-swatch${c === "transparent" ? " none" : ""}" data-colorgroup="${esc(sector)}" style="background:${c}"
          title="Change colour" aria-label="Change the colour of ${esc(sector)} policies" aria-haspopup="dialog"></button>
        <span class="tp-ghbtn" style="cursor:default"><span class="tp-gname">${esc(opts.label)}</span>
          <span class="tp-n${on ? " has" : ""}" title="${on} of ${items.length} on the chart">${on ? `${on}/` : ""}${items.length}</span></span>
      </div>
      <div class="tp-gbody">${bar}${opts.note ? `<div class="trend-hint mb-1">${opts.note}</div>` : ""}${rows}${more}</div>
    </div>`;
  }

  // ---- list rendering ----
  function polItem(p, inData, meta) {
    const checked = T.pins.has(p.key) ? "checked" : "";
    const dis = inData ? "" : "disabled";
    const title = inData ? "" : ` title="${p.year} is outside the years shown on the chart"`;
    return `<label class="tp-item${inData ? "" : " off"}"${title}>
      <input type="checkbox" class="form-check-input" data-polkey="${esc(p.key)}" ${checked} ${dis}>
      <span class="tp-yr">${p.year ?? "–"}</span>
      <span class="tp-txt"><span class="tp-nm">${esc(p.name)}</span>${meta ? `<small>${meta}</small>` : ""}</span>
    </label>`;
  }
  /** One coloured, collapsible group box. `force` opens it while searching. */
  function polGroup(group, label, items, opts) {
    const c = colorOf(group);
    const open = T.polOpen.has(group) || opts.force;
    const on = items.filter(it => T.pins.has(it.p.key)).length;
    const body = items.map(it => polItem(it.p, it.inData, it.meta)).join("") ||
      `<div class="trend-hint py-1">${opts.empty || "Nothing to list."}</div>`;
    return `<div class="tp-group${open ? " open" : ""}" style="--gc:${c};--gbg:${rgba(c, 0.07)};--gbd:${rgba(c, 0.35)}">
      <div class="tp-gh">
        <button type="button" class="tp-swatch${c === "transparent" ? " none" : ""}" data-colorgroup="${esc(group)}" style="background:${c}"
          title="Change colour" aria-label="Change the colour of ${esc(label)}" aria-haspopup="dialog"></button>
        <button type="button" class="tp-ghbtn" data-togglegroup="${esc(group)}" aria-expanded="${open}">
          <span class="tp-gname">${esc(label)}</span>
          <span class="tp-n${on ? " has" : ""}" title="${on} of ${items.length} on the chart">${on ? `${on}/` : ""}${items.length}</span>
          <i class="bi bi-chevron-down tp-chev"></i>
        </button>
      </div>
      ${open ? `<div class="tp-gbody">
        ${items.some(it => it.inData) ? `<div class="tp-bar"><button type="button" class="btn btn-link btn-sm p-0" data-polall="1">Show all</button>
          <button type="button" class="btn btn-link btn-sm p-0" data-polall="0">Hide all</button></div>` : ""}
        ${body}${opts.note ? `<div class="trend-hint mt-1">${opts.note}</div>` : ""}
      </div>` : ""}
    </div>`;
  }

  function renderPolicyPanel() {
    const panel = $("trPolPanel");
    if (!panel || !T.result) return;
    const d = T.polData;
    $("trPolCount").textContent = T.pins.size;
    $("trPolClear").disabled = !T.pins.size;
    if (!d) { $("trPolBody").innerHTML = `<div class="trend-hint">Policy data could not be loaded.</div>`; return; }
    panel.querySelectorAll("[data-poltab]").forEach(b => {
      const on = b.dataset.poltab === T.polTab;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("trPolCorePane").hidden = T.polTab !== "core";
    $("trPolSectorPane").hidden = T.polTab === "core";          // shared by "sector" and "relevant"
    const rel = T.polTab === "relevant";
    $("trPolCrossWrap").hidden = rel;                         // the ranking always weighs cross-sectoral laws in
    $("trPolRelNote").hidden = !rel;
    const R = T.result, lo = R.x[0], hi = R.x[R.x.length - 1];
    const inData = p => isNum(p.year) && p.year >= lo && p.year <= hi;
    const q = $("trPolSearch").value.trim().toLowerCase();
    const match = p => (!q || p.name.toLowerCase().includes(q)) && inPeriod(p);
    paintPeriodFilter();
    const F = T.polFilter;
    const periodTxt = F.on ? ` between ${F.a} and ${F.b}` : "";

    let html = "";
    if (T.polTab === "core") {
      const core = POLICY_LIST.filter(p => p.kind === "core" && match(p));
      html = ["International", "EU", "National", "Target"].map(lv => {
        const ps = core.filter(p => p.level === lv);
        if (!ps.length) return "";
        return polGroup(lv, GROUP_LABEL[lv], ps.map(p => ({ p, inData: inData(p), meta: esc(p.sector) })), { force: !!q || F.on });
      }).join("") || `<div class="trend-hint">No core policy${q ? ` matches “${esc(q)}”` : ""}${periodTxt ? ` started${periodTxt}` : ""}.</div>`;
    } else {
      // sector pane: the chart's sector decides, unless it has no match (or the user picked another)
      const auto = matchedSector();
      const sel = $("trPolSector");
      const sectors = d.sectors.filter(s => s !== "Cross-sectoral");
      if (!sel.options.length || sel.dataset.built !== sectors.join("|")) {
        sel.innerHTML = `<option value="">${auto ? "Same as the chart" : "Choose a sector…"}</option>` +
          sectors.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
        sel.dataset.built = sectors.join("|");
      }
      sel.options[0].textContent = auto ? `Same as the chart (${auto})` : "Choose a sector…";
      sel.value = T.polSector || "";
      const sector = T.polSector || auto;
      const gasName = T.gas === "Total GHG" ? "all greenhouse gases" : T.gas;
      $("trPolSectorNote").innerHTML = auto
        ? `The chart shows <b>${esc(T.sector)}</b>, matched to the <b>${esc(auto)}</b> sector.`
        : `<b>${esc(T.sector)}</b> has no single matching policy sector: choose one.`;
      $("trPolGasNote").textContent = `${rel ? "Ranking" : "Listing"} policies that affect ${gasName}.`;
      $("trPolAllGasesWrap").hidden = rel || T.gas === "Total GHG";
      const note = $("trPolRelNote");
      if (rel) {
        note.innerHTML = sector
          ? `<i class="bi bi-star-fill"></i> Strongest policies for <b>${esc(T.gas)}</b> · <b>${esc(T.sector)}</b>${T.polSector ? ` (using ${esc(sector)})` : ""}.
             Ranked by strength (peak policy intensity), reported effect and key-policy status.`
          : `<i class="bi bi-star"></i> Choose a policy sector above to rank its policies for <b>${esc(T.gas)}</b>.`;
        // a short highlight tells the user the list followed the new series
        if (T.polPulse) { note.classList.remove("pulse"); void note.offsetWidth; note.classList.add("pulse"); }
      }
      T.polPulse = false;
      if (!sector) {
        html = `<div class="trend-hint">Choose a sector above to list its policies.</div>`;
      } else if (rel) {
        // the chart's sector plus cross-sectoral laws, only those affecting the chart's gas
        const code = d.gas_codes[T.gas];
        const pool = POLICY_LIST.filter(p => p.kind === "sector" && (p.sector === sector || p.sector === "Cross-sectoral") &&
          match(p) && (!code || (p.gases || []).some(g => g === code || g === "All")));
        const score = scorePolicies(pool, { cross: true });
        const items = sortPolicies(pool, score).map(p => ({ p, inData: inData(p) }));
        html = relevantBox(sector, items, score, {
          label: `Most relevant: ${sector}`,
          force: !!q || F.on,
          note: items.length && !items.some(it => it.p.sector === sector)
            ? `No ${esc(sector)} policy in the Policy Timeline targets ${esc(T.gas)} directly; the cross-sectoral climate laws below frame it.` : "",
          empty: `No ${esc(sector)} or cross-sectoral policy in the Policy Timeline affects ${esc(T.gas)}${q ? ` matching “${esc(q)}”` : ""}${periodTxt ? ` started${periodTxt}` : ""}.`,
        });
      } else {
        const groups = [sector, ...(T.polCross ? ["Cross-sectoral"] : [])];
        html = groups.map(g => {
          // sector boxes open the first time they are shown
          if (!T.polSeen.has(g)) { T.polSeen.add(g); T.polOpen.add(g); }
          const pool = POLICY_LIST.filter(p => p.kind === "sector" && p.sector === g && match(p));
          const shown = pool.filter(affectsGas), hidden = pool.length - shown.length;
          sortPolicies(shown, scorePolicies(shown));
          const items = shown.map(p => ({ p, inData: inData(p),
            meta: `${esc(p.mechanism)} · ${(p.gases || []).map(x => GAS_LABEL[x] || x).join(", ")}` }));
          return polGroup(g, g === "Cross-sectoral" ? "Cross-sectoral laws" : `${g} policies`, items, {
            force: !!q || F.on,
            empty: `No ${esc(g)} policies in the Policy Timeline${T.gas === "Total GHG" ? "" : ` affect ${esc(T.gas)}`}${q ? ` matching “${esc(q)}”` : ""}${periodTxt ? ` started${periodTxt}` : ""}.`,
            note: hidden ? `${hidden} more ${hidden === 1 ? "policy targets" : "policies target"} other gases.` : "",
          });
        }).join("");
      }
    }
    $("trPolBody").innerHTML = html;
    if (F.on) {
      // count what is actually listed below (after the sector, gas and search filters)
      const n = $("trPolBody").querySelectorAll("input[data-polkey]").length;
      $("trPolFilterNote").textContent = `${n} listed ${n === 1 ? "policy" : "policies"} started in ${F.a} or later.`;
    }
  }

  // ------------------------------------------------------------------
  // Pointer interaction: click to add breakpoints, drag breakpoint lines
  // ------------------------------------------------------------------
  function bindChart() {
    const gd = T.gd = $("trChart");
    window.Plotly.newPlot(gd, [], {});
    setMode(T.mode);

    gd.on("plotly_click", ev => {
      if (T.mode !== "breakpoint" || !ev.points || !ev.points.length) return;
      addBreakpoint(ev.points[0].x);
      recompute();
    });

    // Custom drags (capture phase, so Plotly's own drag never starts)
    const start = (cx, cy, e) => {
      if (T.card && T.card.contains(e.target)) return;      // clicks inside the policy card
      // policy line: keep its card open so the link can be clicked
      const pl = pinnedLineHit(cx, cy);
      if (pl && !hit(cx, cy)) { e.stopPropagation(); e.preventDefault(); showCard(pl.key, pl.xPx, true); return; }
      const h = hit(cx, cy);
      if (!h) return;
      e.stopPropagation(); e.preventDefault();
      T.drag = h;
      document.body.classList.add("tr-dragging");
    };
    gd.addEventListener("mousedown", e => { if (e.button === 0) start(e.clientX, e.clientY, e); }, true);
    gd.addEventListener("touchstart", e => { const t = e.touches[0]; if (t) start(t.clientX, t.clientY, e); }, { capture: true, passive: false });
    const move = (cx, cy) => {
      if (!T.drag) return;
      const xv = pxToX(cx);
      if (!isNum(xv)) return;
      const d = T.drag, { lo, hi } = dataSpan();
      if (d.kind === "bp") {
        const v = Math.max(lo + 1, Math.min(hi - 1, Math.round(xv)));
        if (v !== T.bps[d.i] && !T.bps.includes(v)) { T.bps[d.i] = v; T.bps.sort((a, b) => a - b); d.i = T.bps.indexOf(v); scheduleRender(); }
      }
    };
    window.addEventListener("mousemove", e => {
      if (T.drag) { move(e.clientX, e.clientY); return; }
      if (T.mode === "edit") return;
      if (e.target instanceof Node && gd.contains(e.target)) {
        if (T.card && T.card.contains(e.target)) return;
        const h = hit(e.clientX, e.clientY);
        // hovering a policy line shows its full description
        const pl = !h && pinnedLineHit(e.clientX, e.clientY);
        gd.classList.toggle("tr-hot-ew", !!h);
        gd.classList.toggle("tr-hot-click", !!pl);
        if (pl) showCard(pl.key, pl.xPx, false);
        else if (T.card && !T.card.hidden && !T.card.dataset.sticky) hideCard();
      }
    });
    window.addEventListener("touchmove", e => { if (T.drag && e.touches[0]) { move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
    const end = () => { if (T.drag) { T.drag = null; document.body.classList.remove("tr-dragging"); recompute(); } };
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    bindEditor();
  }

  function plotGeom() {
    const fl = T.gd._fullLayout;
    if (!fl || !fl.xaxis || !fl._size) return null;
    // Use the axes' real pixel offsets: auto-margins can move the plot area.
    const rect = T.gd.getBoundingClientRect(), xa = fl.xaxis, ya = fl.yaxis;
    return { rect, s: { l: xa._offset, w: xa._length }, xa, top: ya._offset, bot: ya._offset + ya._length };
  }
  function pxToX(cx) {
    const g = plotGeom();
    return g ? g.xa.p2l(cx - g.rect.left - g.s.l) : NaN;
  }
  /** The breakpoint line under the pointer, or null. */
  function hit(cx, cy) {
    const g = plotGeom();
    if (!g || !T.result) return null;
    const px = cx - g.rect.left - g.s.l, py = cy - g.rect.top;
    if (px < -HANDLE_PX || px > g.s.w + HANDLE_PX || py < g.top || py > g.bot) return null;
    const xp = v => g.xa.l2p(v);
    if (T.opt.bp) for (let i = 0; i < T.bps.length; i++) {
      if (Math.abs(xp(T.bps[i]) - px) <= HANDLE_PX) return { kind: "bp", i };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Edit plot (chart tool "Edit plot", key E): the chart becomes selectable.
  // Hovering a part outlines it and names it; clicking it opens a small box
  // with only that part's settings (TrendPlotStyle.editPart, plot-style.js).
  // Parts: title, axis titles, axes, plot area, figure, observed data, trend
  // segments, bands, breakpoint and policy lines, legend (entries).
  // ------------------------------------------------------------------
  const ED = { sel: null, hl: null, selBox: null, chip: null };
  const box4 = r => r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  function unionRect(els) {
    let r = null;
    els.forEach(el => {
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) return;
      r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) } : box4(b);
    });
    return r;
  }
  // pixel helpers for the plot area (client coordinates)
  function edGeom() {
    const g = plotGeom(), fl = T.gd._fullLayout;
    if (!g || !fl.yaxis) return null;
    const ya = fl.yaxis, L = g.rect.left + g.s.l, top = g.rect.top + g.top;
    return { ...g, ya, L, R: L + g.s.w, top, bottom: g.rect.top + g.bot,
      X: v => L + g.xa.c2p(v), Y: v => top + ya.c2p(v) };
  }
  const tracesOf = meta => (T.gd.data || []).filter(t => t.meta === meta);
  /** Screen box (client px) of a part, for the hover and selection outlines. */
  function partRect(part, info) {
    const gd = T.gd, G = edGeom();
    if (!G) return null;
    const plot = { left: G.L, right: G.R, top: G.top, bottom: G.bottom };
    switch (part) {
      case "title": return unionRect(gd.querySelectorAll(".g-gtitle text"));
      case "xtitle": return unionRect(gd.querySelectorAll(".g-xtitle text"));
      case "ytitle": return unionRect(gd.querySelectorAll(".g-ytitle text"));
      case "xaxis": return unionRect(gd.querySelectorAll(".xaxislayer-above .xtick text"));
      case "yaxis": return unionRect(gd.querySelectorAll(".yaxislayer-above .ytick text"));
      case "plot": return plot;
      case "figure": return box4(G.rect);
      case "legend": return box4($("trLegend").getBoundingClientRect());
      case "legendEntry": {
        const b = [...$("trLegend").querySelectorAll("[data-lg]")].find(el => el.dataset.lg === info.key);
        return b ? box4(b.getBoundingClientRect()) : null;
      }
      case "bp": case "pol": { const x = G.X(info.x); return { left: x - 4, right: x + 4, top: G.top, bottom: G.bottom }; }
      default: {                                         // a trace: the box around its points, inside the plot area
        let r = null;
        tracesOf(info.meta).forEach(t => t.x.forEach((xv, j) => {
          const x = G.X(xv), y = G.Y(t.y[j]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          r = r ? { left: Math.min(r.left, x), right: Math.max(r.right, x), top: Math.min(r.top, y), bottom: Math.max(r.bottom, y) } : { left: x, right: x, top: y, bottom: y };
        }));
        if (!r) return null;
        const c = { left: Math.max(plot.left, r.left - 5), right: Math.min(plot.right, r.right + 5), top: Math.max(plot.top, r.top - 5), bottom: Math.min(plot.bottom, r.bottom + 5) };
        return c.right > c.left && c.bottom > c.top ? c : null;
      }
    }
  }
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  function tracePart(meta) {
    const [k, n] = String(meta).split(":");
    if (k === "seg") {
      const seg = T.result && T.result.pw && T.result.pw.segments[+n];
      const pal = (PSget().trend.palette || []).length || 8;
      return { part: "trend", info: { meta, pal: +n % pal, label: seg ? `Trend ${seg.start}–${seg.end}` : "Trend line" } };
    }
    return { part: { obs: "obs", band: "band", pred: "pred" }[k] || "plot", info: { meta } };
  }
  function shapePart(s) {
    const i = s.name.indexOf(":"), k = s.name.slice(0, i), v = s.name.slice(i + 1);
    if (k === "bp") return { part: "bp", info: { year: +v, x: +v } };
    const p = policyByKey(v);
    return { part: "pol", info: { key: v, name: p ? p.name : v, color: p ? p.color : "#666666", x: s.x0 } };
  }
  /** The part of the chart under the pointer (client px), or null. */
  function editHit(cx, cy, target) {
    const lg = $("trLegend");
    if (target instanceof Node && lg.contains(target)) {
      const b = target.closest("[data-lg]");
      if (!b) return { part: "legend" };
      const e = (T.legend || []).find(x => x.key === b.dataset.lg);
      return { part: "legendEntry", info: { key: b.dataset.lg, label: e ? e.label : b.dataset.lg } };
    }
    const gd = T.gd, G = edGeom();
    if (!G || !(target instanceof Node) || !gd.contains(target)) return null;
    const near = (r, m = 3) => r && cx >= r.left - m && cx <= r.right + m && cy >= r.top - m && cy <= r.bottom + m;
    for (const p of ["title", "xtitle", "ytitle"]) if (near(partRect(p))) return { part: p };
    const shapes = (gd.layout && gd.layout.shapes) || [];
    // a policy name or breakpoint year written beside its line
    for (const el of gd.querySelectorAll(".shapelayer [data-index]")) {
      const s = shapes[+el.dataset.index];
      if (!s || !s.name) continue;
      if ([...el.querySelectorAll("text")].some(t => near(box4(t.getBoundingClientRect()), 1))) return shapePart(s);
    }
    const inPlot = cx >= G.L && cx <= G.R && cy >= G.top && cy <= G.bottom;
    if (inPlot) {
      // vertical lines first (they are drawn on top), then lines and markers, then filled bands
      let best = null;
      shapes.forEach(s => {
        if (!s.name) return;
        const d = Math.abs(G.X(s.x0) - cx);
        if (d <= 6 && (!best || d < best.d)) best = { d, s };
      });
      if (best) return shapePart(best.s);
      const data = gd.data || [];
      let near1 = null;
      data.forEach(t => {
        if (!t.meta || t.fill || !t.x) return;
        const mode = String(t.mode || ""), lines = mode.includes("lines") && (t.line && t.line.width) > 0;
        const marks = mode.includes("markers");
        if (!lines && !marks) return;
        const tol = Math.max(5, lines ? t.line.width / 2 + 4 : 0, marks ? (t.marker.size || 6) / 2 + 3 : 0);
        for (let j = 0; j < t.x.length; j++) {
          const ax = G.X(t.x[j]), ay = G.Y(t.y[j]);
          if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
          let d = Math.hypot(ax - cx, ay - cy);
          if (lines && j + 1 < t.x.length) d = Math.min(d, segDist(cx, cy, ax, ay, G.X(t.x[j + 1]), G.Y(t.y[j + 1])));
          if (d <= tol && (!near1 || d < near1.d)) near1 = { d, meta: t.meta };
        }
      });
      if (near1) return tracePart(near1.meta);
      for (let i = data.length - 1; i > 0; i--) {         // inside a band: between its lower and upper edge
        const hi = data[i], lo = data[i - 1];
        if (!hi.fill || !hi.meta || lo.meta !== hi.meta) continue;
        const xs = hi.x, xv = G.xa.p2c(cx - G.L);
        if (!(xv >= xs[0] && xv <= xs[xs.length - 1])) continue;
        let j = 0; while (j < xs.length - 2 && xs[j + 1] < xv) j++;
        const f = xs[j + 1] === xs[j] ? 0 : (xv - xs[j]) / (xs[j + 1] - xs[j]);
        const yAt = arr => G.Y(arr[j] + (arr[j + 1] - arr[j]) * f);
        const a = yAt(hi.y), b = yAt(lo.y);
        if (cy >= Math.min(a, b) - 2 && cy <= Math.max(a, b) + 2) return tracePart(hi.meta);
      }
      return { part: "plot" };
    }
    if (near(partRect("xaxis"), 4) || (cx >= G.L && cx <= G.R && cy > G.bottom)) return { part: "xaxis" };
    if (near(partRect("yaxis"), 4) || (cy >= G.top && cy <= G.bottom && cx < G.L)) return { part: "yaxis" };
    return { part: "figure" };
  }
  function paintBox(el, h) {
    const r = h && partRect(h.part, h.info || {});
    if (!r) { el.hidden = true; return; }
    const w = $("trPlotWrap").getBoundingClientRect();
    Object.assign(el.style, { left: `${r.left - w.left - 3}px`, top: `${r.top - w.top - 3}px`,
      width: `${r.right - r.left + 6}px`, height: `${r.bottom - r.top + 6}px` });
    el.hidden = false;
  }
  function paintEdit() { if (ED.selBox) paintBox(ED.selBox, T.mode === "edit" ? ED.sel : null); }
  // leaving Edit plot: close the box and clear the outlines
  function editDone() {
    if (!ED.hl) return;
    ED.sel = null;
    [ED.hl, ED.selBox, ED.chip].forEach(el => { el.hidden = true; });
    if (window.TrendPlotStyle) window.TrendPlotStyle.closeEdit();
  }
  function bindEditor() {
    const wrap = $("trPlotWrap");
    const mk = cls => { const d = document.createElement("div"); d.className = cls; d.hidden = true; d.setAttribute("aria-hidden", "true"); wrap.appendChild(d); return d; };
    ED.hl = mk("tr-ed-hl"); ED.selBox = mk("tr-ed-hl tr-ed-sel"); ED.chip = mk("tr-ed-chip");
    const on = () => T.mode === "edit" && window.TrendPlotStyle;
    // in Edit plot the chart does not zoom, add breakpoints or toggle legend entries
    wrap.addEventListener("mousedown", e => { if (on()) { e.stopPropagation(); e.preventDefault(); } }, true);
    wrap.addEventListener("touchstart", e => { if (on()) e.stopPropagation(); }, { capture: true, passive: true });
    wrap.addEventListener("dblclick", e => { if (on()) { e.stopPropagation(); e.preventDefault(); } }, true);
    wrap.addEventListener("click", e => {
      if (!on()) return;
      e.stopPropagation(); e.preventDefault();
      const h = editHit(e.clientX, e.clientY, e.target);
      if (!h) return;
      ED.sel = h; ED.chip.hidden = true; paintEdit();
      window.TrendPlotStyle.editPart(h.part, h.info || {}, e.clientX, e.clientY);
    }, true);
    wrap.addEventListener("mousemove", e => {
      if (!on()) return;
      const h = editHit(e.clientX, e.clientY, e.target);
      paintBox(ED.hl, h);
      if (!h) { ED.chip.hidden = true; return; }
      const w = wrap.getBoundingClientRect();
      ED.chip.innerHTML = `<i class="bi bi-pencil"></i> ${esc(window.TrendPlotStyle.partName(h.part, h.info))}`;
      ED.chip.style.left = `${Math.min(e.clientX - w.left + 14, w.width - 200)}px`;
      ED.chip.style.top = `${e.clientY - w.top + 16}px`;
      ED.chip.hidden = false;
    });
    wrap.addEventListener("mouseleave", () => { ED.hl.hidden = true; ED.chip.hidden = true; });
    window.addEventListener("resize", () => { if (ED.sel) paintEdit(); });
  }

  // ------------------------------------------------------------------
  // Side panels and tables
  // ------------------------------------------------------------------
  function renderSide() {
    const R = T.result;
    $("trChartTitle").textContent = `${T.gas}: ${T.sector}`;
    $("trChartSub").textContent = `${({ ols: "OLS", huber: "Huber robust", theilsen: "Theil–Sen" })[T.method]} · ${Math.round(T.conf * 100)}% confidence · ${R.x.length} years`;
    $("trBpChips").innerHTML = (R.pw ? R.pw.used : T.bps).map(b =>
      `<button type="button" class="tr-chip" data-bp="${b}" title="Remove breakpoint ${b}">${b}<i class="bi bi-x"></i></button>`).join("")
      || `<span class="trend-hint">None: one trend over the whole period.</span>`;
    $("trCsvBtn").disabled = $("trPngBtn").disabled = !R.x.length;

    // KPI strip
    const n = R.x.length, last = R.pw && R.pw.segments[R.pw.segments.length - 1];
    const lastV = R.y[n - 1], prevV = R.y[n - 2];
    const kpis = [
      ["Latest", n ? `${fmt(lastV)}` : "–", n ? `${R.x[n - 1]} · ${UNITS}` : ""],
      ["Year on year", n > 1 ? `${fmtSigned((lastV / prevV - 1) * 100)}%` : "–", n > 1 ? `${fmtSigned(lastV - prevV)} kt` : "", n > 1 ? (lastV <= prevV ? "good" : "bad") : ""],
      ["Since " + (R.x[0] || ""), n > 1 ? `${fmtSigned((lastV / R.y[0] - 1) * 100)}%` : "–", n > 1 ? `${fmtSigned(lastV - R.y[0])} kt` : "", n > 1 ? (lastV <= R.y[0] ? "good" : "bad") : ""],
      ["Current trend", last ? `${fmtSigned(last.slope)} /yr` : "–", last ? `${last.start}–${last.end} · CI ${fmtSigned(last.ciLow)} to ${fmtSigned(last.ciHigh)}` : "", last ? (last.slope <= 0 ? "good" : "bad") : ""],
      ["Fit (last segment)", last && isNum(last.r2) ? `R² ${last.r2.toFixed(3)}` : "–", last ? `p ${fmtP(last.p)} ${stars(last.p)}` : ""],
    ];
    $("trKpis").innerHTML = kpis.map(([l, v, s, cls]) =>
      `<div class="tr-kpi ${cls || ""}"><div class="lbl">${esc(l)}</div><div class="val">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join("");

    renderDirection();
    renderStatsTables();
    renderPolicyPanel();
  }

  function directionOf(seg) {
    const alpha = 1 - T.conf;
    if (T.opt.mk && seg.mk) {
      const tr = seg.mk.trend;
      return { key: tr === "increasing" ? "up" : tr === "decreasing" ? "down" : "flat", stat: `Z = ${fmt(seg.mk.Z, 2)}`, p: seg.mk.p };
    }
    const sig = isNum(seg.p) && seg.p < alpha;
    return { key: sig && seg.slope > 0 ? "up" : sig && seg.slope < 0 ? "down" : "flat", stat: `t = ${fmt(seg.t, 2)}`, p: seg.p };
  }
  function renderDirection() {
    const R = T.result, box = $("trDirection"), host = $("trDirectionSegments");
    const segs = R.pw ? R.pw.segments : [];
    box.hidden = !segs.length;
    const DIR = { up: ["up", "bi-arrow-up-right", "Increasing"], down: ["down", "bi-arrow-down-right", "Decreasing"], flat: ["flat", "bi-dash-lg", "No significant trend"] };
    box.querySelector(".td-label").textContent = segs.length > 1 ? "Direction of trend (per segment)" : "Direction of trend";
    host.innerHTML = segs.map((s, i) => {
      const d = directionOf(s), [cls, icon, label] = DIR[d.key];
      return `<span class="td-pill ${cls}" style="border-left:4px solid ${SEG_COLORS[i % SEG_COLORS.length]}">` +
        (segs.length > 1 ? `<span class="td-segno">Seg ${s.index}</span>` : "") +
        `<span class="td-period">${s.start}–${s.end}</span><i class="bi ${icon}"></i><span>${label}</span>` +
        `<span class="td-stats">${d.stat} · p ${fmtP(d.p)}</span></span>`;
    }).join("");
  }

  function table(id, cols, rows) {
    const t = $(id);
    t.tHead.innerHTML = "<tr>" + cols.map(c => `<th>${c}</th>`).join("") + "</tr>";
    t.tBodies[0].innerHTML = rows.map(r => "<tr>" + r.map(c => `<td>${c}</td>`).join("") + "</tr>").join("") ||
      `<tr><td colspan="${cols.length}" class="text-muted">–</td></tr>`;
  }
  function renderStatsTables() {
    const R = T.result, segs = R.pw ? R.pw.segments : [];
    const sw = i => `<span class="tr-swatch" style="background:${SEG_COLORS[i % SEG_COLORS.length]}"></span>`;
    table("trStatsTable",
      ["Seg", "Period", "N", "Slope /yr", "SE", `CI ${Math.round(T.conf * 100)}%`, "Intercept", "Level at start", "R²", "Adj R²", "RMSE", "MAE", "t", "p", "F", "Durbin–Watson"],
      segs.map((s, i) => [sw(i) + s.index, `${s.start}–${s.end}`, s.n, fmtSig(s.slope, 6), fmtSig(s.se, 5),
        `${fmtSig(s.ciLow, 5)} to ${fmtSig(s.ciHigh, 5)}`, fmtSig(s.intercept, 7), fmt(s.levelAtStart),
        isNum(s.r2) ? s.r2.toFixed(4) : "–", isNum(s.adjR2) ? s.adjR2.toFixed(4) : "–", fmt(s.rmse, 2), fmt(s.mae, 2),
        fmt(s.t, 3), fmtP(s.p) + " " + stars(s.p), isNum(s.fStat) ? fmt(s.fStat, 2) : "–", fmt(s.dw, 3)]));
    $("trMkPanel").hidden = !T.opt.mk;
    table("trMkTable", ["Seg", "Period", "N", "S", "Kendall τ", "Z", "p", "Trend", "Sen's slope", `Sen CI ${Math.round(T.conf * 100)}%`],
      segs.map((s, i) => [sw(i) + s.index, `${s.start}–${s.end}`, s.n, s.mk.S, fmt(s.mk.tau, 3), fmt(s.mk.Z, 3),
        fmtP(s.mk.p), s.mk.p < 0.05 ? `<span class="trend-significant">${s.mk.trend}</span>` : s.mk.trend,
        fmtSig(s.sen.slope, 6), `${fmtSig(s.sen.ciLow, 5)} to ${fmtSig(s.sen.ciHigh, 5)}`]));
    table("trChowTable", ["Breakpoint", "F", "df", "p", "Verdict"],
      R.chow.map(c => [c.breakpoint, fmt(c.F, 3), `${c.df1}, ${c.df2}`, fmtP(c.p) + " " + stars(c.p),
        c.p < 0.05 ? `<span class="trend-significant">Lines differ (structural break)</span>` : "No significant break"]));
    const det = T.detect && T.detect.candidates;
    $("trDetectPanel").hidden = !det;
    if (det) table("trDetectTable", ["Breaks", "Years", "SSR", "BIC", ""],
      det.map(c => [c.breaks.length, c.breaks.join(", ") || "none", fmt(c.ssr, 0), fmt(c.bic, 2),
        c === T.detect.best ? `<span class="trend-significant">best</span>` : ""]));
  }

  function renderDiagnostics() {
    const R = T.result;
    if (!R || !R.pw) return;
    const segs = R.pw.segments;
    const fitted = segs.flatMap(s => s.yhat), resid = segs.flatMap(s => s.resid), xs = segs.flatMap(s => s.x);
    const colors = segs.flatMap((s, i) => s.x.map(() => SEG_COLORS[i % SEG_COLORS.length]));
    const base = (title, xt, yt) => ({
      title: { text: title, font: { size: 13 } }, margin: { l: 50, r: 10, t: 34, b: 40 }, showlegend: false,
      xaxis: { title: { text: xt, font: { size: 11 } }, gridcolor: "#eef2f5", zeroline: false },
      yaxis: { title: { text: yt, font: { size: 11 } }, gridcolor: "#eef2f5", zeroline: true, zerolinecolor: "#9aa7b3" },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "#fff", font: { size: 11 },
    });
    const cfg = { responsive: true, displayModeBar: false };
    const P = window.Plotly;
    P.react($("trResChart"), [{ x: xs, y: resid, type: "scatter", mode: "markers", marker: { color: colors, size: 7 }, hovertemplate: "%{x}: %{y:,.1f}<extra></extra>" }],
      { ...base("Residuals over time", "Year", "Residual"), xaxis: { ...base().xaxis, tickformat: "d", title: { text: "Year" } } }, cfg);
    // histogram (bins computed here: the basic Plotly bundle has no histogram trace)
    const nb = Math.min(15, Math.max(5, Math.floor(resid.length / 3)));
    const lo = Math.min(...resid), hi = Math.max(...resid), w = (hi - lo) / nb || 1;
    const counts = new Array(nb).fill(0);
    resid.forEach(v => counts[Math.min(nb - 1, Math.floor((v - lo) / w))]++);
    P.react($("trHistChart"), [{ x: counts.map((_, i) => lo + w * (i + 0.5)), y: counts, type: "bar", width: w * 0.92, marker: { color: "rgba(0,132,61,.65)" } }],
      base("Residual distribution", "Residual", "Count"), cfg);
    const qq = S.qq(resid), sd = Math.sqrt(S.sum(resid.map(v => v * v)) / Math.max(resid.length - 1, 1));
    const tq = qq.map(p => p.theoretical);
    P.react($("trQqChart"), [
      { x: tq, y: qq.map(p => p.sample), type: "scatter", mode: "markers", marker: { color: "#1b6ca8", size: 6 } },
      { x: [tq[0], tq[tq.length - 1]], y: [tq[0] * sd, tq[tq.length - 1] * sd], type: "scatter", mode: "lines", line: { color: "#c0392b", dash: "dash" } },
    ], base("Normal Q–Q", "Theoretical quantile", "Residual"), cfg);
    const ac = S.acf(resid, Math.min(10, resid.length - 2)), bound = 1.96 / Math.sqrt(resid.length);
    P.react($("trAcfChart"), [{ x: ac.map((_, i) => i).slice(1), y: ac.slice(1), type: "bar", marker: { color: "#7f8c8d" }, width: 0.4 }],
      { ...base("Residual autocorrelation", "Lag (years)", "ACF"),
        shapes: [bound, -bound].map(b => ({ type: "line", xref: "paper", x0: 0, x1: 1, y0: b, y1: b, line: { color: "#1b6ca8", dash: "dot", width: 1 } })) }, cfg);
    const jb = S.jarqueBera(resid), dw = S.durbinWatson(resid);
    $("trResidTests").innerHTML =
      `<span><b>Durbin–Watson</b> ${fmt(dw, 3)} <small class="text-muted">(≈2 no autocorrelation; &lt;1.5 positive)</small></span>` +
      `<span><b>Jarque–Bera</b> ${fmt(jb.JB, 2)}, p ${fmtP(jb.p)} <small class="text-muted">(p &lt; 0.05 suggests non-normal residuals)</small></span>` +
      `<span><b>Skew</b> ${fmt(jb.skew, 2)} · <b>Kurtosis</b> ${fmt(jb.kurtosis, 2)}</span>`;
  }

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------
  const slug = s => s.replace(/[^\w.-]+/g, "_");
  function downloadCsv() {
    const R = T.result;
    const cols = ["kind", "label", "start", "end", "n", "method", "confidence", "slope_per_year", "std_error", "ci_low", "ci_high",
      "intercept", "level_at_start", "r2", "adj_r2", "rmse", "mae", "t", "p_value", "durbin_watson",
      "mk_S", "mk_tau", "mk_Z", "mk_p", "mk_trend", "sens_slope", "sens_ci_low", "sens_ci_high"];
    const row = (kind, label, f, mk, sen) => [kind, label, f.start, f.end, f.n, f.method, f.confidence, f.slope, f.se, f.ciLow, f.ciHigh,
      f.intercept, f.levelAtStart, f.r2, f.adjR2, f.rmse, f.mae, f.t, f.p, f.dw, mk.S, mk.tau, mk.Z, mk.p, mk.trend, sen.slope, sen.ciLow, sen.ciHigh];
    const rows = [];
    if (R.pw) R.pw.segments.forEach(s => rows.push(row("segment", `Seg ${s.index}`, s, s.mk, s.sen)));
    R.chow.forEach(c => rows.push(["chow_test", `break ${c.breakpoint}`, c.breakpoint, "", "", "", "", "", "", "", "", "", "", "", "", "", "", c.F, c.p]));
    const cell = v => { const s = v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const meta = `# ${T.gas} | ${T.sector} | ${UNITS} | computed in browser by INPACT Trend Analysis | ${new Date().toISOString().slice(0, 10)}`;
    const csv = [meta, cols.join(","), ...rows.map(r => r.map(cell).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = slug(`trend_stats_${T.gas}_${T.sector}`) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copyLink() {
    clearTimeout(T.hashTimer);
    const url = location.origin + location.pathname + "#trend/" + b64e(JSON.stringify(stateObj()));
    history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); flash($("trLinkBtn"), "Copied"); }
    catch (e) { flash($("trLinkBtn"), "Link in address bar"); }
  }
  function flash(btn, text) {
    const old = btn.innerHTML; btn.textContent = text;
    setTimeout(() => { btn.innerHTML = old; }, 1400);
  }

  window.initTrendTab = initTrendTab;
})();
