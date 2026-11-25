/*
 * plot-style.js: Advanced Plot Settings for the Trend Analysis chart
 * ===================================================================
 * Visual configuration only: nothing here touches the data, the fits or the
 * statistics (stats.js). trend-chart.js reads TrendPlotStyle.get() while it
 * builds the Plotly figure and the HTML legend.
 *
 *   TrendPlotStyle.DEFAULTS     the chart's normal look
 *   TrendPlotStyle.PRESETS      Scientific publication, MATLAB style, Minimal, High contrast
 *   TrendPlotStyle.get()        the current style object (read-only by convention)
 *   TrendPlotStyle.mount(ctx)   builds the panel; ctx = {
 *        root,                    element the panel is drawn into
 *        onChange(),              redraw the chart (called live, or on Apply)
 *        getOpt(k) / setOpt(k,v), the Display switches shared with the sidebar
 *        dynamic(),               {segments:[{index,label}], breakpoints:[year],
 *                                  policies:[{key,name,color}], legend:[{key,label}]}
 *      }
 *   TrendPlotStyle.refresh()    re-draws the lists that depend on the chart
 *                               (segments, breakpoints, policies, legend entries)
 *
 * The current style is kept in the viewer's browser (localStorage) so it
 * survives a reload; named configurations can be saved there too, and any
 * style can be exported to / imported from a JSON file.
 */
