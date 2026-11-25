/*
 * trend-chart.js: interactive Trend Analysis tab
 * ===============================================
 * Every statistic is computed in the browser by stats.js (window.TrendStats),
 * so the chart responds while you drag. The server engine
 * (/api/trend/fit/, explorer/trend_engine.py) stays the reference:
 * "Verify on server" re-runs the same fits there and compares the numbers.
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
  // Plotly drag behaviour per tool (Breakpoint mode only reacts to clicks)
  const DRAGMODE = { breakpoint: false, zoom: "zoom" };

  const T = {
    inited: false, data: null, gd: null,
    gas: null, sector: null, method: "ols", conf: 0.95,
    bps: [2001],
    opt: { band: true, pred: false, bp: true, policies: true, yoy: true, log: false, mk: true, proj: 2030 },
    mode: "breakpoint", result: null, drag: null, raf: 0, hashTimer: 0, verify: null,
    pins: new Set(),          // pinned policies, keyed "year|name"
    card: null, cardTimer: 0, cardKey: null,
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
      if (isNum(st.c) && st.c >= 0.8 && st.c <= 0.99) T.conf = Math.round(st.c * 100) / 100;
      if (Array.isArray(st.p)) st.p.forEach(k => { if (typeof k === "string") T.pins.add(k); });
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
  const stateObj = () => ({ g: T.gas, s: T.sector, m: T.method, c: T.conf, b: T.bps, o: T.opt, p: [...T.pins] });

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
    conf.addEventListener("input", () => { T.conf = parseInt(conf.value, 10) / 100; showConf(); resetVerify(); scheduleRender(); });
    conf.addEventListener("dblclick", () => { conf.value = "95"; conf.dispatchEvent(new Event("input")); });
    const toggles = { trShowBand: "band", trShowPred: "pred", trShowBp: "bp", trShowPolicies: "policies", trShowYoy: "yoy", trLogY: "log", trEnableMk: "mk" };
    for (const [id, key] of Object.entries(toggles)) {
      const el = $(id);
      el.checked = !!T.opt[key];
      el.addEventListener("change", () => { T.opt[key] = el.checked; recompute(); });
    }
    $("trProjYear").value = T.opt.proj || "";

    gasSel.addEventListener("change", () => { T.gas = gasSel.value; fillSectors(); resetVerify(); hideCard(true); recompute(); });
    $("trSector").addEventListener("change", e => { T.sector = e.target.value; resetVerify(); hideCard(true); recompute(); });
    $("trMethod").addEventListener("change", e => { T.method = e.target.value; resetVerify(); recompute(); });
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
    $("trPinnedClear").addEventListener("click", () => { T.pins.clear(); hideCard(true); recompute(); });

    $("trCsvBtn").addEventListener("click", downloadCsv);
    $("trPngBtn").addEventListener("click", () => window.Plotly.downloadImage(T.gd, {
      format: "png", scale: 2, width: 1400, height: 760, filename: slug(`trend_${T.gas}_${T.sector}`),
    }));
    $("trLinkBtn").addEventListener("click", copyLink);
    $("trVerifyBtn").addEventListener("click", verifyOnServer);
    $("trAdvancedPanel").addEventListener("shown.bs.collapse", renderDiagnostics);

    document.addEventListener("keydown", e => {
      if (!$("tab-trend").classList.contains("active")) return;
      const el = e.target instanceof Element ? e.target : null;
      if ((el && el.closest("input, select, textarea, [contenteditable]")) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = { b: "breakpoint", z: "zoom" }[e.key.toLowerCase()];
      if (k) { setMode(k); e.preventDefault(); }
      if (e.key === "Escape") hideCard(true);
    });
  }

  function setMode(mode) {
    T.mode = mode;
    document.querySelectorAll("#trModes [data-mode]").forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (T.gd && T.gd.layout) window.Plotly.relayout(T.gd, { dragmode: DRAGMODE[mode] });
    $("trModeHint").innerHTML = {
      breakpoint: '<i class="bi bi-hand-index"></i> <b>Split the trend:</b> click a year to add a breakpoint, or drag a dashed line to move it. Click a ▲ policy marker under the chart to draw it as a line.',
      zoom: '<i class="bi bi-hand-index"></i> <b>Zoom in:</b> drag a box. Double-click the chart or press Reset view to zoom out.',
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

    // Breakpoints
    if (T.opt.bp && R.pw) R.pw.used.forEach(bp => shapes.push({
      type: "line", xref: "x", yref: "y domain", x0: bp, x1: bp, y0: 0, y1: 1,
      line: { color: "rgba(22,50,79,.75)", width: 2, dash: "dash" },
      label: { text: String(bp), textposition: "start", font: { size: 10, color: "#16324F" }, yanchor: "bottom" },
    }));

    // Policy markers (data/policies.csv): ▲ along the bottom of the chart; click one to pin it
    const inSpan = p => p.year >= R.x[0] && p.year <= R.x[R.x.length - 1];
    const pol = policies().filter(inSpan);
    if (T.opt.policies && pol.length) {
      const levels = [...new Set(pol.map(p => p.level))];
      levels.forEach(lv => {
        const ps = pol.filter(p => p.level === lv);
        traces.push({
          x: ps.map(p => p.year), y: ps.map(() => POLICY_Y), yaxis: "y3", type: "scatter", mode: "markers",
          marker: {
            symbol: "triangle-up", size: ps.map(p => T.pins.has(p.key) ? 15 : 12), color: POLICY_COLORS[lv] || "#666",
            line: { color: ps.map(p => T.pins.has(p.key) ? "#111" : "#fff"), width: ps.map(p => T.pins.has(p.key) ? 2 : 1) },
          },
          name: `▲ ${lv} policy`, text: ps.map(p => p.name), customdata: ps.map(p => p.key), meta: "policy",
          hovertemplate: `▲ %{text}  <i>(click to show on chart)</i><extra>${esc(lv)}</extra>`,
        });
      });
    }
    // Pinned policies: vertical lines with a label; hover one for its full description
    pinnedInView(inSpan).forEach(({ p, x }) => {
      const c = POLICY_COLORS[p.level] || "#666";
      shapes.push({
        type: "line", xref: "x", yref: "y domain", x0: x, x1: x, y0: 0.07, y1: 1,
        line: { color: c, width: 2, dash: "dot" }, layer: "above",
        label: { text: shortName(p.name), textposition: "end", textangle: -90, xanchor: "right",
          font: { size: 10, color: c }, padding: 4 },
      });
    });

    // Year-on-year change bars (not policies): % change in emissions from the year before
    if (yoy) {
      const xs = [], ys = [];
      for (let i = 1; i < R.x.length; i++) if (R.x[i] - R.x[i - 1] === 1 && R.y[i - 1] !== 0) {
        xs.push(R.x[i]); ys.push((R.y[i] / R.y[i - 1] - 1) * 100);
      }
      traces.push({
        x: xs, y: ys, type: "bar", yaxis: "y2", name: "Change from previous year (%)",
        marker: { color: ys.map(v => v <= 0 ? "rgba(0,132,61,.7)" : "rgba(192,57,43,.7)") },
        hovertemplate: "%{y:+.1f}% vs previous year<extra></extra>",
      });
      annotations.push({
        xref: "paper", yref: "y2 domain", x: 0.005, y: 1.12, xanchor: "left", yanchor: "bottom", showarrow: false,
        text: "<b>Change from previous year (%)</b>: green = emissions fell, red = rose",
        font: { size: 10, color: "#5f6b76" },
      });
    }

    const layout = {
      uirevision: T.gas + "|" + T.sector,
      margin: { l: 70, r: 18, t: 24, b: 70 },
      dragmode: DRAGMODE[T.mode],
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
      yaxis2: { domain: [0, 0.2], gridcolor: "#f2f5f7",
        zeroline: true, zerolinecolor: "#9aa7b3", ticksuffix: "%", visible: yoy, fixedrange: true },
      yaxis3: { overlaying: "y", range: [0, 1], visible: false, fixedrange: true },
      shapes, annotations,
    };
    return { traces, layout };
  }

  function render() {
    const { traces, layout } = buildFigure();
    // No Plotly toolbar: the tool buttons above the chart replace it
    window.Plotly.react(T.gd, traces, layout, { responsive: true, displayModeBar: false, scrollZoom: false });
    renderSide();
    if ($("trAdvancedPanel").classList.contains("show")) renderDiagnostics();
  }

  // ------------------------------------------------------------------
  // Policies: ▲ markers, pinned vertical lines, detail card with a link
  // to the Policy Timeline tab
  // ------------------------------------------------------------------
  const POLICY_Y = 0.035;                 // marker height on the hidden 0..1 axis (y3)
  let POLICY_LIST = null;
  function policies() {
    if (!POLICY_LIST) {
      const raw = typeof POLICIES_RAW !== "undefined" ? POLICIES_RAW : [];
      POLICY_LIST = raw.map(p => ({ ...p, key: `${p.year}|${p.name}` }));
    }
    return POLICY_LIST;
  }
  const policyByKey = k => policies().find(p => p.key === k);
  const shortName = s => s.length > 34 ? s.slice(0, 32).trimEnd() + "…" : s;
  /** Pinned policies inside the data span, with a small x offset when several share a year. */
  function pinnedInView(inSpan) {
    const perYear = {};
    return policies().filter(p => T.pins.has(p.key) && inSpan(p)).map(p => {
      const k = perYear[p.year] = (perYear[p.year] ?? -1) + 1;
      return { p, x: p.year + k * 0.22 };
    });
  }

  // Policy Timeline profiles that match a chart policy. Several profiles exist
  // per sector; the one for the sector being analysed is used when it exists.
  const PROFILE_MAP = [
    [/Emissions Trading System/i, { electricity: "capmf-eu-ets--electricity", industry: "capmf-eu-ets--industry", transport: "capmf-eu-ets--transport", _: "capmf-eu-ets--electricity" }],
    [/^Carbon Tax/i, { transport: "irl-p0005--transport", industry: "irl-p0005--industry", _: "irl-p0005--buildings" }],
    [/\(Amendment\) Act 2021/i, "capmf-act-2021--cross-sectoral"],
    [/Low Carbon Development Act 2015/i, "capmf-act-2015--cross-sectoral"],
    [/Carbon Budgets/i, "capmf-carbon-budgets--cross-sectoral"],
    [/Climate-Neutral Ireland/i, "capmf-net-zero--cross-sectoral"],
  ];
  function sectorKey() {
    const s = T.sector || "";
    if (/energy industries|electricity|power|heat production/i.test(s)) return "electricity";
    if (/transport|road|aviation|navigation|railway/i.test(s)) return "transport";
    if (/industr|manufactur|cement|chemical|mineral|metal/i.test(s)) return "industry";
    return "_";
  }
  function policyLink(p) {
    for (const [re, target] of PROFILE_MAP) if (re.test(p.name)) {
      const slugId = typeof target === "string" ? target : (target[sectorKey()] || target._);
      return { inApp: `#policy/policies/${slugId}/`, standalone: `/policy/policies/${slugId}/`, profile: true };
    }
    return { inApp: "#policy/timeline/", standalone: "/policy/timeline/", profile: false };
  }

  function togglePin(key) {
    if (T.pins.has(key)) T.pins.delete(key); else T.pins.add(key);
    recompute();
  }

  function ensureCard() {
    if (T.card) return T.card;
    const c = T.card = document.createElement("div");
    c.className = "tr-pcard"; c.hidden = true; c.setAttribute("role", "dialog");
    c.addEventListener("mouseenter", () => clearTimeout(T.cardTimer));
    c.addEventListener("mouseleave", () => { if (!c.dataset.sticky) hideCard(); });
    c.addEventListener("click", e => {
      const pin = e.target.closest("[data-pin]");
      if (pin) { togglePin(pin.dataset.pin); if (c.dataset.list) showList(c.dataset.list.split("\n"), null, true); else hideCard(true); return; }
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
  function policyCardHtml(p) {
    const link = policyLink(p), c = POLICY_COLORS[p.level] || "#666";
    const row = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "";
    return `<button type="button" class="pc-close" aria-label="Close">×</button>
      <h4>${esc(p.name)}</h4>
      <div class="pc-meta"><span class="pc-tag" style="background:${rgba(c, 0.15)};color:${c}"><b>${esc(p.level)}</b></span>
        <span class="pc-tag">${p.year}</span>${p.agency ? `<span class="pc-tag">${esc(p.agency)}</span>` : ""}</div>
      ${p.description ? `<div>${esc(p.description)}</div>` : ""}
      <dl>${row("Sector", p.sector)}${row("Type", p.type)}${row("Instrument", p.instrument)}${row("Direction", p.direction)}${row("Outcome", p.outcome)}</dl>
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
      c.style.setProperty("--pc", POLICY_COLORS[p.level] || "#666");
      placeCard(c, xPx);
    }
    const sameOpen = T.cardKey === key && !c.hidden;
    delete c.dataset.list;
    if (sticky) c.dataset.sticky = "1"; else if (!sameOpen) delete c.dataset.sticky;
    T.cardKey = key; c.hidden = false;
    T.gd.classList.add("tr-card-open");
  }
  /** Several policies share the clicked year: choose which to show as lines. */
  function showList(keys, xPx, keepPos) {
    const c = ensureCard();
    clearTimeout(T.cardTimer);
    const ps = keys.map(policyByKey).filter(Boolean);
    c.innerHTML = `<button type="button" class="pc-close" aria-label="Close">×</button>
      <h4>${ps.length} policies in ${ps[0].year}</h4>
      <div class="trend-hint mb-1">Choose which to draw on the chart. Hover a line for its full description.</div>
      <ul class="pc-list">${ps.map(p => `<li><span class="pc-dot" style="background:${POLICY_COLORS[p.level] || "#666"}"></span>
        <span class="flex-fill">${esc(p.name)}</span>
        <button type="button" class="btn btn-sm py-0 ${T.pins.has(p.key) ? "btn-success" : "btn-outline-secondary"}" data-pin="${esc(p.key)}">${T.pins.has(p.key) ? "Shown" : "Show"}</button></li>`).join("")}</ul>`;
    c.style.setProperty("--pc", "#16324F");
    if (!keepPos && xPx != null) placeCard(c, xPx);
    c.dataset.list = keys.join("\n"); c.dataset.sticky = "1";
    T.cardKey = null; c.hidden = false;
    T.gd.classList.add("tr-card-open");
  }
  function hideCard(now) {
    const c = T.card;
    if (!c || c.hidden) return;
    clearTimeout(T.cardTimer);
    const go = () => { c.hidden = true; T.cardKey = null; delete c.dataset.sticky; delete c.dataset.list; T.gd.classList.remove("tr-card-open"); };
    if (now) go(); else T.cardTimer = setTimeout(go, 350);
  }

  /** ▲ markers under the pointer (all policies of that year), or null. */
  function policyMarkerHit(cx, cy) {
    if (!T.opt.policies || !T.result || !T.result.x.length) return null;
    const fl = T.gd._fullLayout, ya3 = fl && fl.yaxis3;
    if (!ya3 || !ya3.c2p) return null;
    const rect = T.gd.getBoundingClientRect(), xa = fl.xaxis;
    const px = cx - rect.left, py = cy - rect.top;
    const my = ya3._offset + ya3.c2p(POLICY_Y);
    if (Math.abs(py - my) > 12) return null;
    const R = T.result, ps = policies().filter(p => p.year >= R.x[0] && p.year <= R.x[R.x.length - 1]);
    let best = null;
    for (const p of ps) {
      const d = Math.abs(xa._offset + xa.c2p(p.year) - px);
      if (d <= 9 && (!best || d < best.d)) best = { d, year: p.year, x: xa._offset + xa.c2p(p.year) };
    }
    return best && { year: best.year, xPx: best.x, keys: ps.filter(p => p.year === best.year).map(p => p.key) };
  }
  /** Pinned policy line under the pointer, or null. */
  function pinnedLineHit(cx, cy) {
    if (!T.pins.size || !T.result) return null;
    const g = plotGeom();
    if (!g) return null;
    const px = cx - g.rect.left, py = cy - g.rect.top;
    if (py < g.top || py > g.bot) return null;
    const R = T.result;
    let best = null;
    for (const { p, x } of pinnedInView(q => q.year >= R.x[0] && q.year <= R.x[R.x.length - 1])) {
      const lx = g.xa._offset + g.xa.c2p(x), d = Math.abs(lx - px);
      if (d <= 6 && (!best || d < best.d)) best = { d, key: p.key, xPx: lx };
    }
    return best;
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
      // ▲ policy marker: pin/unpin it (one policy) or list that year's policies
      const pm = policyMarkerHit(cx, cy);
      if (pm) {
        e.stopPropagation(); e.preventDefault();
        if (pm.keys.length === 1) {
          const k = pm.keys[0], pinning = !T.pins.has(k);
          togglePin(k);
          if (pinning) showCard(k, pm.xPx, true); else hideCard(true);
        } else showList(pm.keys, pm.xPx);
        return;
      }
      // pinned policy line: keep its card open so the link can be clicked
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
      if (e.target instanceof Node && gd.contains(e.target)) {
        if (T.card && T.card.contains(e.target)) return;
        const h = hit(e.clientX, e.clientY);
        const pm = !h && policyMarkerHit(e.clientX, e.clientY);
        gd.classList.toggle("tr-hot-ew", !!h);
        gd.classList.toggle("tr-hot-click", !!pm);
        // hovering a pinned policy line shows its full description
        const pl = !h && pinnedLineHit(e.clientX, e.clientY);
        if (pl) showCard(pl.key, pl.xPx, false);
        else if (T.card && !T.card.hidden && !T.card.dataset.sticky) hideCard();
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
    $("trPinnedBox").hidden = !T.pins.size;
    $("trPinnedCount").textContent = T.pins.size;

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
