/* =====================================================================
   Landing banner ("hero", hero.css) for the main dashboard.
   On the landing page (before any tab is chosen) the header becomes a wide
   banner: an Irish landscape drawn in SVG (sky, hills, coast, wind turbines,
   a power station, grazing cattle and an atmospheric measurement mast), a
   glowing map of Ireland with the measurement stations, a glass panel with
   the live national emissions trend, and the dashboard's sections as
   floating cards with figures read from the page's own data (Explorer
   Dashboard is this page, so it has no card). Choosing a section turns the
   header into the slim bar with the menu on the left (atmosphere.css,
   menu.css); Explorer Dashboard brings this page back (menu.js).
   Decoration is aria-hidden; the cards are real buttons.
   ===================================================================== */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-standalone")) return;            // /map/ keeps the compact header
  const header = document.querySelector(".app-header");
  const inner = header && header.querySelector(".header-inner");
  if (!header || !inner || header.querySelector(".hero-scene")) return;

  const IRELAND = "M192 32L183 38L180 52L174 59L174 64L168 64L161 68L156 65L151 69L156 75L164 76L165 78L154 85L147 84L143 90L137 92L150 108L154 110L156 117L165 118L171 124L177 126L182 124L187 127L187 123L189 122L190 126L192 119L198 116L198 113L194 109L195 105L206 97L214 104L214 111L219 118L222 120L225 118L228 121L226 131L229 134L244 132L245 127L249 128L260 137L257 141L245 137L244 145L245 150L252 152L253 172L262 183L258 192L255 192L258 194L259 198L263 199L262 201L258 199L253 203L260 209L260 215L264 227L263 237L267 242L258 256L253 271L254 283L245 297L244 303L238 302L239 300L237 301L242 309L244 305L243 308L247 314L246 318L243 320L243 316L231 320L224 316L218 316L221 312L217 314L218 319L211 325L212 320L207 309L209 320L206 324L200 325L202 321L200 320L200 322L196 324L181 325L173 329L171 328L169 331L174 332L172 338L165 340L164 343L157 342L156 340L155 345L152 346L154 349L147 352L146 355L133 357L137 352L136 348L122 349L128 351L127 355L130 355L130 361L121 368L119 366L119 370L114 367L118 368L116 376L113 373L102 373L106 374L106 380L97 378L92 384L88 381L81 381L81 384L76 385L75 389L72 387L65 390L69 384L64 387L64 383L62 381L52 388L49 385L46 390L39 393L38 389L55 376L37 383L53 372L61 369L62 365L57 365L55 361L55 365L51 369L36 372L27 378L19 378L25 374L23 370L31 367L29 366L30 364L35 361L34 363L36 363L37 360L41 361L40 359L44 354L53 350L37 357L35 355L20 363L15 359L18 356L14 352L8 359L8 353L5 353L5 349L13 347L10 342L13 339L26 333L30 329L33 331L34 325L42 325L41 324L43 322L31 323L31 327L29 324L17 327L12 324L10 325L12 326L7 325L7 326L2 328L0 322L4 318L6 320L7 315L12 311L18 309L19 314L22 314L26 311L25 307L28 307L28 312L32 314L44 313L36 310L35 308L37 309L37 307L39 307L38 300L31 297L43 292L46 289L50 290L47 286L51 280L60 282L72 280L85 275L88 276L90 273L103 270L90 268L91 260L86 263L79 275L71 279L68 278L71 274L62 277L53 271L55 274L47 277L46 280L32 282L39 278L51 265L58 263L59 258L67 245L59 244L72 223L78 227L84 226L80 222L88 223L85 221L89 220L92 223L90 220L94 216L85 216L90 214L88 213L91 212L87 210L57 215L54 212L55 209L51 214L51 206L55 204L52 202L55 199L51 200L50 205L49 199L44 207L40 208L34 206L35 202L41 199L39 198L40 196L37 199L37 195L34 195L31 200L25 197L18 197L20 193L25 193L23 190L28 190L22 189L19 184L16 184L18 183L24 181L28 184L30 182L26 178L36 176L46 178L34 173L34 162L54 159L51 156L55 152L53 151L54 148L43 148L34 152L32 150L33 143L36 142L41 147L41 143L34 136L38 127L35 127L33 131L30 130L29 128L34 126L30 120L32 120L28 116L26 122L23 122L24 129L21 129L25 116L22 115L29 108L30 111L35 112L33 116L30 114L29 116L34 118L38 111L42 113L40 110L43 110L38 106L41 105L46 107L72 108L75 111L75 116L79 124L80 118L85 109L91 109L96 112L107 111L113 118L117 118L110 113L112 110L119 111L113 108L116 106L108 105L108 102L119 95L120 91L121 94L135 88L131 86L137 76L139 78L140 74L130 78L129 74L120 82L124 78L122 74L120 78L118 75L114 78L107 76L100 72L100 69L109 62L120 63L116 60L123 62L114 57L118 53L128 55L125 53L126 50L129 51L127 48L123 50L121 46L121 44L126 44L120 38L123 38L127 32L128 35L131 23L139 23L138 26L149 16L150 18L147 21L153 20L153 23L156 22L154 25L156 25L155 17L159 13L158 19L164 22L165 29L167 24L165 18L164 17L164 21L160 17L162 13L168 11L170 19L175 27L169 33L173 34L167 43L180 33L179 24L174 17L176 10L178 10L179 8L183 10L186 7L188 10L191 10L184 0L210 15L210 17L196 24L192 32ZM31 143L33 143L31 150L25 147L24 141L13 140L17 137L20 138L30 136L32 139L31 143ZM192 32L191 33L204 34L209 19L221 21L238 14L252 18L260 17L264 22L262 31L268 34L267 40L273 44L278 56L283 60L278 54L281 53L285 59L282 66L273 71L270 75L272 78L281 70L291 70L300 92L297 102L295 105L291 98L292 87L284 81L283 85L288 87L286 88L288 94L283 103L291 100L293 108L287 115L282 113L274 115L272 128L264 135L260 135L261 133L255 129L250 128L245 127L244 132L229 134L226 131L228 121L225 118L222 120L219 118L214 111L214 104L206 97L195 105L194 109L198 113L198 116L192 119L190 126L189 122L187 124L188 127L183 126L182 124L177 126L171 124L165 118L156 117L154 110L150 108L147 103L139 95L137 92L143 90L147 84L154 85L165 78L164 76L156 75L151 69L156 65L161 68L168 64L174 64L174 59L180 52L183 38L192 32Z";                                      // island outline, viewBox 0 0 300 393 (Natural Earth)
  const STATIONS = [                                                  // [x, y, label] on that outline
    [34, 205, "Mace Head"], [186, 12, "Malin Head"], [240, 316, "Carnsore Point"], [251, 203, "Dublin"]
  ];

  /* ---------- Live figures from the dashboard's own data ---------- */
  // REAL_DATA, DATA_YEARS and POLICIES_RAW are defined by the page's main script (injected by the server)
  const data = typeof REAL_DATA !== "undefined" ? REAL_DATA : {};
  const years = typeof DATA_YEARS !== "undefined" ? DATA_YEARS : [];
  const pols = typeof POLICIES_RAW !== "undefined" ? POLICIES_RAW : [];
  const key = Object.keys(data).find(k => /^all greenhouse/i.test(k)) || Object.keys(data)[0];
  const total = key ? data[key] : [];
  const pts = years.map((y, i) => [y, total[i]]).filter(p => p[1] != null && isFinite(p[1]));
  const last = pts[pts.length - 1], first = pts[0];
  const peak = pts.reduce((a, b) => (b[1] > a[1] ? b : a), pts[0] || [0, 0]);
  const pct = (a, b) => ((a / b - 1) * 100);
  const fmtMt = v => (v / 1000).toFixed(1);
  const gasVal = re => { const k = Object.keys(data).find(n => re.test(n)); const a = k ? data[k] : []; return a.length ? a[years.indexOf(last && last[0])] : null; };
  const co2 = gasVal(/^CO2$/), ch4 = gasVal(/^CH4/), n2o = gasVal(/^N2O/);
  const polReal = pols.filter(p => String(p.level || "").toLowerCase() !== "target");
  const polYears = polReal.map(p => +p.year).filter(isFinite);

  /* Sparkline of the national total (glass panel) */
  function sparkline(w, h) {
    if (pts.length < 2) return "";
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys) * 0.96, y1 = Math.max(...ys) * 1.02;
    const X = x => ((x - x0) / (x1 - x0)) * w, Y = y => h - ((y - y0) / (y1 - y0)) * h;
    const line = pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("");
    const bars = pts.filter((_, i) => i % 3 === 0).map(p =>
      `<rect x="${(X(p[0]) - 2).toFixed(1)}" y="${Y(p[1]).toFixed(1)}" width="4" height="${(h - Y(p[1])).toFixed(1)}" rx="1"/>`).join("");
    return `<svg class="hs-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <g class="hs-bars">${bars}</g>
      <path class="hs-area" d="${line}L${w} ${h}L0 ${h}Z"/><path class="hs-line" d="${line}"/>
      <circle class="hs-dot" cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="3.2"/></svg>`;
  }

  /* ---------- The landscape (viewBox 1600 x 260, anchored to the bottom) ---------- */
  const turbine = (x, y, s, d) => `<g class="hs-turbine" transform="translate(${x} ${y}) scale(${s})">
      <path d="M-1.4 0L-.6 -58H.6L1.4 0Z" class="hs-tower"/>
      <g class="hs-blades" style="animation-duration:${d}s"><path d="M0 -58L-2 -60L0 -92L2 -60Z"/><path d="M0 -58L-2 -60L0 -92L2 -60Z" transform="rotate(120 0 -58)"/>
      <path d="M0 -58L-2 -60L0 -92L2 -60Z" transform="rotate(240 0 -58)"/><circle cx="0" cy="-58" r="2.2"/></g></g>`;
  // A cow walks slowly forward, turns, walks back and grazes (hero.css); dur / delay keep the herd out of step
  const cow = (x, y, s, flip, dur, delay) => `<g class="hs-cow" role="button" tabindex="0" aria-label="Cow: release a puff of methane" transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})"><title>Cattle: click to release a puff of methane</title>
      <g class="hs-walk" style="animation-duration:${dur}s;animation-delay:-${delay}s"><g class="hs-bob">
      <path d="M-11 -2v8M-6 -1v7M6 -1v7M10 -2v8" class="hs-leg"/>
      <ellipse cx="0" cy="-6" rx="13" ry="6.5" class="hs-hide"/>
      <path d="M-6 -11c3 2 5 6 3 9-3 1-6-1-7-4zM4 -12c2 3 5 4 7 3l1 4c-3 2-8 1-9-2z" class="hs-patch"/>
      <path d="M12 -9l7-1 3 5-2 3-6 0z" class="hs-head" style="animation-delay:-${(delay * 0.7).toFixed(1)}s"/><path d="M-13 -7c-3 2-3 6-2 9" class="hs-tail"/></g></g></g>`;
  const tree = (x, y, r) => `<g class="hs-tree"><circle cx="${x}" cy="${y}" r="${r}"/><circle cx="${x + r * .8}" cy="${y + r * .25}" r="${r * .75}"/><circle cx="${x - r * .8}" cy="${y + r * .3}" r="${r * .7}"/></g>`;

  const scene = `
    <svg class="hs-land" viewBox="0 0 1600 260" preserveAspectRatio="xMidYMax slice" role="group" aria-label="Illustration: Irish farmland, peatland and coast; the cows and the bog can be clicked">
      <defs>
        <linearGradient id="hsSea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5DB4DE"/><stop offset="1" stop-color="#2E86BD"/></linearGradient>
        <linearGradient id="hsHillA" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#A5CF77"/><stop offset="1" stop-color="#7DB458"/></linearGradient>
        <linearGradient id="hsHillB" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7EBB52"/><stop offset="1" stop-color="#4F9A3C"/></linearGradient>
        <linearGradient id="hsWaveA" x1="0" x2="1"><stop offset="0" stop-color="#0B6B6A"/><stop offset=".55" stop-color="#0E8C8A"/><stop offset="1" stop-color="#14A3A0"/></linearGradient>
        <linearGradient id="hsWaveB" x1="0" x2="1"><stop offset="0" stop-color="#9FE3DD" stop-opacity=".9"/><stop offset="1" stop-color="#E7FAF7" stop-opacity=".9"/></linearGradient>
      </defs>
      <path class="hs-mtn" d="M0 176C120 150 210 158 300 148S470 128 560 146 700 134 780 150 930 120 1040 146 1180 150 1240 160V200H0Z"/>
      <rect x="980" y="168" width="620" height="60" fill="url(#hsSea)"/>
      <path class="hs-glint" d="M1060 186h90M1180 194h120M1330 182h80M1250 204h70"/>
      <path d="M0 186C160 168 300 176 420 170S640 160 760 176 980 182 1100 196 1200 206 1240 214V260H0Z" fill="url(#hsHillA)"/>
      <g class="hs-peat" role="button" tabindex="0" aria-label="Peatland: release methane bubbles from the bog pools">
        <title>Peatland: wet bogs release methane. Click to see the bog pools bubble</title>
        <path class="hs-bog" d="M24 184C70 176 120 181 170 178S260 175 300 178 380 175 440 179L446 204H18Z"/>
        <path class="hs-bog-dark" d="M40 190C90 186 140 191 190 188S290 186 330 189 400 187 436 190L440 204H30Z"/>
        <ellipse class="hs-heather" cx="70" cy="184" rx="22" ry="3.4"/><ellipse class="hs-heather" cx="205" cy="182" rx="26" ry="3.2"/>
        <ellipse class="hs-heather" cx="330" cy="183" rx="20" ry="3"/><ellipse class="hs-heather" cx="415" cy="185" rx="16" ry="2.6"/>
        <ellipse class="hs-pool" cx="96" cy="190" rx="13" ry="2.6"/><ellipse class="hs-pool" cx="168" cy="194" rx="9" ry="2.1"/>
        <ellipse class="hs-pool" cx="278" cy="189" rx="12" ry="2.4"/><ellipse class="hs-pool" cx="388" cy="193" rx="9" ry="2"/>
        <path class="hs-turf" d="M124 189l4-5 4 5zM131 189l4-5 4 5zM127.5 185l4-4.5 4 4.5zM222 191l4-5 4 5zM229 191l4-5 4 5zM346 189l3.5-4.5 3.5 4.5zM352 189l3.5-4.5 3.5 4.5z"/>
        <path class="hs-turf-bank" d="M110 196h52v2.4h-52zM300 196h46v2.2h-46z"/>
        <g class="hs-cotton"><circle cx="52" cy="182" r="1.3"/><circle cx="61" cy="184" r="1.3"/><circle cx="118" cy="186" r="1.3"/><circle cx="150" cy="182" r="1.3"/><circle cx="190" cy="184" r="1.3"/><circle cx="212" cy="186" r="1.3"/><circle cx="246" cy="182" r="1.3"/><circle cx="262" cy="184" r="1.3"/><circle cx="309" cy="186" r="1.3"/><circle cx="322" cy="182" r="1.3"/><circle cx="360" cy="184" r="1.3"/><circle cx="402" cy="186" r="1.3"/><circle cx="428" cy="182" r="1.3"/></g>
      </g>
      ${turbine(250, 172, .72, 7)}${turbine(300, 168, .62, 8.5)}${turbine(345, 171, .55, 6.4)}
      <g class="hs-plant">
        <rect x="520" y="160" width="120" height="22" rx="1"/><rect x="545" y="148" width="34" height="14"/>
        <rect x="650" y="166" width="46" height="16" rx="1"/>
        <path class="hs-stack" d="M592 182V138h7v44zM612 182V130h8v52zM706 182V144h6v38z"/>
        <path class="hs-band" d="M592 142h7v4h-7zM612 134h8v4h-8zM706 148h6v4h-6z"/>
      </g>
      <!-- chimney tops: where the CO2 leaves the power station (hero-ch4.js); the white smoke puffs were removed -->
      <g class="hs-stack-tops"><circle class="hs-stack-top" cx="595.5" cy="137" r="1.5"/><circle class="hs-stack-top" cx="616" cy="129" r="1.5"/><circle class="hs-stack-top" cx="709" cy="143" r="1.5"/></g>
      ${tree(470, 186, 7)}${tree(760, 184, 8)}${tree(820, 188, 6)}${tree(905, 190, 7)}
      <path d="M0 214C140 198 280 206 420 202S700 196 820 206 1060 222 1200 216 1460 206 1600 214V260H0Z" fill="url(#hsHillB)"/>
      <path class="hs-road" d="M760 260C820 238 900 226 1000 220S1160 210 1240 214"/>
      <path class="hs-road-mid" d="M760 260C820 238 900 226 1000 220S1160 210 1240 214"/>
      <g class="hs-car"><rect x="-9" y="-6" width="18" height="7" rx="2"/><rect x="-5" y="-10" width="10" height="5" rx="2"/></g>
      ${cow(170, 226, .95, false, 80, 5)}${cow(250, 220, .8, true, 64, 30)}${cow(380, 228, 1, false, 96, 52)}
      ${tree(1270, 210, 13)}${tree(1310, 206, 16)}${tree(1600, 200, 22)}${tree(1560, 210, 15)}
      <!-- the measurement tower is its own element now (hero-ch4.js), so it is always on screen -->
      <path d="M0 236C220 252 440 214 760 236S1300 262 1600 222V260H0Z" fill="url(#hsWaveB)"/>
      <path d="M0 246C260 262 520 232 840 248S1360 264 1600 238V260H0Z" fill="url(#hsWaveA)"/>
    </svg>
    <div class="hs-clouds" aria-hidden="true"><span></span><span></span><span></span><span></span></div>`;

  /* ---------- Glowing map of Ireland with the live trend panel ---------- */
  const stations = STATIONS.map(([x, y, n], i) =>
    `<g class="hs-st" style="animation-delay:${i * .7}s"><circle class="hs-st-ring" cx="${x}" cy="${y}" r="9"/><circle cx="${x}" cy="${y}" r="3.4"/><title>${n}</title></g>`).join("");
  const holo = `
    <div class="hs-holo" aria-hidden="true">
      <div class="hs-orbit"></div><div class="hs-orbit o2"></div>
      <svg class="hs-map" viewBox="-10 -10 320 413">
        <defs>
          <linearGradient id="hsIre" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#5BD18B"/><stop offset=".6" stop-color="#1FA37A"/><stop offset="1" stop-color="#0E8C8A"/></linearGradient>
          <pattern id="hsGrid" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M14 0H0V14" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".6"/></pattern>
          <filter id="hsGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <path d="${IRELAND}" class="hs-ire" fill="url(#hsIre)" filter="url(#hsGlow)"/>
        <path d="${IRELAND}" fill="url(#hsGrid)"/>
        <path d="${IRELAND}" class="hs-ire-edge"/>
        ${stations}
      </svg>
    </div>`;

  const shares = [["CO₂", co2, "co2"], ["CH₄", ch4, "ch4"], ["N₂O", n2o, "n2o"]].filter(g => g[1] != null && last);
  const panel = last ? `
    <div class="hs-panel" aria-hidden="true">
      <div class="hs-p-top"><span class="hs-p-k">National GHG emissions</span><span class="hs-p-y">${first[0]}–${last[0]}</span></div>
      <div class="hs-p-v"><b>${fmtMt(last[1])}</b> Mt CO₂e <span class="${last[1] <= peak[1] ? "dn" : "up"}">${pct(last[1], peak[1]).toFixed(0)}% vs ${peak[0]} peak</span></div>
      ${sparkline(190, 46)}
      <div class="hs-p-legend">${shares.map(([n, v, c]) => `<span><i class="${c}"></i>${n} ${Math.round(v / last[1] * 100)}%</span>`).join("")}</div>
    </div>` : "";

  /* ---------- The main menu, floating on the banner (landing page) ----------
     Built from the Main Menu itself (#mainMenu), so a section added or hidden there follows here;
     each card gets a one-line figure from the page's own data where there is one. */
  const dsCount = (document.querySelector("#dcKpis .dc-kpi .v") || {}).textContent;
  const blurb = {
    explorer: last ? `${fmtMt(last[1])} Mt CO₂e in ${last[0]}` : "National emissions and policies",
    policy: polReal.length ? `${polReal.length} milestones, ${Math.min(...polYears)}–${Math.max(...polYears)}` : "Ireland's climate policies",
    mapping: "3 maps + air quality",
    trend: last ? `${pct(last[1], first[1]) >= 0 ? "+" : ""}${pct(last[1], first[1]).toFixed(1)}% since ${first[0]}` : "Breakpoints and trends",
    data: dsCount ? `${dsCount} sources, how to cite` : "Sources, coverage, citations",
    about: "The project and team",
    guide: "Chapters and videos",
    feedback: "Share your views",
  };
  // Explorer Dashboard is this page itself, so it has no card here (the left menu takes you back to it)
  const tabs = [...document.querySelectorAll("#mainMenu .tab-btn[data-tab]")]
    .filter(b => !b.hidden && b.style.display !== "none" && b.dataset.tab !== "explorer");
  const nav = document.createElement("nav");
  nav.className = "hs-menu";
  nav.setAttribute("aria-label", "Dashboard sections");
  nav.innerHTML = tabs.map(b => {
    const ic = (b.querySelector("i") || {}).className || "bi bi-circle";
    return `<button type="button" class="hs-card" data-tab="${b.dataset.tab}">
      <i class="${ic}" aria-hidden="true"></i><span><b>${b.textContent.trim()}</b><small>${blurb[b.dataset.tab] || ""}</small></span></button>`;
  }).join("") + `<button type="button" class="hs-card" data-tour-picker>
      <i class="bi bi-signpost-split" aria-hidden="true"></i><span><b>Guided tours</b><small>Step-by-step help</small></span></button>`;
  nav.addEventListener("click", e => {
    const b = e.target.closest(".hs-card[data-tab]");
    if (b && typeof window.activateTab === "function") window.activateTab(b.dataset.tab);
  });


  const wrap = document.createElement("div");
  wrap.className = "hero-scene";               // decorative, except the cows and the bog (buttons, hero-ch4.js)
  wrap.innerHTML = scene;
  header.prepend(wrap);
  const art = document.createElement("div");
  art.className = "hs-art";
  art.innerHTML = holo + panel;
  inner.appendChild(art);
  inner.appendChild(nav);

  // The cards line up under the title (its left edge moves with the logo size)
  const text = inner.querySelector(".header-text");
  const align = () => { if (text) inner.style.setProperty("--hs-text-x", (text.offsetLeft + 22) + "px"); };
  align();
  window.addEventListener("resize", () => { align(); clampAll(); });
  if (window.ResizeObserver && text) new ResizeObserver(align).observe(text);

  /* ---------- Movable cards and logo: they stay still until you drag them ----------
     A card (or the INPACT logo) follows the pointer (mouse, pen or touch) once it has moved a few
     pixels; a short press is still a click (a card opens its section). Shift + arrow keys move the
     focused card or logo. Positions are offsets from their places, kept in this browser
     (localStorage); "Reset layout" puts everything back. Nothing floats or tilts by itself
     (27 Nov 2026: the slow floating was dizzying). */
  const POS_KEY = "inpact.hero.cards";
  const cards = [...nav.querySelectorAll(".hs-card")];
  cards.forEach(c => { c.dataset.key = c.dataset.tab || "tours"; });
  const brandEl = document.getElementById("brandBtn");
  const logo = inner.querySelector(".brand-inpact");
  if (logo) {
    logo.dataset.key = "logo";
    // the browser's own image dragging would cancel ours after the first few pixels
    logo.querySelectorAll("img").forEach(im => { im.draggable = false; });
    logo.addEventListener("dragstart", e => e.preventDefault());
  }
  const items = logo ? [...cards, logo] : cards;                  // everything that can be moved
  let pos = {};
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || "{}") || {}; } catch (e) { pos = {}; }
  const savePos = () => { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* storage blocked */ } };
  const setOff = (c, x, y) => {
    c.style.setProperty("--dx", Math.round(x) + "px"); c.style.setProperty("--dy", Math.round(y) + "px");
    if (x || y) pos[c.dataset.key] = [Math.round(x), Math.round(y)]; else delete pos[c.dataset.key];
  };
  const offOf = c => (pos[c.dataset.key] || [0, 0]);
  // Keep an item inside the banner (its offset is measured from its own place)
  function bounds(c) {
    const h = header.getBoundingClientRect(), r = c.getBoundingClientRect(), [ox, oy] = offOf(c);
    const bl = r.left - ox, bt = r.top - oy;
    return { minX: h.left + 8 - bl, maxX: h.right - 8 - (bl + r.width), minY: h.top + 8 - bt, maxY: h.bottom - 30 - (bt + r.height) };
  }
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  function clampAll() {
    if (!nav.offsetParent) return;
    items.forEach(c => { const [x, y] = offOf(c); if (!x && !y) return; const b = bounds(c); setOff(c, clamp(x, b.minX, b.maxX), clamp(y, b.minY, b.maxY)); });
    savePos(); syncReset();
  }

  // Reset layout + a one-time hint
  const reset = document.createElement("button");
  reset.type = "button"; reset.className = "hs-reset"; reset.hidden = true;
  reset.innerHTML = `<i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>Reset layout`;
  reset.title = "Put the cards and the logo back in their places";
  reset.addEventListener("click", () => {
    header.classList.add("hs-returning");
    items.forEach(c => { setOff(c, 0, 0); c.style.zIndex = ""; }); savePos(); syncReset();
    setTimeout(() => header.classList.remove("hs-returning"), 500);
  });
  inner.appendChild(reset);
  const syncReset = () => { reset.hidden = !Object.keys(pos).length; };
  const hint = document.createElement("div");
  hint.className = "hs-hint"; hint.setAttribute("role", "status");
  hint.innerHTML = `<i class="bi bi-arrows-move" aria-hidden="true"></i>Tip: drag the cards or the logo to arrange the banner`;
  inner.appendChild(hint);
  const HINT_KEY = "inpact.hero.hint";
  let hinted = false; try { hinted = localStorage.getItem(HINT_KEY) === "1"; } catch (e) { hinted = true; }
  if (!hinted) {
    setTimeout(() => hint.classList.add("on"), 1800);
    setTimeout(() => hint.classList.remove("on"), 9000);
  }
  const hintDone = () => { hint.classList.remove("on"); try { localStorage.setItem(HINT_KEY, "1"); } catch (e) { /* storage blocked */ } };

  items.forEach(c => { const [x, y] = offOf(c); setOff(c, x, y); });
  syncReset();
  requestAnimationFrame(clampAll);

  // Dragging
  let drag = null, justDragged = false, zTop = 3;
  const toFront = c => { if (c !== logo) c.style.zIndex = String(++zTop); };   // the card moved last stays on top
  const startDrag = (c, e) => {
    if (!c || e.button > 0) return;
    const [ox, oy] = offOf(c);
    drag = { c, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox, oy, b: bounds(c), moving: false };
  };
  nav.addEventListener("pointerdown", e => startDrag(e.target.closest(".hs-card"), e));
  if (logo) logo.addEventListener("pointerdown", e => { if (!root.classList.contains("hdr-shrinkable")) startDrag(logo, e); });   // on the banner only
  window.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < 6) return;                            // a click, not a drag (yet)
      drag.moving = true;
      try { drag.c.setPointerCapture(drag.id); } catch (err) { /* old browsers */ }
      drag.c.classList.add("hs-dragging"); nav.classList.add("hs-has-drag");
      hintDone();
    }
    e.preventDefault();
    setOff(drag.c, clamp(drag.ox + dx, drag.b.minX, drag.b.maxX), clamp(drag.oy + dy, drag.b.minY, drag.b.maxY));
  }, { passive: false });
  const endDrag = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.moving) {
      drag.c.classList.remove("hs-dragging"); nav.classList.remove("hs-has-drag");
      toFront(drag.c); savePos(); syncReset(); justDragged = true; setTimeout(() => { justDragged = false; }, 0);
    }
    drag = null;
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  // A drag must not also open the section (or the tours, or the logo's menu) when the button is released
  const stopAfterDrag = e => { if (justDragged) { e.preventDefault(); e.stopPropagation(); } };
  nav.addEventListener("click", stopAfterDrag, true);
  if (brandEl) brandEl.addEventListener("click", stopAfterDrag, true);

  // Keyboard: Shift + arrows move the focused card, or the logo when the brand is focused (10 px a step)
  const keyMove = (c, e) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
    if (!c || !step || !e.shiftKey) return;
    e.preventDefault(); e.stopPropagation();
    const [x, y] = offOf(c), b = bounds(c);
    setOff(c, clamp(x + step[0], b.minX, b.maxX), clamp(y + step[1], b.minY, b.maxY)); toFront(c); savePos(); syncReset(); hintDone();
  };
  nav.addEventListener("keydown", e => keyMove(e.target.closest(".hs-card"), e));
  if (brandEl && logo) brandEl.addEventListener("keydown", e => { if (!root.classList.contains("hdr-shrinkable")) keyMove(logo, e); });

  // A soft highlight follows the pointer over a card (light only: the card itself does not move)
  nav.addEventListener("pointermove", e => {
    const c = e.target.closest(".hs-card"); if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty("--gx", ((e.clientX - r.left) / r.width * 100).toFixed(0) + "%");
    c.style.setProperty("--gy", ((e.clientY - r.top) / r.height * 100).toFixed(0) + "%");
  });

  // Scrolled past the banner (landing page): the menu slides in as a bar at the top (hero.css)
  const onScroll = () => {
    if (root.classList.contains("hdr-shrinkable")) { root.classList.remove("hero-past"); return; }
    root.classList.toggle("hero-past", window.scrollY > header.offsetHeight - 24);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // The car drives along the coast road
  const car = wrap.querySelector(".hs-car"), road = wrap.querySelector(".hs-road");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (car && road && road.getTotalLength) {
    const L = road.getTotalLength();
    let t0 = performance.now();
    const step = now => {
      if (root.classList.contains("hdr-shrinkable")) return;          // banner gone: stop the animation
      if (!still.matches) {
        const f = ((now - t0) / 16000) % 1, p = road.getPointAtLength(L * (1 - f)), q = road.getPointAtLength(Math.max(0, L * (1 - f) - 2));
        const a = Math.atan2(p.y - q.y, p.x - q.x) * 180 / Math.PI;
        car.setAttribute("transform", `translate(${p.x.toFixed(1)} ${(p.y - 1).toFixed(1)}) rotate(${a.toFixed(1)}) scale(${(0.55 + 0.45 * (1 - f)).toFixed(2)})`);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
})();
