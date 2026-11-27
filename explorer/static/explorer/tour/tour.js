/* =====================================================================
   INPACT Explorer: in-app guided walkthroughs
   ---------------------------------------------------------------------
   A step-by-step tour that dims the dashboard, puts a spotlight on the
   control being explained and shows a short professional description in
   a card beside it. Each step can be done by the viewer (the spotlight is
   a hole, so the real control is usable) or with "Do it for me", which
   performs the step on the dashboard.

   Works on the main dashboard (controls in the page and inside the
   Spatial Mapping frame, /map/?embed=1, same origin) and on /map/ opened
   on its own. Inside the frame (map-embed) it does nothing: the parent
   page runs the tour.

   Tours are defined in TOURS below. A step:
     id, phase, title, text (HTML), tip / warn (HTML), summary (one line for the User Guide outline)
     where   : "page" (dashboard) or "map" (Spatial Mapping workspace)
     pageOnly: skip on /map/ opened on its own
     target  : selector, list of selectors or fn(ctx) -> Element(s); none = centred card
     place   : preferred card side: "right" | "left" | "bottom" | "top" (or a function returning one)
     prepare : async fn(ctx) run before the step is shown (open a section…)
     task    : what the viewer should do (shown with a tick when done)
     done    : fn(ctx) -> true once the step's task is complete
     auto    : async fn(ctx) that performs the step ("Do it for me")
     autoLabel, noReplay (not repeated when a tour is started mid-way, e.g. downloads)
     skip    : true leaves the step out (kept for later)

   Launch: window.inpactTour.start(id, stepIndex), [data-tour-start="id"]
   (optional data-tour-step), [data-tour-picker]. [data-tour-outline="id"]
   is filled with the tour's steps as text (User Guide).
   Progress is kept in this browser only (localStorage).
   ===================================================================== */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-embed")) return;          // the dashboard around the frame runs tours
  const STANDALONE = root.classList.contains("map-standalone");
  const STORE_POS = "inpact.tour.pos", STORE_DONE = "inpact.tour.done", STORE_NUDGE = "inpact.tour.nudged";
  const STORE_DELAY = "inpact.tour.delay", STORE_DL = "inpact.tour.playDownloads";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, timeout = 9000, every = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) { /* not ready yet */ }
      await sleep(every);
    }
    return null;
  }
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- The Spatial Mapping workspace (frame or this page) ---------- */
  const frameEl = () => (STANDALONE ? null : document.getElementById("smFrame"));
  function mapDoc() {
    if (STANDALONE) return document;
    const f = frameEl();
    try {
      const d = f && f.contentDocument;
      return d && d.getElementById("msSteps") && d.readyState !== "loading" ? d : null;
    } catch (e) { return null; }
  }
  const tabActive = name => { const p = document.getElementById("tab-" + name); return !!(p && p.classList.contains("active")); };
  async function ensureMapping() {
    if (!STANDALONE && !tabActive("mapping") && typeof window.activateTab === "function") {
      if (!location.hash.startsWith("#mapping")) history.replaceState(null, "", location.pathname + location.search + "#mapping/RasterLayer");
      window.activateTab("mapping");
    }
    const d = await waitFor(mapDoc, 20000);
    if (!d) throw new Error("The Spatial Mapping workspace did not load. Please check your connection and try again.");
    if (!STANDALONE && window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });   // the workspace fills the screen
    // Raster Layer view (not Air Quality), and the layer panel open
    const ras = d.getElementById("msMapping");
    if (ras && ras.getAttribute("aria-pressed") !== "true") { ras.click(); await sleep(300); }
    return d;
  }

  /* Helpers handed to the steps (ctx) */
  function fire(el, type) {
    const W = el.ownerDocument.defaultView || window;
    el.dispatchEvent(new W.Event(type, { bubbles: true }));
  }
  const ctx = {
    doc: mapDoc,
    q(sel) { const d = mapDoc(); return d ? d.querySelector(sel) : null; },
    page(sel) { return document.querySelector(sel); },
    wait: waitFor,
    sleep,
    // Open a numbered step of the map's left panel (its header button) if it is folded
    async openStep(btnId) {
      const b = await waitFor(() => ctx.q("#" + btnId));
      if (b && b.getAttribute("aria-expanded") !== "true") { b.click(); await sleep(260); }
    },
    async click(sel) {
      const el = await waitFor(() => { const e = ctx.q(sel); return e && !e.disabled && e; });
      if (!el) throw new Error("This control is not available yet. Complete the previous steps first.");
      el.click(); await sleep(200); return el;
    },
    // Choose an option of a drop-down by value or label, once it is enabled and filled
    async select(sel, val) {
      const match = e => [...e.options].find(o => o.value === val || o.textContent.trim() === val);
      const el = await waitFor(() => { const e = ctx.q(sel); return e && !e.disabled && match(e) && e; }, 12000);
      if (!el) throw new Error("The list is still loading or this option is not available. Please try again in a moment.");
      el.value = match(el).value; fire(el, "input"); fire(el, "change"); await sleep(250);
    },
    pressed: sel => { const e = ctx.q(sel); return !!e && (e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-pressed") === "true"); },
    fire
  };

  // The layer selected in the left panel is in the time series plot: its "Add to plot" button then
  // reads "Already in the plot" (a layer of another gas, or none, does not count)
  const inPlot = c => { const b = c.q("#tsAdd"); return !!b && /already/i.test(b.textContent); };
  // Time series analysis on (the tab above step 1 works as a switch: clicking it when ON closes it)
  const tsOn = c => c.pressed("#msTabTs");
  // The menu: floating cards on the landing banner, a rail on the left once a section is open (768 px and
  // wider), or the fold-away menu on phones. menuPrep shows it; menuSide puts the card beside it.
  const railOn = () => root.classList.contains("hdr-shrinkable") && window.innerWidth >= 768;
  const menuSide = () => (railOn() ? "right" : "bottom");
  async function menuPrep() {
    if (!root.classList.contains("hdr-shrinkable")) { window.scrollTo({ top: 0, behavior: "smooth" }); await sleep(450); return; }
    if (!railOn() && typeof window.showMainMenu === "function") { window.showMainMenu(false); await sleep(350); }
  }
  const menuItem = tab => [`.hs-menu [data-tab="${tab}"]`, `#mainMenu .tab-btn[data-tab="${tab}"]`];

  /* =====================================================================
     TOURS
     A tour with requireTs keeps the Time series analysis on during its map steps.
     ===================================================================== */
  const TOURS = {};

  /* ---------- Spatial Mapping: time series (recorded workflow) ---------- */
  TOURS["mapping-timeseries"] = {
    title: "Spatial Mapping: build a time series",
    icon: "bi-graph-up",
    eyebrow: "Time series tour",
    summary: "A complete analysis with a real example, methane from livestock in the EPA MapEIre inventory: select a layer, plot it, style and download the map, then export a grid of maps for one county.",
    minutes: 6,
    requireTs: true,
    steps: [
      {
        id: "intro", phase: "Overview",
        title: "Build an emission time series from the maps",
        text: `<p>This walkthrough takes you through a complete Spatial Mapping analysis using a real example: <b>methane (CH&#8324;) emitted by livestock</b>, from the EPA&rsquo;s MapEIre national emission maps.</p>
               <ul class="gt-outline">
                 <li><i class="bi bi-check2-circle"></i>Select a dataset and a layer</li>
                 <li><i class="bi bi-check2-circle"></i>Plot its time series</li>
                 <li><i class="bi bi-check2-circle"></i>Style the map</li>
                 <li><i class="bi bi-check2-circle"></i>Download the map as a JPEG</li>
                 <li><i class="bi bi-check2-circle"></i>Focus the analysis on a county</li>
                 <li><i class="bi bi-check2-circle"></i>Export a grid of maps with the graph</li>
               </ul>`,
        tip: `Each step highlights the control to use. Use it yourself, or press <b>Do it for me</b> and the dashboard performs the step for you. Two steps save a file to your computer.`
      },
      {
        id: "open", phase: "Getting started", where: "page", pageOnly: true,
        title: "Open the Spatial Mapping section",
        text: `<p><b>Spatial Mapping</b> is the dashboard&rsquo;s map workspace. It places gridded emission estimates for Ireland on a satellite base map, so you can see <b>where</b> emissions occur and <b>how they change</b> over time.</p>`,
        target: menuItem("mapping"), place: menuSide,
        prepare: menuPrep,
        task: "Click Spatial Mapping in the menu.",
        done: () => tabActive("mapping"),
        auto: async () => { await ensureMapping(); }
      },
      {
        id: "analysis", phase: "Getting started", where: "map",
        title: "Check that the Time series analysis is on",
        summary: "Time series opens by default (its tab shows ON). Leave it on: clicking an open analysis again closes it and hides the time series panel.",
        text: `<p>The workspace offers two analyses. <b>Time series</b> follows a layer through every year in which it is available, for a single grid cell, a region you define or the whole map. <b>Compare</b> maps the difference between two layers.</p>
               <p><b>Time series</b> opens by default: its tab shows <b>ON</b>, the panel lists six steps and the time series panel is open on the right of the map. If it does not show ON, select it.</p>`,
        warn: `Do not click <b>Time series</b> when it already shows ON. The tab works as a switch: clicking an open analysis closes it, which hides the time series panel and steps 3 and 4. If this happens, the tour switches it back on for you.`,
        target: "#msModes", place: "right",
        task: "Make sure Time series shows ON.",
        done: tsOn,
        auto: async c => { if (!tsOn(c)) await c.click("#msTabTs"); }
      },
      {
        id: "dataset", phase: "Select the data", where: "map",
        title: "Step 1 · Choose a dataset",
        summary: "Pick one of three independent emission datasets (MapEIre, EDGAR or the Inverse model); this example uses MapEIre, the EPA national inventory on a 1 km grid.",
        text: `<p>Three independent datasets describe Ireland&rsquo;s emissions:</p>
               <ul><li><b>MapEIre</b>: the EPA national inventory mapped on a 1&nbsp;km grid (2015, 2016, 2019).</li>
                   <li><b>EDGAR</b>: the European Commission&rsquo;s bottom-up inventory, 2000&ndash;2024.</li>
                   <li><b>Inverse model</b>: top-down estimates derived from atmospheric measurements.</li></ul>
               <p>Select <b>MapEIre</b>, the dataset with the finest spatial detail.</p>`,
        target: '[data-step="1"]', place: "right",
        prepare: c => c.openStep("msStep1Btn"),
        task: "Select the MapEIre card.",
        done: c => { const s = c.q("#mapDataset"); return !!s && s.value === "mapeire"; },
        auto: c => c.click('.ms-ds-card[data-ds="mapeire"]')
      },
      {
        id: "year", phase: "Select the data", where: "map",
        title: "Step 2 · Select the layer: year",
        text: `<p>The drop-downs in <b>Select the layer</b> narrow the dataset down to a single map. They unlock one after another, from left to right.</p>
               <p>Start with the <b>Year</b> and choose <b>2019</b>, the most recent MapEIre year.</p>`,
        tip: `The year chosen here sets only the map. The time series always uses <b>every year</b> of the layer.`,
        target: c => { const e = c.q("#rasterYear"); return e && e.closest(".raster-field"); }, place: "right",
        prepare: c => c.openStep("msStep2Btn"),
        task: "Set Year to 2019.",
        done: c => { const s = c.q("#rasterYear"); return !!s && s.value === "2019"; },
        auto: c => c.select("#rasterYear", "2019")
      },
      {
        id: "sector", phase: "Select the data", where: "map",
        title: "Step 2 · Select the layer: sector",
        text: `<p>Sectors follow the <b>GNFR</b> classification used in European emission reporting. Choose <b>Agriculture &ndash; livestock &middot; GNFR K</b>: emissions from farmed animals, mainly digestion in cattle (enteric fermentation) and the storage of manure.</p>`,
        target: c => { const e = c.q("#rasterSector"); return e && e.closest(".raster-field"); }, place: "right",
        prepare: c => c.openStep("msStep2Btn"),
        task: "Set Sector to Agriculture – livestock · GNFR K.",
        done: c => { const s = c.q("#rasterSector"); return !!s && s.value === "K_AgriLivestock"; },
        auto: c => c.select("#rasterSector", "K_AgriLivestock")
      },
      {
        id: "pollutant", phase: "Select the data", where: "map",
        title: "Step 2 · Select the layer: pollutant",
        text: `<p>Choose <b>Methane (CH&#8324;)</b>. Pollutants marked &ldquo;no emission&rdquo; have no values for this sector. Livestock is Ireland&rsquo;s largest source of methane, so the map shows a clear pattern across the farming regions of the country.</p>
               <p>As soon as the selection is complete, the layer is drawn on the map. Hover over any cell to read its value.</p>`,
        target: c => { const e = c.q("#rasterParam"); return e && e.closest(".raster-field"); }, place: "right",
        prepare: c => c.openStep("msStep2Btn"),
        task: "Set Pollutant to Methane (CH₄).",
        done: c => { const s = c.q("#rasterParam"); return !!s && s.value === "CH4"; },
        auto: c => c.select("#rasterParam", "CH4")
      },
      {
        id: "area", phase: "Plot the time series", where: "map",
        title: "Step 3 · Choose the area",
        summary: "Decide which grid cells the series is calculated from: one pixel, a region (drawn or a county) or the whole image. Keep Whole image for now.",
        text: `<p>The area decides which grid cells the time series is calculated from:</p>
               <ul><li><b>Pixel</b>: the single cell you click on the map.</li>
                   <li><b>Region</b>: a rectangle or polygon you draw, or a county.</li>
                   <li><b>Whole image</b>: every cell of the layer.</li></ul>
               <p>Keep <b>Whole image</b> for now. Later in this walkthrough you will narrow the analysis to one county.</p>`,
        target: '[data-step="area"]', place: "right",
        prepare: c => c.openStep("msStepAreaBtn")
      },
      {
        id: "add", phase: "Plot the time series", where: "map",
        title: "Step 4 · Add the layer to the plot",
        text: `<p>This step summarises the layer you have selected. Press <b>Add to plot</b> to calculate its time series. The graph appears in the panel to the right of the map.</p>`,
        target: '[data-step="add"]', place: "right",
        prepare: c => c.openStep("msStepAddBtn"),
        tip: `Only layers of the same gas can share a graph. If the plot already holds another gas, a warning appears here: press <b>Remove all</b> under <b>Layers in the plot</b> first.`,
        task: "Press Add to plot.",
        done: inPlot,
        auto: async c => {
          if (inPlot(c)) return;
          const warn = c.q("#tsGasWarn");                      // another gas in the plot: clear it first
          if (warn && !warn.hidden && c.q("#tsClear")) { c.q("#tsClear").click(); await sleep(400); }
          await c.click("#tsAdd");
          if (!await c.wait(() => inPlot(c), 15000)) throw new Error("The layer could not be added. Check the message above the Add to plot button.");
        }
      },
      {
        id: "graph", phase: "Plot the time series", where: "map",
        title: "Read the time series graph",
        text: `<p>Each layer you add becomes a line in the graph and an entry under <b>Layers in the plot</b>, where it can be shown, hidden or removed.</p>
               <p>MapEIre provides three years, so this series has <b>three data points</b>. The dashed line between 2016 and 2019 only connects them: no values exist for the years in between.</p>`,
        tip: `To compare sectors, go back to Step 2, choose another sector with the <b>same gas</b> and press <b>Add to plot</b> again.`,
        target: ["#tsResults .ts-chart", "#tsList"], place: "left",
        prepare: async c => { await c.wait(() => +c.q("#tsCount").textContent > 0, 4000); }
      },
      {
        id: "filter", phase: "Style the map", where: "map",
        title: "Step 5 · Map style: the value filter",
        text: `<p><b>Map style</b> controls how the layer is drawn. The <b>Filter</b> has two handles that set the lowest and the highest value shown, with the values at each end. Cells outside the range are hidden, while the colour scale stays the same.</p>
               <p>For this example, show every value: the left handle should sit at the far left, which is where it starts. If you have moved it, drag it back to the left.</p>`,
        tip: `Dragging the left handle to the right hides the many low-value cells around the coast and offshore, and focuses the map on the main sources. Cells with a value of zero are always left uncoloured.`,
        target: c => { const e = c.q("#msRs"); return e && e.closest(".ms-bgrow"); }, place: "right",
        prepare: c => c.openStep("msStep3Btn"),
        task: "Check that the left handle of the Filter is at the far left.",
        done: c => { const s = c.q("#msRsMin"); return !!s && +s.value === +s.min; },
        auto: async c => { const s = c.q("#msRsMin"); if (!s) throw new Error("Show a layer on the map first."); s.value = s.min; c.fire(s, "input"); c.fire(s, "change"); await sleep(200); }
      },
      {
        id: "palette", phase: "Style the map", where: "map",
        title: "Step 5 · Map style: colour palette",
        text: `<p>Click the bar that shows the current palette to open the list. Palettes are grouped and can be searched by name.</p>
               <p>Choose <b>Jet</b> in the Rainbow group. The map and its legend are recoloured immediately, and the downloaded map will use the same colours.</p>`,
        tip: `The small box to the right of the palette <b>reverses</b> it, so that low and high values swap colours.`,
        target: ["#msCpPop", "#msCp"], place: "right",
        prepare: c => c.openStep("msStep3Btn"),
        task: "Open the palette list and choose Jet.",
        done: c => { const n = c.q("#msCpName"); return !!n && n.textContent.trim() === "Jet"; },
        auto: async c => {
          const pop = c.q("#msCpPop");
          if (pop && pop.hidden) await c.click("#msCpBtn");
          const opt = await c.wait(() => c.q("#msCpOpt-jet"));
          if (!opt) throw new Error("The palette list did not open. Click the palette bar and choose Jet.");
          (opt.querySelector(".bar") || opt).click(); await sleep(250);
        }
      },
      {
        id: "format", phase: "Download the map", where: "map",
        title: "Step 6 · Download the map: file format",
        summary: "Save the map as a JPEG image with legend, as GeoTIFF cell values for GIS software, or both in one ZIP file. Select JPEG.",
        text: `<p>The map on screen can be saved in three formats:</p>
               <ul><li><b>JPEG</b>: a map image with title, legend and source, ready for reports and presentations.</li>
                   <li><b>GeoTIFF</b>: the cell values themselves, georeferenced for GIS software such as QGIS or ArcGIS.</li>
                   <li><b>Both</b>: one ZIP file containing the two.</li></ul>
               <p>Select <b>JPEG</b>.</p>`,
        target: "#msDl", place: "right",
        prepare: c => c.openStep("msStep4Btn"),
        task: "Select JPEG.",
        done: c => c.pressed('#msDlFmts [data-fmt="jpeg"]'),
        auto: c => c.click('#msDlFmts [data-fmt="jpeg"]')
      },
      {
        id: "download", phase: "Download the map", where: "map", noReplay: true,
        title: "Step 6 · Download the map: save the JPEG",
        text: `<p>Press <b>Download JPEG map</b>. The image is prepared with the colour palette and filter you chose and saved to your computer, normally in the Downloads folder.</p>`,
        target: "#msDlGo", place: "right",
        prepare: c => c.openStep("msStep4Btn"),
        task: "Press Download JPEG map (optional).",
        autoLabel: "Download it for me",
        auto: c => c.click("#msDlGo")
      },
      {
        id: "about", phase: "Check the source", where: "map",
        title: "About this dataset: check the metadata",
        text: `<p>Before you interpret a map, check what the data represent. <b>About this dataset</b>, at the bottom of the left panel, summarises the provider, resolution, projection, coverage, years and contents of MapEIre, with notes on interpretation and links to the original report.</p>
               <p>Click it to open the summary. While it is open, the numbered steps above fold away to make room; click it again and they come back.</p>`,
        target: '[data-step="about"]', place: "right",
        task: "Open About this dataset.",
        done: c => { const b = c.q("#msAboutBtn"); return !!b && b.getAttribute("aria-expanded") === "true"; },
        auto: async c => { const b = c.q("#msAboutBtn"); if (b && b.getAttribute("aria-expanded") !== "true") { b.click(); await sleep(300); } }
      },
      {
        id: "region", phase: "Focus on a county", where: "map",
        title: "Change the area to a region",
        text: `<p>The <b>Area</b> card at the top of the graph panel repeats the area choice, so you can change it at any time. Every series in the graph is recalculated for the new area.</p>
               <p>Select <b>Region</b>.</p>`,
        target: "#tsWhere", place: "left",
        task: "Select Region.",
        done: c => c.pressed('#tsWhere [data-where="region"]'),
        auto: c => c.click('#tsWhere [data-where="region"]')
      },
      {
        id: "county", phase: "Focus on a county", where: "map",
        title: "Use a county as the region",
        text: `<p>A region can be a <b>Rectangle</b> or a <b>Polygon</b> that you draw on the map, or a <b>County</b>.</p>
               <p>Select <b>County</b>, then choose <b>Dublin</b> from the list. The county boundary is drawn on the map and the series uses the cells whose centre lies inside it.</p>`,
        target: "#tsRegionTools", place: "left",
        prepare: async c => { if (!c.pressed('#tsWhere [data-where="region"]')) await c.click('#tsWhere [data-where="region"]'); },
        task: "Select County and choose Dublin.",
        done: c => { const s = c.q("#tsRegionTools .ts-county"); return !!s && !s.hidden && s.value === "Dublin"; },
        auto: async c => {
          if (!c.pressed('#tsShape [data-shape="county"]')) await c.click('#tsShape [data-shape="county"]');
          await c.select("#tsRegionTools .ts-county", "Dublin");
        }
      },
      {
        id: "combine", phase: "Focus on a county", where: "map",
        title: "Decide how the cells are combined",
        summary: "Summarise the county's cells each year by their Mean, Median or Sum (the county total).",
        text: `<p>For a region, <b>Combine cells by</b> sets how its cells are summarised each year:</p>
               <ul><li><b>Mean</b> or <b>Median</b>: the typical value of a cell in the county.</li>
                   <li><b>Sum</b>: the total emission of the county.</li></ul>
               <p>The graph and the statistics update as soon as you change it.</p>`,
        target: "#tsAggBox", place: "left"
      },
      {
        id: "incmap", phase: "Export the results", where: "map",
        title: "Include the map in the exported image",
        text: `<p>On its own, the graph is exported as a PNG image, and <b>CSV</b> saves its values. Tick <b>Include map</b> to export a single image that combines the map (left), the graph (top right) and a details box (bottom right).</p>`,
        target: "#tsMapBox", place: "left",
        task: "Tick Include map.",
        done: c => { const b = c.q("#tsMap"); return !!b && b.checked; },
        auto: async c => { const b = await c.wait(() => { const e = c.q("#tsMap"); return e && !e.disabled && e; }); if (!b) throw new Error("Show a layer on the map first."); if (!b.checked) b.click(); await sleep(250); }
      },
      {
        id: "grid", phase: "Export the results", where: "map",
        title: "Choose a Time Series Grid",
        text: `<p><b>Current Map</b> adds the map exactly as it is now. <b>Time Series Grid</b> draws one map for every time step of the layer, all with one shared colour scale, which makes change over the years easy to see.</p>
               <p>Select <b>Time Series Grid</b>. Because Dublin is the area, every map shows only Dublin, with its boundary.</p>`,
        tip: `<b>Statistics table</b> adds a final panel with each map&rsquo;s maximum, mean, minimum, median and standard deviation. <b>Panel layout</b> sets the rows and columns of the grid.`,
        target: "#tsMapOpts", place: "left",
        prepare: async c => { await c.wait(() => { const o = c.q("#tsMapOpts"); return o && !o.hidden; }, 2500); },
        task: "Select Time Series Grid.",
        done: c => c.pressed('#tsMapMode [data-mode="grid"]'),
        auto: c => c.click('#tsMapMode [data-mode="grid"]')
      },
      {
        id: "export", phase: "Export the results", where: "map", noReplay: true,
        title: "Export the image",
        text: `<p>The export button now reads <b>JPG</b>. Press it to download the combined image: the grid of Dublin maps, the time series graph and a details box that lists the layer, the area and the data sources.</p>
               <p>The small <b>CSV</b> button beside it downloads the values of every series in the plot.</p>`,
        target: ".ts-export", place: "left",
        task: "Press JPG to download the image (optional).",
        autoLabel: "Download it for me",
        auto: c => c.click("#tsPng")
      },
      {
        id: "finish", phase: "Done",
        title: "Walkthrough complete",
        text: `<p>You have built a complete Spatial Mapping analysis: you selected a layer, plotted its time series, styled and downloaded the map, focused on a county and exported a grid of maps with the graph.</p>
               <p><b>Next, try this:</b></p>
               <ul><li>Repeat the analysis with <b>EDGAR</b>, which has every year from 2000 to 2024 and monthly values.</li>
                   <li>Add a second sector with the same gas to compare the two lines.</li>
                   <li>Switch the area to <b>Pixel</b> and click a cell to follow one square kilometre.</li></ul>`,
        finish: [
          { label: "Open User Guide 3.1", icon: "bi-book", run: () => { if (!STANDALONE && window.activateTab) { window.activateTab("guide"); location.hash = "#guide/mapping"; } else window.open("/#guide/mapping", "_blank"); } }
        ]
      }
    ]
  };

  /* ---------- Getting around the dashboard ---------- */
  TOURS["dashboard"] = {
    title: "Getting around the dashboard",
    icon: "bi-compass",
    eyebrow: "Basics tour",
    summary: "The Main Menu, the User Guide and where to find these walkthroughs again.",
    minutes: 1,
    pageOnly: true,
    steps: [
      {
        id: "intro", phase: "Overview",
        title: "Welcome to the INPACT Explorer",
        text: `<p>The Ireland Greenhouse Gas Policy Impact Explorer brings together Ireland&rsquo;s emissions, emission maps and climate policies in one place. This one-minute tour shows you how to move around it.</p>`,
        tip: `Use <kbd>&rarr;</kbd> and <kbd>&larr;</kbd> to move between steps and <kbd>Esc</kbd> to leave the tour at any time.`
      },
      {
        id: "menu", phase: "Navigation", where: "page",
        title: "The Main Menu",
        text: `<p>The Main Menu leads to every section of the platform: the <b>Explorer Dashboard</b> (national emissions), the <b>Policy Timeline</b>, <b>Spatial Mapping</b>, <b>Trend Analysis</b>, the <b>Datasets</b> catalogue and information <b>About INPACT</b>.</p>
               <p>On this first page the sections float on the banner, each with a key figure. Once you open one, the menu moves to the <b>left side</b> of the page, so every section stays one click away.</p>`,
        target: [".hs-menu", "#mainMenu"], place: menuSide,
        prepare: menuPrep
      },
      {
        id: "settings", phase: "Navigation", where: "page", skip: true,   // My settings is hidden from the menu
        title: "My settings",
        text: `<p>The dashboard remembers your preferences in this browser: chart styles, map colour palettes, Air Quality symbology and display options.</p>
               <p><b>My settings</b> exports them to a small file that you can import later, on another computer or share with colleagues. No personal data is stored.</p>`,
        target: "#mySettingsBtn", place: "bottom",
        prepare: async () => { if (typeof window.showMainMenu === "function") window.showMainMenu(false); await sleep(200); }
      },
      {
        id: "guide", phase: "Help", where: "page",
        title: "The User Guide",
        text: `<p>The <b>User Guide</b> explains every section in detail, chapter by chapter, with video tutorials and step-by-step instructions you can tick off as you go.</p>`,
        target: menuItem("guide"), place: menuSide,
        prepare: menuPrep
      },
      {
        id: "tours", phase: "Help", where: "page",
        title: "Guided tours",
        text: `<p>All interactive walkthroughs are listed under <b>Guided tours</b>. Each one shows you the real controls, explains them and can perform the steps for you. You can leave a tour at any time and resume it later from the same step.</p>`,
        target: [".hs-tours", "#tourBtn"], place: menuSide,
        prepare: menuPrep
      },
      {
        id: "finish", phase: "Done",
        title: "You are ready to explore",
        text: `<p>Next, follow the Spatial Mapping walkthrough to build your first emission time series from the maps, or open the User Guide for the full reference.</p>`,
        finish: [
          { label: "Start the Spatial Mapping tour", icon: "bi-graph-up", primary: true, run: () => setTimeout(() => api.start("mapping-timeseries"), 50) }
        ]
      }
    ]
  };

  /* =====================================================================
     ENGINE
     ===================================================================== */
  const ui = {};
  const st = { tour: null, id: null, steps: [], i: 0, raf: 0, busy: false, last: "", lastCheck: 0, doneNow: false, gen: 0 };
  // Auto-play: delay in seconds (1 by default, the viewer can raise it), downloads included or not
  const play = { on: false, token: 0, delay: Math.min(30, Math.max(1, +store.get(STORE_DELAY, 1) || 1)), dl: !!store.get(STORE_DL, false) };
  const stepsOf = t => t.steps.filter(s => !s.skip && !(STANDALONE && s.pageOnly));
  const available = t => !(STANDALONE && t.pageOnly);

  function build() {
    if (ui.root) return;
    const r = document.createElement("div");
    r.className = "gt-root"; r.hidden = true;
    r.innerHTML = `
      <div class="gt-dim" data-d="t"></div><div class="gt-dim" data-d="b"></div>
      <div class="gt-dim" data-d="l"></div><div class="gt-dim" data-d="r"></div>
      <div class="gt-ring" hidden></div>
      <div class="gt-card" role="dialog" aria-modal="false" aria-labelledby="gtTitle" aria-describedby="gtText" tabindex="-1">
        <div class="gt-bar" aria-hidden="true"><span></span></div>
        <div class="gt-head"><span class="gt-eyebrow"></span><span class="gt-count"></span>
          <button type="button" class="gt-x" aria-label="Close the tour" title="Close (Esc)"><i class="bi bi-x-lg"></i></button></div>
        <div class="gt-body" aria-live="polite">
          <h2 class="gt-title" id="gtTitle"></h2>
          <div class="gt-text" id="gtText"></div>
          <div class="gt-tipbox"></div>
          <div class="gt-taskbox"></div>
          <p class="gt-msg" role="alert"></p>
        </div>
        <!-- Auto-play: performs every remaining step in turn, waiting "Delay" seconds before and after each -->
        <div class="gt-play" hidden>
          <button type="button" class="gt-btn play" data-a="play" aria-pressed="false"
                  title="Run the rest of the tour automatically, step by step, to the end"><i class="bi bi-play-circle"></i><span>Auto-play</span></button>
          <label class="gt-delay" title="How long each step stays on screen before and after it is performed">Delay
            <input type="number" min="1" max="30" step="0.5" value="1" inputmode="decimal" aria-label="Delay for each step, in seconds"><span>s</span></label>
          <label class="gt-dlopt" title="Also save the JPEG map and the exported image while auto-playing"><input type="checkbox">Include downloads</label>
          <span class="gt-play-state" aria-live="polite"></span>
        </div>
        <div class="gt-foot">
          <button type="button" class="gt-btn ghost" data-a="back"><i class="bi bi-arrow-left"></i>Back</button>
          <span class="gt-sp"></span>
          <span class="gt-extra"></span>
          <button type="button" class="gt-btn auto" data-a="auto"><i class="bi bi-magic"></i><span>Do it for me</span></button>
          <button type="button" class="gt-btn primary" data-a="next"><span>Next</span><i class="bi bi-arrow-right"></i></button>
        </div>
      </div>`;
    document.body.appendChild(r);
    ui.root = r;
    ui.dims = [...r.querySelectorAll(".gt-dim")];
    ui.ring = r.querySelector(".gt-ring");
    ui.card = r.querySelector(".gt-card");
    ui.bar = r.querySelector(".gt-bar span");
    ui.eyebrow = r.querySelector(".gt-eyebrow");
    ui.count = r.querySelector(".gt-count");
    ui.title = r.querySelector(".gt-title");
    ui.text = r.querySelector(".gt-text");
    ui.tip = r.querySelector(".gt-tipbox");
    ui.task = r.querySelector(".gt-taskbox");
    ui.msg = r.querySelector(".gt-msg");
    ui.extra = r.querySelector(".gt-extra");
    ui.back = r.querySelector('[data-a="back"]');
    ui.auto = r.querySelector('[data-a="auto"]');
    ui.next = r.querySelector('[data-a="next"]');
    ui.playBox = r.querySelector(".gt-play");
    ui.play = r.querySelector('[data-a="play"]');
    ui.delay = r.querySelector(".gt-delay input");
    ui.dl = r.querySelector(".gt-dlopt input");
    ui.playState = r.querySelector(".gt-play-state");
    ui.delay.value = play.delay;
    ui.dl.checked = play.dl;
    r.querySelector(".gt-x").addEventListener("click", () => stop(false));
    // Any button the viewer presses pauses Auto-play
    ui.back.addEventListener("click", () => { stopPlay(); go(st.i - 1); });
    ui.next.addEventListener("click", () => { stopPlay(); st.i >= st.steps.length - 1 ? stop(true) : go(st.i + 1); });
    ui.auto.addEventListener("click", () => { stopPlay(); doAuto(); });
    ui.play.addEventListener("click", () => (play.on ? stopPlay() : runPlay()));
    const setDelay = () => {
      const v = Math.min(30, Math.max(1, parseFloat(ui.delay.value) || 1));
      play.delay = v; store.set(STORE_DELAY, v);
    };
    ui.delay.addEventListener("input", setDelay);
    ui.delay.addEventListener("change", () => { setDelay(); ui.delay.value = play.delay; });
    ui.dl.addEventListener("change", () => { play.dl = ui.dl.checked; store.set(STORE_DL, play.dl); });
    // A click on the dimmed page: a gentle shake of the card, the tour stays
    ui.dims.forEach(d => d.addEventListener("click", () => {
      ui.card.animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 260 });
    }));
  }

  function onKey(e) {
    if (!st.tour) return;
    if (e.key === "Escape") { e.preventDefault(); stop(false); return; }
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
    if (typing) return;
    if (e.key === "ArrowRight" && ui.card.contains(document.activeElement)) { e.preventDefault(); ui.next.click(); }
    if (e.key === "ArrowLeft" && ui.card.contains(document.activeElement) && st.i > 0) { e.preventDefault(); ui.back.click(); }
  }
  let keyDoc = null;
  function bindFrameKeys() {
    const d = mapDoc();
    if (!d || d === document || d === keyDoc) return;
    keyDoc = d;
    d.addEventListener("keydown", e => { if (st.tour && e.key === "Escape") { stop(false); } });
  }

  /* Rectangle of a step's target, in this page's coordinates (frame offset added) */
  function resolveTargets(step) {
    if (!step.target) return [];
    const onMap = step.where === "map";
    const d = onMap ? mapDoc() : document;
    if (!d) return [];
    let t = step.target;
    if (typeof t === "function") { try { t = t(ctx); } catch (e) { t = null; } }
    const list = (Array.isArray(t) ? t : [t]).flatMap(x => (typeof x === "string" ? [d.querySelector(x)] : [x])).filter(Boolean);
    return list.filter(el => {
      if (el.closest("[hidden]")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }
  function rectOf(els, onMap) {
    if (!els.length) return null;
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    els.forEach(el => { const r = el.getBoundingClientRect(); L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); });
    if (onMap && !STANDALONE) {
      const f = frameEl(), fr = f.getBoundingClientRect();
      const ox = fr.left + f.clientLeft, oy = fr.top + f.clientTop;
      L = Math.max(L + ox, fr.left); R = Math.min(R + ox, fr.right);
      T = Math.max(T + oy, fr.top); B = Math.min(B + oy, fr.bottom);
      if (R <= L || B <= T) return null;
    }
    const pad = 6;
    return { left: L - pad, top: T - pad, right: R + pad, bottom: B + pad, width: R - L + 2 * pad, height: B - T + 2 * pad };
  }

  function layout() {
    const step = st.steps[st.i];
    if (!step) return;
    const W = window.innerWidth, H = window.innerHeight;
    const els = resolveTargets(step);
    const r = rectOf(els, step.where === "map");
    const key = r ? [r.left, r.top, r.width, r.height].map(Math.round).join(",") + "|" + W + "x" + H + "|" + ui.card.offsetHeight : "none|" + W + "x" + H + "|" + ui.card.offsetHeight;
    if (key === st.last) return;
    st.last = key;
    const [dt, db, dl, dr] = ui.dims;
    const set = (el, x, y, w, h) => Object.assign(el.style, { left: x + "px", top: y + "px", width: Math.max(0, w) + "px", height: Math.max(0, h) + "px" });
    const cw = ui.card.offsetWidth, ch = ui.card.offsetHeight, m = 14;
    let x, y;
    if (!r) {
      set(dt, 0, 0, W, H); set(db, 0, 0, 0, 0); set(dl, 0, 0, 0, 0); set(dr, 0, 0, 0, 0);
      ui.ring.hidden = true;
      ui.card.classList.add("center");
      x = (W - ui.card.offsetWidth) / 2; y = Math.max(m, (H - ch) / 2);
    } else {
      ui.card.classList.remove("center");
      const top = Math.max(0, r.top), bot = Math.min(H, r.bottom), lft = Math.max(0, r.left), rgt = Math.min(W, r.right);
      set(dt, 0, 0, W, top); set(db, 0, bot, W, H - bot);
      set(dl, 0, top, lft, bot - top); set(dr, rgt, top, W - rgt, bot - top);
      ui.ring.hidden = false;
      set(ui.ring, r.left, r.top, r.width, r.height);
      // Card: the preferred side, then the others, else over the bottom of the screen
      const fits = {
        right: W - r.right - m >= cw, left: r.left - m >= cw,
        bottom: H - r.bottom - m >= ch, top: r.top - m >= ch
      };
      const pref = typeof step.place === "function" ? step.place() : step.place;
      const order = [pref || "right", "right", "left", "bottom", "top"];
      const side = order.find(s => fits[s]);
      const clampY = v => Math.min(Math.max(m, v), H - ch - m);
      const clampX = v => Math.min(Math.max(m, v), W - cw - m);
      if (side === "right") { x = r.right + m; y = clampY(r.top + r.height / 2 - ch / 2); }
      else if (side === "left") { x = r.left - m - cw; y = clampY(r.top + r.height / 2 - ch / 2); }
      else if (side === "bottom") { x = clampX(r.left + r.width / 2 - cw / 2); y = r.bottom + m; }
      else if (side === "top") { x = clampX(r.left + r.width / 2 - cw / 2); y = r.top - m - ch; }
      else { x = clampX(W - cw - m); y = clampY(H - ch - m); }
    }
    ui.card.style.left = Math.round(x) + "px";
    ui.card.style.top = Math.round(y) + "px";
  }

  function tick(ts) {
    if (!st.tour) return;
    layout();
    if (ts - st.lastCheck > 300) { st.lastCheck = ts; watchTs(); checkDone(); bindFrameKeys(); }
    st.raf = requestAnimationFrame(tick);
  }

  function checkDone() {
    const step = st.steps[st.i];
    if (!step || !step.task) return;
    let ok = false;
    if (step.done) { try { ok = !!step.done(ctx); } catch (e) { ok = false; } }
    if (ok === st.doneNow) return;
    st.doneNow = ok;
    renderTask(step, ok);
  }
  function renderTask(step, ok) {
    if (!step.task) { ui.task.innerHTML = ""; ui.next.classList.remove("ready"); return; }
    ui.task.innerHTML = `<div class="gt-task${ok ? " ok" : ""}"><i class="bi ${ok ? "bi-check-circle-fill" : "bi-hand-index"}" aria-hidden="true"></i><span>${ok ? "Done. Press Next to continue." : esc(step.task)}</span></div>`;
    ui.next.classList.toggle("ready", ok);
    if (step.auto && ok && !step.noReplay) ui.auto.hidden = true;
    else if (step.auto) ui.auto.hidden = false;
  }

  function render() {
    const step = st.steps[st.i], n = st.steps.length;
    ui.eyebrow.textContent = st.tour.eyebrow + " · " + step.phase;
    ui.count.textContent = (st.i + 1) + " / " + n;
    ui.bar.style.width = (100 * (st.i + 1) / n) + "%";
    ui.title.innerHTML = step.title;
    ui.text.innerHTML = step.text || "";
    ui.tip.innerHTML = (step.tip ? `<div class="gt-tip"><i class="bi bi-lightbulb" aria-hidden="true"></i><span>${step.tip}</span></div>` : "") +
                       (step.warn ? `<div class="gt-tip warn"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i><span>${step.warn}</span></div>` : "");
    ui.msg.textContent = ""; ui.msg.classList.remove("info");
    ui.back.hidden = st.i === 0;
    ui.auto.hidden = !step.auto;
    ui.auto.disabled = false;
    ui.auto.querySelector("span").textContent = step.autoLabel || "Do it for me";
    const last = st.i === n - 1;
    ui.next.innerHTML = st.i === 0 ? `<span>Start the tour</span><i class="bi bi-arrow-right"></i>`
      : last ? `<i class="bi bi-check2"></i><span>Finish</span>` : `<span>Next</span><i class="bi bi-arrow-right"></i>`;
    ui.next.classList.remove("ready");
    ui.extra.innerHTML = "";
    (step.finish || []).forEach(a => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "gt-btn " + (a.primary ? "auto" : "ghost");
      b.innerHTML = `<i class="bi ${a.icon}"></i><span>${esc(a.label)}</span>`;
      b.addEventListener("click", () => { stop(true); a.run(); });
      ui.extra.appendChild(b);
    });
    if (last && st.tour === TOURS["mapping-timeseries"]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "gt-btn ghost";
      b.innerHTML = `<i class="bi bi-arrow-counterclockwise"></i><span>Restart</span>`;
      b.addEventListener("click", () => go(0));
      ui.extra.prepend(b);
    }
    st.doneNow = false;
    renderTask(step, false);
    // Auto-play bar: for tours whose steps can be performed; hidden on the last step
    ui.playBox.hidden = !st.tour.steps.some(s => s.auto) || last;
    syncPlay();
    st.last = "";
  }

  function setBusy(on, label) {
    st.busy = on;
    ui.next.disabled = on; ui.back.disabled = on; ui.auto.disabled = on;
    if (on) ui.auto.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${esc(label || "Working…")}</span>`;
    else ui.auto.innerHTML = `<i class="bi bi-magic"></i><span>${esc((st.steps[st.i] || {}).autoLabel || "Do it for me")}</span>`;
  }

  // Time series tours: switch the analysis back on if it was closed (true when it had to be)
  async function keepTsOn(step) {
    if (!st.tour || !st.tour.requireTs || step.where !== "map" || !mapDoc() || tsOn(ctx)) return false;
    const tab = ctx.q("#msTabTs");
    if (!tab || tab.disabled) return false;
    tab.click(); await sleep(350);
    return true;
  }
  let tsFixing = false;
  async function watchTs() {
    const step = st.steps[st.i];
    if (tsFixing || st.busy || !step) return;
    tsFixing = true;
    try {
      if (await keepTsOn(step)) {
        ui.msg.classList.add("info");
        ui.msg.textContent = "Time series was switched off, which closes its panel. The tour has switched it back on, as the next steps need it.";
        st.last = "";
      }
    } finally { tsFixing = false; }
  }

  async function prepareStep(step) {
    if (step.where === "map") { await ensureMapping(); await keepTsOn(step); }
    else if (step.where === "page" && !STANDALONE && step.tab && window.activateTab && !tabActive(step.tab)) window.activateTab(step.tab);
    if (step.prepare) await step.prepare(ctx);
    const els = resolveTargets(step);
    if (els[0]) revealEl(els[0]);
  }

  /* Bring a control into view by scrolling only its own scroll box (e.g. the map's left panel).
     scrollIntoView would also scroll the dashboard around the frame, down to its footer. */
  function revealEl(el) {
    const W = el.ownerDocument.defaultView;
    let box = el.parentElement;
    while (box && box !== el.ownerDocument.body) {
      const oy = W.getComputedStyle(box).overflowY;
      if (/(auto|scroll)/.test(oy) && box.scrollHeight > box.clientHeight + 2) break;
      box = box.parentElement;
    }
    const r = el.getBoundingClientRect();
    if (box && box !== el.ownerDocument.body) {
      const b = box.getBoundingClientRect();
      if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
        const want = box.scrollTop + (r.top - b.top) - Math.max(8, (b.height - Math.min(r.height, b.height)) / 2);
        box.scrollTo({ top: Math.max(0, want), behavior: "smooth" });
      }
    } else if (el.ownerDocument === document && (r.top < 0 || r.bottom > W.innerHeight)) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function go(i) {
    if (!st.tour || st.busy) return;
    i = Math.max(0, Math.min(st.steps.length - 1, i));
    const gen = ++st.gen;
    st.i = i;
    store.set(STORE_POS, Object.assign(store.get(STORE_POS, {}), { [st.id]: i }));
    const step = st.steps[i];
    render();
    setBusy(true, "Preparing…");
    ui.auto.hidden = false;
    try { await prepareStep(step); }
    catch (e) { if (gen === st.gen) { ui.msg.classList.remove("info"); ui.msg.textContent = e.message || String(e); } }
    if (gen !== st.gen) return;
    setBusy(false);
    ui.auto.hidden = !step.auto;
    st.doneNow = null; checkDone();
    st.last = "";
    ui.next.focus({ preventScroll: true });
  }

  // Perform one step's action ("Do it for me"); false when it failed (the message is shown)
  async function runAuto(step) {
    setBusy(true);
    ui.msg.textContent = ""; ui.msg.classList.remove("info");
    let ok = true;
    try {
      await prepareStep(step);
      await step.auto(ctx);
      await sleep(250);
    } catch (e) { ok = false; ui.msg.classList.remove("info"); ui.msg.textContent = e.message || String(e); }
    setBusy(false);
    st.doneNow = null; checkDone();
    return ok;
  }
  async function doAuto() {
    const step = st.steps[st.i];
    if (!step || !step.auto || st.busy) return;
    const ok = await runAuto(step);
    // Steps without a "done" check (downloads) move on by themselves once performed
    if (!step.done && ok && st.i < st.steps.length - 1) setTimeout(() => go(st.i + 1), 700);
    else ui.next.focus({ preventScroll: true });
  }

  /* ---------- Auto-play: every remaining step in turn, to the end ----------
     For each step: show it for "Delay" seconds, perform it if it has an action and is not done yet
     (downloads only with "Include downloads"), show the result for "Delay" seconds, then move on.
     Any button the viewer presses, Esc or an error pauses it. */
  async function playWait(ms, t) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!play.on || t !== play.token || !st.tour) return false;
      ui.playState.textContent = "Next action in " + Math.max(0, (end - Date.now()) / 1000).toFixed(1) + " s";
      await sleep(100);
    }
    return play.on && t === play.token && !!st.tour;
  }
  async function runPlay() {
    if (play.on || !st.tour || st.i >= st.steps.length - 1) return;
    play.on = true;
    const t = ++play.token;
    syncPlay();
    try {
      while (play.on && t === play.token && st.tour) {
        if (!await waitFor(() => !st.busy, 30000)) break;
        const step = st.steps[st.i];
        if (!await playWait(play.delay * 1000, t)) break;
        let done = false;
        try { done = step.done ? !!step.done(ctx) : false; } catch (e) { done = false; }
        if (step.auto && !done && (!step.noReplay || play.dl)) {
          ui.playState.textContent = "Performing this step…";
          if (!await runAuto(step)) break;                 // an error stops Auto-play; its message stays
          if (!await playWait(play.delay * 1000, t)) break;
        }
        if (st.i >= st.steps.length - 1) break;
        await go(st.i + 1);
        if (ui.msg.textContent && !ui.msg.classList.contains("info")) break;   // the next step could not be prepared
      }
    } finally {
      if (t === play.token) { play.on = false; syncPlay(); }
    }
  }
  function stopPlay() {
    if (!play.on) return;
    play.on = false; play.token++;
    syncPlay();
  }
  function syncPlay() {
    if (!ui.play) return;
    const last = !st.tour || st.i >= st.steps.length - 1;
    ui.play.setAttribute("aria-pressed", String(play.on));
    ui.play.innerHTML = play.on ? `<i class="bi bi-pause-circle"></i><span>Pause</span>`
      : `<i class="bi bi-play-circle"></i><span>${st.i > 0 ? "Auto-play the rest" : "Auto-play"}</span>`;
    ui.play.disabled = last && !play.on;
    ui.card.classList.toggle("playing", play.on);
    if (!play.on) ui.playState.textContent = last ? "" : "Runs each step for you, " + play.delay + " s apart";
  }

  // Starting part-way through: perform the earlier steps so the workspace is ready
  async function fastForward(to) {
    for (let j = 0; j < to; j++) {
      const s = st.steps[j];
      if (!s.auto || s.noReplay) continue;
      let ok = false; try { ok = s.done ? !!s.done(ctx) : false; } catch (e) { ok = false; }
      if (ok) continue;
      ui.title.textContent = "Preparing the workspace…";
      ui.text.innerHTML = `<p>Setting up the earlier steps for you: <b>${s.title}</b></p>`;
      await prepareStep(s);
      await s.auto(ctx);
      await sleep(200);
    }
  }

  async function start(id, from, opts) {
    const tour = TOURS[id];
    if (!tour || !available(tour)) return;
    build();
    closePicker(); hideNudge();
    if (st.tour) stop(false, true);
    st.tour = tour; st.id = id; st.steps = stepsOf(tour); st.i = 0; st.busy = false;
    ui.root.hidden = false;
    document.addEventListener("keydown", onKey, true);
    root.classList.add("gt-on");
    syncFab();
    st.raf = requestAnimationFrame(tick);
    from = Math.max(0, Math.min(st.steps.length - 1, from | 0));
    if (from > 1) {
      st.i = from; render(); setBusy(true, "Preparing…");
      try { await fastForward(from); } catch (e) { { ui.msg.classList.remove("info"); ui.msg.textContent = e.message || String(e); } }
      setBusy(false);
    }
    await go(from);
    if (opts && opts.autoplay) runPlay();
  }

  function stop(completed, silent) {
    if (!st.tour) return;
    stopPlay();
    if (completed) {
      const done = store.get(STORE_DONE, []);
      if (!done.includes(st.id)) done.push(st.id);
      store.set(STORE_DONE, done);
      const pos = store.get(STORE_POS, {}); delete pos[st.id]; store.set(STORE_POS, pos);
    }
    cancelAnimationFrame(st.raf);
    st.tour = null; st.gen++; st.busy = false;
    ui.root.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    root.classList.remove("gt-on");
    if (!silent) { syncFab(); renderOutlines(); }
  }

  /* ---------- Tour picker (Guided tours) ---------- */
  function openPicker() {
    if (!ui.picker) {
      const p = document.createElement("div");
      p.className = "gt-picker"; p.hidden = true;
      p.innerHTML = `<div class="gt-pk" role="dialog" aria-modal="true" aria-labelledby="gtPkTitle">
          <div class="gt-pk-head"><div style="flex:1">
            <h2 id="gtPkTitle">Guided tours</h2>
            <p>Interactive walkthroughs that show you the real controls of the dashboard, explain each one and can perform the steps for you. Leave at any time; your place is remembered.</p></div>
            <button type="button" class="gt-x" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>
          <div class="gt-pk-list"></div></div>`;
      document.body.appendChild(p);
      p.addEventListener("click", e => { if (e.target === p || e.target.closest(".gt-x")) closePicker(); });
      p.addEventListener("keydown", e => { if (e.key === "Escape") closePicker(); });
      ui.picker = p;
    }
    const list = ui.picker.querySelector(".gt-pk-list");
    const pos = store.get(STORE_POS, {}), done = store.get(STORE_DONE, []);
    list.innerHTML = Object.entries(TOURS).filter(([, t]) => available(t)).map(([id, t]) => {
      const n = stepsOf(t).length, at = pos[id];
      const resume = at > 0 && at < n - 1;
      return `<div class="gt-pk-item">
          <span class="gt-pk-ic"><i class="bi ${t.icon}"></i></span>
          <span class="gt-pk-txt"><b>${esc(t.title)}</b><span>${esc(t.summary)}</span>
            <span class="gt-pk-meta"><span><i class="bi bi-clock"></i> about ${t.minutes} min</span><span><i class="bi bi-list-ol"></i> ${n} steps</span>${done.includes(id) ? '<span style="color:#00843D"><i class="bi bi-check-circle-fill"></i> Completed</span>' : ""}</span></span>
          <span class="gt-pk-btns">
            ${resume ? `<button type="button" class="gt-btn primary" data-tour-start="${id}" data-tour-step="${at}"><i class="bi bi-play-fill"></i>Resume (step ${at + 1})</button>
                        <button type="button" class="gt-btn ghost" data-tour-start="${id}">Start over</button>`
                     : `<button type="button" class="gt-btn primary" data-tour-start="${id}"><i class="bi bi-play-fill"></i>${done.includes(id) ? "Take again" : "Start"}</button>`}
            ${t.steps.some(s => s.auto) ? `<button type="button" class="gt-btn auto" data-tour-start="${id}" data-tour-autoplay title="Watch every step being performed for you, one after another"><i class="bi bi-play-circle"></i>Auto-play</button>` : ""}
          </span></div>`;
    }).join("");
    ui.picker.hidden = false;
    const first = list.querySelector("button"); if (first) first.focus();
  }
  function closePicker() { if (ui.picker) ui.picker.hidden = true; }

  /* ---------- Spatial Mapping: floating help button and first-visit prompt ---------- */
  function syncFab() {
    if (!ui.fab) return;
    const show = !st.tour && (STANDALONE || tabActive("mapping"));
    ui.fab.classList.toggle("on", show);
  }
  function hideNudge() { if (ui.nudge) ui.nudge.hidden = true; }
  function setupMappingHelp() {
    const fab = document.createElement("button");
    fab.type = "button"; fab.className = "gt-fab";
    fab.innerHTML = `<i class="bi bi-signpost-split"></i><span>Guided tour: time series</span>`;
    fab.title = "Start the step-by-step walkthrough of a Spatial Mapping time series";
    fab.addEventListener("click", () => start("mapping-timeseries", resumeAt("mapping-timeseries")));
    document.body.appendChild(fab);
    ui.fab = fab;
    const pane = document.getElementById("tab-mapping");
    const onShow = () => {
      syncFab();
      if (st.tour || store.get(STORE_NUDGE, false) || !(STANDALONE || tabActive("mapping"))) return;
      store.set(STORE_NUDGE, true);
      setTimeout(() => {
        if (st.tour || !(STANDALONE || tabActive("mapping"))) return;
        const n = document.createElement("div");
        n.className = "gt-nudge"; n.setAttribute("role", "status");
        n.innerHTML = `<b>New to Spatial Mapping?</b><p>Take a short guided tour: it shows you, step by step, how to build an emission time series, style the map and export the results.</p>
          <div class="row"><button type="button" class="gt-btn primary" data-go="1"><i class="bi bi-play-fill"></i>Start the tour</button>
          <button type="button" class="gt-btn ghost" data-no="1">Not now</button></div>`;
        n.querySelector("[data-go]").addEventListener("click", () => { n.remove(); start("mapping-timeseries"); });
        n.querySelector("[data-no]").addEventListener("click", () => n.remove());
        document.body.appendChild(n);
        ui.nudge = n;
        setTimeout(() => n.isConnected && n.remove(), 20000);
      }, 2500);
    };
    if (pane) new MutationObserver(onShow).observe(pane, { attributes: true, attributeFilter: ["class"] });
    onShow();
  }
  const resumeAt = id => { const at = store.get(STORE_POS, {})[id] || 0; const n = TOURS[id] ? stepsOf(TOURS[id]).length : 0; return at > 0 && at < n - 1 ? at : 0; };

  /* ---------- User Guide: a tour's steps as text, with "Start here" links ---------- */
  function renderOutlines() {
    document.querySelectorAll("[data-tour-outline]").forEach(box => {
      const id = box.dataset.tourOutline, t = TOURS[id];
      if (!t) return;
      const steps = stepsOf(t);
      box.innerHTML = `<ol class="gt-ol">` + steps.map((s, i) => {
        if (s.id === "intro" || s.id === "finish") return "";
        const tmp = document.createElement("div"); tmp.innerHTML = s.text || "";
        const first = s.summary || (tmp.querySelector("p") || tmp).textContent.trim();
        return `<li><span><span class="ph">${esc(s.phase)}</span><b>${s.title}</b><span class="s">${esc(first)}</span></span>
          <button type="button" class="gt-link" data-tour-start="${id}" data-tour-step="${i}" title="Start the walkthrough at this step">Show me <i class="bi bi-arrow-right-short"></i></button></li>`;
      }).join("") + `</ol>`;
    });
  }

  /* ---------- Launchers ---------- */
  document.addEventListener("click", e => {
    const s = e.target.closest("[data-tour-start]");
    if (s) { e.preventDefault(); start(s.dataset.tourStart, +s.dataset.tourStep || 0, { autoplay: s.hasAttribute("data-tour-autoplay") }); return; }
    const p = e.target.closest("[data-tour-picker]");
    if (p) { e.preventDefault(); openPicker(); }
  });
  window.addEventListener("resize", () => { st.last = ""; });

  const api = { start, stop: () => stop(false), openPicker, tours: TOURS };
  window.inpactTour = api;

  function init() {
    renderOutlines();
    setupMappingHelp();
    // Deep link: #tour/<id>
    const m = location.hash.match(/^#tour\/([\w-]+)/);
    if (m && TOURS[m[1]]) setTimeout(() => start(m[1]), 600);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
