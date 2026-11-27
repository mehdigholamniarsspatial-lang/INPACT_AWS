/* Vertical menu rail (menu.css): on screens 768 px and wider, once a section is open, the menu stays
   on the left, so the header always stays slim. The page's own code can unfold the menu (the logo, the
   "Main Menu" button, the guided tours); here that is turned straight back into the slim header,
   because the rail already shows every section. */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-standalone")) return;
  const wide = window.matchMedia("(min-width: 768px)");
  const keepSlim = () => {
    if (!wide.matches || !root.classList.contains("hdr-shrinkable") || root.classList.contains("hdr-slim")) return;
    if (typeof window.setNavFolded === "function") window.setNavFolded(true);
  };
  new MutationObserver(keepSlim).observe(root, { attributes: true, attributeFilter: ["class"] });
  wide.addEventListener("change", keepSlim);
  // The rail sits under the header: re-measure the sticky offsets when it appears
  wide.addEventListener("change", () => { if (typeof window.syncNavMetrics === "function") window.syncNavMetrics(); });
})();
