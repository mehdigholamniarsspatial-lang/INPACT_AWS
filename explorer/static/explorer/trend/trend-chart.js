/*
 * trend-chart.js: interactive Trend Analysis tab
 * ===============================================
 * Every statistic is computed in the browser by stats.js (window.TrendStats),
 * so the chart responds while you drag. The server engine
 * (/api/trend/fit/, explorer/trend_engine.py) stays the reference:
 * "Verify on server" re-runs the same fits there and compares the numbers.
 *
 * What you can do on the chart
 *   Select mode (R):    drag horizontally to draw an analysis range. A live
 *                       preview line and stats appear while you drag; release
 *                       to keep it as a coloured range (up to 8).
 *   Breakpoint mode (B): click a year to add a piecewise breakpoint.
 *   Zoom (Z) / Pan (P): Plotly navigation; double-click resets the view.
 *   Any mode:          drag a dashed breakpoint line, a range edge, or a
 *                       range's top strip (moves it). Fits update live.
 * State (series, model, breakpoints, ranges, options) is kept in the URL
 * hash, #trend/<state>, so a copied link reopens the same analysis.
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
  const RANGE_COLORS = ["#e67e22", "#7d3c98", "#138d75", "#cb4335", "#2e4053", "#b7950b", "#1f618d", "#a04000"];
  const POLICY_COLORS = { International: "#5b6b7a", EU: "#1f4e9e", National: "#00843D", Target: "#c0392b" };
  const MAX_RANGES = 8;
  const MAX_BREAKS = 10;
  const HANDLE_PX = 8;

  const T = {
    inited: false, data: null, gd: null,
    gas: null, sector: null, method: "ols", conf: 0.95,
    bps: [2001], ranges: [], preview: null, nextRangeId: 1,
    opt: { band: true, pred: false, bp: true, policies: true, yoy: true, log: false, mk: true, proj: 2030 },
    mode: "select", result: null, drag: null, raf: 0, hashTimer: 0, verify: null,
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
      const [bundle] = await Promise.all([
        fetch("/api/trend/bundle/").then(r => r.json()),
        loadPlotly(),
      ]);
      if (!bundle.ok) throw new Error(bundle.detail || "Trend data unavailable.");
      T.data = bundle;
      readHash();
      buildControls();
      bindChart();
      recompute();
    } catch (err) {
      setError("Could not start Trend Analysis: " + err.message);
    } finally {
      $("trLoading").hidden = true;
    }
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
      if ([0.9, 0.95, 0.99].includes(st.c)) T.conf = st.c;
      if (Array.isArray(st.b)) T.bps = st.b.filter(isNum).slice(0, MAX_BREAKS);
      if (Array.isArray(st.r)) st.r.filter(r => Array.isArray(r) && isNum(r[0]) && isNum(r[1]) && r[0] < r[1])
        .slice(0, MAX_RANGES).forEach(r => T.ranges.push(newRange(r[0], r[1])));
      if (st.o && typeof st.o === "object") for (const k of Object.keys(T.opt)) if (k in st.o) T.opt[k] = st.o[k];
    } catch (e) { /* ignore a malformed link and start from defaults */ }
  }
  function writeHash() {
    clearTimeout(T.hashTimer);
    T.hashTimer = setTimeout(() => {
      if (!location.hash.startsWith("#trend") && !document.getElementById("tab-trend").classList.contains("active")) return;
      const st = { g: T.gas, s: T.sector, m: T.method, c: T.conf, b: T.bps, r: T.ranges.map(r => [r.a, r.b]), o: T.opt };
      history.replaceState(null, "", location.pathname + location.search + "#trend/" + b64e(JSON.stringify(st)));
    }, 250);
  }

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
    $("trConf").value = String(T.conf);
    const toggles = { trShowBand: "band", trShowPred: "pred", trShowBp: "bp", trShowPolicies: "policies", trShowYoy: "yoy", trLogY: "log", trEnableMk: "mk" };
    for (const [id, key] of Object.entries(toggles)) {
      const el = $(id);
      el.checked = !!T.opt[key];
      el.addEventListener("change", () => { T.opt[key] = el.checked; recompute(); });
    }
    $("trProjYear").value = T.opt.proj || "";

    gasSel.addEventListener("change", () => { T.gas = gasSel.value; fillSectors(); resetVerify(); recompute(); });
    $("trSector").addEventListener("change", e => { T.sector = e.target.value; resetVerify(); recompute(); });
    $("trMethod").addEventListener("change", e => { T.method = e.target.value; resetVerify(); recompute(); });
    $("trConf").addEventListener("change", e => { T.conf = parseFloat(e.target.value); resetVerify(); recompute(); });
    $("trProjYear").addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      T.opt.proj = isNum(v) && v > 0 ? v : null;
      recompute();
    });

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
      b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("trResetView").addEventListener("click", () => window.Plotly.relayout(T.gd, { "xaxis.autorange": true, "yaxis.autorange": true }));
    $("trClearRanges").addEventListener("click", () => { T.ranges = []; recompute(); });
    $("trRangeBody").addEventListener("click", e => {
      const b = e.target.closest("[data-remove]");
      if (b) { T.ranges = T.ranges.filter(r => r.id !== Number(b.dataset.remove)); recompute(); }
    });
    $("trRangeBody").addEventListener("change", e => {
      const inp = e.target.closest("[data-edge]");
      if (!inp) return;
      const r = T.ranges.find(q => q.id === Number(inp.dataset.id));
      const v = parseInt(inp.value, 10);
      if (r && isNum(v)) { setRangeEdge(r, inp.dataset.edge, v); recompute(); }
    });

    $("trCsvBtn").addEventListener("click", downloadCsv);
    $("trPngBtn").addEventListener("click", () => window.Plotly.downloadImage(T.gd, {
      format: "png", scale: 2, width: 1400, height: 760, filename: slug(`trend_${T.gas}_${T.sector}`),
    }));
    $("trLinkBtn").addEventListener("click", copyLink);
    $("trVerifyBtn").addEventListener("click", verifyOnServer);
    $("trAdvancedPanel").addEventListener("shown.bs.collapse", renderDiagnostics);

    document.addEventListener("keydown", e => {
      if (!$("tab-trend").classList.contains("active")) return;
      if (e.target.closest("input, select, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = { r: "select", b: "breakpoint", z: "zoom", p: "pan" }[e.key.toLowerCase()];
      if (k) { setMode(k); e.preventDefault(); }
      if (e.key === "Escape" && T.preview) { T.preview = null; scheduleRender(); }
    });
  }

  function setMode(mode) {
    T.mode = mode;
    document.querySelectorAll("#trModes [data-mode]").forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const dragmode = { select: "select", breakpoint: "zoom", zoom: "zoom", pan: "pan" }[mode];
    if (T.gd && T.gd.layout) window.Plotly.relayout(T.gd, { dragmode });
    $("trModeHint").textContent = {
      select: "Drag across the chart to analyse a period. Drag a range's edge or its top strip to change it.",
      breakpoint: "Click a year to add a breakpoint. Drag a dashed line to move it.",
      zoom: "Drag to zoom. Double-click to reset the view.",
      pan: "Drag to pan. Double-click to reset the view.",
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
  function newRange(a, b) {
    const used = new Set(T.ranges.map(r => r.color));
    const color = RANGE_COLORS.find(c => !used.has(c)) || RANGE_COLORS[T.nextRangeId % RANGE_COLORS.length];
    return { id: T.nextRangeId++, a: Math.round(a), b: Math.round(b), color };
  }
  function addRange(a, b) {
    if (T.ranges.length >= MAX_RANGES) { setError(`At most ${MAX_RANGES} ranges; remove one first.`); return; }
    const { lo, hi } = dataSpan();
    a = Math.max(lo, Math.ceil(a)); b = Math.min(hi, Math.floor(b));
    if (b - a < 2) { setError("A range needs at least 3 years. Drag a wider selection."); return; }
    T.ranges.push(newRange(a, b));
  }
  function setRangeEdge(r, edge, v) {
    const { lo, hi } = dataSpan();
    if (edge === "a") r.a = Math.max(lo, Math.min(Math.round(v), r.b - 2));
    else r.b = Math.min(hi, Math.max(Math.round(v), r.a + 2));
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
  function fitRange(x, y, a, b) {
    const idx = []; x.forEach((v, i) => { if (v >= a && v <= b) idx.push(i); });
    const xs = idx.map(i => x[i]), ys = idx.map(i => y[i]);
    if (xs.length < S.MIN_POINTS_PER_SEGMENT) return { error: `${xs.length} data point(s) in ${a}–${b}; at least 3 are needed.`, n: xs.length };
    try {
      const f = S.fit(xs, ys, { method: T.method, confidence: T.conf });
      return {
        fit: f, mk: S.mannKendall(ys), sen: S.sensSlope(xs, ys, T.conf), sum: S.rangeSummary(xs, ys),
        warn: f.warning,
      };
    } catch (e) { return { error: e.message, n: xs.length }; }
  }

  function recompute() {
    if (!T.data) return;
    const { x, y } = series();
    const res = { x, y, pw: null, pwError: null, ranges: [], chow: [] };
    // drop breakpoints that fall outside a new series' span
    T.bps = T.bps.filter(b => b > x[0] && b < x[x.length - 1]);
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
    res.ranges = T.ranges.map(r => ({ r, ...fitRange(x, y, r.a, r.b) }));
    if (T.preview) res.preview = fitRange(x, y, T.preview.a, T.preview.b);
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
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  };
  function bandTraces(lo, hi, xs, color, name, alpha) {
    return [
      { x: xs, y: lo, type: "scatter", mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
      { x: xs, y: hi, type: "scatter", mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: rgba(color, alpha),
        hoverinfo: "skip", name, showlegend: false },
    ];
  }
  function lineGrid(a, b) { // dense x grid so bands curve smoothly
    const out = []; const steps = Math.max(2, Math.round((b - a) * 2));
    for (let i = 0; i <= steps; i++) out.push(a + (b - a) * i / steps);
    return out;
  }

  function buildFigure() {
    const R = T.result, traces = [], shapes = [], annotations = [];
    const yoy = T.opt.yoy && R.x.length > 1;
    const mainDomain = yoy ? [0.27, 1] : [0, 1];

    // Observations
    traces.push({
      x: R.x, y: R.y, type: "scatter", mode: "lines+markers", name: "Observed",
      line: { color: "rgba(60,60,60,.45)", width: 1.2 }, marker: { color: "#3c3c3c", size: 6 },
      unselected: { marker: { opacity: 1 } }, selected: { marker: { opacity: 1 } },
      hovertemplate: `%{y:,.1f} ${UNITS}<extra>Observed</extra>`,
    });

    // Piecewise segments
    if (R.pw) R.pw.segments.forEach((seg, i) => {
      const c = SEG_COLORS[i % SEG_COLORS.length];
      const g = lineGrid(seg.start, seg.end), bd = S.bands(seg, g, T.conf);
      if (T.opt.pred) traces.push(...bandTraces(bd.map(p => p.predLo), bd.map(p => p.predHi), g, c, "Prediction interval", 0.08));
      if (T.opt.band) traces.push(...bandTraces(bd.map(p => p.meanLo), bd.map(p => p.meanHi), g, c, "Confidence band", 0.18));
      traces.push({
        x: [seg.start, seg.end], y: [seg.intercept + seg.slope * seg.start, seg.intercept + seg.slope * seg.end],
        type: "scatter", mode: "lines", line: { color: c, width: 2.6 },
        name: `Seg ${seg.index} ${seg.start}–${seg.end}`,
        hovertemplate: `Seg ${seg.index} fit: %{y:,.1f}<extra>${fmtSigned(seg.slope)} /yr</extra>`,
      });
    });

    // Projection of the last segment
    const last = R.pw && R.pw.segments[R.pw.segments.length - 1];
    if (last && T.opt.proj && T.opt.proj > last.end && T.opt.proj <= last.end + 50) {
      const g = lineGrid(last.end, T.opt.proj), bd = S.bands(last, g, T.conf);
      traces.push(...bandTraces(bd.map(p => p.predLo), bd.map(p => p.predHi), g, "#16324F", "Projection interval", 0.10));
      traces.push({
        x: g, y: bd.map(p => p.y), type: "scatter", mode: "lines", line: { color: "#16324F", width: 2, dash: "dash" },
        name: `Projection to ${T.opt.proj}`, hovertemplate: `Projection: %{y:,.1f}<extra></extra>`,
      });
    }

    // Saved ranges: line + translucent rectangle + draggable top strip
    R.ranges.forEach((rr, k) => {
      const r = rr.r;
      shapes.push({ type: "rect", xref: "x", yref: "y domain", x0: r.a, x1: r.b, y0: 0, y1: 1,
        fillcolor: rgba(r.color, 0.07), line: { color: rgba(r.color, 0.55), width: 1 }, layer: "below" });
      shapes.push({ type: "rect", xref: "x", yref: "y domain", x0: r.a, x1: r.b, y0: 0.94, y1: 1,
        fillcolor: rgba(r.color, 0.35), line: { width: 0 }, layer: "above",
        label: { text: `R${k + 1}`, font: { size: 10, color: "#fff" }, textposition: "middle center" } });
      if (rr.fit) {
        const f = rr.fit;
        traces.push({
          x: [r.a, r.b], y: [f.intercept + f.slope * r.a, f.intercept + f.slope * r.b], type: "scatter", mode: "lines",
          line: { color: r.color, width: 3 }, name: `R${k + 1} ${r.a}–${r.b}`,
          hovertemplate: `R${k + 1}: %{y:,.1f}<extra>${fmtSigned(f.slope)} /yr</extra>`,
        });
      }
    });

    // Breakpoints
    if (T.opt.bp && R.pw) R.pw.used.forEach(bp => shapes.push({
      type: "line", xref: "x", yref: "y domain", x0: bp, x1: bp, y0: 0, y1: 1,
      line: { color: "rgba(22,50,79,.75)", width: 2, dash: "dash" },
      label: { text: String(bp), textposition: "start", font: { size: 10, color: "#16324F" }, yanchor: "bottom" },
    }));

    // Policy markers (data from the page's policy timeline CSV)
    const pol = (typeof POLICIES_RAW !== "undefined" ? POLICIES_RAW : []).filter(p => p.year >= R.x[0] && p.year <= R.x[R.x.length - 1]);
    if (T.opt.policies && pol.length) {
      const levels = [...new Set(pol.map(p => p.level))];
      levels.forEach(lv => {
        const ps = pol.filter(p => p.level === lv);
        traces.push({
          x: ps.map(p => p.year), y: ps.map(() => 0.035), yaxis: "y3", type: "scatter", mode: "markers",
          marker: { symbol: "triangle-up", size: 9, color: POLICY_COLORS[lv] || "#666", line: { color: "#fff", width: 1 } },
          name: `${lv} policy`, text: ps.map(p => p.name),
          hovertemplate: `%{text}<extra>${esc(lv)}</extra>`,
        });
      });
    }

    // Year-on-year change bars
    if (yoy) {
      const xs = [], ys = [];
      for (let i = 1; i < R.x.length; i++) if (R.x[i] - R.x[i - 1] === 1 && R.y[i - 1] !== 0) {
        xs.push(R.x[i]); ys.push((R.y[i] / R.y[i - 1] - 1) * 100);
      }
      traces.push({
        x: xs, y: ys, type: "bar", yaxis: "y2", name: "YoY %",
        marker: { color: ys.map(v => v <= 0 ? "rgba(0,132,61,.7)" : "rgba(192,57,43,.7)") },
        hovertemplate: "YoY %{y:+.1f}%<extra></extra>",
      });
    }

    // a range selection must never dim any trace
    traces.forEach(t => { t.selectedpoints = null; t.unselected = { marker: { opacity: 1 } }; });

    const layout = {
      uirevision: T.gas + "|" + T.sector,
      margin: { l: 70, r: 18, t: 24, b: 70 },
      dragmode: { select: "select", breakpoint: "zoom", zoom: "zoom", pan: "pan" }[T.mode],
      selectdirection: "h",
      hovermode: "x unified",
      hoverlabel: { bgcolor: "rgba(255,255,255,.96)", bordercolor: "#c9d3dc", font: { size: 12 } },
      showlegend: true,
      legend: { orientation: "h", y: -0.07, yanchor: "top", x: 0, font: { size: 11 } },
      plot_bgcolor: "#fff", paper_bgcolor: "rgba(0,0,0,0)",
      font: { family: "inherit", color: "#2b3a48" },
      xaxis: {
        anchor: yoy ? "y2" : "y", showspikes: true, spikemode: "across", spikesnap: "cursor",
        spikecolor: "#8a99a8", spikethickness: 1, spikedash: "dot", gridcolor: "#eef2f5",
        tickformat: "d", hoverformat: "d", zeroline: false,
      },
      yaxis: {
        domain: mainDomain, title: { text: UNITS, font: { size: 12 } }, gridcolor: "#eef2f5",
        type: T.opt.log ? "log" : "linear", tickformat: ",~r", zeroline: false,
      },
      yaxis2: { domain: [0, 0.2], title: { text: "YoY %", font: { size: 11 } }, gridcolor: "#f2f5f7",
        zeroline: true, zerolinecolor: "#9aa7b3", ticksuffix: "%", visible: yoy, fixedrange: true },
      yaxis3: { overlaying: "y", range: [0, 1], visible: false, fixedrange: true },
      shapes, annotations,
    };
    return { traces, layout };
  }

  function render() {
    const { traces, layout } = buildFigure();
    window.Plotly.react(T.gd, traces, layout, {
      responsive: true, displaylogo: false, scrollZoom: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
      toImageButtonOptions: { format: "png", scale: 2, filename: slug(`trend_${T.gas}_${T.sector}`) },
    });
    renderSide();
    drawOverlay();
    if ($("trAdvancedPanel").classList.contains("show")) renderDiagnostics();
  }

  /** Preview regression line drawn over the plot without redrawing Plotly. */
  function drawOverlay() {
    let svg = T.overlay;
    if (!svg) {
      svg = T.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "tr-overlay");
      svg.setAttribute("aria-hidden", "true");
      T.gd.appendChild(svg);
    }
    const pv = T.result && T.result.preview, fl = T.gd._fullLayout;
    if (!pv || !pv.fit || !fl || !fl.xaxis) { svg.innerHTML = ""; return; }
    const xa = fl.xaxis, ya = fl.yaxis, f = pv.fit;
    const P = xv => [xa._offset + xa.c2p(xv), ya._offset + ya.c2p(f.intercept + f.slope * xv)];
    const [x1, y1] = P(f.start), [x2, y2] = P(f.end);
    if (![x1, y1, x2, y2].every(isNum)) { svg.innerHTML = ""; return; }
    const label = `${fmtSigned(f.slope)} /yr · R² ${isNum(f.r2) ? f.r2.toFixed(2) : "–"} · p ${fmtP(f.p)}`;
    svg.innerHTML =
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111" stroke-width="2.5" stroke-dasharray="5 4"/>` +
      `<text x="${(x1 + x2) / 2}" y="${Math.min(y1, y2) - 10}" text-anchor="middle" class="tr-overlay-label">${esc(label)}</text>`;
  }

  // ------------------------------------------------------------------
  // Pointer interaction: select / click / custom handle drags
  // ------------------------------------------------------------------
  function bindChart() {
    const gd = T.gd = $("trChart");
    window.Plotly.newPlot(gd, [], {});
    setMode(T.mode);

    // While a selection is being drawn, Plotly must not be redrawn (that would
    // cancel the drag), so the preview goes to an SVG overlay and the table only.
    gd.on("plotly_selecting", ev => {
      if (!ev || !ev.range || !ev.range.x) return;
      const [a, b] = ev.range.x;
      T.preview = { a: Math.ceil(Math.min(a, b)), b: Math.floor(Math.max(a, b)) };
      if (T.previewRaf) return;
      T.previewRaf = requestAnimationFrame(() => {
        T.previewRaf = 0;
        if (!T.preview || !T.result) return;
        const { x, y } = series();
        T.result.preview = fitRange(x, y, T.preview.a, T.preview.b);
        renderRanges();
        drawOverlay();
      });
    });
    // Redrawing the figure can itself emit plotly_selected / plotly_deselect,
    // so only a real, user-drawn selection is acted on, outside the event.
    gd.on("plotly_selected", ev => {
      const rng = ev && ev.range && ev.range.x;
      if (!rng || T.mode !== "select") return;
      T.preview = null;
      if (T.previewRaf) { cancelAnimationFrame(T.previewRaf); T.previewRaf = 0; }
      setTimeout(() => {
        addRange(Math.min(...rng), Math.max(...rng));
        // reset Plotly's own selection so the next drag starts fresh
        gd.layout.selections = [];
        recompute();
      }, 0);
    });
    gd.on("plotly_deselect", () => {
      if (!T.preview) return;
      T.preview = null;
      if (T.result) T.result.preview = null;
      renderRanges(); drawOverlay();
    });
    gd.on("plotly_click", ev => {
      if (T.mode !== "breakpoint" || !ev.points || !ev.points.length) return;
      addBreakpoint(ev.points[0].x);
      recompute();
    });

    // Custom drags (capture phase, so Plotly's own drag never starts)
    const start = (cx, cy, e) => {
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
      } else if (d.kind === "edge") {
        const r = T.ranges[d.i], before = r[d.edge];
        setRangeEdge(r, d.edge, xv);
        if (r[d.edge] !== before) scheduleRender();
      } else if (d.kind === "move") {
        const r = T.ranges[d.i], w = r.b - r.a;
        let a = Math.round(xv - d.grab);
        a = Math.max(lo, Math.min(hi - w, a));
        if (a !== r.a) { r.a = a; r.b = a + w; scheduleRender(); }
      }
    };
    window.addEventListener("mousemove", e => {
      if (T.drag) { move(e.clientX, e.clientY); return; }
      if (e.target instanceof Node && gd.contains(e.target)) {
        const h = hit(e.clientX, e.clientY);
        gd.classList.toggle("tr-hot-ew", !!h && h.kind !== "move");
        gd.classList.toggle("tr-hot-move", !!h && h.kind === "move");
      }
    });
    window.addEventListener("touchmove", e => { if (T.drag && e.touches[0]) { move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
    const end = () => { if (T.drag) { T.drag = null; document.body.classList.remove("tr-dragging"); recompute(); } };
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
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
  /** What is under the pointer: a breakpoint line, a range edge, or a range's top strip. */
  function hit(cx, cy) {
    const g = plotGeom();
    if (!g || !T.result) return null;
    const px = cx - g.rect.left - g.s.l, py = cy - g.rect.top;
    if (px < -HANDLE_PX || px > g.s.w + HANDLE_PX || py < g.top || py > g.bot) return null;
    const xp = v => g.xa.l2p(v);
    const stripBottom = g.top + (g.bot - g.top) * 0.06;
    for (let i = T.ranges.length - 1; i >= 0; i--) {
      const r = T.ranges[i];
      if (Math.abs(xp(r.a) - px) <= HANDLE_PX) return { kind: "edge", i, edge: "a" };
      if (Math.abs(xp(r.b) - px) <= HANDLE_PX) return { kind: "edge", i, edge: "b" };
      if (py <= stripBottom && px > xp(r.a) && px < xp(r.b)) return { kind: "move", i, grab: g.xa.p2l(px) - r.a };
    }
    if (T.opt.bp) for (let i = 0; i < T.bps.length; i++) {
      if (Math.abs(xp(T.bps[i]) - px) <= HANDLE_PX) return { kind: "bp", i };
    }
    return null;
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
    if (last && T.opt.proj && T.opt.proj > last.end) {
      const pj = S.bands(last, [T.opt.proj], T.conf)[0];
      kpis.push([`Projection ${T.opt.proj}`, fmt(pj.y), `${Math.round(T.conf * 100)}% PI ${fmt(pj.predLo)} to ${fmt(pj.predHi)}`]);
    }
    $("trKpis").innerHTML = kpis.map(([l, v, s, cls]) =>
      `<div class="tr-kpi ${cls || ""}"><div class="lbl">${esc(l)}</div><div class="val">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join("");

    renderDirection();
    renderRanges();
    renderStatsTables();
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

  function rangeRowHtml(rr, label, color, editable) {
    const r = rr.r || {};
    const edges = editable
      ? `<input type="number" class="tr-yr" data-id="${r.id}" data-edge="a" value="${r.a}" aria-label="Range start year">–<input type="number" class="tr-yr" data-id="${r.id}" data-edge="b" value="${r.b}" aria-label="Range end year">`
      : `${rr.fit ? rr.fit.start + "–" + rr.fit.end : "…"}`;
    const sw = `<span class="tr-swatch" style="background:${color}"></span>`;
    if (rr.error) return `<tr class="${editable ? "" : "tr-preview"}"><td>${sw}${label}</td><td class="text-nowrap">${edges}</td><td>${rr.n ?? "–"}</td><td colspan="9" class="text-danger">${esc(rr.error)}</td><td>${editable ? removeBtn(r.id) : ""}</td></tr>`;
    const f = rr.fit, m = rr.mk, su = rr.sum;
    const pct = f.slope / su.mean * 100;
    return `<tr class="${editable ? "" : "tr-preview"}">
      <td>${sw}${label}</td><td class="text-nowrap">${edges}</td><td>${f.n}</td>
      <td class="text-nowrap ${f.slope <= 0 ? "tr-good" : "tr-bad"}"><b>${fmtSigned(f.slope)}</b></td>
      <td class="text-nowrap small">${fmtSigned(f.ciLow)} to ${fmtSigned(f.ciHigh)}</td>
      <td>${fmtSigned(pct, 2)}%</td>
      <td>${isNum(f.r2) ? f.r2.toFixed(3) : "–"}</td>
      <td class="text-nowrap">${fmtP(f.p)} <span class="tr-stars">${stars(f.p)}</span></td>
      <td>${fmtSigned(rr.sen.slope)}</td>
      <td class="text-nowrap">${fmt(m.tau, 2)} <small class="text-muted">(p ${fmtP(m.p)})</small></td>
      <td class="text-nowrap">${fmtSigned(su.pctChange)}%</td>
      <td>${fmtSigned(su.cagr, 2)}%</td>
      <td>${editable ? removeBtn(r.id) : ""}</td></tr>` +
      (rr.warn ? `<tr><td></td><td colspan="12" class="small text-warning-emphasis">${esc(rr.warn)}</td></tr>` : "");
  }
  const removeBtn = id => `<button type="button" class="btn btn-link btn-sm p-0 text-danger" data-remove="${id}" title="Remove range"><i class="bi bi-x-circle"></i></button>`;

  function renderRanges() {
    const R = T.result;
    let rows = R.ranges.map((rr, k) => rangeRowHtml(rr, `R${k + 1}`, rr.r.color, true)).join("");
    if (R.preview) rows += rangeRowHtml(R.preview, "Preview", "#111", false);
    $("trRangeBody").innerHTML = rows ||
      `<tr><td colspan="13" class="text-muted small py-3">No ranges yet. Choose <b>Select range</b> and drag across the chart to analyse a period, for example the years after a policy started.</td></tr>`;
    $("trClearRanges").disabled = !R.ranges.length;
    // range-difference test between the first two ranges (slopes compared with a z-test)
    const ok = R.ranges.filter(rr => rr.fit);
    const cmp = $("trRangeCompare");
    if (ok.length >= 2) {
      const [a, b] = ok, d = b.fit.slope - a.fit.slope, se = Math.sqrt(a.fit.se ** 2 + b.fit.se ** 2), z = d / se;
      cmp.hidden = false;
      cmp.innerHTML = `<b>Slope change R1 → R2:</b> ${fmtSigned(d)} ${UNITS}/yr (SE ${fmt(se)}, z = ${fmt(z, 2)}, p ${fmtP(S.normTwoSided(z))} ${stars(S.normTwoSided(z))}). ` +
        `<span class="text-muted">Assumes the two ranges are independent; overlapping ranges overstate significance.</span>`;
    } else cmp.hidden = true;
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
    const cfg = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] };
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
  // Server verification: same fits on the reference engine
  // ------------------------------------------------------------------
  function resetVerify() { const b = $("trVerifyBadge"); b.hidden = true; b.className = "tr-verify"; }

  async function postFit(body) {
    const r = await fetch("/api/trend/fit/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    return d;
  }
  /** Relative difference, allowing for the server's rounding to `dp` decimals. */
  function diff(client, server, dp) {
    if (server == null || !isNum(client)) return (server == null && !isNum(client)) ? 0 : Infinity;
    const tol = dp != null ? 0.5 * Math.pow(10, -dp) : 0;
    const ad = Math.max(0, Math.abs(client - server) - tol);
    return ad / Math.max(Math.abs(server), 1e-9);
  }
  async function verifyOnServer() {
    const badge = $("trVerifyBadge"), btn = $("trVerifyBtn");
    btn.disabled = true; badge.hidden = false; badge.className = "tr-verify"; badge.textContent = "Checking…";
    try {
      const R = T.result, base = { gas: T.gas, sector: T.sector, method: T.method, confidence: T.conf };
      const jobs = [];
      if (R.pw) jobs.push(postFit({ ...base, breakpoints: R.pw.used }).then(d => ({ client: R.pw.segments, server: d.segments })));
      R.ranges.filter(rr => rr.fit).forEach(rr =>
        jobs.push(postFit({ ...base, breakpoints: [], start: rr.r.a, end: rr.r.b }).then(d => ({ client: [rr.fit], server: d.segments }))));
      const out = await Promise.all(jobs);
      let worst = 0, count = 0;
      for (const { client, server } of out) {
        if (client.length !== server.length) throw new Error("Segment count differs from the server.");
        client.forEach((c, i) => {
          const s = server[i];
          const ds = [diff(c.slope, s.Slope, 6), diff(c.intercept, s.Intercept, 6), diff(c.r2, s.R2, 4),
            diff(c.se, s.Std_Error, 6), diff(c.p, s.p_value, 6)];
          s.y_pred.forEach((v, j) => ds.push(diff(c.yhat[j], v)));
          worst = Math.max(worst, ...ds); count++;
        });
      }
      const tol = T.method === "ols" ? 1e-6 : 1e-4;
      const ok = worst <= tol;
      badge.className = "tr-verify " + (ok ? "ok" : "bad");
      badge.innerHTML = ok
        ? `<i class="bi bi-patch-check-fill"></i> Server agrees: ${count} fit(s), max relative difference ${worst.toExponential(1)}`
        : `<i class="bi bi-exclamation-triangle-fill"></i> Server differs: max relative difference ${worst.toExponential(2)}`;
    } catch (e) {
      badge.className = "tr-verify bad"; badge.textContent = "Verification failed: " + e.message;
    } finally { btn.disabled = false; }
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
    R.ranges.forEach((rr, k) => { if (rr.fit) rows.push(row("range", `R${k + 1}`, rr.fit, rr.mk, rr.sen)); });
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
    const st = { g: T.gas, s: T.sector, m: T.method, c: T.conf, b: T.bps, r: T.ranges.map(r => [r.a, r.b]), o: T.opt };
    const url = location.origin + location.pathname + "#trend/" + b64e(JSON.stringify(st));
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
