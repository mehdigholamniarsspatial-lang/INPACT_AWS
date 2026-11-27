/* =====================================================================
   Landing banner: methane from farmland to the measurement tower
   (hero-ch4.js + the "CH4" part of hero.css)

   An illustration of how atmospheric measurements see farm emissions:
   methane (CH4) rises from the grazing cattle and from the fields, drifts
   with the wind across the banner and is drawn into the inlet of a
   measurement tower like the one at Mace Head (Co. Galway). The tower is a
   button: its reading rises as methane arrives, and it opens a short card
   that explains what the station measures, with a live trace and a link
   to the inverse-model maps in Spatial Mapping.

   The particles and the reading are an illustration, not data: the reading
   moves around typical Mace Head methane levels (about 1,950-2,000 ppb).
   Runs only on the landing banner, pauses when the banner is off screen or
   the tab is hidden, and is still (no particles) for reduced motion.
   ===================================================================== */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-standalone")) return;
  const header = document.querySelector(".app-header");
  const scene = header && header.querySelector(".hero-scene");
  if (!scene || header.querySelector(".ch4-tower")) return;

  const BASE_PPB = 1958;                                 // typical recent Mace Head CH4 level (illustrative)
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fmt = v => Math.round(v).toLocaleString("en-IE");

  /* ---------- The tower (a button) with its reading and card ---------- */
  const tower = document.createElement("button");
  tower.type = "button";
  tower.className = "ch4-tower";
  tower.setAttribute("aria-haspopup", "dialog");
  tower.setAttribute("aria-expanded", "false");
  tower.setAttribute("aria-label", "Mace Head atmospheric station: methane reading. Open details");
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
    <span class="ch4-chip"><span class="ch4-dot" aria-hidden="true"></span><b>CH₄</b> <span class="ch4-val">${fmt(BASE_PPB)}</span> ppb<small>Mace Head</small></span>`;
  header.appendChild(tower);

  const card = document.createElement("div");
  card.className = "ch4-card";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Mace Head atmospheric station");
  card.innerHTML = `
    <div class="ch4-c-head"><span><i class="bi bi-broadcast-pin" aria-hidden="true"></i> Mace Head atmospheric station</span>
      <button type="button" class="ch4-x" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>
    <div class="ch4-c-read"><b class="ch4-c-val">${fmt(BASE_PPB)}</b> ppb <span>methane (CH₄) in the air</span></div>
    <svg class="ch4-c-spark" viewBox="0 0 240 40" preserveAspectRatio="none" aria-hidden="true"><path class="ch4-c-area"/><path class="ch4-c-line"/></svg>
    <p>Cattle, manure and farm soils release methane. When the wind blows from the land, it carries this methane to stations such as <b>Mace Head</b> on the Galway coast. <b>Inverse models</b> use these measurements to work out where the emissions came from.</p>
    <div class="ch4-c-foot"><button type="button" class="ch4-c-go"><i class="bi bi-globe-europe-africa" aria-hidden="true"></i> See the inverse-model maps</button>
      <span class="ch4-c-hits"><span class="ch4-c-n">0</span> plumes measured</span></div>
    <p class="ch4-c-note">Animation for illustration: the reading is simulated around typical Mace Head levels (about 1,950–2,000 ppb).</p>`;
  header.appendChild(card);

  const valEls = [tower.querySelector(".ch4-val"), card.querySelector(".ch4-c-val")];
  const nEl = card.querySelector(".ch4-c-n");
  const sparkLine = card.querySelector(".ch4-c-line"), sparkArea = card.querySelector(".ch4-c-area");
  const openCard = on => {
    card.hidden = !on;
    tower.setAttribute("aria-expanded", String(on));
    tower.classList.toggle("open", on);
    if (on) { drawSpark(); card.querySelector(".ch4-c-go").focus({ preventScroll: true }); }
  };
  tower.addEventListener("click", e => { e.stopPropagation(); openCard(card.hidden); });
  card.querySelector(".ch4-x").addEventListener("click", () => { openCard(false); tower.focus({ preventScroll: true }); });
  card.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => { if (!card.hidden) openCard(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !card.hidden) { openCard(false); tower.focus({ preventScroll: true }); } });
  card.querySelector(".ch4-c-go").addEventListener("click", () => {
    openCard(false);
    location.hash = "#mapping/RasterLayer?ds=inverse";             // Spatial Mapping on the PARIS inverse models
  });

  /* ---------- The reading: background level + methane that has arrived ---------- */
  let enh = 0, hits = 0, shown = BASE_PPB, t0 = performance.now();
  const hist = [];
  function reading(now) {
    const base = BASE_PPB + 4 * Math.sin((now - t0) / 9000) + 2 * Math.sin((now - t0) / 3100);
    return base + enh;
  }
  function drawSpark() {
    if (hist.length < 2) return;
    const lo = Math.min(...hist) - 2, hi = Math.max(...hist) + 2, W = 240, H = 40;
    const X = i => (i / (hist.length - 1)) * W, Y = v => H - ((v - lo) / (hi - lo)) * H;
    const d = hist.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join("");
    sparkLine.setAttribute("d", d);
    sparkArea.setAttribute("d", d + `L${W} ${H}L0 ${H}Z`);
  }
  let lastUi = 0;
  function updateUi(now) {
    if (now - lastUi < 250) return;
    lastUi = now;
    shown += (reading(now) - shown) * 0.35;
    valEls.forEach(el => { el.textContent = fmt(shown); });
    hist.push(shown); if (hist.length > 90) hist.shift();
    nEl.textContent = fmt(hits);
    if (!card.hidden) drawSpark();
  }

  /* ---------- The particles (canvas behind the banner content) ---------- */
  const canvas = document.createElement("canvas");
  canvas.className = "ch4-canvas";
  canvas.setAttribute("aria-hidden", "true");
  scene.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, hr = null;
  const sprite = (() => {                                // a soft glowing dot, drawn once
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d"), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, "rgba(255,214,140,1)"); r.addColorStop(.35, "rgba(240,168,58,.85)"); r.addColorStop(1, "rgba(240,168,58,0)");
    g.fillStyle = r; g.fillRect(0, 0, 32, 32); return c;
  })();
  function size() {
    hr = header.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = hr.width; H = hr.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Where things are, in banner coordinates (cows walk, so they are re-read now and then)
  let cows = [], inlet = { x: 0, y: 0 }, lastGeo = 0;
  function geometry(now) {
    if (now - lastGeo < 500 && cows.length) return;
    lastGeo = now;
    hr = header.getBoundingClientRect();
    cows = [...scene.querySelectorAll(".hs-cow")].map(c => c.getBoundingClientRect())
      .filter(r => r.width > 0 && r.right > hr.left && r.left < hr.right)
      .map(r => ({ x: r.left - hr.left + r.width * 0.75, y: r.top - hr.top + r.height * 0.35 }));
    const t = tower.querySelector(".ch4-inlet").getBoundingClientRect();
    inlet = { x: t.left - hr.left + t.width / 2, y: t.top - hr.top + t.height / 2 };
  }

  const P = [];
  let lastLabel = 0;
  function spawn(x, y, fromCow, now) {
    if (P.length > 260) return;
    const label = now - lastLabel > 2600 && Math.random() < 0.5;
    if (label) lastLabel = now;
    P.push({ x, y, vx: 0, vy: -(8 + Math.random() * 14), r: (fromCow ? 3.2 : 2.6) + Math.random() * 2.2,
             age: 0, life: 34 + Math.random() * 12, seed: Math.random() * 1000, label });
  }
  let flashUntil = 0;
  function step(dt, now) {
    geometry(now);
    // emission: the cattle (enteric fermentation) and the fields (manure, soils)
    const rate = dt * (W / 1440);
    cows.forEach(c => { if (Math.random() < 2.2 * rate) spawn(c.x + (Math.random() - .5) * 6, c.y, true, now); });
    if (Math.random() < 2.8 * rate) spawn(W * (0.03 + Math.random() * 0.55), H * (0.74 + Math.random() * 0.13), false, now);
    const wind = 30 + W * 0.03, reach = Math.max(300, W * 0.38);
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt;
      const gust = Math.sin(now / 1700 + p.seed) * 0.5 + Math.sin(now / 610 + p.seed * 2) * 0.3;
      const dx = inlet.x - p.x, dy = inlet.y - p.y;
      // drift with the wind, rise and swirl; near the tower, the air is drawn into the inlet
      let tvx = wind * (0.8 + 0.4 * gust), tvy = -6 + 10 * Math.sin(now / 900 + p.seed);
      if (dx > -12 && dx < reach) {
        const pull = Math.pow(1 - Math.max(0, dx) / reach, 1.6);
        tvy += (dy / Math.max(30, dx)) * wind * 1.2 * pull + dy * 1.2 * pull;
        tvx += wind * 0.6 * pull;
      }
      p.vx += (tvx - p.vx) * Math.min(1, dt * 1.8);
      p.vy += (tvy - p.vy) * Math.min(1, dt * 1.8);
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (Math.hypot(dx, dy) < 12) {                    // measured
        P.splice(i, 1); hits++; enh += 0.32; flashUntil = now + 220; continue;
      }
      if (p.age > p.life || p.x > W + 20 || p.y < -20 || p.y > H + 20) P.splice(i, 1);
    }
    enh *= Math.exp(-dt / 7);                            // the excess dilutes away
    tower.classList.toggle("hit", now < flashUntil);
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of P) {
      const a = Math.min(1, p.age / 1.2) * Math.min(1, (p.life - p.age) / 3);
      const s = p.r * 2.6;
      ctx.globalAlpha = 0.62 * a;
      ctx.drawImage(sprite, p.x - s, p.y - s, s * 2, s * 2);
      if (p.label) {
        ctx.globalAlpha = 0.85 * a;
        ctx.font = "700 11px 'Source Sans 3', sans-serif";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.fillStyle = "#8A5208";
        ctx.strokeText("CH₄", p.x + 6, p.y - 6); ctx.fillText("CH₄", p.x + 6, p.y - 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- Run only while the banner is on screen ---------- */
  let visible = true, raf = 0, last = 0;
  const active = () => !root.classList.contains("hdr-shrinkable") && visible && !document.hidden && window.innerWidth >= 768;
  function frame(now) {
    raf = 0;
    if (!active()) { ctx.clearRect(0, 0, W, H); return; }
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    if (!still.matches) { step(dt, now); draw(); } else { enh = 0; }
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
  // Warm-up: run the first 20 s at once, so the stream already reaches the tower when the page opens
  if (!still.matches && window.innerWidth >= 768) {
    let t = performance.now() - 20000;
    for (let k = 0; k < 400; k++) { step(0.05, t); t += 50; }
    hits = 0; enh = 0.6 * enh;
  }
  kick();
})();
