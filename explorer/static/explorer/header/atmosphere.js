/* "Atmosphere" header (atmosphere.css): drifting contour lines behind the header and a gentle
   3D tilt of the INPACT badge that follows the pointer. Decoration only (aria-hidden); nothing
   moves for viewers who ask for reduced motion, and touch screens get no tilt. */
(function () {
  "use strict";
  const header = document.querySelector(".app-header");
  if (!header || header.querySelector(".atm-bg")) return;
  if (document.documentElement.classList.contains("map-embed")) return;   // no header in the map frame

  // Contour lines: smooth waves, drawn twice side by side so the drift loops without a seam
  const W = 1600, H = 240, lines = 9;
  let d = "";
  for (let i = 0; i < lines; i++) {
    const y0 = 20 + i * (H - 40) / (lines - 1), amp = 10 + (i % 3) * 6, ph = i * 0.9;
    let p = "";
    for (let x = 0; x <= W * 2; x += 40) {
      const y = y0 + amp * Math.sin((x / W) * Math.PI * 4 + ph) + 5 * Math.sin((x / W) * Math.PI * 10 + ph * 2);
      p += (x ? " L" : "M") + x + " " + y.toFixed(1);
    }
    d += `<path d="${p}"/>`;
  }
  const bg = document.createElement("div");
  bg.className = "atm-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML = `<svg viewBox="0 0 ${W * 2} ${H}" preserveAspectRatio="none">${d}</svg>`;
  header.prepend(bg);

  // 3D tilt of the INPACT badge while the pointer is over the brand (mouse / pen only)
  const brand = document.getElementById("brandBtn"), badge = brand && brand.querySelector(".brand-inpact");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
  if (!brand || !badge) return;
  let raf = 0;
  brand.addEventListener("pointermove", e => {
    if (still.matches || !fine.matches) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const r = badge.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 1.4)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 1.4)));
      badge.style.setProperty("--atm-ry", (nx * 9).toFixed(2) + "deg");
      badge.style.setProperty("--atm-rx", (-ny * 9).toFixed(2) + "deg");
    });
  });
  brand.addEventListener("pointerleave", () => {
    cancelAnimationFrame(raf);
    badge.style.setProperty("--atm-ry", "0deg");
    badge.style.setProperty("--atm-rx", "0deg");
  });
})();