(function (root) {
  "use strict";

  const LS_CURRENT = "inpact.trend.plotStyle.v1";
  const LS_SAVED = "inpact.trend.plotStyles.v1";

  // ------------------------------------------------------------------
  // Defaults reproduce the chart exactly as it looked before this panel
  // ------------------------------------------------------------------
  const PALETTES = {
    inpact: ["#1b6ca8", "#c0392b", "#2e8b57", "#8e44ad", "#d68910", "#16a085", "#7f8c8d", "#2c3e50"],
    matlab: ["#0072BD", "#D95319", "#EDB120", "#7E2F8E", "#77AC30", "#4DBEEE", "#A2142F", "#000000"],
    okabe: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#F0E442", "#000000"],
    tableau: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
    gray: ["#000000", "#555555", "#888888", "#aaaaaa", "#333333", "#777777", "#999999", "#bbbbbb"],
    contrast: ["#0033cc", "#d00000", "#007a00", "#000000", "#b35900", "#6a00b3", "#00838f", "#5c5c5c"],
  };
  const PALETTE_NAMES = [["inpact", "INPACT (default)"], ["matlab", "MATLAB"], ["okabe", "Okabe–Ito (colour-blind safe)"],
    ["tableau", "Tableau 10"], ["gray", "Greyscale"], ["contrast", "High contrast"]];

  const axisDefaults = (title, grid) => ({
    title: { text: title, family: "", size: 12, weight: "normal", style: "normal", color: "" },
    tick: { family: "", size: 11, weight: "normal", color: "", angle: "auto", dir: "", len: 5, dtick: null, vals: "", minor: false },
    range: { min: null, max: null },
    line: { show: false, color: "#2b3a48", width: 1 },
    grid: { show: grid, color: "#eef2f5", width: 1, dash: "solid", minor: false, minorColor: "#f4f6f8" },
    zeroline: false,
  });

  const DEFAULTS = {
    font: { family: "", size: 12, color: "#2b3a48" },
    figure: { plot: "#ffffff", paper: "#ffffff", paperTransparent: true, height: 540,
      margin: { l: 70, r: 18, t: 24, b: 44 }, box: false, boxColor: "#2b3a48", boxWidth: 1,
      title: { show: false, text: "", size: 15, weight: "bold" } },
    obs: {
      line: { show: true, color: "#3c3c3c", width: 1.2, dash: "solid", opacity: 0.45 },
      marker: { show: true, symbol: "circle", size: 6, color: "#3c3c3c", opacity: 1, edge: "#ffffff", edgeWidth: 0 },
    },
    trend: { palette: PALETTES.inpact.slice(), paletteName: "inpact", width: 2.6, dash: "solid", opacity: 1 },
    band: { color: "", opacity: 0.18 },          // "" = segment colour
    pred: { color: "", opacity: 0.08 },
    proj: { color: "#16324F", width: 2, dash: "dash", opacity: 1, bandColor: "#16324F", bandOpacity: 0.10 },
    bp: { color: "#16324F", width: 2, dash: "dash", opacity: 0.75,
      label: { show: true, family: "", size: 10, weight: "normal", color: "#16324F", position: "start", angle: 0 },
      hidden: [], hiddenLabel: [] },
    pol: { width: 2, coreDash: "dot", sectorDash: "dashdot", opacity: 1,
      label: { show: true, family: "", size: 10, weight: "normal", style: "normal", color: "", angle: -90,
        position: "end", anchor: "right", padding: 4, maxChars: 34 },
      per: {} },                                 // key -> {show, label, color, text}
    xaxis: axisDefaults("", true),
    yaxis: axisDefaults("kt CO₂-eq", true),
    legend: { show: true, position: "bottom", columns: 3, size: 12, color: "", bg: "#fafbfc", bgOpacity: 1,
      border: true, borderColor: "#d9e0e6", borderWidth: 1, gap: 0.9, labels: {}, omit: [] },
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  // deep merge that keeps only known keys with matching types (open maps allowed where noted)
  const OPEN_MAPS = new Set(["pol.per", "legend.labels"]);
  function merge(base, src, path = "") {
    const out = clone(base);
    if (!src || typeof src !== "object") return out;
    for (const k of Object.keys(src)) {
      const p = path ? `${path}.${k}` : k, v = src[k], d = base[k];
      if (OPEN_MAPS.has(p)) { if (v && typeof v === "object" && !Array.isArray(v)) out[k] = clone(v); continue; }
      if (!(k in base)) continue;
      if (Array.isArray(d)) { if (Array.isArray(v)) out[k] = v.slice(0, 50); continue; }
      if (d !== null && typeof d === "object") { out[k] = merge(d, v, p); continue; }
      if (d === null) { if (v === null || typeof v === "number") out[k] = v; continue; }
      if (typeof v === typeof d) out[k] = v;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Presets: each is a partial style laid over the defaults
  // ------------------------------------------------------------------
  const axisPub = { title: { color: "#000000", size: 13 }, tick: { color: "#000000", size: 12, dir: "inside", len: 6, minor: true },
    line: { show: true, color: "#000000", width: 1 }, grid: { show: false } };
  const PRESETS = {
    default: { label: "INPACT default", style: {} },
    publication: { label: "Scientific publication", style: {
      font: { family: "Times New Roman, Times, serif", size: 13, color: "#000000" },
      figure: { plot: "#ffffff", paper: "#ffffff", paperTransparent: false, box: true, boxColor: "#000000", boxWidth: 1 },
      obs: { line: { color: "#000000", width: 1, opacity: 0.5 }, marker: { symbol: "circle-open", size: 6, color: "#000000", edgeWidth: 0 } },
      trend: { palette: PALETTES.okabe.slice(), paletteName: "okabe", width: 2.2 },
      band: { opacity: 0.12 }, pred: { opacity: 0.06 },
      proj: { color: "#000000", bandColor: "#888888", bandOpacity: 0.12 },
      bp: { color: "#000000", width: 1.2, dash: "dash", opacity: 0.9, label: { color: "#000000", family: "Times New Roman, Times, serif" } },
      pol: { width: 1.4, label: { family: "Times New Roman, Times, serif", style: "italic", size: 10 } },
      xaxis: axisPub, yaxis: axisPub,
      legend: { bg: "#ffffff", border: true, borderColor: "#000000", borderWidth: 1, color: "#000000" },
    } },
    matlab: { label: "MATLAB style", style: {
      font: { family: "Helvetica, Arial, sans-serif", size: 12, color: "#262626" },
      figure: { plot: "#ffffff", paper: "#ffffff", paperTransparent: false, box: true, boxColor: "#262626", boxWidth: 0.75 },
      obs: { line: { color: "#0072BD", width: 0.75, opacity: 0.6 }, marker: { symbol: "circle", size: 5, color: "#0072BD" } },
      trend: { palette: PALETTES.matlab.slice(1).concat(["#0072BD"]), paletteName: "matlab", width: 2 },
      band: { opacity: 0.15 },
      proj: { color: "#262626" },
      bp: { color: "#262626", width: 1, dash: "dash", opacity: 1, label: { color: "#262626" } },
      xaxis: { tick: { dir: "inside", color: "#262626", minor: true }, line: { show: true, color: "#262626", width: 0.75 }, grid: { show: true, color: "#e6e6e6" } },
      yaxis: { tick: { dir: "inside", color: "#262626", minor: true }, line: { show: true, color: "#262626", width: 0.75 }, grid: { show: true, color: "#e6e6e6" } },
      legend: { bg: "#ffffff", border: true, borderColor: "#262626", borderWidth: 0.75 },
    } },
    minimal: { label: "Minimal", style: {
      obs: { line: { opacity: 0.3 }, marker: { size: 4, color: "#6b7785" } },
      trend: { width: 2 }, band: { opacity: 0.1 },
      bp: { opacity: 0.5, width: 1 }, pol: { width: 1.2, opacity: 0.8 },
      xaxis: { tick: { dir: "" }, grid: { show: false } },
      yaxis: { tick: { dir: "" }, grid: { show: true, color: "#f1f3f5" } },
      legend: { bg: "#ffffff", bgOpacity: 0, border: false, size: 11 },
    } },
    contrast: { label: "High contrast", style: {
      font: { size: 14, color: "#000000" },
      figure: { plot: "#ffffff", paper: "#ffffff", paperTransparent: false, box: true, boxColor: "#000000", boxWidth: 2 },
      obs: { line: { color: "#000000", width: 2, opacity: 1 }, marker: { size: 8, color: "#000000" } },
      trend: { palette: PALETTES.contrast.slice(), paletteName: "contrast", width: 4 },
      band: { opacity: 0.25 },
      proj: { color: "#000000", width: 3, bandColor: "#000000", bandOpacity: 0.15 },
      bp: { color: "#000000", width: 3, opacity: 1, label: { color: "#000000", size: 13, weight: "bold" } },
      pol: { width: 3, label: { size: 13, weight: "bold" } },
      xaxis: { title: { weight: "bold", color: "#000000", size: 14 }, tick: { color: "#000000", size: 13, weight: "bold" },
        line: { show: true, color: "#000000", width: 2 }, grid: { color: "#bdbdbd" } },
      yaxis: { title: { weight: "bold", color: "#000000", size: 14 }, tick: { color: "#000000", size: 13, weight: "bold" },
        line: { show: true, color: "#000000", width: 2 }, grid: { color: "#bdbdbd" } },
      legend: { size: 14, color: "#000000", bg: "#ffffff", border: true, borderColor: "#000000", borderWidth: 2 },
    } },
  };

  // ------------------------------------------------------------------
  // State and persistence (browser only; every access guarded)
  // ------------------------------------------------------------------
  let style = clone(DEFAULTS);
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  style = merge(DEFAULTS, lsGet(LS_CURRENT));

  const LS_PRESET = LS_CURRENT + ".preset";
  let ctx = null, live = true, dirty = false;
  let presetName = lsGet(LS_PRESET) || "default";    // which preset the current style came from
  const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) {
    const ks = p.split("."), last = ks.pop();
    const t = ks.reduce((a, k) => (a[k] = a[k] && typeof a[k] === "object" ? a[k] : {}), o);
    t[last] = v;
  }
  function changed() {
    lsSet(LS_CURRENT, style); lsSet(LS_PRESET, presetName);
    if (live) { ctx && ctx.onChange(); dirty = false; }
    else dirty = true;
    syncButtons();
  }
  function setStyle(next, label) {
    style = merge(DEFAULTS, next);
    presetName = label || "custom";
    if (ctx) { renderPanel(); }
    lsSet(LS_CURRENT, style); lsSet(LS_PRESET, presetName);
    ctx && ctx.onChange(); dirty = false; syncButtons();
  }

  // ------------------------------------------------------------------
  // Panel schema: tabs -> groups -> fields. "opt:" paths are the Display
  // switches shared with the sidebar (owned by trend-chart.js).
  // ------------------------------------------------------------------
  const DASHES = [["solid", "Solid ───"], ["dash", "Dashed – – –"], ["dot", "Dotted · · ·"], ["dashdot", "Dash-dot – · –"], ["longdash", "Long dash"]];
  const WEIGHTS = [["normal", "Normal"], ["bold", "Bold"]];
  const STYLES = [["normal", "Normal"], ["italic", "Italic"]];
  const FONTS = [["", "Page font (default)"], ["Segoe UI, Helvetica, Arial, sans-serif", "Sans-serif"],
    ["Helvetica, Arial, sans-serif", "Helvetica / Arial"], ["Times New Roman, Times, serif", "Times New Roman"],
    ["Georgia, serif", "Georgia"], ["Courier New, monospace", "Courier New (mono)"]];
  const SYMBOLS = [["circle", "● Circle"], ["circle-open", "○ Open circle"], ["square", "■ Square"], ["square-open", "□ Open square"],
    ["diamond", "◆ Diamond"], ["triangle-up", "▲ Triangle"], ["cross", "✚ Cross"], ["x", "✕ X"]];
  const TICKDIR = [["outside", "Outside"], ["inside", "Inside"], ["", "None"]];
  const ANGLES = [["auto", "Auto"], ["0", "0°"], ["-30", "−30°"], ["-45", "−45°"], ["-60", "−60°"], ["-90", "−90° (vertical)"], ["45", "45°"], ["90", "90°"]];

  const f = (type, path, label, extra) => ({ type, path, label, ...extra });
  const fontGroup = (p, title) => ({ title, fields: [
    f("select", `${p}.family`, "Font", { options: FONTS }), f("num", `${p}.size`, "Size", { min: 6, max: 32, step: 1, unit: "px" }),
    f("select", `${p}.weight`, "Weight", { options: WEIGHTS }), f("select", `${p}.style`, "Style", { options: STYLES }),
    f("colorAuto", `${p}.color`, "Colour"),
  ] });
  const axisTab = (ax, name) => ({ id: ax, title: `${name} axis`, icon: ax === "xaxis" ? "bi-arrows" : "bi-arrows-vertical", groups: [
    { title: "Title", fields: [f("text", `${ax}.title.text`, "Title text", { placeholder: ax === "xaxis" ? "e.g. Year" : "e.g. kt CO₂-eq" })] },
    fontGroup(`${ax}.title`, "Title font"),
    { title: "Tick labels", fields: [
      f("select", `${ax}.tick.family`, "Font", { options: FONTS }), f("num", `${ax}.tick.size`, "Size", { min: 6, max: 28, step: 1, unit: "px" }),
      f("select", `${ax}.tick.weight`, "Weight", { options: WEIGHTS }), f("colorAuto", `${ax}.tick.color`, "Colour"),
      f("select", `${ax}.tick.angle`, "Rotation", { options: ANGLES }),
    ] },
    { title: "Ticks", fields: [
      f("select", `${ax}.tick.dir`, "Direction", { options: TICKDIR, hint: "Plotly draws ticks on one side only." }),
      f("num", `${ax}.tick.len`, "Length", { min: 0, max: 20, step: 1, unit: "px" }),
      f("num", `${ax}.tick.dtick`, "Interval", { nullable: true, min: 0, step: ax === "xaxis" ? 1 : 100, placeholder: "auto" }),
      f("text", `${ax}.tick.vals`, "Custom positions", { placeholder: ax === "xaxis" ? "e.g. 1990, 2000, 2010, 2020" : "e.g. 5000, 10000, 15000" }),
      f("check", `${ax}.tick.minor`, "Minor ticks"),
    ] },
    { title: "Limits and scale", fields: [
      f("num", `${ax}.range.min`, "Minimum", { nullable: true, placeholder: "auto" }),
      f("num", `${ax}.range.max`, "Maximum", { nullable: true, placeholder: "auto" }),
      ...(ax === "yaxis" ? [f("selectOpt", "log", "Scale", { options: [["false", "Linear"], ["true", "Logarithmic"]] }),
        f("check", `${ax}.zeroline`, "Zero line")] : []),
    ] },
    { title: "Axis line", fields: [
      f("check", `${ax}.line.show`, "Show axis line"), f("color", `${ax}.line.color`, "Colour"),
      f("num", `${ax}.line.width`, "Width", { min: 0.5, max: 6, step: 0.25, unit: "px" }),
    ] },
    { title: "Gridlines", fields: [
      f("check", `${ax}.grid.show`, "Major gridlines"), f("color", `${ax}.grid.color`, "Colour"),
      f("num", `${ax}.grid.width`, "Width", { min: 0.5, max: 4, step: 0.25, unit: "px" }),
      f("select", `${ax}.grid.dash`, "Style", { options: DASHES.slice(0, 4) }),
      f("check", `${ax}.grid.minor`, "Minor gridlines"), f("color", `${ax}.grid.minorColor`, "Minor colour"),
    ] },
  ] });

  const TABS = [
    { id: "series", title: "Observed data", icon: "bi-graph-up", groups: [
      { title: "Line", fields: [
        f("check", "obs.line.show", "Show line"), f("color", "obs.line.color", "Colour"),
        f("num", "obs.line.width", "Width", { min: 0.25, max: 8, step: 0.25, unit: "px" }),
        f("select", "obs.line.dash", "Style", { options: DASHES }), f("range", "obs.line.opacity", "Opacity", { min: 0, max: 1, step: 0.05, pct: true }),
      ] },
      { title: "Markers", fields: [
        f("check", "obs.marker.show", "Show markers"), f("select", "obs.marker.symbol", "Symbol", { options: SYMBOLS }),
        f("num", "obs.marker.size", "Size", { min: 2, max: 20, step: 1, unit: "px" }), f("color", "obs.marker.color", "Colour"),
        f("range", "obs.marker.opacity", "Opacity", { min: 0, max: 1, step: 0.05, pct: true }),
        f("color", "obs.marker.edge", "Edge colour"), f("num", "obs.marker.edgeWidth", "Edge width", { min: 0, max: 4, step: 0.5, unit: "px" }),
      ] },
    ] },
    { id: "trend", title: "Trends & intervals", icon: "bi-bezier2", groups: [
      { title: "Trend lines", fields: [
        f("palette", "trend.palette", "Segment colours"),
        f("num", "trend.width", "Width", { min: 0.5, max: 8, step: 0.25, unit: "px" }),
        f("select", "trend.dash", "Style", { options: DASHES }), f("range", "trend.opacity", "Opacity", { min: 0.1, max: 1, step: 0.05, pct: true }),
      ] },
      { title: "Confidence band (mean)", fields: [
        f("checkOpt", "band", "Show"), f("colorAuto", "band.color", "Fill colour", { autoLabel: "Segment colour" }),
        f("range", "band.opacity", "Opacity", { min: 0, max: 0.8, step: 0.02, pct: true }),
      ] },
      { title: "Prediction interval", fields: [
        f("checkOpt", "pred", "Show"), f("colorAuto", "pred.color", "Fill colour", { autoLabel: "Segment colour" }),
        f("range", "pred.opacity", "Opacity", { min: 0, max: 0.8, step: 0.02, pct: true }),
      ] },
      { title: "Projection", fields: [
        f("color", "proj.color", "Line colour"), f("num", "proj.width", "Width", { min: 0.5, max: 8, step: 0.25, unit: "px" }),
        f("select", "proj.dash", "Style", { options: DASHES }), f("range", "proj.opacity", "Opacity", { min: 0.1, max: 1, step: 0.05, pct: true }),
        f("color", "proj.bandColor", "Interval fill"), f("range", "proj.bandOpacity", "Interval opacity", { min: 0, max: 0.8, step: 0.02, pct: true }),
      ] },
    ] },
    { id: "bp", title: "Breakpoints", icon: "bi-signpost-split", groups: [
      { title: "Lines", fields: [
        f("checkOpt", "bp", "Show breakpoint lines"), f("color", "bp.color", "Colour"),
        f("num", "bp.width", "Width", { min: 0.5, max: 8, step: 0.25, unit: "px" }),
        f("select", "bp.dash", "Style", { options: DASHES }), f("range", "bp.opacity", "Opacity", { min: 0.1, max: 1, step: 0.05, pct: true }),
      ] },
      { title: "Year labels", fields: [
        f("check", "bp.label.show", "Show years"), f("select", "bp.label.family", "Font", { options: FONTS }),
        f("num", "bp.label.size", "Size", { min: 6, max: 24, step: 1, unit: "px" }), f("select", "bp.label.weight", "Weight", { options: WEIGHTS }),
        f("color", "bp.label.color", "Colour"),
        f("select", "bp.label.position", "Position", { options: [["start", "Bottom"], ["middle", "Middle"], ["end", "Top"]] }),
        f("select", "bp.label.angle", "Rotation", { options: [["0", "Horizontal"], ["-90", "Vertical"]] }),
      ] },
      { title: "Individual breakpoints", dynamic: "breakpoints" },
    ] },
    { id: "pol", title: "Policy overlays", icon: "bi-flag", groups: [
      { title: "All policy lines", fields: [
        f("num", "pol.width", "Width", { min: 0.5, max: 8, step: 0.25, unit: "px" }),
        f("select", "pol.coreDash", "Core policy style", { options: DASHES }),
        f("select", "pol.sectorDash", "Sector policy style", { options: DASHES }),
        f("range", "pol.opacity", "Opacity", { min: 0.1, max: 1, step: 0.05, pct: true }),
      ] },
      { title: "Annotations", fields: [
        f("check", "pol.label.show", "Show labels"), f("select", "pol.label.family", "Font", { options: FONTS }),
        f("num", "pol.label.size", "Size", { min: 6, max: 24, step: 1, unit: "px" }),
        f("select", "pol.label.weight", "Weight", { options: WEIGHTS }), f("select", "pol.label.style", "Style", { options: STYLES }),
        f("colorAuto", "pol.label.color", "Colour", { autoLabel: "Line colour" }),
        f("select", "pol.label.angle", "Orientation", { options: [["-90", "Vertical"], ["0", "Horizontal"], ["-45", "Diagonal"]] }),
        f("select", "pol.label.position", "Position", { options: [["end", "Top"], ["middle", "Middle"], ["start", "Bottom"]] }),
        f("select", "pol.label.anchor", "Alignment", { options: [["right", "Left of line"], ["center", "On the line"], ["left", "Right of line"]] }),
        f("num", "pol.label.padding", "Offset", { min: 0, max: 40, step: 1, unit: "px" }),
        f("num", "pol.label.maxChars", "Max length", { min: 8, max: 120, step: 1, unit: "chars" }),
      ] },
      { title: "Individual policies", dynamic: "policies" },
    ] },
    axisTab("xaxis", "X"),
    axisTab("yaxis", "Y"),
    { id: "legend", title: "Legend", icon: "bi-list-ul", groups: [
      { title: "Layout", fields: [
        f("check", "legend.show", "Show legend"),
        f("select", "legend.position", "Position", { options: [["bottom", "Below the chart"], ["top", "Above the chart"], ["right", "Right of the chart"],
          ["inside-tr", "Inside, top right"], ["inside-tl", "Inside, top left"], ["inside-br", "Inside, bottom right"], ["inside-bl", "Inside, bottom left"]] }),
        f("num", "legend.columns", "Columns", { min: 1, max: 4, step: 1 }),
        f("range", "legend.gap", "Item spacing", { min: 0.2, max: 2, step: 0.1, unit: "rem" }),
      ] },
      { title: "Text", fields: [f("num", "legend.size", "Font size", { min: 8, max: 20, step: 1, unit: "px" }), f("colorAuto", "legend.color", "Colour")] },
      { title: "Box", fields: [
        f("color", "legend.bg", "Background"), f("range", "legend.bgOpacity", "Background opacity", { min: 0, max: 1, step: 0.05, pct: true }),
        f("check", "legend.border", "Border"), f("color", "legend.borderColor", "Border colour"),
        f("num", "legend.borderWidth", "Border width", { min: 0, max: 4, step: 0.25, unit: "px" }),
      ] },
      { title: "Entries", dynamic: "legend" },
    ] },
    { id: "figure", title: "Figure", icon: "bi-aspect-ratio", groups: [
      { title: "Title", fields: [f("check", "figure.title.show", "Show title"),
        f("text", "figure.title.text", "Text", { placeholder: "Defaults to gas and sector" }),
        f("num", "figure.title.size", "Size", { min: 8, max: 32, step: 1, unit: "px" }), f("select", "figure.title.weight", "Weight", { options: WEIGHTS })] },
      { title: "Colours", fields: [
        f("color", "figure.plot", "Plot background"), f("color", "figure.paper", "Figure background"),
        f("check", "figure.paperTransparent", "Transparent figure background"),
        f("color", "font.color", "Default text colour"),
      ] },
      { title: "Size and margins", fields: [
        f("num", "figure.height", "Height", { min: 280, max: 1200, step: 10, unit: "px" }),
        f("num", "figure.margin.l", "Left margin", { min: 0, max: 200, step: 2, unit: "px" }),
        f("num", "figure.margin.r", "Right margin", { min: 0, max: 200, step: 2, unit: "px" }),
        f("num", "figure.margin.t", "Top margin", { min: 0, max: 200, step: 2, unit: "px" }),
        f("num", "figure.margin.b", "Bottom margin", { min: 0, max: 200, step: 2, unit: "px" }),
      ] },
      { title: "Plot border", fields: [f("check", "figure.box", "Box around the plot"), f("color", "figure.boxColor", "Colour"),
        f("num", "figure.boxWidth", "Width", { min: 0.5, max: 6, step: 0.25, unit: "px" })] },
      { title: "Fonts", fields: [f("select", "font.family", "Font family", { options: FONTS }),
        f("num", "font.size", "Base size", { min: 8, max: 24, step: 1, unit: "px" })] },
    ] },
  ];

  // ------------------------------------------------------------------
  // Rendering helpers
  // ------------------------------------------------------------------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let uid = 0;
  function fieldHtml(fd) {
    const id = `ps_${++uid}`;
    const lab = `<label for="${id}">${esc(fd.label)}</label>`;
    const hint = fd.hint ? `<small class="ps-hint">${esc(fd.hint)}</small>` : "";
    const v = getPath(style, fd.path);
    switch (fd.type) {
      case "check":
        return `<div class="ps-f ps-check"><input type="checkbox" class="form-check-input" id="${id}" data-ps="${fd.path}" data-t="check" ${v ? "checked" : ""}>${lab}</div>`;
      case "checkOpt":
        return `<div class="ps-f ps-check"><input type="checkbox" class="form-check-input" id="${id}" data-opt="${fd.path}" data-t="check" ${ctx.getOpt(fd.path) ? "checked" : ""}>${lab}</div>`;
      case "selectOpt":
        return `<div class="ps-f">${lab}<select class="form-select form-select-sm" id="${id}" data-opt="${fd.path}" data-t="bool">${fd.options.map(([o, t]) =>
          `<option value="${o}"${String(!!ctx.getOpt(fd.path)) === o ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></div>`;
      case "color":
        return `<div class="ps-f">${lab}<span class="ps-color"><input type="color" id="${id}" data-ps="${fd.path}" data-t="color" value="${esc(v || "#000000")}"><code>${esc(v)}</code></span>${hint}</div>`;
      case "colorAuto": {
        const auto = !v;
        return `<div class="ps-f">${lab}<span class="ps-color"><input type="color" id="${id}" data-ps="${fd.path}" data-t="color" value="${esc(v || "#2b3a48")}"${auto ? ' class="is-auto"' : ""}>
          <button type="button" class="ps-auto${auto ? " on" : ""}" data-auto="${fd.path}" title="Use the automatic colour">${esc(fd.autoLabel || "Auto")}</button></span></div>`;
      }
      case "num":
        return `<div class="ps-f">${lab}<span class="ps-num"><input type="number" class="form-control form-control-sm" id="${id}" data-ps="${fd.path}"
          data-t="${fd.nullable ? "numNull" : "num"}" value="${v == null ? "" : v}"${fd.min != null ? ` min="${fd.min}"` : ""}${fd.max != null ? ` max="${fd.max}"` : ""}
          step="${fd.step || "any"}"${fd.placeholder ? ` placeholder="${esc(fd.placeholder)}"` : ""}>${fd.unit ? `<small>${esc(fd.unit)}</small>` : ""}</span>${hint}</div>`;
      case "range": {
        const out = fd.pct ? `${Math.round(v * 100)}%` : `${v}${fd.unit || ""}`;
        return `<div class="ps-f">${lab}<span class="ps-range"><input type="range" class="form-range" id="${id}" data-ps="${fd.path}" data-t="num"
          min="${fd.min}" max="${fd.max}" step="${fd.step}" value="${v}" data-pct="${fd.pct ? 1 : ""}" data-unit="${esc(fd.unit || "")}"><output>${out}</output></span></div>`;
      }
      case "select":
        return `<div class="ps-f">${lab}<select class="form-select form-select-sm" id="${id}" data-ps="${fd.path}" data-t="${typeof v === "number" ? "num" : "str"}">${fd.options.map(([o, t]) =>
          `<option value="${esc(o)}"${String(v) === String(o) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>${hint}</div>`;
      case "text":
        return `<div class="ps-f ps-wide">${lab}<input type="text" class="form-control form-control-sm" id="${id}" data-ps="${fd.path}" data-t="str" value="${esc(v)}"
          placeholder="${esc(fd.placeholder || "")}"></div>`;
      case "palette":
        return `<div class="ps-f ps-wide"><label>${esc(fd.label)}</label><div class="ps-palette">
          <select class="form-select form-select-sm" data-palette="1" aria-label="Colour palette">${PALETTE_NAMES.map(([k, t]) =>
            `<option value="${k}"${style.trend.paletteName === k ? " selected" : ""}>${esc(t)}</option>`).join("")}<option value="custom"${style.trend.paletteName === "custom" ? " selected" : ""}>Custom</option></select>
          <span class="ps-swatches">${style.trend.palette.slice(0, 8).map((c, i) =>
            `<input type="color" value="${esc(c)}" data-pal="${i}" title="Segment ${i + 1}" aria-label="Colour of trend segment ${i + 1}">`).join("")}</span></div></div>`;
      default: return "";
    }
  }

  // lists that depend on the chart: rebuilt only when their contents change
  const lastSig = {};
  function dynamicHtml(kind) {
    const d = ctx.dynamic();
    if (kind === "breakpoints") {
      if (!d.breakpoints.length) return `<p class="ps-empty">No breakpoints on the chart. Add one with <b>Split the trend</b>.</p>`;
      return `<table class="ps-table"><thead><tr><th>Year</th><th>Line</th><th>Label</th></tr></thead><tbody>${d.breakpoints.map(y => `<tr><td><b>${y}</b></td>
        <td><input type="checkbox" class="form-check-input" data-bpline="${y}" ${style.bp.hidden.includes(y) ? "" : "checked"} aria-label="Show breakpoint ${y} line"></td>
        <td><input type="checkbox" class="form-check-input" data-bplabel="${y}" ${style.bp.hiddenLabel.includes(y) ? "" : "checked"} aria-label="Show breakpoint ${y} label"></td></tr>`).join("")}</tbody></table>`;
    }
    if (kind === "policies") {
      if (!d.policies.length) return `<p class="ps-empty">No policy lines on the chart. Tick policies in the <b>Policy overlay</b> panel.</p>`;
      return `<table class="ps-table"><thead><tr><th>Policy</th><th>Line</th><th>Label</th><th>Colour</th><th>Label text</th></tr></thead><tbody>${d.policies.map(p => {
        const o = style.pol.per[p.key] || {};
        return `<tr><td class="ps-name" title="${esc(p.name)}">${esc(p.name)}</td>
          <td><input type="checkbox" class="form-check-input" data-per="${esc(p.key)}" data-prop="show" ${o.show === false ? "" : "checked"} aria-label="Show line"></td>
          <td><input type="checkbox" class="form-check-input" data-per="${esc(p.key)}" data-prop="label" ${o.label === false ? "" : "checked"} aria-label="Show label"></td>
          <td><span class="ps-color"><input type="color" data-per="${esc(p.key)}" data-prop="color" value="${esc(o.color || p.color)}" aria-label="Line colour">
            <button type="button" class="ps-auto${o.color ? "" : " on"}" data-perauto="${esc(p.key)}" title="Use the group colour">Group</button></span></td>
          <td><input type="text" class="form-control form-control-sm" data-per="${esc(p.key)}" data-prop="text" value="${esc(o.text || "")}" placeholder="${esc(p.name.slice(0, 30))}"></td></tr>`;
      }).join("")}</tbody></table>`;
    }
    if (kind === "legend") {
      if (!d.legend.length) return `<p class="ps-empty">The legend is empty.</p>`;
      return `<table class="ps-table"><thead><tr><th>Entry</th><th>Show</th><th>Custom label</th></tr></thead><tbody>${d.legend.map(e => `<tr>
        <td class="ps-name">${esc(e.label)}</td>
        <td><input type="checkbox" class="form-check-input" data-lgomit="${esc(e.key)}" ${style.legend.omit.includes(e.key) ? "" : "checked"} aria-label="Show this entry in the legend"></td>
        <td><input type="text" class="form-control form-control-sm" data-lglabel="${esc(e.key)}" value="${esc(style.legend.labels[e.key] || "")}" placeholder="${esc(e.label)}"></td></tr>`).join("")}</tbody></table>`;
    }
    return "";
  }
  function refresh() {
    if (!ctx || !ctx.root.querySelector(".ps-body")) return;
    const d = ctx.dynamic();
    const sigs = { breakpoints: d.breakpoints.join(","), policies: d.policies.map(p => p.key).join("\n"), legend: d.legend.map(e => e.key + e.label).join("\n") };
    ctx.root.querySelectorAll("[data-dyn]").forEach(box => {
      const k = box.dataset.dyn;
      if (lastSig[k] === sigs[k] && box.innerHTML) return;
      if (box.contains(document.activeElement) && document.activeElement.type === "text") return;  // don't steal focus mid-typing
      lastSig[k] = sigs[k];
      box.innerHTML = dynamicHtml(k);
    });
  }

  let activeTab = "series";
  function renderPanel() {
    const r = ctx.root;
    uid = 0; for (const k of Object.keys(lastSig)) delete lastSig[k];
    const saved = lsGet(LS_SAVED) || {};
    r.innerHTML = `
      <div class="ps-bar">
        <label class="ps-bar-item">Preset
          <select class="form-select form-select-sm" data-preset="1">${presetName === "custom" ? `<option value="" selected>Custom</option>` : ""}${Object.entries(PRESETS).map(([k, p]) =>
            `<option value="${k}"${presetName === k ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
        <span class="ps-bar-item form-check form-switch m-0"><input class="form-check-input" type="checkbox" id="psLive" ${live ? "checked" : ""}>
          <label class="form-check-label" for="psLive">Live preview</label></span>
        <button type="button" class="btn btn-success btn-sm" data-act="apply" ${live ? "disabled" : ""}><i class="bi bi-check2"></i> Apply</button>
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="reset"><i class="bi bi-arrow-counterclockwise"></i> Reset to default</button>
        <span class="ps-bar-sep"></span>
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="save"><i class="bi bi-bookmark-plus"></i> Save</button>
        <select class="form-select form-select-sm ps-load" data-load="1" aria-label="Load a saved configuration">
          <option value="">Load saved…</option>${Object.keys(saved).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="delete" title="Delete the selected saved configuration" ${Object.keys(saved).length ? "" : "disabled"}><i class="bi bi-trash"></i></button>
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="export"><i class="bi bi-filetype-json"></i> Export</button>
        <button type="button" class="btn btn-outline-secondary btn-sm" data-act="import"><i class="bi bi-upload"></i> Import</button>
        <input type="file" accept="application/json,.json" hidden data-importfile="1">
        <span class="ps-status" role="status" aria-live="polite"></span>
      </div>
      <div class="ps-body">
        <nav class="ps-tabs" role="tablist" aria-label="Plot settings sections">${TABS.map(t =>
          `<button type="button" role="tab" class="ps-tab${t.id === activeTab ? " active" : ""}" data-pstab="${t.id}" aria-selected="${t.id === activeTab}">
            <i class="bi ${t.icon}"></i><span>${esc(t.title)}</span></button>`).join("")}</nav>
        <div class="ps-panes">${TABS.map(t => `<section class="ps-pane" data-pane="${t.id}" role="tabpanel"${t.id === activeTab ? "" : " hidden"}>
          ${t.groups.map(g => `<fieldset class="ps-group${g.dynamic ? " ps-group-wide" : ""}"><legend>${esc(g.title)}</legend>
            ${g.dynamic ? `<div data-dyn="${g.dynamic}"></div>` : `<div class="ps-grid">${g.fields.map(fieldHtml).join("")}</div>`}</fieldset>`).join("")}
        </section>`).join("")}</div>
      </div>`;
    refresh();
    syncButtons();
  }
  function syncButtons() {
    if (!ctx) return;
    const a = ctx.root.querySelector('[data-act="apply"]');
    if (a) { a.disabled = live || !dirty; a.classList.toggle("btn-success", !live && dirty); a.classList.toggle("btn-outline-success", live || !dirty); }
  }
  function status(msg) {
    const s = ctx.root.querySelector(".ps-status");
    if (!s) return;
    s.textContent = msg; clearTimeout(status.t); status.t = setTimeout(() => { s.textContent = ""; }, 2600);
  }
  const markCustom = () => {
    if (presetName === "custom") return;
    presetName = "custom";
    const sel = ctx.root.querySelector("[data-preset]");
    if (sel && !sel.querySelector('option[value=""]')) sel.insertAdjacentHTML("afterbegin", `<option value="">Custom</option>`);
    if (sel) sel.value = "";
  };

  // ------------------------------------------------------------------
  // Events (delegated)
  // ------------------------------------------------------------------
  function onInput(e) {
    const el = e.target;
    // shared Display switches
    if (el.dataset.opt) {
      ctx.setOpt(el.dataset.opt, el.dataset.t === "bool" ? el.value === "true" : el.checked);
      return;
    }
    if (el.dataset.pal != null) {
      style.trend.palette[+el.dataset.pal] = el.value; style.trend.paletteName = "custom";
      const sel = ctx.root.querySelector("[data-palette]"); if (sel) sel.value = "custom";
      markCustom(); return changed();
    }
    if (el.dataset.per) {
      const o = style.pol.per[el.dataset.per] = style.pol.per[el.dataset.per] || {};
      const prop = el.dataset.prop;
      o[prop] = el.type === "checkbox" ? el.checked : el.value;
      if (prop === "color") { const b = el.parentElement.querySelector(".ps-auto"); if (b) b.classList.remove("on"); }
      markCustom(); return changed();
    }
    if (el.dataset.bpline || el.dataset.bplabel) {
      const key = el.dataset.bpline ? "hidden" : "hiddenLabel", y = +(el.dataset.bpline || el.dataset.bplabel);
      const s = new Set(style.bp[key]); if (el.checked) s.delete(y); else s.add(y);
      style.bp[key] = [...s]; markCustom(); return changed();
    }
    if (el.dataset.lgomit) {
      const s = new Set(style.legend.omit); if (el.checked) s.delete(el.dataset.lgomit); else s.add(el.dataset.lgomit);
      style.legend.omit = [...s]; markCustom(); return changed();
    }
    if (el.dataset.lglabel) {
      if (el.value.trim()) style.legend.labels[el.dataset.lglabel] = el.value; else delete style.legend.labels[el.dataset.lglabel];
      markCustom(); return changed();
    }
    const p = el.dataset.ps;
    if (!p) return;
    let v;
    switch (el.dataset.t) {
      case "check": v = el.checked; break;
      case "num": v = parseFloat(el.value); if (!Number.isFinite(v)) return; break;
      case "numNull": v = el.value.trim() === "" ? null : parseFloat(el.value); if (v !== null && !Number.isFinite(v)) return; break;
      case "color": v = el.value; el.classList.remove("is-auto");
        { const b = el.parentElement.querySelector(".ps-auto"); if (b) b.classList.remove("on"); const c = el.parentElement.querySelector("code"); if (c) c.textContent = v; } break;
      default: v = el.value;
    }
    if (el.type === "range") {
      const o = el.parentElement.querySelector("output");
      if (o) o.textContent = el.dataset.pct ? `${Math.round(v * 100)}%` : `${v}${el.dataset.unit}`;
    }
    setPath(style, p, v);
    markCustom();
    changed();
  }
  function onClick(e) {
    const t = e.target.closest("[data-pstab],[data-act],[data-auto],[data-perauto]");
    if (!t) return;
    if (t.dataset.pstab) {
      activeTab = t.dataset.pstab;
      ctx.root.querySelectorAll("[data-pstab]").forEach(b => { const on = b === t; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
      ctx.root.querySelectorAll("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== activeTab; });
      refresh();
      return;
    }
    if (t.dataset.auto) {
      setPath(style, t.dataset.auto, ""); t.classList.add("on");
      const c = t.parentElement.querySelector("input[type=color]"); if (c) c.classList.add("is-auto");
      markCustom(); return changed();
    }
    if (t.dataset.perauto) {
      const o = style.pol.per[t.dataset.perauto] = style.pol.per[t.dataset.perauto] || {};
      delete o.color; t.classList.add("on"); markCustom(); return changed();
    }
    const act = t.dataset.act;
    if (act === "apply") { ctx.onChange(); dirty = false; syncButtons(); status("Applied."); }
    if (act === "reset") { setStyle(DEFAULTS, "default"); status("Default appearance restored."); }
    if (act === "save") {
      const name = (window.prompt("Name for this configuration:", "My chart style") || "").trim().slice(0, 60);
      if (!name) return;
      const saved = lsGet(LS_SAVED) || {}; saved[name] = style; lsSet(LS_SAVED, saved);
      renderPanel(); status(`Saved “${name}” in this browser.`);
    }
    if (act === "delete") {
      const sel = ctx.root.querySelector("[data-load]"), name = sel && sel.value;
      if (!name) { status("Choose a saved configuration first."); return; }
      const saved = lsGet(LS_SAVED) || {}; delete saved[name]; lsSet(LS_SAVED, saved);
      renderPanel(); status(`Deleted “${name}”.`);
    }
    if (act === "export") {
      const blob = new Blob([JSON.stringify({ app: "INPACT Trend Analysis", kind: "plot-style", version: 1, style }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "inpact-trend-plot-settings.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      status("Settings exported as JSON.");
    }
    if (act === "import") ctx.root.querySelector("[data-importfile]").click();
  }
  function onChangeEvt(e) {
    const el = e.target;
    if (el.dataset.preset) {
      if (!el.value) return;
      // a preset changes the overall look; choices made for individual items are kept
      const next = merge(DEFAULTS, PRESETS[el.value].style);
      next.pol.per = clone(style.pol.per);
      next.legend.labels = clone(style.legend.labels); next.legend.omit = style.legend.omit.slice();
      next.bp.hidden = style.bp.hidden.slice(); next.bp.hiddenLabel = style.bp.hiddenLabel.slice();
      setStyle(next, el.value); status(`Preset: ${PRESETS[el.value].label}.`);
      return;
    }
    if (el.dataset.palette) {
      if (el.value !== "custom") { style.trend.palette = PALETTES[el.value].slice(); style.trend.paletteName = el.value; markCustom(); renderPanel(); changed(); }
      return;
    }
    if (el.dataset.load) {
      const saved = lsGet(LS_SAVED) || {};
      if (el.value && saved[el.value]) { const n = el.value; setStyle(saved[n], "custom"); status(`Loaded “${n}”.`); }
      return;
    }
    if (el.dataset.importfile) {
      const file = el.files && el.files[0];
      if (!file) return;
      file.text().then(txt => {
        const j = JSON.parse(txt);
        if (!j || (j.kind && j.kind !== "plot-style")) throw new Error("not a plot settings file");
        setStyle(j.style || j, "custom"); status(`Imported ${file.name}.`);
      }).catch(err => status(`Could not import: ${err.message}.`)).finally(() => { el.value = ""; });
      return;
    }
    if (el.id === "psLive") { live = el.checked; if (live && dirty) { ctx.onChange(); dirty = false; } syncButtons(); return; }
    // number fields, text fields and selects commit on change as well as input
    onInput(e);
  }

  function mount(c) {
    ctx = c;
    renderPanel();
    // "input" gives live updates while dragging or typing; "change" handles selects,
    // switches and the file/preset/load controls (both paths are idempotent)
    c.root.addEventListener("input", e => {
      const t = e.target;
      if (t.type === "file" || t.dataset.preset || t.dataset.load || t.dataset.palette || t.id === "psLive") return;
      onInput(e);
    });
    c.root.addEventListener("change", e => {
      const t = e.target;
      if (t.type === "text" || t.type === "number" || t.type === "range" || t.type === "color") return;
      onChangeEvt(e);
    });
    c.root.addEventListener("click", onClick);
  }

  root.TrendPlotStyle = { DEFAULTS, PRESETS, PALETTES, get: () => style, mount, refresh, merge };
})(typeof window !== "undefined" ? window : globalThis);
