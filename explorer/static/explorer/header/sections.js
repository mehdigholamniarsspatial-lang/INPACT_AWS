/* =====================================================================
   Explorer Dashboard (the first page): each panel's title bar opens its
   section of the dashboard (27 Nov 2026; replaces the menu cards on the
   banner). sections.css styles them.

     2A Time-Series Emissions Analysis   -> Trend Analysis
     2B Spatial Environmental Mapping    -> Spatial Mapping
     3  Policy Intelligence Panel        -> Policy Timeline
     4  Climate Policy Roadmap           -> Policy Timeline
     5  Public Participation             -> Feedback
        Research Team                    -> About INPACT
     6  Datasets                         -> Datasets

   A click anywhere on the title bar opens the section, except on the bar's
   own controls (zoom buttons, "New window", "Detailed timeline"); each bar
   also gets a labelled button for the keyboard and screen readers.
   Section 6 is filled here with a summary of the data catalogue (its key
   figures and categories, read from the Datasets tab).
   ===================================================================== */
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.classList.contains("map-standalone")) return;
  const page = document.getElementById("tab-explorer");
  if (!page || typeof window.activateTab !== "function") return;

  const LINKS = [
    ["Emissions analysis", "trend", "Trend Analysis", "bi-activity"],
    ["Spatial environmental mapping", "mapping", "Spatial Mapping", "bi-globe-europe-africa"],
    ["Policy intelligence", "policy", "Policy Timeline", "bi-calendar3-range"],
    ["Climate policy roadmap", "policy", "Policy Timeline", "bi-calendar3-range"],
    ["Public participation", "feedback", "Feedback", "bi-chat-square-text"],
    ["Research team", "about", "About INPACT", "bi-info-circle"],
    ["Datasets", "data", "Datasets", "bi-database"],
  ];
  const go = tab => {
    if (tab === "mapping") history.replaceState(null, "", location.pathname + location.search + "#mapping/RasterLayer");
    window.activateTab(tab);
  };

  LINKS.forEach(([label, tab, name, icon]) => {
    const panel = page.querySelector(`section.panel[aria-label="${label}"]`);
    const head = panel && panel.querySelector(":scope > .panel-head");
    if (!head) return;
    head.classList.add("panel-head-go");
    head.dataset.goSection = tab;
    head.title = `Open ${name}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-go";
    btn.setAttribute("aria-label", `Open ${name}`);
    btn.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i><span>Open ${name}</span><i class="bi bi-arrow-right-short" aria-hidden="true"></i>`;
    const title = head.querySelector(".panel-title");
    (title ? title : head.lastChild).after(btn);
    head.addEventListener("click", e => {
      // the bar's own controls keep their own job; our button and the rest of the bar open the section
      const ctl = e.target.closest("button, a, input, select, label, [role='button']");
      if (ctl && ctl !== btn && !btn.contains(ctl)) return;
      go(tab);
    });
  });

  /* ---------- Section 6: a summary of the data catalogue ---------- */
  const kpiBox = document.getElementById("dsKpis"), catBox = document.getElementById("dsCats");
  function fillDatasets() {
    if (!kpiBox || !catBox) return;
    const kpis = [...document.querySelectorAll("#dcKpis .dc-kpi")].map(k => [
      (k.querySelector(".v") || {}).textContent || "", (k.querySelector(".l") || {}).textContent || ""]);
    const icons = ["bi-collection", "bi-map", "bi-graph-up", "bi-calendar3-range"];
    kpiBox.innerHTML = kpis.map(([v, l], i) =>
      `<div class="ds-kpi"><i class="bi ${icons[i] || "bi-database"}" aria-hidden="true"></i><div><b>${v}</b><span>${l}</span></div></div>`).join("");
    const cats = [...document.querySelectorAll("#dcCats .dc-cat")];
    catBox.innerHTML = cats.map(c => {
      const ic = (c.querySelector(".ic i") || {}).className || "bi bi-database";
      const t = (c.querySelector(".t") || {}).textContent || "", n = (c.querySelector(".n") || {}).textContent || "";
      const cls = [...c.classList].filter(x => x !== "dc-cat").join(" ");
      return `<button type="button" class="ds-cat ${cls}" data-cat="${c.dataset.cat}" title="Open the Datasets tab on this category">
        <span class="ds-cat-ic"><i class="${ic}" aria-hidden="true"></i></span><span class="ds-cat-t">${t}</span><span class="ds-cat-n">${n}</span></button>`;
    }).join("");
    catBox.querySelectorAll(".ds-cat").forEach(b => b.addEventListener("click", () => {
      go("data");
      setTimeout(() => {                                          // then filter the catalogue on that category
        const src = document.querySelector(`#dcCats .dc-cat[data-cat="${b.dataset.cat}"]`);
        if (src && src.getAttribute("aria-pressed") !== "true") src.click();
      }, 60);
    }));
  }
  fillDatasets();
})();
