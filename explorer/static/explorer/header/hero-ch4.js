/* =====================================================================
   Landing banner: greenhouse gases from the land to the measurement tower
   (hero-ch4.js + the "CH4" part of hero.css)

   An illustration of how atmospheric measurements see emissions from the
   land: carbon dioxide (CO2, near-black) leaves the power station's chimneys,
   methane (CH4, amber) rises from the grazing cattle, the bog pools of
   the peatland and the farm fields; nitrous oxide (N2O, violet) rises from
   fertilised and grazed soils. Both drift slowly with the wind across the
   banner and are drawn into the inlet of a measurement tower like the one at
   Mace Head (Co. Galway). The tower is a button: its readings rise as the gases
   arrive, and it opens a short card that explains what the station measures,
   with live traces and a link to the inverse-model maps in Spatial Mapping.
   Clicking a cow releases a puff of methane; clicking the bog makes it bubble.

   The particles and readings are an illustration, not data: they move around
   typical Mace Head levels (CO2 about 424-428 ppm, CH4 about 1,950-2,000 ppb,
   N2O about 337-339 ppb).
   Runs only on the landing banner, pauses when the banner is off screen or the
   tab is hidden, and is still (no particles) for reduced motion.
   ===================================================================== */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-standalone")) return;
  const header = document.querySelector(".app-header");
  const scene = header && header.querySelector(".hero-scene");
  if (!scene || header.querySelector(".ch4-tower")) return;

  /* Speed of the drift: 0.25 = a quarter of the first version (asked for 27 Nov 2026); 1 = original.
     Emission rates and lifetimes follow it, so the amount of gas on screen stays about the same. */
  const SPEED = 0.25;

  /* The two gases: colours of the particles, typical background level at Mace Head (illustrative),
     how much one arriving plume adds to the reading, and the number of decimals shown */
  const GAS = {
    co2: { name: "CO₂", long: "carbon dioxide", unit: "ppm", core: "rgba(70,74,80,.95)", mid: "rgba(38,42,48,.78)", edge: "rgba(38,42,48,0)",
           text: "#1F2328", base: 425.6, swing: 0.6, perHit: 0.12, dec: 1 },
    ch4: { name: "CH₄", long: "methane", core: "rgba(255,214,140,1)", mid: "rgba(240,168,58,.85)", edge: "rgba(240,168,58,0)",
           text: "#8A5208", base: 1958, swing: 4, perHit: 2.0, dec: 0, unit: "ppb" },
    n2o: { name: "N₂O", long: "nitrous oxide", core: "rgba(226,212,255,1)", mid: "rgba(142,107,216,.85)", edge: "rgba(142,107,216,0)",
           text: "#4E3592", base: 337.9, swing: 0.12, perHit: 0.07, dec: 1, unit: "ppb" },
  };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fmt = (v, dec) => v.toLocaleString("en-IE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

  /* ---------- The tower (a button) with its readings and card ---------- */
  const tower = document.createElement("button");
  tower.type = "button";
  tower.className = "ch4-tower";
  tower.setAttribute("aria-haspopup", "dialog");
  tower.setAttribute("aria-expanded", "false");
  tower.setAttribute("aria-label", "Mace Head atmospheric station: CO₂ over the years and live readings. Open details");
  tower.innerHTML = `
    <svg class="ch4-mast" viewBox="0 0 60 190" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <path class="ch4-lattice" d="M22 188L30 26L38 188M24 150H36M25.5 112H34.5M27 76H33M28.5 46H31.5M23 168L35 132M25 132L34 96M26.5 96L33 62M37 168L25 132M35 132L26 96M33.5 96L27 62"/>
      <path class="ch4-arm" d="M30 26V12M18 16H42M18 16v5M42 16v5"/>
      <circle class="ch4-cup" cx="18" cy="23" r="2.4"/><circle class="ch4-cup" cx="42" cy="23" r="2.4"/>
      <circle class="ch4-inlet-glow" cx="30" cy="12" r="9"/>
      <circle class="ch4-inlet" cx="30" cy="12" r="3.6"/>
      <rect class="ch4-box" x="10" y="150" width="14" height="20" rx="2"/><rect class="ch4-box" x="36" y="120" width="11" height="14" rx="2"/>
      <rect class="ch4-hut" x="4" y="172" width="52" height="16" rx="2"/><rect class="ch4-hut-door" x="23" y="176" width="9" height="12" rx="1"/>
    </svg>
    <span class="ch4-chip"><span class="ch4-dot" aria-hidden="true"></span>
      <b class="co2">CO₂</b> <span class="ch4-val" data-gas="co2">${fmt(GAS.co2.base, 1)}</span> ppm
      <span class="ch4-sep" aria-hidden="true">·</span>
      <b>CH₄</b> <span class="ch4-val" data-gas="ch4">${fmt(GAS.ch4.base, 0)}</span>
      <span class="ch4-sep" aria-hidden="true">·</span>
      <b class="n2o">N₂O</b> <span class="ch4-val" data-gas="n2o">${fmt(GAS.n2o.base, 1)}</span> ppb<small>Mace Head</small></span>`;
  header.appendChild(tower);

  const card = document.createElement("div");
  card.className = "ch4-card";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Mace Head atmospheric station");
  const readTile = g => `
    <div class="ch4-c-tile ${g}"><span class="ch4-c-gas">${GAS[g].name}</span>
      <div class="ch4-c-read"><b class="ch4-c-val" data-gas="${g}">${fmt(GAS[g].base, GAS[g].dec)}</b> ${GAS[g].unit}</div>
      <span class="ch4-c-what">${GAS[g].long}</span>
      <svg class="ch4-c-spark ${g}" viewBox="0 0 240 22" preserveAspectRatio="none" aria-hidden="true"><path class="ch4-c-area"/><path class="ch4-c-line"/></svg></div>`;
  card.innerHTML = `
    <div class="ch4-c-head"><span><i class="bi bi-broadcast-pin" aria-hidden="true"></i> Mace Head atmospheric station</span>
      <button type="button" class="ch4-x" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>
    <div class="ch4-tabs" role="tablist" aria-label="Station views">
      <button type="button" role="tab" class="ch4-tab" data-view="trend" aria-selected="true"><i class="bi bi-graph-down" aria-hidden="true"></i> CO₂ over the years</button>
      <button type="button" role="tab" class="ch4-tab" data-view="live" aria-selected="false"><i class="bi bi-broadcast" aria-hidden="true"></i> Live readings</button>
    </div>
    <div class="ch4-view" data-view="trend" role="tabpanel">
      <div class="ch4-t-title">Ireland&rsquo;s CO₂ emissions <span class="ch4-t-src"></span></div>
      <div class="ch4-t-stats" aria-live="polite"></div>
      <svg class="ch4-t-chart" viewBox="0 0 360 112" tabindex="0" role="img" aria-label="Ireland's CO₂ emissions by year; use the arrow keys to read each year"></svg>
      <div class="ch4-c-foot"><button type="button" class="ch4-c-go ch4-go-trend"><i class="bi bi-activity" aria-hidden="true"></i> Explore CO₂ in Trend Analysis</button>
        <span class="ch4-c-hits">Source: EPA national inventory</span></div>
    </div>
    <div class="ch4-view" data-view="live" role="tabpanel" hidden>
      <div class="ch4-c-tiles">${readTile("co2")}${readTile("ch4")}${readTile("n2o")}</div>
      <p>Chimneys release <b>CO₂</b>, cattle and wet bogs <b>methane</b>, fertilised soils <b>nitrous oxide</b>. The wind carries them to <b>Mace Head</b>; <b>inverse models</b> use the CH₄ and N₂O readings to trace their sources.</p>
      <div class="ch4-c-foot"><button type="button" class="ch4-c-go ch4-go-maps"><i class="bi bi-globe-europe-africa" aria-hidden="true"></i> See the inverse-model maps</button>
        <span class="ch4-c-hits"><span class="ch4-c-n co2" data-gas="co2">0</span> CO₂ · <span class="ch4-c-n" data-gas="ch4">0</span> CH₄ · <span class="ch4-c-n n2o" data-gas="n2o">0</span> N₂O measured</span></div>
      <p class="ch4-c-note" title="CO₂ about 424–428 ppm; CH₄ about 1,950–2,000 ppb; N₂O about 337–339 ppb">Illustration: simulated around typical Mace Head levels.</p>
    </div>`;
  header.appendChild(card);

  /* ---------- "CO₂ over the years": Ireland's CO₂ emissions from the EPA inventory (the page's own data) ---------- */
  const inv = typeof REAL_DATA !== "undefined" ? REAL_DATA : {}, invYears = typeof DATA_YEARS !== "undefined" ? DATA_YEARS : [];
  const co2Key = Object.keys(inv).find(k => /^CO2$/i.test(k));
  const series = co2Key ? invYears.map((y, i) => [y, inv[co2Key][i]]).filter(p => p[1] != null && isFinite(p[1])).map(([y, v]) => [y, v / 1000]) : [];
  const chart = card.querySelector(".ch4-t-chart"), statsEl = card.querySelector(".ch4-t-stats");
  let focusI = series.length - 1;
  function drawTrend() {
    if (series.length < 2) { statsEl.textContent = "The inventory data could not be loaded."; return; }
    const first = series[0], last = series[series.length - 1];
    const peak = series.reduce((a, b) => (b[1] > a[1] ? b : a));
    card.querySelector(".ch4-t-src").textContent = `${first[0]}–${last[0]} · Mt CO₂`;
    const pc = (a, b) => (a / b - 1) * 100, sg = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(0) + "%";
    statsEl.innerHTML = `<b>${last[1].toFixed(1)} Mt</b> in ${last[0]} · ${sg(pc(last[1], peak[1]))} since the ${peak[0]} peak (${peak[1].toFixed(1)} Mt) · ${sg(pc(last[1], first[1]))} since ${first[0]}`;
    const L = 30, Rr = 352, T = 8, B = 94;
    const x0 = first[0], x1 = last[0], vs = series.map(p => p[1]);
    const y0 = Math.floor(Math.min(...vs) / 5) * 5, y1 = Math.ceil(Math.max(...vs) / 5) * 5;
    const X = y => L + ((y - x0) / (x1 - x0)) * (Rr - L), Y = v => B - ((v - y0) / (y1 - y0)) * (B - T);
    const line = series.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("");
    let g = "";
    for (let v = y0; v <= y1; v += 5) g += `<line class="ch4-t-grid" x1="${L}" x2="${Rr}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ch4-t-ax" x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
    for (let y = Math.ceil(x0 / 10) * 10; y < x1 - 2; y += 10) g += `<text class="ch4-t-ax" x="${X(y)}" y="${B + 12}" text-anchor="middle">${y}</text>`;
    g += `<text class="ch4-t-ax" x="${X(x1)}" y="${B + 12}" text-anchor="end">${x1}</text>`;
    chart.innerHTML = g + `<path class="ch4-t-area" d="${line}L${X(x1)} ${B}L${X(x0)} ${B}Z"/><path class="ch4-t-line" d="${line}"/>
      <circle class="ch4-t-peak" cx="${X(peak[0])}" cy="${Y(peak[1])}" r="3.2"/>
      <g class="ch4-t-cur"><line class="ch4-t-cursor" y1="${T}" y2="${B}"/><circle class="ch4-t-dot" r="3.6"/>
        <rect class="ch4-t-tipbg" rx="4" height="17"/><text class="ch4-t-tip" y="0"></text></g>`;
    chart._geo = { X, Y };
    showYear(focusI);
  }
  function showYear(i) {
    if (!chart._geo || !series.length) return;
    focusI = Math.max(0, Math.min(series.length - 1, i));
    const [yr, v] = series[focusI], { X, Y } = chart._geo, x = X(yr), y = Y(v);
    const cur = chart.querySelector(".ch4-t-cur"), tip = cur.querySelector(".ch4-t-tip"), bg = cur.querySelector(".ch4-t-tipbg");
    cur.querySelector(".ch4-t-cursor").setAttribute("x1", x); cur.querySelector(".ch4-t-cursor").setAttribute("x2", x);
    cur.querySelector(".ch4-t-dot").setAttribute("cx", x); cur.querySelector(".ch4-t-dot").setAttribute("cy", y);
    tip.textContent = `${yr} · ${v.toFixed(1)} Mt`;
    const w = tip.getComputedTextLength ? tip.getComputedTextLength() + 10 : 70;
    const tx = Math.min(352 - w, Math.max(30, x - w / 2)), ty = Math.max(2, y - 24);
    bg.setAttribute("x", tx); bg.setAttribute("y", ty); bg.setAttribute("width", w);
    tip.setAttribute("x", tx + 5); tip.setAttribute("y", ty + 12);
    chart.setAttribute("aria-label", `Ireland's CO₂ emissions: ${yr}, ${v.toFixed(1)} megatonnes. Use the arrow keys to read other years`);
  }
  chart.addEventListener("pointermove", e => {
    if (!chart._geo) return;
    const r = chart.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * 360;
    let best = 0; series.forEach((p, i) => { if (Math.abs(chart._geo.X(p[0]) - vx) < Math.abs(chart._geo.X(series[best][0]) - vx)) best = i; });
    showYear(best);
  });
  chart.addEventListener("keydown", e => {
    const d = { ArrowLeft: -1, ArrowRight: 1, Home: -999, End: 999 }[e.key];
    if (d) { e.preventDefault(); showYear(d === -999 ? 0 : d === 999 ? series.length - 1 : focusI + d); }
  });
  card.querySelector(".ch4-go-trend").addEventListener("click", async () => {
    openCard(false);
    if (typeof window.activateTab !== "function") return;
    window.activateTab("trend");                                     // then pick CO₂ once the chart is ready
    for (let k = 0; k < 40; k++) {
      const sel = document.getElementById("trGas");
      const opt = sel && [...sel.options].find(o => /^CO(2|₂)$/.test(o.value));
      if (opt) { if (sel.value !== opt.value) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } break; }
      await new Promise(r => setTimeout(r, 150));
    }
  });

  // Tabs: CO₂ over the years | Live readings
  const tabs = [...card.querySelectorAll(".ch4-tab")];
  const showView = v => {
    tabs.forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === v)));
    card.querySelectorAll(".ch4-view").forEach(p => { p.hidden = p.dataset.view !== v; });
    if (v === "trend") drawTrend(); else drawSparks();
  };
  tabs.forEach(t => t.addEventListener("click", () => showView(t.dataset.view)));
  card.querySelector(".ch4-tabs").addEventListener("keydown", e => {
    const i = tabs.indexOf(document.activeElement), d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (i < 0 || !d) return;
    e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); showView(n.dataset.view);
  });

  const openCard = on => {
    card.hidden = !on;
    tower.setAttribute("aria-expanded", String(on));
    tower.classList.toggle("open", on);
    if (on) { showView("trend"); card.querySelector(".ch4-tab[aria-selected='true']").focus({ preventScroll: true }); }
  };
  tower.addEventListener("click", e => { e.stopPropagation(); openCard(card.hidden); });
  card.querySelector(".ch4-x").addEventListener("click", () => { openCard(false); tower.focus({ preventScroll: true }); });
  card.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => { if (!card.hidden) openCard(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !card.hidden) { openCard(false); tower.focus({ preventScroll: true }); } });
  card.querySelector(".ch4-go-maps").addEventListener("click", () => {
    openCard(false);
    location.hash = "#mapping/RasterLayer?ds=inverse";             // Spatial Mapping on the PARIS inverse models
  });

  /* ---------- The readings: background level + gas that has arrived ---------- */
  const t0 = performance.now();
  const R = {};
  Object.keys(GAS).forEach(g => { R[g] = { enh: 0, hits: 0, shown: GAS[g].base, hist: [] }; });
  const reading = (g, now) => GAS[g].base + GAS[g].swing * (Math.sin((now - t0) / 9000) + 0.5 * Math.sin((now - t0) / 3100)) + R[g].enh;
  function drawSparks() {
    Object.keys(GAS).forEach(g => {
      const hist = R[g].hist; if (hist.length < 2) return;
      const pad = GAS[g].swing * 0.6, lo = Math.min(...hist) - pad, hi = Math.max(...hist) + pad, W = 240, H = 22;
      const X = i => (i / (hist.length - 1)) * W, Y = v => H - ((v - lo) / (hi - lo)) * H;
      const d = hist.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join("");
      const svg = card.querySelector(".ch4-c-spark." + g);
      svg.querySelector(".ch4-c-line").setAttribute("d", d);
      svg.querySelector(".ch4-c-area").setAttribute("d", d + `L${W} ${H}L0 ${H}Z`);
    });
  }
  let lastUi = 0;
  function updateUi(now) {
    if (now - lastUi < 250) return;
    lastUi = now;
    Object.keys(GAS).forEach(g => {
      const r = R[g];
      r.shown += (reading(g, now) - r.shown) * 0.35;
      header.querySelectorAll(`.ch4-val[data-gas="${g}"], .ch4-c-val[data-gas="${g}"]`).forEach(el => { el.textContent = fmt(r.shown, GAS[g].dec); });
      card.querySelector(`.ch4-c-n[data-gas="${g}"]`).textContent = fmt(r.hits, 0);
      r.hist.push(r.shown); if (r.hist.length > 120) r.hist.shift();
    });
    if (!card.hidden) drawSparks();
  }

  /* ---------- The particles (canvas behind the banner content) ---------- */
  const canvas = document.createElement("canvas");
  canvas.className = "ch4-canvas";
  canvas.setAttribute("aria-hidden", "true");
  scene.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, hr = null;
  const sprites = {};                                     // a soft glowing dot per gas, drawn once
  Object.keys(GAS).forEach(g => {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const x = c.getContext("2d"), r = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, GAS[g].core); r.addColorStop(.35, GAS[g].mid); r.addColorStop(1, GAS[g].edge);
    x.fillStyle = r; x.fillRect(0, 0, 32, 32); sprites[g] = c;
  });
  function size() {
    hr = header.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = hr.width; H = hr.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Where things are, in banner coordinates (cows walk, so they are re-read now and then)
  let cows = [], pools = [], stacks = [], inlet = { x: 0, y: 0 }, lastGeo = 0;
  const centreOf = r => ({ x: r.left - hr.left + r.width / 2, y: r.top - hr.top + r.height / 2 });
  function geometry(now) {
    if (now - lastGeo < 500 && cows.length) return;
    lastGeo = now;
    hr = header.getBoundingClientRect();
    cows = [...scene.querySelectorAll(".hs-cow")].map(c => c.getBoundingClientRect())
      .filter(r => r.width > 0 && r.right > hr.left && r.left < hr.right)
      .map(r => ({ x: r.left - hr.left + r.width * 0.75, y: r.top - hr.top + r.height * 0.35, foot: r.bottom - hr.top }));
    pools = [...scene.querySelectorAll(".hs-pool")].map(p => p.getBoundingClientRect())
      .filter(r => r.width > 0 && r.right > hr.left && r.left < hr.right).map(centreOf);
    stacks = [...scene.querySelectorAll(".hs-stack-top")].map(p => p.getBoundingClientRect())
      .filter(r => r.width > 0 && r.right > hr.left && r.left < hr.right).map(centreOf);
    const t = tower.querySelector(".ch4-inlet").getBoundingClientRect();
    inlet = { x: t.left - hr.left + t.width / 2, y: t.top - hr.top + t.height / 2 };
  }

  const P = [];
  const lastLabel = { co2: 0, ch4: 0, n2o: 0 };
  const field = () => ({ x: W * (0.03 + Math.random() * 0.55), y: H * (0.74 + Math.random() * 0.13) });
  function spawn(gas, x, y, big, now) {
    if (P.length > 260) return;
    const label = now - lastLabel[gas] > 3200 && Math.random() < 0.5;
    if (label) lastLabel[gas] = now;
    P.push({ gas, x, y, vx: 0, vy: -(8 + Math.random() * 14) * SPEED, r: (big ? 3.2 : 2.6) + Math.random() * 2.2,
             age: 0, life: (34 + Math.random() * 12) / SPEED * 0.85, seed: Math.random() * 1000, label });
  }
  let flashUntil = 0;
  function step(dt, now) {
    geometry(now);
    // Emission, per second at 1440 px. Rates follow SPEED, so the amount on screen stays the same.
    // CH4: cattle (enteric fermentation), wet peatland (bog pools), farm fields (manure, slurry)
    // N2O: fertilised fields and the grazed grass around the cattle (dung and urine patches)
    // CO2: the chimneys of the power station (fuel burnt for electricity)
    const rate = dt * (W / 1440) * SPEED;
    cows.forEach(c => {
      if (Math.random() < 0.6 * rate) spawn("ch4", c.x + (Math.random() - .5) * 6, c.y, true, now);
      if (Math.random() < 0.2 * rate) spawn("n2o", c.x + (Math.random() - .5) * 30, c.foot - 2, false, now);
    });
    pools.forEach(p => { if (Math.random() < 0.2 * rate) spawn("ch4", p.x + (Math.random() - .5) * 14, p.y - 2, false, now); });
    if (Math.random() < 0.5 * rate) { const f = field(); spawn("ch4", f.x, f.y, false, now); }
    if (Math.random() < 0.75 * rate) { const f = field(); spawn("n2o", f.x, f.y, false, now); }
    // CO2: the power station's chimneys
    stacks.forEach(st => { if (Math.random() < 0.45 * rate) spawn("co2", st.x + (Math.random() - .5) * 3, st.y - 2, true, now); });

    const wind = (30 + W * 0.03) * SPEED, reach = Math.max(300, W * 0.38), slow = 1 / SPEED;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt;
      const gust = Math.sin(now / (1700 * slow) + p.seed) * 0.5 + Math.sin(now / (610 * slow) + p.seed * 2) * 0.3;
      const dx = inlet.x - p.x, dy = inlet.y - p.y;
      // drift with the wind, rise and swirl; near the tower, the air is drawn into the inlet
      let tvx = wind * (0.8 + 0.4 * gust), tvy = (-6 + 10 * Math.sin(now / (900 * slow) + p.seed)) * SPEED;
      if (dx > -12 && dx < reach) {
        const pull = Math.pow(1 - Math.max(0, dx) / reach, 1.6);
        tvy += (dy / Math.max(30, dx)) * wind * 1.2 * pull + dy * 1.2 * pull * SPEED;
        tvx += wind * 0.6 * pull;
      }
      p.vx += (tvx - p.vx) * Math.min(1, dt * 1.8);
      p.vy += (tvy - p.vy) * Math.min(1, dt * 1.8);
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (Math.hypot(dx, dy) < 12) {                    // measured
        P.splice(i, 1); R[p.gas].hits++; R[p.gas].enh += GAS[p.gas].perHit; flashUntil = now + 220; continue;
      }
      if (p.age > p.life || p.x > W + 20 || p.y < -20 || p.y > H + 20) P.splice(i, 1);
    }
    Object.keys(GAS).forEach(g => { R[g].enh *= Math.exp(-dt / 7); });   // the excess dilutes away
    tower.classList.toggle("hit", now < flashUntil);
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.font = "700 11px 'Source Sans 3', sans-serif";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)";
    for (const p of P) {
      const a = Math.min(1, p.age / 1.5) * Math.min(1, (p.life - p.age) / 4);
      const s = p.r * 2.6;
      ctx.globalAlpha = 0.62 * a;
      ctx.drawImage(sprites[p.gas], p.x - s, p.y - s, s * 2, s * 2);
      if (p.label) {
        ctx.globalAlpha = 0.88 * a;
        ctx.fillStyle = GAS[p.gas].text;
        ctx.strokeText(GAS[p.gas].name, p.x + 6, p.y - 6); ctx.fillText(GAS[p.gas].name, p.x + 6, p.y - 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- Click a cow (puff of methane) or the peatland (bubbles) ---------- */
  function burst(x, y, n, spread) {
    for (let k = 0; k < n; k++) {
      if (P.length > 300) break;
      const a = -Math.PI / 2 + (Math.random() - .5) * spread, pop = 0.5;   // a quick pop, then the slow wind takes over
      P.push({ gas: "ch4", x: x + (Math.random() - .5) * 6, y, vx: Math.cos(a) * (20 + Math.random() * 30) * pop, vy: Math.sin(a) * (24 + Math.random() * 30) * pop,
               r: 2.8 + Math.random() * 2.4, age: 0.4, life: (34 + Math.random() * 10) / SPEED * 0.85, seed: Math.random() * 1000, label: k === 0 });
    }
    lastLabel.ch4 = performance.now();
    kick();
  }
  function release(el) {
    hr = header.getBoundingClientRect();
    if (el.classList.contains("hs-cow")) {
      const r = el.getBoundingClientRect();
      burst(r.left - hr.left + r.width * 0.75, r.top - hr.top + r.height * 0.3, 14, 1.6);
      el.classList.remove("moo"); void el.getBBox(); el.classList.add("moo");
      setTimeout(() => el.classList.remove("moo"), 650);
    } else {
      [...el.querySelectorAll(".hs-pool")].forEach(p => { const c = centreOf(p.getBoundingClientRect()); burst(c.x, c.y - 2, 5, 0.8); });
      el.classList.remove("bubble"); void el.getBBox(); el.classList.add("bubble");
      setTimeout(() => el.classList.remove("bubble"), 900);
    }
  }
  scene.addEventListener("click", e => { const t = e.target.closest(".hs-cow, .hs-peat"); if (t) { e.stopPropagation(); release(t); } });
  scene.addEventListener("keydown", e => {
    const t = e.target.closest && e.target.closest(".hs-cow, .hs-peat");
    if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); release(t); }
  });

  /* ---------- Run only while the banner is on screen ---------- */
  let visible = true, raf = 0, last = 0;
  const active = () => !root.classList.contains("hdr-shrinkable") && visible && !document.hidden && window.innerWidth >= 768;
  function frame(now) {
    raf = 0;
    if (!active()) { ctx.clearRect(0, 0, W, H); return; }
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (!still.matches) { step(dt, now); draw(); } else { Object.keys(GAS).forEach(g => { R[g].enh = 0; }); }
    updateUi(now);
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && active()) { last = 0; raf = requestAnimationFrame(frame); } };
  if ("IntersectionObserver" in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; kick(); }).observe(header);
  document.addEventListener("visibilitychange", kick);
  if (window.ResizeObserver) new ResizeObserver(() => { size(); lastGeo = 0; }).observe(header);   // banner <-> slim bar
  new MutationObserver(() => { if (root.classList.contains("hdr-shrinkable")) openCard(false); kick(); })
    .observe(root, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", () => { size(); lastGeo = 0; kick(); });
  size();
  // Warm-up: run the first stretch at once (longer when the drift is slow), so the streams already
  // reach the tower when the page opens
  if (!still.matches && window.innerWidth >= 768) {
    const n = Math.round(400 / SPEED);
    let t = performance.now() - n * 50;
    for (let k = 0; k < n; k++) { step(0.05, t); t += 50; }
    Object.keys(GAS).forEach(g => { R[g].hits = 0; });
  }
  kick();
})();
