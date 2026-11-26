/*
 * settings-io.js: "My settings" (main menu): export / import / reset the viewer's dashboard settings
 * ===================================================================================================
 * Every setting the dashboard remembers lives in this browser's localStorage. This dialog
 *   - exports them as one JSON file (downloaded; nothing is sent to the server),
 *   - imports such a file: only the keys listed in GROUPS are read, each value is type-checked here,
 *     and the page is reloaded so each section reads its settings again through its own loader, which
 *     drops any value it does not recognise (the same path as a normal visit),
 *   - resets them all to the defaults.
 * Never exported or imported: User Guide progress and anything from the Feedback section.
 * A Trend Analysis plot-style file (Advanced Plot Settings > Export) is accepted too.
 *
 * File: { app: "INPACT dashboard", kind: "dashboard-settings", version: 1, exported, settings: { key: value } }
 */
(function () {
  "use strict";
  if (document.documentElement.classList.contains("map-standalone")) return;   // the embedded map page

  const KIND = "dashboard-settings", VERSION = 1, MAX_BYTES = 2_000_000;
  const json = (maxLen = 400_000) => v => {             // a JSON object (kept as text in storage)
    const o = typeof v === "string" ? JSON.parse(v) : v;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    const s = JSON.stringify(o);
    if (s.length > maxLen) throw new Error("too large");
    return s;
  };
  const oneOf = (...vals) => v => { const s = String(v); if (!vals.includes(s)) throw new Error("unknown value"); return s; };
  const text = re => v => { const s = String(v); if (s.length > 60 || !re.test(s)) throw new Error("unknown value"); return s; };
  const int = (lo, hi) => v => { const n = parseInt(v, 10); if (!(n >= lo && n <= hi)) throw new Error("out of range"); return String(n); };

  // What is exported, grouped as the dialog lists it: key -> check (returns the text to store)
  const GROUPS = [
    { label: "Trend Analysis chart style", icon: "bi-activity", keys: {
      "inpact.trend.plotStyle.v1": json(), "inpact.trend.plotStyle.v1.preset": v => JSON.stringify(text(/^[\w -]*$/)(typeof v === "string" && v.startsWith('"') ? JSON.parse(v) : v)),
      "inpact.trend.plotStyles.v1": json(1_500_000) },
      note: s => { try { const n = Object.keys(JSON.parse(s["inpact.trend.plotStyles.v1"] || "{}")).length; return n ? `and ${n} saved style${n > 1 ? "s" : ""}` : ""; } catch (e) { return ""; } } },
    { label: "Spatial Mapping colour palette", icon: "bi-palette", keys: { "inpact.mapPalette": json(2000) } },
    { label: "Air Quality layer symbology", icon: "bi-wind", keys: { "inpact.overlaySymbology": json(200_000) } },
    { label: "Map display: text size, panel widths, legend, pixel values, download format", icon: "bi-display", keys: {
      "inpact.mapTextSize": int(100, 150), "inpact.mapPanelWidths": json(2000), "inpact.legendOpen": oneOf("0", "1"),
      "inpact.pixelValues": oneOf("0", "1"), "inpact.mapDlFormat": text(/^[a-z0-9]{1,10}$/) } },
    { label: "Time series map options: include map, map image, grid layout, statistics table", icon: "bi-grid-3x3-gap", keys: {
      "inpact.tsIncludeMap": oneOf("0", "1"), "inpact.tsMapMode": oneOf("current", "grid"),
      "inpact.tsGridLayout": text(/^[0-9a-z×x ]{0,12}$/i), "inpact.tsGridStats": oneOf("0", "1") } },
    { label: "Datasets view (cards or table)", icon: "bi-database", keys: { "dcView": oneOf("cards", "table") } },
  ];
  const ALL = Object.assign({}, ...GROUPS.map(g => g.keys));
  // stored as JSON text: written to the file as objects, so it stays readable
  const JSON_KEYS = new Set(["inpact.trend.plotStyle.v1", "inpact.trend.plotStyle.v1.preset", "inpact.trend.plotStyles.v1", "inpact.mapPalette", "inpact.overlaySymbology", "inpact.mapPanelWidths"]);

  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { localStorage.setItem(k, v); },
    del: k => { try { localStorage.removeItem(k); } catch (e) { /* blocked */ } },
  };
  const current = () => Object.fromEntries(Object.keys(ALL).map(k => [k, ls.get(k)]).filter(([, v]) => v != null));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const dlg = document.getElementById("mySettings"), btn = document.getElementById("mySettingsBtn");
  if (!dlg || !btn) return;
  const listEl = dlg.querySelector("[data-ms-list]"), msg = dlg.querySelector("[data-ms-msg]"), file = dlg.querySelector("input[type=file]");
  const say = (t, bad) => { msg.textContent = t; msg.classList.toggle("bad", !!bad); };

  function renderList() {
    const s = current();
    listEl.innerHTML = GROUPS.map(g => {
      const mine = Object.keys(g.keys).some(k => s[k] != null), extra = mine && g.note ? g.note(s) : "";
      return `<li><i class="bi ${g.icon}" aria-hidden="true"></i><span>${esc(g.label)}${extra ? ` <small>${esc(extra)}</small>` : ""}</span>
        <b class="${mine ? "mine" : ""}">${mine ? "Your settings" : "Default"}</b></li>`;
    }).join("");
    dlg.querySelector('[data-ms-act="export"]').disabled = !Object.keys(s).length;
  }

  function exportFile() {
    const settings = {};
    for (const [k, v] of Object.entries(current())) {
      if (JSON_KEYS.has(k)) { try { settings[k] = JSON.parse(v); } catch (e) { /* unreadable: skipped */ } }
      else settings[k] = v;
    }
    const body = { app: "INPACT dashboard", kind: KIND, version: VERSION, exported: new Date().toISOString(), settings };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    a.download = `inpact-dashboard-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    say(`Exported ${Object.keys(settings).length} settings to ${a.download}.`);
  }

  // Read a file into { key: text-to-store }; unknown keys are ignored, bad values are reported
  function parseFile(txt) {
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error("this is not a JSON file"); }
    if (!j || typeof j !== "object") throw new Error("the file is empty");
    let src;
    if (j.kind === KIND && j.settings && typeof j.settings === "object") {
      if (+j.version > VERSION) throw new Error("the file comes from a newer version of the dashboard");
      src = j.settings;
    } else if (j.kind === "plot-style" && j.style) {              // Trend Analysis > Advanced Plot Settings > Export
      src = { "inpact.trend.plotStyle.v1": j.style, "inpact.trend.plotStyle.v1.preset": "custom" };
    } else throw new Error("this is not an INPACT settings file");
    const out = {}, skipped = [];
    for (const [k, v] of Object.entries(src)) {
      if (!ALL[k]) continue;                                       // not a setting we know: ignored
      try { out[k] = ALL[k](v); } catch (e) { skipped.push(k.replace(/^inpact\./, "")); }
    }
    return { out, skipped, partial: j.kind === "plot-style" };
  }

  function apply({ out, skipped, partial }) {
    const n = Object.keys(out).length;
    if (!n) throw new Error("the file has no settings this dashboard can use");
    const what = partial ? "your Trend Analysis chart style" : "your dashboard settings (settings missing from the file go back to the default)";
    if (!window.confirm(`Replace ${what} with the ${n} setting${n > 1 ? "s" : ""} in this file? The page reloads to apply them.`)) { say("Import cancelled."); return; }
    try {
      if (!partial) Object.keys(ALL).forEach(ls.del);
      for (const [k, v] of Object.entries(out)) ls.set(k, v);
    } catch (e) { throw new Error("this browser does not allow saving settings (private mode?)"); }
    try { sessionStorage.setItem("inpact.settingsImported", skipped.length ? `skipped:${skipped.join(", ")}` : "ok"); } catch (e) { /* no note */ }
    location.reload();
  }

  btn.addEventListener("click", () => { say(""); renderList(); dlg.showModal(); });
  dlg.addEventListener("click", e => {
    if (e.target === dlg) return dlg.close();                      // click on the backdrop
    const a = e.target.closest("[data-ms-act]");
    if (!a) return;
    const act = a.dataset.msAct;
    if (act === "close") dlg.close();
    if (act === "export") exportFile();
    if (act === "import") file.click();
    if (act === "reset") {
      if (!Object.keys(current()).length) { say("Everything already uses the default settings."); return; }
      if (!window.confirm("Reset all your dashboard settings to the defaults? Export them first if you may want them back. The page reloads.")) return;
      Object.keys(ALL).forEach(ls.del);
      try { sessionStorage.setItem("inpact.settingsImported", "reset"); } catch (e) { /* no note */ }
      location.reload();
    }
  });
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    if (f.size > MAX_BYTES) { say("This file is too large to be a settings file.", true); return; }
    f.text().then(t => apply(parseFile(t))).catch(err => say(`Could not import ${f.name}: ${err.message}.`, true));
  });

  // after the reload: say what happened
  let note = null;
  try { note = sessionStorage.getItem("inpact.settingsImported"); sessionStorage.removeItem("inpact.settingsImported"); } catch (e) { /* none */ }
  if (note) {
    const t = document.createElement("div");
    t.className = "ms-toast"; t.setAttribute("role", "status");
    t.innerHTML = `<i class="bi bi-check-circle-fill" aria-hidden="true"></i> ${note === "reset" ? "All settings are back to the defaults."
      : note === "ok" ? "Settings imported and applied."
      : esc(`Settings imported. Not used (unrecognised values): ${note.slice(8)}.`)}`;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("out"), 5200);
    setTimeout(() => t.remove(), 6000);
  }
})();
