/* =====================================================================
   INPACT consultation (Feedback tab), questionnaire version 2026.12-v4.2.

   The questionnaires are defined once on the server (explorer/feedback_survey.py)
   and fetched from /api/feedback/schema/. This file renders them, applies the
   routing of Section 13.1 of the instrument (the same rules run again on the
   server), keeps a draft in this browser only, checks required answers, shows a
   review page, submits to /api/feedback/, and shows the reference code and the
   debrief. Members of the public answer without a key and are randomly given
   Form A or Form B; the four professional groups verify their group's access key.
   Aggregated results are shown to key holders only once fieldwork has closed.

   The whole Feedback section stays closed until the section code is accepted
   (/api/feedback/gate/); every feedback request then carries its token.
   ===================================================================== */
(function stakeholderSurvey(){
  "use strict";
  const $ = id => document.getElementById(id);
  const form = $("fbForm"); if (!form) return;
  const E = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY_DRAFT = "inpact.survey.draft42", KEY_DONE = "inpact.survey.submitted", KEY_CLIENT = "inpact.survey.client",
        KEY_ACCESS = "inpact.survey.access", KEY_RESULTS = "inpact.survey.results", KEY_GATE = "inpact.feedback.gate";
  const mk = st => ({
    get(k){ try { return JSON.parse(st.getItem(k)); } catch (e){ return null; } },
    set(k, v){ try { st.setItem(k, JSON.stringify(v)); } catch (e){ /* private mode */ } },
    del(k){ try { st.removeItem(k); } catch (e){ /* ignore */ } },
  });
  const store = mk(localStorage), sess = mk(sessionStorage);

  // ---- Section code: every feedback request carries the token from /api/feedback/gate/ ----
  let gate = sess.get(KEY_GATE);
  const gateOk = () => !!(gate && gate.token && gate.exp > Date.now());
  const gateHeaders = (h = {}) => gateOk() ? { ...h, "X-Feedback-Gate": gate.token } : h;
  const gateDlg = $("fbGate");
  function askKey(msg){
    const m = $("fbGateMsg"); m.className = "fb-keymsg" + (msg ? " err" : ""); m.textContent = msg || "";
    $("fbGateCode").value = "";
    if (!gateDlg.open) gateDlg.showModal();
    $("fbGateCode").focus();
  }
  function lockSection(msg){
    gate = null; sess.del(KEY_GATE);
    $("fbGated").hidden = true;
    if (msg) askKey(msg);
  }
  async function fbFetch(url, opts = {}){
    const resp = await fetch(url, { ...opts, headers: gateHeaders(opts.headers || {}) });
    if (resp.status === 403 && resp.headers.get("X-Feedback-Gate") === "closed"){
      lockSection("Your access to the feedback section has expired. Please enter the code again.");
      throw new Error("The feedback section is closed.");
    }
    return resp;
  }

  const RESULTS_STEP = { id: "results", title: "Results", icon: "bi-bar-chart-line", questions: [] };
  const REVIEW = { id: "review", title: "Review", icon: "bi-check2-square", intro: "Check your answers. Use Edit to change anything before you submit.", questions: [] };
  const S = { schema: null, groups: [], gmap: {}, steps: [], step: 0, max: 0, answers: {}, started: null, form: null, orders: {},
              polQ: "", polLevel: "all", access: sess.get(KEY_ACCESS), results: store.get(KEY_RESULTS), submitted: false, keyMsg: "", keyErr: false };
  let client = store.get(KEY_CLIENT);
  if (!client){
    client = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    store.set(KEY_CLIENT, client);
  }
  const body = $("fbStepBody"), prevBtn = $("fbPrev"), nextBtn = $("fbNext");
  const POLS = (typeof POLICIES !== "undefined" ? POLICIES : []).filter(p => p && p.name);
  const polByName = new Map(POLS.map(p => [p.name, p]));
  const LEVELS = [["all", "All"], ["International", "International"], ["EU", "EU"], ["National", "National"], ["Target", "Targets"]];
  const DIV = ["#C84B3C", "#E58A5C", "#C9CED4", "#5BB381", "#00843D"], DK = "#E6EBF0";
  const DIV_MID = ["#B8541A", "#E3A06A", "#C9CED4", "#7EA3D6", "#2F5FA8"];
  const GCOL = { public: "#5C6B7A", stakeholder: "#D9822B", researcher: "#2F6FDE", expert: "#0F9D8A", policymaker: "#9C3D8F" };
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  function setStatus(kind, html, el){
    el = el || $("fbStatusMsg");
    el.className = "fb-status" + (kind ? " " + kind : "");
    el.innerHTML = html || "";
  }
  const questionsOf = step => step.questions || [];
  const curQuestions = () => S.steps.flatMap(questionsOf);
  const qById = id => curQuestions().find(q => q.id === id);
  const accessOk = g => !!(S.access && S.access.token && S.access.exp > Date.now() && (!g || S.access.group === g));
  const groupOf = () => S.gmap[S.answers.group];
  const resultsOk = () => !!(S.results && S.results.token && S.results.exp > Date.now());
  const isPro = () => !!(groupOf() && groupOf().keyed);

  /* ---------------- Routing (Section 13.1; mirrors feedback_survey.visible) ---------------- */
  function cond(c){
    if (c.any) return c.any.some(cond);
    if (c.form) return S.form === c.form;
    const v = S.answers[c.q];
    if ("ne" in c) return v !== c.ne;
    if ("eq" in c) return v === c.eq;
    if ("has" in c) return Array.isArray(v) && v.includes(c.has);
    if ("not_has" in c) return !(Array.isArray(v) && v.includes(c.not_has));
    if ("count_gt" in c) return Array.isArray(v) && v.length > c.count_gt;
    return true;
  }
  const dynRows = q => {
    if (!q.rows_from) return q.rows;
    const chosen = S.answers[q.rows_from.q] || [], ex = q.rows_from.exclude || [];
    return q.rows.filter(r => chosen.includes(r.code) && !ex.includes(r.code));
  };
  const visible = q => (q.show_if || []).every(cond) && (!q.rows_from || dynRows(q).length > 0);
  function optionsFor(q){
    let o = q.options || [];
    if (q.exclude_group) o = o.filter(x => x.code !== S.answers.group);
    if (q.options_from){ const ch = S.answers[q.options_from.q] || []; o = o.filter(x => ch.includes(x.code)); }
    if (q.randomize_first){
      const ord = S.orders[q.id], head = o.slice(0, q.randomize_first), rest = o.slice(q.randomize_first);
      if (ord) o = ord.map(c => head.find(x => x.code === c)).filter(Boolean).concat(rest);
    }
    return o;
  }
  const rowsFor = q => {
    const rows = dynRows(q), ord = q.randomize ? S.orders[q.id] : null;
    return ord ? ord.map(c => rows.find(r => r.code === c)).filter(Boolean) : rows;
  };
  const depsOf = q => {
    const out = new Set();
    const walk = c => { if (c.any) c.any.forEach(walk); else if (c.q) out.add(c.q); };
    (q.show_if || []).forEach(walk);
    if (q.rows_from) out.add(q.rows_from.q);
    if (q.options_from) out.add(q.options_from.q);
    if (q.exclude_group) out.add("group");
    return out;
  };
  // A step is left out when none of its questions can be shown for this form (public Form B: Module G)
  const stepPossible = st => !st.questions.length || st.questions.some(q => !(q.show_if || []).some(c => c.form && c.form !== S.form));

  /* ---------------- Steps depend on the group ---------------- */
  function buildSteps(){
    const g = S.answers.group, flow = (g && S.schema.flows[g]) || [];
    if (g === "public" && !S.form) S.form = Math.random() < .5 ? "A" : "B";         // split ballot, stored as FORM
    const steps = flow.filter(stepPossible);
    S.steps = steps.length ? [S.schema.welcome, ...steps, REVIEW].concat(S.gmap[g].keyed ? [RESULTS_STEP] : []) : [S.schema.welcome];
    S.step = Math.min(S.step, S.steps.length - 1);
    S.max = Math.min(S.max, S.steps.length - 1);
    // randomised orders, drawn once and kept with the draft (Section 13.3)
    curQuestions().forEach(q => {
      if (q.randomize && !S.orders[q.id]) S.orders[q.id] = shuffle(q.rows.map(r => r.code));
      if (q.randomize_first && !S.orders[q.id]) S.orders[q.id] = shuffle(q.options.slice(0, q.randomize_first).map(o => o.code));
      if (q.type === "policies3") ensurePolicies(q);
    });
  }
  function ensurePolicies(q){
    let arr = S.answers[q.id];
    const refs = q.refs.map(r => r.code);
    if (!Array.isArray(arr) || arr.length < 2 || arr.slice(0, 2).map(e => e.ref).sort().join() !== refs.slice().sort().join()){
      arr = shuffle(refs).map(ref => ({ ref })).concat(arr && arr[2] && arr[2].policy ? [arr[2]] : []);
      S.answers[q.id] = arr;
    }
    if (q.own === false && S.answers[q.id].length > 2) S.answers[q.id] = S.answers[q.id].slice(0, 2);
  }

  /* ---------------- Draft (answers stay on this device until submitted) ---------------- */
  function saveDraft(){
    store.set(KEY_DRAFT, { v: S.schema.version, step: S.step, max: S.max, answers: S.answers, started: S.started,
                           form: S.form, orders: S.orders, saved: Date.now() });
  }
  function clearDraft(){ store.del(KEY_DRAFT); }
  function setAccess(a){
    S.access = a;
    if (a) sess.set(KEY_ACCESS, a); else sess.del(KEY_ACCESS);
  }

  /* ---------------- Rendering helpers ---------------- */
  const reqMark = q => q.required ? '<span class="req" aria-hidden="true">*</span>' : '<span class="opt">optional</span>';
  const errBox = () => '<div class="fb-err" role="alert"><i class="bi bi-exclamation-circle-fill"></i><span></span></div>';
  const pts = s => { const out = []; for (let k = s.min; k <= s.max; k++) out.push(k); return out; };
  const signed = (s, k) => s.min < 0 ? (k > 0 ? "+" + k : k < 0 ? "−" + (-k) : "0") : String(k);
  const isNs = v => typeof v === "string";
  function helpHtml(q){
    if (!q.help || !q.help.length) return "";
    const items = q.help.map(k => S.schema.help[k]).filter(Boolean);
    return `<details class="fb-help"><summary><i class="bi bi-question-circle"></i>${items.length === 1 ? "What does “" + E(items[0].term) + "” mean?" : "Terms used in this question"}</summary>
      <dl>${items.map(h => `<dt>${E(h.term)}</dt><dd>${E(h.text)}</dd>`).join("")}</dl></details>`;
  }

  // One scale (single question or one policy item). attrs: extra data attributes on every input.
  function scaleHtml(q, v, nm, attrs){
    const s = q.scale, n = s.max - s.min + 1;
    const segs = pts(s).map(k => {
      const id = `${nm}-${k}`, lab = s.labels[k] || "";
      return `<span class="fb-seg"><input type="radio" name="${E(nm)}" id="${E(id)}" value="${k}"${v === k ? " checked" : ""}${attrs}>
        <label for="${E(id)}" title="${E(lab || String(k))}"><b>${signed(s, k)}</b>${lab ? `<span>${E(lab)}</span>` : ""}</label></span>`;
    }).join("");
    const na = (q.na || []).map(o => `<span class="fb-seg dk"><input type="radio" name="${E(nm)}" id="${E(nm)}-${o.code}" value="${o.code}"${v === o.code ? " checked" : ""}${attrs}>
      <label for="${E(nm)}-${o.code}"><b>${E(o.label)}</b></label></span>`).join("");
    const ends = s.ends_only ? `<div class="fb-ends7"><span>${signed(s, s.min)} = ${E(s.labels[s.min])}</span><span>${signed(s, s.max)} = ${E(s.labels[s.max])}</span></div>`
      : `<div class="fb-scale-ends"><span>${signed(s, s.min)} = ${E(s.labels[s.min])}</span><span>${signed(s, s.max)} = ${E(s.labels[s.max])}</span></div>`;
    return `<div class="fb-scale${s.ends_only ? " ends" : ""}"><div class="fb-segs" style="--n:${n}">${segs}</div>${na ? `<div class="fb-nas">${na}</div>` : ""}${ends}</div>`;
  }
  function choiceHtml(q, opts, v, nm, attrs, multi){
    const sel = multi ? new Set(v || []) : null, full = multi && q.max && sel.size >= q.max;
    const chips = opts.map(o => {
      const id = `${nm}-${o.code}`, on = multi ? sel.has(o.code) : v === o.code;
      const ex = (q.exclusive || []).includes(o.code);
      return `<span class="fb-chip${ex ? " ex" : ""}"><input type="${multi ? "checkbox" : "radio"}" name="${E(nm)}" id="${E(id)}" value="${E(o.code)}"${on ? " checked" : ""}${
        full && !on && !ex ? " disabled" : ""}${attrs}><label for="${E(id)}">${E(o.label)}</label></span>`;
    }).join("");
    return `<div class="fb-chips" role="${multi ? "group" : "radiogroup"}">${chips}</div>${
      multi && q.max && q.max < opts.length ? `<div class="fb-counter">${sel.size} of ${q.max} chosen</div>` : ""}`;
  }
  function otherHtml(q){
    if (!q.other) return "";
    const v = S.answers[q.id], on = q.type === "multi" ? (v || []).includes(q.other) : v === q.other;
    return `<div class="fb-other"${on ? "" : " hidden"}><input type="text" class="form-control form-control-sm" data-other="${q.id}" maxlength="200"
      value="${E(S.answers[q.id + "_other"] || "")}" placeholder="Please specify (up to 200 characters)" aria-label="Please specify"></div>`;
  }
  // A grid: one row per item; on narrow screens every row becomes a single question with full labels
  function matrixHtml(q, rows, v, nm, attrs){
    v = v || {};
    const s = q.scale, P = pts(s), na = q.na || [];
    const cols = `--n:${P.length};--na:${na.length}`;
    const head = `<div class="fb-mhead" aria-hidden="true"><span></span>${P.map(k => `<span><b>${signed(s, k)}</b>${s.labels[k] ? "<br>" + E(s.labels[k]) : ""}</span>`).join("")}${
      na.map(o => `<span>${E(o.label)}</span>`).join("")}</div>`;
    const body = rows.map(r => {
      const name = `${nm}--${r.code}`;
      const cells = P.map(k => `<span class="fb-mcell"><input type="radio" name="${E(name)}" id="${E(name)}-${k}" value="${k}" data-row="${E(r.code)}"${v[r.code] === k ? " checked" : ""}${attrs}>
          <label for="${E(name)}-${k}" title="${E(s.labels[k] || String(k))}"><b>${signed(s, k)}</b>${s.labels[k] ? `<span class="tx">${E(s.labels[k])}</span>` : ""}</label></span>`)
        .concat(na.map(o => `<span class="fb-mcell dk"><input type="radio" name="${E(name)}" id="${E(name)}-${o.code}" value="${o.code}" data-row="${E(r.code)}"${v[r.code] === o.code ? " checked" : ""}${attrs}>
          <label for="${E(name)}-${o.code}"><b>${E(o.label)}</b></label></span>`)).join("");
      return `<div class="fb-mrow" role="radiogroup" aria-label="${E(r.label)}"><span class="lbl">${E(r.label)}</span>${cells}</div>`;
    }).join("");
    return `<div class="fb-matrix${P.length > 5 ? " wide" : ""}" style="${cols}">${head}${body}</div>
      <p class="fb-hint" style="margin:.5rem 0 0">Click a selected answer again to clear it.</p>`;
  }
  function textHtml(id, v, max, attrs, label){
    v = v || "";
    return `<textarea class="form-control" id="q-${E(id)}" rows="${max > 600 ? 4 : 3}" maxlength="${max}"${attrs}${label ? ` aria-label="${E(label)}"` : ""}>${E(v)}</textarea>
      <div class="fb-count">${v.length} / ${max}</div>`;
  }

  /* ---------------- Group choice and access key ---------------- */
  function groupQ(){
    const v = S.answers.group;
    const cards = S.groups.map(g => {
      const on = v === g.code, closed = g.open === false;
      return `<span class="fb-gcard"><input type="radio" name="q-group" id="q-group-${g.code}" value="${g.code}"${on ? " checked" : ""}${closed ? " disabled" : ""}>
        <label for="q-group-${g.code}"><span class="gi" style="--gc:${GCOL[g.code]}"><i class="bi ${E(g.icon)}"></i></span>
        <b>${E(g.label)}</b><span class="gd">${E(g.desc)}</span>
        <span class="gm"><span><i class="bi bi-clock"></i>${E(g.minutes)} min</span>${closed ? '<span class="lk"><i class="bi bi-slash-circle"></i>Not open yet</span>'
          : g.keyed ? '<span class="lk"><i class="bi bi-key-fill"></i>Access key</span>' : '<span class="op"><i class="bi bi-unlock-fill"></i>Open to all</span>'}</span></label></span>`;
    }).join("");
    return `<div class="fb-groups" data-q="group" role="radiogroup" aria-label="Respondent group">${cards}</div><div id="fbKeyBox">${keyBoxHtml()}</div>`;
  }
  function keyBoxHtml(){
    const g = groupOf(); if (!g || !g.keyed) return "";
    if (accessOk(g.code)) return `<div class="fb-keybox ok"><i class="bi bi-patch-check-fill"></i><span>Key verified: you are answering as <b>${E(g.label.toLowerCase())}</b>. ${E(S.schema.access_note)}</span>
      <button type="button" id="fbKeyChange">Enter another key</button></div>`;
    return `<div class="fb-keybox"><label for="fbKeyInput"><i class="bi bi-key-fill"></i>Access key for ${E(g.plural.toLowerCase())}</label>
      <div class="fb-keyrow"><input type="text" class="form-control" id="fbKeyInput" maxlength="16" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="8 characters" aria-describedby="fbKeyMsg">
        <button type="button" class="btn btn-submit text-white" id="fbKeyBtn"><i class="bi bi-shield-check"></i>Verify key</button></div>
      <div class="fb-keymsg${S.keyErr ? " err" : ""}" id="fbKeyMsg" role="status">${S.keyMsg ? E(S.keyMsg) : "Use the key you received from the INPACT team. " + E(S.schema.access_note)}</div></div>`;
  }
  function refreshKeyBox(focus){
    const kb = $("fbKeyBox"); if (!kb) return;
    kb.innerHTML = keyBoxHtml();
    if (focus) $("fbKeyInput")?.focus();
  }
  function setGroup(code){
    if (S.answers.group === code) return;
    S.answers.group = code; S.keyMsg = ""; S.keyErr = false; S.max = 0;
    if (Array.isArray(S.answers.W2_role)) S.answers.W2_role = S.answers.W2_role.filter(c => c !== code);
    buildSteps(); saveDraft();
    body.querySelector('[data-qbox="group"]')?.classList.remove("invalid");
    refreshKeyBox(groupOf()?.keyed && !accessOk(code));
    renderNav();
  }
  async function postAccess(payload){
    const resp = await fbFetch("/api/feedback/access/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok || !r.ok) throw new Error(r.detail || "The key could not be checked. Please try again.");
    const a = { group: r.group, label: r.label, token: r.token, exp: Date.now() + (r.hours || 12) * 3600e3 };
    setAccess(a);
    return a;
  }
  async function verifyKey(){
    const inp = $("fbKeyInput"), btn = $("fbKeyBtn"), g = groupOf();
    if (!inp || !g) return;
    const key = inp.value.trim();
    if (!key){ S.keyMsg = "Please enter your access key."; S.keyErr = true; $("fbKeyMsg").className = "fb-keymsg err"; $("fbKeyMsg").textContent = S.keyMsg; inp.focus(); return; }
    btn.disabled = true; $("fbKeyMsg").className = "fb-keymsg"; $("fbKeyMsg").innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking&hellip;';
    try {
      await postAccess({ group: g.code, key });
      S.keyMsg = ""; S.keyErr = false;
      body.querySelector('[data-qbox="group"]')?.classList.remove("invalid");
      refreshKeyBox(false);
    } catch (err){
      S.keyMsg = err.message; S.keyErr = true;
      refreshKeyBox(true);
      $("fbKeyInput").value = key;
    }
  }

  /* ---------------- Module C: three policies ---------------- */
  const polArr = q => S.answers[q.id] || [];
  function refOf(q, e){ return e && e.ref ? q.refs.find(r => r.code === e.ref) : null; }
  const excluded = (q, name) => q.refs.some(r => name.startsWith(r.exclude_prefix || r.timeline));
  function levelBadge(p){ return `<span class="lv" style="background:${E(p.color || "#5C6B7A")}">${E(p.cat || p.level)}</span>`; }
  function polListHtml(q){
    const own = polArr(q)[2], chosen = own && own.policy;
    const needle = S.polQ.trim().toLowerCase();
    const list = POLS.filter(p => !excluded(q, p.name) && (S.polLevel === "all" || (p.cat || p.level) === S.polLevel) &&
      (!needle || `${p.name} ${p.sector} ${p.year} ${p.type || ""}`.toLowerCase().includes(needle)));
    if (!list.length) return '<div class="fb-pol-empty">No policy matches. Try another word or level.</div>';
    return list.map(p => {
      const on = chosen === p.name;
      return `<label class="fb-pol${on ? " on" : ""}"><input type="radio" name="fbOwnPol" data-polpick="${E(p.name)}"${on ? " checked" : ""}>
        <span class="yr">${E(p.year)}</span><span class="nm">${E(p.name)}<small>${E(p.sector || "")}${p.type ? " · " + E(p.type) : ""}</small></span>${levelBadge(p)}</label>`;
    }).join("");
  }
  function polItemHtml(q, idx, it){
    const e = polArr(q)[idx] || {}, v = e[it.id], nm = `q-C-${idx}-${it.id}`, attrs = ` data-pol="${idx}" data-item="${it.id}"`;
    let inner = "";
    if (it.type === "scale") inner = scaleHtml(it, v, nm, attrs);
    else if (it.type === "multi") inner = choiceHtml(it, it.options, v, nm, attrs, true);
    else if (it.type === "text") inner = textHtml(`C-${idx}-${it.id}`, v, it.max_len, attrs, it.label);
    const tag = it.type === "text" ? "div" : "fieldset";
    const legend = tag === "fieldset" ? `<legend>${E(it.label)}${reqMark(it)}</legend>` : `<label class="fb-label" for="q-C-${idx}-${it.id}">${E(it.label)}${reqMark(it)}</label>`;
    return `<${tag} class="fb-q fb-pq" data-pbox="${idx}-${it.id}">${legend}${it.hint ? `<p class="fb-hint">${E(it.hint)}</p>` : ""}${helpHtml(it)}${inner}${errBox()}</${tag}>`;
  }
  function polCardHtml(q, idx){
    const e = polArr(q)[idx] || {}, ref = refOf(q, e), p = ref ? null : polByName.get(e.policy) || { name: e.policy };
    const title = ref ? ref.title : p.name, fam = e.fam;
    const meta = ref ? `<div class="fb-c0"><span class="lv" style="background:#244A6E">${E(ref.level)}</span><span>${E(ref.lead)}</span></div>
        <p class="fb-c0d">${E(ref.desc)}</p><p class="fb-c0p"><b>Assessment period:</b> ${E(ref.period)}.</p>
        <a class="fb-c0l" href="${E(ref.link)}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right"></i>Open its profile in the dashboard (new tab)</a>`
      : `<div class="fb-c0">${levelBadge(p)}<span>${E(p.year || "")}${p.sector ? " · " + E(p.sector) : ""}</span></div>${p.description ? `<p class="fb-c0d">${E(p.description)}</p>` : ""}
        <button type="button" class="fb-c0x" data-unpick="1"><i class="bi bi-x-circle"></i>Choose another policy</button>`;
    const skip = fam === q.items[0].scale.min;
    const items = q.items.map((it, i) => i === 0 || !skip ? polItemHtml(q, idx, it) : "").join("");
    return `<div class="fb-pcard fb-c" data-card="${idx}" style="border-left-color:${ref ? "#244A6E" : E(p.color || "var(--emerald)")}">
      <div class="fb-pcard-h"><span class="fb-pn">${idx + 1}</span><div class="t">${E(title)}<small>${ref ? "Reference policy, rated by everyone" : "Your own choice"}</small></div></div>
      ${meta}<div class="fb-c-items">${items}${skip ? '<p class="fb-hint fb-skipnote"><i class="bi bi-skip-forward"></i>You are not familiar with this policy, so its other questions are skipped.</p>' : ""}</div></div>`;
  }
  function ownPickerHtml(q){
    return `<div class="fb-pcard fb-c fb-ownpick"><div class="fb-pcard-h"><span class="fb-pn">3</span><div class="t">${E(q.own_label)}<small>${E(q.own_hint)}</small></div></div>
        <div class="fb-pol-tools">
          <div class="fb-search"><i class="bi bi-search"></i><input type="search" class="form-control" id="fbPolSearch" placeholder="Search by name, sector or year" value="${E(S.polQ)}" aria-label="Search policies"></div>
          <div class="fb-levels" role="group" aria-label="Filter by level">${LEVELS.map(([v, t]) => `<button type="button" data-level="${v}" aria-pressed="${S.polLevel === v}">${t}</button>`).join("")}</div>
        </div>
        <div class="fb-pol-list" id="fbPolList">${polListHtml(q)}</div>
        <p class="fb-hint" style="margin:.5rem 0 0">If you do not know any other policy in the timeline, you can leave this one out.</p></div>`;
  }
  function policiesQ(q){
    const arr = polArr(q), own = arr[2] && arr[2].policy;
    const third = q.own === false ? "" : own ? polCardHtml(q, 2) : ownPickerHtml(q);
    return `<div class="fb-cwrap" data-q="${q.id}">${[0, 1].map(i => polCardHtml(q, i)).join("")}${third}</div>`;
  }
  function refreshPolCard(q, idx){
    const card = body.querySelector(`[data-card="${idx}"]`); if (card) card.outerHTML = polCardHtml(q, idx);
  }

  /* ---------------- E7: choose technologies, then rate each ---------------- */
  function pickgridQ(q){
    const v = S.answers[q.id] || { picked: [], ratings: {} }, picked = v.picked || [];
    const chips = q.options.map(o => {
      const on = picked.includes(o.code), dis = !on && picked.length >= q.max;
      return `<span class="fb-chip"><input type="checkbox" id="q-${q.id}-${o.code}" data-pgpick="${q.id}" value="${E(o.code)}"${on ? " checked" : ""}${dis ? " disabled" : ""}><label for="q-${q.id}-${o.code}">${E(o.label)}</label></span>`;
    }).join("");
    const grids = picked.map(c => {
      const o = q.options.find(x => x.code === c);
      return `<div class="fb-pg"><h6><i class="bi bi-lightning-charge"></i>${E(o.label)}</h6>${matrixHtml(q, q.rows, (v.ratings || {})[c], `q-${q.id}-${c}`, ` data-pg="${q.id}" data-tech="${E(c)}"`)}</div>`;
    }).join("");
    return `<div class="fb-chips" role="group">${chips}</div><div class="fb-counter">${picked.length} of ${q.max} chosen</div><div class="fb-pgs">${grids}</div>`;
  }

  /* ---------------- Welcome page: participant information (Section 3) ---------------- */
  function welcomeHtml(){
    const info = S.schema.info || {}, icons = ["bi-info-circle", "bi-list-check", "bi-graph-up-arrow", "bi-patch-check"];
    const cards = (info.about || []).map(([t, x], i) => `<div class="fb-info"><b><i class="bi ${icons[i] || "bi-info-circle"}"></i>${E(t)}</b><p>${E(x)}</p></div>`).join("");
    const data = (info.data || []).map(([t, x]) => `<li><b>${E(t)}.</b> ${linkify(E(x))}</li>`).join("");
    return `<div class="fb-info-grid">${cards}</div>
      <details class="fb-privacy" open><summary>Your data</summary><ul>${data}</ul></details>`;
  }
  const linkify = s => s.replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, '<a href="mailto:$1">$1</a>')
    .replace(/\b(www\.[\w.-]+\.[a-z]{2,})(?=[)\s.,]|$)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>');

  /* ---------------- A question ---------------- */
  function renderQuestion(q){
    const vis = visible(q), v = S.answers[q.id], nm = `q-${q.id}`, at = "";
    let inner = "";
    switch (q.type){
      case "group": inner = groupQ(); break;
      case "single": inner = choiceHtml(q, optionsFor(q), v, nm, at, false) + otherHtml(q); break;
      case "multi": inner = choiceHtml(q, optionsFor(q), v, nm, at, true) + otherHtml(q); break;
      case "scale": inner = scaleHtml(q, v, nm, at); break;
      case "matrix": inner = vis ? matrixHtml(q, rowsFor(q), v, nm, at) : ""; break;
      case "consents": inner = `<div class="fb-consents">${q.rows.map(r => `<label class="fb-check"><input type="checkbox" data-consent="${E(r.code)}"${(v || []).includes(r.code) ? " checked" : ""}><span>${E(r.label)}</span></label>`).join("")}</div>`; break;
      case "text": inner = textHtml(q.id, v, q.max_len, ` data-q="${q.id}"`); break;
      case "pickgrid": inner = pickgridQ(q); break;
      case "policies3": return `<div class="fb-q" data-qbox="${q.id}">${policiesQ(q)}${errBox()}</div>`;
    }
    const tag = ["text"].includes(q.type) ? "div" : "fieldset";
    const legend = tag === "fieldset" ? `<legend>${E(q.label)}${reqMark(q)}</legend>` : `<label class="fb-label" for="q-${q.id}">${E(q.label)}${reqMark(q)}</label>`;
    return `<${tag} class="fb-q" data-qbox="${q.id}" data-q="${q.id}"${vis ? "" : " hidden"}>${legend}${q.hint ? `<p class="fb-hint">${E(q.hint)}</p>` : ""}${helpHtml(q)}${inner}${errBox()}</${tag}>`;
  }
  function refreshQuestion(q){
    const box = body.querySelector(`[data-qbox="${q.id}"]`); if (box) box.outerHTML = renderQuestion(q);
  }
  // Answers that other questions in this step depend on (routing, rows or options taken from them)
  function refreshDependents(changed){
    questionsOf(S.steps[S.step]).forEach(q => { if (q.id !== changed && depsOf(q).has(changed)) refreshQuestion(q); });
  }

  /* ---------------- Review ---------------- */
  const nsLabel = (q, v) => ((q.na || []).find(o => o.code === v) || {}).label || v;
  function fmtAnswer(q, v){
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "";
    const lab = (list, c) => ((list || []).find(o => o.code === c) || {}).label || c;
    const s = q.scale;
    switch (q.type){
      case "single": return lab(q.options, v) + (q.other === v && S.answers[q.id + "_other"] ? `: ${S.answers[q.id + "_other"]}` : "");
      case "multi": return v.map(c => lab(q.options, c) + (q.other === c && S.answers[q.id + "_other"] ? `: ${S.answers[q.id + "_other"]}` : "")).join(" · ");
      case "scale": return isNs(v) ? nsLabel(q, v) : `${signed(s, v)}${s.labels[v] ? " · " + s.labels[v] : ""}`;
      case "matrix": return rowsFor(q).filter(r => v[r.code] != null).map(r => `${r.label}: ${isNs(v[r.code]) ? nsLabel(q, v[r.code]) : signed(s, v[r.code]) + (s.labels[v[r.code]] ? " " + s.labels[v[r.code]] : "")}`).join("\n");
      case "consents": return v.length === q.rows.length ? "All statements ticked" : `${v.length} of ${q.rows.length} ticked`;
      case "pickgrid": return (v.picked || []).map(c => lab(q.options, c) + ": " + q.rows.map(r => { const x = ((v.ratings || {})[c] || {})[r.code]; return x == null ? "–" : isNs(x) ? nsLabel(q, x) : x; }).join(" / ")).join("\n");
      case "policies3": return v.filter(e => e.ref || e.policy).map((e, i) => {
        const ref = refOf(q, e), t = ref ? ref.title : e.policy;
        const f = e.fam == null ? "familiarity not answered" : e.fam === q.items[0].scale.min ? "not familiar" : q.items.slice(1).filter(it => it.type === "scale" && e[it.id] != null).length + " ratings";
        return `${i + 1}. ${t} (${f})`;
      }).join("\n");
      default: return String(v);
    }
  }
  function renderReview(){
    const g = groupOf();
    const secs = S.steps.slice(1, S.steps.indexOf(REVIEW)).map((st, i) => {
      const rows = questionsOf(st).filter(visible).map(q => {
        const txt = q.type === "group" ? (g ? g.label : "") : fmtAnswer(q, S.answers[q.id]);
        return `<dt>${E(q.label)}</dt><dd class="${txt ? "" : "none"}">${txt ? E(txt) : "Not answered"}</dd>`;
      }).join("");
      return `<div class="fb-review-sec"><h4><i class="bi ${E(st.icon)}"></i><span>${E(st.title)}</span>
        <button type="button" data-goto="${i + 1}"><i class="bi bi-pencil me-1"></i>Edit</button></h4><dl>${rows}</dl></div>`;
    }).join("");
    return (g ? `<div class="fb-asgroup"><i class="bi ${E(g.icon)}"></i>Answering as ${E(g.label.toLowerCase())}${g.keyed ? ' · <i class="bi bi-patch-check-fill"></i>key verified' : ""}</div>` : "") +
      secs + `<p class="fb-hint" style="margin:.8rem 0 0">Press <b>Submit</b> to send your answers. You cannot change them afterwards. After you submit you will see a reference code, which you need if you later want to withdraw your answers.</p>`;
  }
  function renderNav(){
    const ghost = S.answers.group ? "" : '<span class="fb-step ghost"><span class="n">2</span><span class="t">Questions for your group</span></span>';
    $("fbSteps").innerHTML = S.steps.map((s, i) => {
      const cur = i === S.step, done = !cur && i < S.max;
      return `<button type="button" class="fb-step${cur ? " cur" : done ? " done" : ""}" data-goto="${i}"${i > S.max || S.submitted ? " disabled" : ""}${
        cur ? ' aria-current="step"' : ""}><span class="n">${done ? '<i class="bi bi-check-lg"></i>' : i + 1}</span><span class="t">${E(s.title)}</span></button>`;
    }).join("") + ghost;
    const pct = S.steps.length > 1 ? Math.round(100 * S.step / (S.steps.length - 1)) : 0;
    $("fbProgressBar").style.width = pct + "%";
    $("fbProgress").setAttribute("aria-valuenow", pct);
    $("fbSteps").querySelector(".cur")?.scrollIntoView({ block: "nearest", inline: "center" });
  }
  function render(focus){
    const st = S.steps[S.step], isReview = st.id === "review";
    const g = groupOf();
    const head = `<div class="fb-step-h"><span class="ico"><i class="bi ${E(st.icon)}"></i></span><div>
      <div class="k">Step ${S.step + 1}${S.answers.group ? " of " + S.steps.length : ""}${g && S.step > 0 ? " · " + E(g.label) : ""}</div><h3>${E(st.title)}</h3></div></div>
      ${st.intro ? `<p class="fb-step-intro">${E(st.intro)}</p>` : ""}`;
    body.innerHTML = head + (S.step === 0 ? welcomeHtml() : "") + (isReview ? renderReview() : questionsOf(st).map(renderQuestion).join(""));
    prevBtn.hidden = S.step === 0;
    nextBtn.disabled = false;
    nextBtn.innerHTML = isReview ? '<i class="bi bi-send"></i>Submit' : S.step === 0 ? 'Start the questionnaire<i class="bi bi-arrow-right"></i>' : 'Next<i class="bi bi-arrow-right"></i>';
    renderNav();
    setStatus("", "");
    if (focus){
      const top = $("fbSteps").getBoundingClientRect().top;
      if (top < 0 || top > innerHeight * .6) $("fbSteps").scrollIntoView({ behavior: "smooth", block: "start" });
      body.querySelector("h3")?.setAttribute("tabindex", "-1");
      body.querySelector("h3")?.focus({ preventScroll: true });
    }
  }

  /* ---------------- Answers ---------------- */
  const empty = v => v == null || v === "" || v === false || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  function setAnswer(id, v){
    if (empty(v)) delete S.answers[id]; else S.answers[id] = v;
    body.querySelector(`[data-qbox="${id}"]`)?.classList.remove("invalid");
    refreshDependents(id);
    saveDraft();
  }
  const valOf = t => /^-?\d+$/.test(t.value) ? +t.value : t.value;
  // Exclusive options ("None of these", "Don't know"...) cannot be combined with other answers
  function exclusiveSel(q, sel, clicked){
    const ex = q.exclusive || [];
    if (!ex.length || !clicked) return sel;
    return ex.includes(clicked) ? (sel.includes(clicked) ? [clicked] : sel) : sel.filter(c => !ex.includes(c));
  }
  function syncChips(container, q, sel){
    const full = q.max && sel.length >= q.max;
    container.querySelectorAll("input[type=checkbox]").forEach(x => {
      x.checked = sel.includes(x.value);
      x.disabled = !x.checked && full && !(q.exclusive || []).includes(x.value);
    });
    const c = container.parentElement.querySelector(":scope > .fb-counter"); if (c) c.textContent = `${sel.length} of ${q.max} chosen`;
  }
  function polQ(){ return curQuestions().find(q => q.type === "policies3"); }
  function setPolItem(idx, item, v){
    const q = polQ(), arr = polArr(q), e = arr[idx]; if (!e) return;
    if (empty(v)) delete e[item]; else e[item] = v;
    S.answers[q.id] = arr; saveDraft();
    body.querySelector(`[data-pbox="${idx}-${item}"]`)?.classList.remove("invalid");
    if (item === "fam") refreshPolCard(q, idx);                       // "not at all familiar" skips the rest
  }
  // A radio answer. toggle: a mouse click on the answer already chosen clears it (optional questions only)
  function applyRadio(t, toggle){
    if (t.name === "q-group"){ setGroup(t.value); return; }
    if (t.dataset.polpick != null){ pickOwn(t.dataset.polpick); return; }
    const val = valOf(t);
    if (t.dataset.pol != null){
      const q = polQ(), e = polArr(q)[+t.dataset.pol] || {}, it = q.items.find(i => i.id === t.dataset.item);
      if (toggle && e[it.id] === val && !it.required){ t.checked = false; setPolItem(+t.dataset.pol, it.id, null); }
      else if (!(e[it.id] === val)) setPolItem(+t.dataset.pol, it.id, val);
      return;
    }
    if (t.dataset.pg != null){
      const q = qById(t.dataset.pg), v = S.answers[q.id] || { picked: [], ratings: {} }, r = v.ratings[t.dataset.tech] = { ...(v.ratings[t.dataset.tech] || {}) };
      if (toggle && r[t.dataset.row] === val){ delete r[t.dataset.row]; t.checked = false; } else r[t.dataset.row] = val;
      S.answers[q.id] = v; saveDraft(); return;
    }
    const qbox = t.closest("[data-qbox]"), q = qbox ? qById(qbox.dataset.qbox) : null;
    if (!q) return;
    if (q.type === "matrix"){
      const m = { ...(S.answers[q.id] || {}) }, row = t.dataset.row;
      if (toggle && m[row] === val){ delete m[row]; t.checked = false; } else m[row] = val;
      setAnswer(q.id, m);
    } else if (toggle && S.answers[q.id] === val && !q.required){ t.checked = false; setAnswer(q.id, null); }
    else if (S.answers[q.id] !== val) setAnswer(q.id, val);
    if (q.other){ const o = qbox.querySelector(".fb-other"); if (o) o.hidden = S.answers[q.id] !== q.other; }
  }
  function pickOwn(name){
    const q = polQ(), arr = polArr(q);
    arr[2] = { policy: name }; S.answers[q.id] = arr.slice(0, 3); saveDraft();
    const pick = body.querySelector(".fb-ownpick"); if (pick) pick.outerHTML = polCardHtml(q, 2);
    body.querySelector('[data-card="2"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  body.addEventListener("click", e => {
    const t = e.target;
    if (t.closest("#fbKeyBtn")){ verifyKey(); return; }
    if (t.closest("#fbKeyChange")){ setAccess(null); refreshKeyBox(true); return; }
    const go = t.closest("[data-goto]"); if (go){ goTo(+go.dataset.goto); return; }
    const lv = t.closest("[data-level]");
    if (lv){ S.polLevel = lv.dataset.level; body.querySelectorAll("[data-level]").forEach(b => b.setAttribute("aria-pressed", b === lv)); $("fbPolList").innerHTML = polListHtml(polQ()); return; }
    if (t.closest("[data-unpick]")){
      const q = polQ(); S.answers[q.id] = polArr(q).slice(0, 2); saveDraft();
      const card = body.querySelector('[data-card="2"]'); if (card) card.outerHTML = ownPickerHtml(q);
      return;
    }
    if (t.matches("input[type=radio]")){ applyRadio(t, t.dataset.was === "1"); delete t.dataset.was; }
  });
  body.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.id === "fbKeyInput"){ e.preventDefault(); verifyKey(); }
    if (e.key === "Enter" && e.target.matches("input[type=text], input[type=search]")) e.preventDefault();
  });
  body.addEventListener("pointerdown", e => {
    const r = e.target.closest(".fb-seg, .fb-mcell, .fb-chip")?.querySelector("input[type=radio]");
    if (r) r.dataset.was = r.checked ? "1" : "0";
  });
  body.addEventListener("change", e => {
    const t = e.target;
    if (t.type === "radio"){ if (t.checked) applyRadio(t, false); return; }
    if (t.type !== "checkbox") return;
    if (t.dataset.consent != null){
      const q = qById("W6_consent"), sel = [...body.querySelectorAll("[data-consent]:checked")].map(x => x.dataset.consent);
      setAnswer(q.id, sel); return;
    }
    if (t.dataset.pgpick != null){
      const q = qById(t.dataset.pgpick), v = S.answers[q.id] || { picked: [], ratings: {} };
      v.picked = t.checked ? [...new Set([...(v.picked || []), t.value])].slice(0, q.max) : (v.picked || []).filter(c => c !== t.value);
      if (!t.checked) delete (v.ratings || {})[t.value];
      S.answers[q.id] = v.picked.length ? v : undefined; if (!v.picked.length) delete S.answers[q.id];
      saveDraft(); refreshQuestion(q); return;
    }
    if (t.dataset.pol != null){
      const q = polQ(), it = q.items.find(i => i.id === t.dataset.item), box = t.closest(".fb-chips");
      let sel = [...box.querySelectorAll("input:checked")].map(x => x.value);
      sel = exclusiveSel(it, sel, t.value); syncChips(box, it, sel);
      setPolItem(+t.dataset.pol, it.id, sel); return;
    }
    const qbox = t.closest("[data-qbox]"), q = qbox ? qById(qbox.dataset.qbox) : null;
    if (q && q.type === "multi"){
      const box = t.closest(".fb-chips");
      let sel = [...box.querySelectorAll("input:checked")].map(x => x.value);
      sel = exclusiveSel(q, sel, t.value); syncChips(box, q, sel);
      setAnswer(q.id, sel);
      if (q.other){ const o = qbox.querySelector(".fb-other"); if (o) o.hidden = !sel.includes(q.other); }
    }
  });
  body.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "fbPolSearch"){ S.polQ = t.value; $("fbPolList").innerHTML = polListHtml(polQ()); return; }
    if (t.dataset.other){ setAnswer(t.dataset.other + "_other", t.value.slice(0, 200)); return; }
    if (t.tagName !== "TEXTAREA") return;
    const c = t.parentElement.querySelector(".fb-count"); if (c) c.textContent = `${t.value.length} / ${t.maxLength}`;
    if (t.dataset.pol != null){ setPolItem(+t.dataset.pol, t.dataset.item, t.value); return; }
    if (t.dataset.q) setAnswer(t.dataset.q, t.value);
  });

  /* ---------------- Checks before moving on ---------------- */
  function problems(stepIdx){                                 // {box key: message} for one step
    const out = {};
    questionsOf(S.steps[stepIdx]).forEach(q => {
      if (!visible(q)) return;
      const v = S.answers[q.id];
      if (q.type === "group"){
        const g = groupOf();
        if (!g) out[q.id] = "Please choose the perspective you will answer from.";
        else if (g.keyed && !accessOk(g.code)) out[q.id] = `Enter and verify the access key for ${g.plural.toLowerCase()}, or choose another perspective.`;
        return;
      }
      if (q.type === "consents"){
        if (q.required && (v || []).length < q.rows.length) out[q.id] = "All five statements are required to take part. If you do not agree with one of them, you cannot take part in the survey.";
        return;
      }
      if (q.type === "policies3"){
        polArr(q).forEach((e, i) => { if ((e.ref || e.policy) && e.fam == null) out[`p:${i}-fam`] = "Please tell us how familiar you are with this policy."; });
        return;
      }
      if (q.required && empty(v)) out[q.id] = "Please answer this question.";
    });
    return out;
  }
  function validate(){
    const p = problems(S.step), bad = [];
    body.querySelectorAll(".fb-q.invalid").forEach(b => b.classList.remove("invalid"));
    Object.entries(p).forEach(([k, msg]) => {
      const box = k.startsWith("p:") ? body.querySelector(`[data-pbox="${k.slice(2)}"]`) : body.querySelector(`[data-qbox="${k}"]`);
      if (!box) return;
      box.classList.add("invalid");
      const sp = box.querySelector(":scope > .fb-err span"); if (sp) sp.textContent = msg;
      bad.push(box);
    });
    if (bad.length){
      bad[0].scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus("err", `<i class="bi bi-exclamation-triangle-fill"></i>${bad.length === 1 ? "One question needs" : bad.length + " questions need"} your attention.`);
    }
    return !bad.length;
  }
  function goTo(i){
    if (i < 0 || i >= S.steps.length || i > S.max) return;
    S.step = i; saveDraft(); render(true);
  }
  prevBtn.addEventListener("click", () => goTo(S.step - 1));
  nextBtn.addEventListener("click", () => {
    if (S.steps[S.step].id === "review"){ submit(); return; }
    if (!validate()) return;
    if (!S.started) S.started = new Date().toISOString();
    S.step += 1; S.max = Math.max(S.max, S.step); saveDraft(); render(true);
  });
  $("fbSteps").addEventListener("click", e => { const b = e.target.closest("button[data-goto]"); if (b && !b.disabled) goTo(+b.dataset.goto); });

  /* ---------------- Submit ---------------- */
  function payloadAnswers(){                                   // only questions that are shown to this respondent
    const out = { group: S.answers.group };
    curQuestions().forEach(q => {
      if (q.type === "group" || !visible(q)) return;
      const v = S.answers[q.id];
      if (!empty(v)) out[q.id] = v;
      if (q.other && S.answers[q.id + "_other"]) out[q.id + "_other"] = S.answers[q.id + "_other"];
    });
    return out;
  }
  async function submit(){
    const badStep = S.steps.findIndex((_, i) => Object.keys(problems(i)).length);
    if (badStep >= 0){ S.step = badStep; render(true); validate(); return; }
    const g = groupOf();
    const started = S.started ? new Date(S.started) : new Date();
    const payload = {
      answers: payloadAnswers(), form: g.code === "public" ? S.form : null, orders: S.orders,
      started_at: started.toISOString(), client_id: client,
      elapsed_s: Math.round((Date.now() - started.getTime()) / 1000),
      device: matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
      website: $("fbWebsite").value,
      access: g.keyed && accessOk(g.code) ? S.access.token : null,
    };
    nextBtn.disabled = true; prevBtn.disabled = true;
    setStatus("sending", '<span class="spinner-border spinner-border-sm"></span>Sending your answers&hellip;');
    try {
      const resp = await fbFetch("/api/feedback/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const r = await resp.json().catch(() => ({}));
      if (r.code === "access"){
        setAccess(null); S.step = 0; render(true); validate();
        setStatus("err", `<i class="bi bi-exclamation-triangle-fill"></i>${E(r.detail)}`);
        return;
      }
      if (!resp.ok || !r.ok) throw new Error(r.detail || "The answers could not be saved. Please try again.");
      const wasForm = S.form;
      clearDraft();
      store.set(KEY_DONE, { at: new Date().toISOString(), group: g.code });
      const keyed = !!r.results_token;
      if (keyed){
        S.results = { group: g.code, token: r.results_token, exp: Date.now() + (r.results_days || 365) * 864e5 };
        store.set(KEY_RESULTS, S.results);
      }
      showThanks(r.reference || r.response_id, g, wasForm, keyed);
      S.submitted = true;
      if (keyed){ form.hidden = true; $("fbBanner").hidden = true; S.step = S.max = S.steps.length - 1; renderNav(); }
      else $("fbSurvey").hidden = true;
      if (keyed) showResults(true);
    } catch (err){
      setStatus("err", `<i class="bi bi-exclamation-triangle-fill"></i>${E(err.message || "Network error: the server could not be reached.")}`);
    } finally {
      nextBtn.disabled = false; prevBtn.disabled = false;
    }
  }

  /* ---------------- Thank-you page, debrief and sign-up (Sections 10.3 and 11.3) ---------------- */
  function showThanks(ref, g, formUsed, keyed){
    const c = S.schema.confirm || {};
    $("fbRef").textContent = ref;
    $("fbThanksWithdraw").textContent = `If you want to withdraw your answers, e-mail this code to ${c.team_email} ${c.withdraw_period}. We will delete your response within 10 working days and confirm by e-mail. After one week the code is deleted and your answers can no longer be identified. The code is shown only once and is not e-mailed, so please note it now.`;
    const d = S.schema.debrief || {}, key = S.schema.k2_key || [], k2q = (S.schema.flows.public.find(st => st.id === "information") || { questions: [] }).questions.find(q => q.id === "K2_tf");
    const table = formUsed === "B" && k2q ? `<p>${E(d.intro)}</p><ol class="fb-key">${key.map(k => {
        const row = k2q.rows.find(r => r.code === k.row);
        return `<li><span class="ans ${k.true ? "t" : "f"}">${k.true ? "True" : "False"}</span><div><b>${E(k.text)}</b><small>Statement: “${E(row ? row.label : "")}” · Source: ${E(k.source)}</small></div></li>`;
      }).join("")}</ol>` : "";
    $("fbDebrief").innerHTML = `<h4><i class="bi bi-lightbulb"></i>About some of the questions</h4>${table}<p>${linkify(E(d.general))}</p>`;
    $("fbThanksMore").textContent = keyed ? (S.schema.results_open ? "Below are the aggregated results of the consultation so far." :
      "The aggregated results will be shown to stakeholders, researchers, experts and policy makers on this page once fieldwork has closed. You can come back to them on this device.")
      : "The INPACT team will publish the aggregated results in its reports.";
    $("fbSeeResults").hidden = !(keyed && S.schema.results_open);
    $("fbThanks").hidden = false;
    $("fbThanks").scrollIntoView({ behavior: "smooth", block: "start" });
    $("fbThanks").focus({ preventScroll: true });
  }
  $("fbAgain").addEventListener("click", () => {
    S.answers = {}; S.step = 0; S.max = 0; S.started = null; S.polQ = ""; S.polLevel = "all"; S.submitted = false; S.form = null; S.orders = {};
    buildSteps();
    form.hidden = false; $("fbResults").hidden = true;
    $("fbThanks").hidden = true; $("fbSurvey").hidden = false; banner(); render(true);
  });
  $("fbSeeResults").addEventListener("click", () => $("fbResults").scrollIntoView({ behavior: "smooth", block: "start" }));
  function banner(msg){
    const b = $("fbBanner");
    if (!msg){ b.hidden = true; b.innerHTML = ""; return; }
    b.innerHTML = msg; b.hidden = false;
  }

  /* =================== Results dashboard (key holders, once fieldwork has closed) =================== */
  const R = { data: null, tab: "all", sort: { k: "n", dir: -1 }, allPol: false };
  const resBody = $("fbResultsBody"), tip = $("fbTip");
  const NAVY = "#16324F";
  const fmt = (v, d = 1) => v == null || isNaN(v) ? "–" : (+v).toFixed(d);
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const gLabel = c => c === "all" ? "All respondents" : (S.gmap[c] || {}).plural || c;
  const gCol = c => c === "all" ? NAVY : GCOL[c];
  const findQ = (qid, g) => {
    const flows = g ? [S.schema.flows[g] || []] : Object.values(S.schema.flows);
    for (const f of flows) for (const st of f) for (const q of st.questions) if (q.id === qid) return q;
    return null;
  };
  const optLabel = (qid, code) => {
    for (const f of Object.values(S.schema.flows)) for (const st of f) for (const q of st.questions)
      if (q.id === qid){ const o = (q.options || []).concat(q.rows || []).find(x => x.code === code); if (o) return o.label; }
    return code;
  };
  // n colours from the diverging palette (red - grey - green, or orange - grey - blue for "about right" scales)
  function palFor(scale){
    const base = scale && Object.values(scale.labels).some(l => /about right/i.test(l)) ? DIV_MID : DIV;
    const n = scale ? scale.max - scale.min + 1 : 5;
    if (n === 5) return base;
    const rgb = base.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    return Array.from({ length: n }, (_, i) => {
      const x = n === 1 ? 2 : 4 * i / (n - 1), j = Math.min(3, Math.floor(x)), f = x - j;
      return "#" + rgb[j].map((v, k) => Math.round(v + (rgb[j + 1][k] - v) * f).toString(16).padStart(2, "0")).join("");
    });
  }
  function meanColour(m, scale){
    const s = scale || { min: 1, max: 5 }, stops = palFor(scale || null).map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
    const x = Math.min(stops.length - 1, Math.max(0, (m - s.min) / (s.max - s.min) * (stops.length - 1))), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    return { bg: `rgb(${c.join(",")})`, fg: lum > .62 ? "#1F2D3A" : "#fff" };
  }
  function merge(a, b){
    if (!b) return a;
    if (!a) return JSON.parse(JSON.stringify(b));
    a.a = (a.a || 0) + (b.a || 0);
    if (b.c){ a.c = a.c || {}; for (const k in b.c) a.c[k] = (a.c[k] || 0) + b.c[k]; }
    if (b.ns){ a.ns = a.ns || {}; for (const k in b.ns) a.ns[k] = (a.ns[k] || 0) + b.ns[k]; }
    if (b.rows){ a.rows = a.rows || {}; for (const r in b.rows) a.rows[r] = merge(a.rows[r], b.rows[r]); }
    if (b.p){
      a.p = a.p || {};
      for (const p in b.p){
        const x = a.p[p] || (a.p[p] = { n: 0, ref: b.p[p].ref, name: b.p[p].name, items: {} }); x.n += b.p[p].n;
        for (const it in b.p[p].items) x.items[it] = merge(x.items[it], b.p[p].items[it]);
      }
    }
    return a;
  }
  const charted = () => S.groups.map(g => g.code).filter(g => Object.values(R.data.q).some(x => x[g]));
  const agg = (qid, gs) => gs.reduce((acc, g) => merge(acc, (R.data.q[qid] || {})[g]), null);
  const nsSum = a => sum(a && a.ns);
  const meanOf = a => { if (!a || !a.c) return null; let s = 0, n = 0; for (const k in a.c){ s += +k * a.c[k]; n += a.c[k]; } return n ? s / n : null; };
  function statsOf(a, sc){
    if (!a || !a.c) return null;
    let n = 0, s = 0, ss = 0;
    for (const k in a.c){ n += a.c[k]; s += +k * a.c[k]; ss += (+k) * (+k) * a.c[k]; }
    if (!n) return null;
    const m = s / n, sd = n > 1 ? Math.sqrt(Math.max(0, (ss - n * m * m) / (n - 1))) : 0;
    return { m, n, lo: Math.max(sc.min, m - 1.96 * sd / Math.sqrt(n)), hi: Math.min(sc.max, m + 1.96 * sd / Math.sqrt(n)) };
  }
  function legendHtml(scale, na){
    const pal = palFor(scale);
    return `<div class="fb-legend">${Object.keys(scale.labels).map((k, i) => `<span><i style="background:${pal[i]}"></i>${E(scale.labels[k] || k)}</span>`).join("")}${
      na ? `<span><i style="background:${DK}"></i>Non-substantive (don't know, cannot judge ...)</span>` : ""}</div>`;
  }
  function likRow(label, a, scale, dot){
    const lab = `<span class="l">${dot ? `<i class="dot" style="--gc:${gCol(dot)}"></i>` : ""}<span>${label}</span></span>`;
    const ns = nsSum(a);
    if (!a || !(sum(a.c) + ns)) return lab + '<span class="na">No answers yet</span>';
    const keys = Object.keys(scale.labels), tot = sum(a.c) + ns, pal = palFor(scale), mid = (keys.length - 1) / 2;
    const parts = keys.map((k, i) => [scale.labels[k] || k, (a.c || {})[k] || 0, pal[i], i === mid]).concat(ns ? [["Non-substantive answers", ns, DK, true]] : []);
    const segsH = parts.filter(p => p[1]).map(([l, n, col, light]) => {
      const w = 100 * n / tot;
      return `<span class="${light ? "lt" : ""}" style="width:${w}%;background:${col}" data-tip="<b>${E(l)}</b><br>${n} of ${tot} (${Math.round(w)}%)">${w >= 9 ? Math.round(w) + "%" : ""}</span>`;
    }).join("");
    const m = meanOf(a);
    return `${lab}<div class="fb-stack" role="img" aria-label="${E(label.replace(/<[^>]+>/g, ""))}: ${parts.map(p => `${p[0]} ${p[1]}`).join(", ")}">${segsH}</div>
      <span class="m" data-tip="Mean of ${sum(a.c)} answers on the ${scale.min} to ${scale.max} scale${ns ? " (non-substantive answers excluded)" : ""}">${fmt(m)}<small>n=${tot}</small></span>`;
  }
  function hbars(items, colour){
    if (!items.length) return '<p class="fb-empty" style="font-size:.8rem"><i class="bi bi-dash-circle"></i>No answers yet.</p>';
    const max = Math.max(...items.map(i => i.v)) || 1;
    return `<div class="fb-hbars">${items.map(i => `<span class="l">${E(i.label)}</span><span class="t" style="--gc:${i.colour || colour || "var(--teal)"}">
      <span style="width:${Math.max(1.5, 100 * i.v / max)}%" data-tip="${i.tip || ""}"></span></span><span class="v">${i.text}</span>`).join("")}</div>`;
  }
  function choiceBars(qid, a, top, colour){
    if (!a || !a.a) return hbars([]);
    const all = Object.assign({}, a.c || {}, a.ns || {});
    const items = Object.entries(all).sort((x, y) => y[1] - x[1]).slice(0, top || 99).map(([code, n]) => ({
      label: optLabel(qid, code), v: n, text: `${pct(n, a.a)}%`, tip: `<b>${E(optLabel(qid, code))}</b><br>${n} of ${a.a} respondents (${pct(n, a.a)}%)` }));
    return hbars(items, colour);
  }
  const panel = (title, sub, inner, wide) => `<div class="fb-panel${wide ? " wide" : ""}"><h5>${title}</h5>${sub ? `<p class="sub">${sub}</p>` : ""}${inner}</div>`;
  const section = (title, inner) => inner ? `<div class="fb-dsec">${title}</div><div class="fb-dgrid">${inner}</div>` : "";

  function kpis(gs, label){
    const n = gs.reduce((s, g) => s + (R.data.groups[g] || 0), 0);
    const o = agg("A2_eff_overall", gs), t = agg("A5_target2030", gs), p = agg("A6_pace", gs), pr = agg("C_policies", gs);
    const q2 = findQ("A2_eff_overall"), om = meanOf(o), likely = t ? ((t.c || {})["4"] || 0) + ((t.c || {})["5"] || 0) : 0, tOp = t ? sum(t.c) : 0;
    const slow = p ? (p.c || {}).too_slow || 0 : 0;
    const ratings = pr ? Object.values(pr.p || {}).reduce((s, x) => s + x.n, 0) : 0, npol = pr ? Object.keys(pr.p || {}).length : 0;
    return `<div class="fb-kpis">
      <div class="fb-kpi"><div class="k">Responses</div><div class="v">${n.toLocaleString("en-IE")}</div><div class="s">${E(label)}</div></div>
      <div class="fb-kpi"><div class="k">Overall effectiveness</div><div class="v">${fmt(om)}<small> / 5</small></div><div class="s">${om == null ? "No answers yet" : E(q2.scale.labels[Math.round(om)]) + " on average"}</div>
        <div class="meter"><span style="width:${om ? 100 * (om - 1) / 4 : 0}%;background:${om ? meanColour(om).bg : "transparent"}"></span></div></div>
      <div class="fb-kpi"><div class="k">Expect 2030 target met</div><div class="v">${tOp ? pct(likely, tOp) : "–"}<small>%</small></div><div class="s">likely or very likely (of ${tOp} with a view)</div>
        <div class="meter"><span style="width:${pct(likely, tOp)}%"></span></div></div>
      <div class="fb-kpi"><div class="k">Pace too slow</div><div class="v">${p && p.a ? pct(slow, p.a) : "–"}<small>%</small></div><div class="s">of ${p ? p.a : 0} who answered</div>
        <div class="meter"><span style="width:${p ? pct(slow, p.a) : 0}%"></span></div></div>
      <div class="fb-kpi"><div class="k">Policy assessments</div><div class="v">${ratings}</div><div class="s">${npol} different policies</div></div>
    </div>`;
  }
  function whoPanel(){
    const tot = R.data.n || 1;
    const items = S.groups.map(g => ({ label: g.plural, v: R.data.groups[g.code] || 0, colour: GCOL[g.code],
      text: `${R.data.groups[g.code] || 0}`, tip: `<b>${E(g.plural)}</b><br>${R.data.groups[g.code] || 0} responses (${pct(R.data.groups[g.code] || 0, tot)}%)` }));
    const med = R.data.median_duration_s;
    return panel("Responses by group", `${R.data.n} responses${med ? ` · median ${Math.max(1, Math.round(med / 60))} min to complete` : ""}`, hbars(items));
  }
  function timelinePanel(){
    const days = Object.keys(R.data.timeline);
    if (!days.length) return panel("Responses over time", "", '<p class="fb-empty" style="font-size:.8rem">No responses yet.</p>');
    const d0 = new Date(days[0] + "T00:00:00Z"), d1 = new Date(), span = Math.max(1, Math.round((d1 - d0) / 864e5) + 1);
    const step = span > 60 ? 7 : 1, nb = Math.ceil(span / step), bins = Array.from({ length: nb }, () => ({}));
    days.forEach(d => {
      const i = Math.min(nb - 1, Math.floor(Math.round((new Date(d + "T00:00:00Z") - d0) / 864e5) / step));
      for (const g in R.data.timeline[d]) bins[i][g] = (bins[i][g] || 0) + R.data.timeline[d][g];
    });
    const max = Math.max(1, ...bins.map(b => sum(b)));
    const lab = i => new Date(d0.getTime() + i * step * 864e5).toLocaleDateString("en-IE", { day: "numeric", month: "short" });
    const cols = bins.map((b, i) => `<span class="st" style="height:${100 * sum(b) / max}%" data-tip="<b>${step === 7 ? "Week of " : ""}${lab(i)}</b><br>${sum(b)} responses${
      Object.keys(b).length ? "<br>" + S.groups.filter(g => b[g.code]).map(g => `${E(g.plural)}: ${b[g.code]}`).join("<br>") : ""}">${
      S.groups.filter(g => b[g.code]).map(g => `<i style="flex:${b[g.code]};background:${GCOL[g.code]}"></i>`).join("")}</span>`).join("");
    return panel("Responses over time", (step === 7 ? "Responses per week" : "Responses per day") + ", by group",
      `<div class="fb-cols">${cols}</div><div class="fb-cols-x"><span>${lab(0)}</span><span>${lab(nb - 1)}</span></div>`);
  }
  function groupLegend(gs, withAll){
    return `<div class="fb-legend">${(withAll ? ["all"] : []).concat(gs).map(g => `<span><i style="background:${gCol(g)};border-radius:50%"></i>${E(gLabel(g))}</span>`).join("")}</div>`;
  }
  function dotPlot(qid, gs){
    const q = findQ(qid); if (!q) return "";
    const sc = q.scale, rows = gs.map(g => [g, statsOf((R.data.q[qid] || {})[g], sc)]).filter(r => r[1]);
    if (!rows.length) return "";
    if (rows.length > 1) rows.unshift(["all", statsOf(agg(qid, gs), sc)]);
    const W = 420, L = 116, Rt = 38, rowH = 30, top = 10, H = top + rows.length * rowH + 30;
    const x = v => L + (v - sc.min) / (sc.max - sc.min) * (W - L - Rt);
    let svg = "";
    for (let k = sc.min; k <= sc.max; k++){
      const mid = k === (sc.min + sc.max) / 2;
      svg += `<line x1="${x(k)}" x2="${x(k)}" y1="${top - 4}" y2="${top + rows.length * rowH}" stroke="${mid ? "#C5CFD8" : "#E3E8EE"}" stroke-width="1"${mid ? ' stroke-dasharray="3 3"' : ""}/>`;
      svg += `<text x="${x(k)}" y="${top + rows.length * rowH + 14}" text-anchor="middle" class="ax">${k}</text>`;
    }
    svg += `<text x="${x(sc.min)}" y="${H - 2}" class="ax2">${E(sc.labels[sc.min])}</text><text x="${x(sc.max)}" y="${H - 2}" text-anchor="end" class="ax2">${E(sc.labels[sc.max])}</text>`;
    rows.forEach(([g, s], i) => {
      const y = top + i * rowH + rowH / 2, col = gCol(g), tipTxt = `<b>${E(gLabel(g))}</b><br>Mean ${fmt(s.m, 2)} (95% CI ${fmt(s.lo, 2)}–${fmt(s.hi, 2)})<br>n = ${s.n}`;
      if (g === "all") svg += `<rect x="0" y="${y - rowH / 2 + 2}" width="${W}" height="${rowH - 4}" rx="6" fill="#F3F6F9"/>`;
      svg += `<text x="${L - 12}" y="${y + 4}" text-anchor="end" class="lb${g === "all" ? " b" : ""}">${E(gLabel(g))}</text>`;
      svg += `<line x1="${x(s.lo)}" x2="${x(s.hi)}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>`;
      svg += `<circle cx="${x(s.m)}" cy="${y}" r="${g === "all" ? 7 : 6}" fill="${col}" stroke="#fff" stroke-width="2" data-tip="${tipTxt}"/>`;
      svg += `<text x="${W - 4}" y="${y + 4}" text-anchor="end" class="vl">${fmt(s.m)}</text>`;
      svg += `<rect x="${L}" y="${y - rowH / 2}" width="${W - L - Rt}" height="${rowH}" fill="transparent" data-tip="${tipTxt}"/>`;
    });
    return `<svg class="fb-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${E(q.label)}: mean by group">${svg}</svg>`;
  }
  function byGroupLikert(qid, gs, title){
    const q = findQ(qid); if (!q) return "";
    const have = gs.filter(g => (R.data.q[qid] || {})[g]);
    if (!have.length) return "";
    let rows = have.map(g => likRow(E(gLabel(g)), R.data.q[qid][g], q.scale, g)).join("");
    if (have.length > 1) rows = likRow("<b>All respondents</b>", agg(qid, have), q.scale, "all") + rows;
    return panel(title, E(q.label), legendHtml(q.scale, q.na) + `<div class="fb-lik">${rows}</div>`, true);
  }
  const PACE_COL = { too_slow: "#D9822B", about_right: "#00843D", too_fast: "#2F5FA8", dk: DK };
  function paceByGroup(gs){
    const q = findQ("A6_pace"); const have = gs.filter(g => (R.data.q.A6_pace || {})[g]); if (!q || !have.length) return "";
    const row = (g, a) => {
      const tot = a.a || 1, cnt = Object.assign({}, a.c || {}, a.ns || {});
      return `<span class="l"><i class="dot" style="--gc:${gCol(g)}"></i><span>${g === "all" ? "<b>All respondents</b>" : E(gLabel(g))}</span></span><div class="fb-stack">${
        q.options.filter(o => cnt[o.code]).map(o => { const n = cnt[o.code], w = 100 * n / tot;
          return `<span class="${o.code === "dk" ? "lt" : ""}" style="width:${w}%;background:${PACE_COL[o.code]}" data-tip="<b>${E(o.label)}</b><br>${n} of ${tot} (${Math.round(w)}%)">${w >= 9 ? Math.round(w) + "%" : ""}</span>`; }).join("")}</div><span class="m">n=${tot}</span>`;
    };
    const rows = (have.length > 1 ? [row("all", agg("A6_pace", have))] : []).concat(have.map(g => row(g, R.data.q.A6_pace[g]))).join("");
    return panel("Pace of climate action", E(q.label), `<div class="fb-legend">${q.options.map(o => `<span><i style="background:${PACE_COL[o.code]}"></i>${E(o.label)}</span>`).join("")}</div><div class="fb-lik">${rows}</div>`, true);
  }
  function heatPanel(qid, gs, title, sub){
    const q = findQ(qid); if (!q) return "";
    const have = gs.filter(g => (R.data.q[qid] || {})[g]);
    if (!have.length) return "";
    const cols = (have.length > 1 ? ["all"] : []).concat(have);
    const cell = (a, row) => {
      const r = a && a.rows && a.rows[row]; const m = meanOf(r), n = r ? sum(r.c) : 0;
      if (m == null) return '<td class="c none" data-tip="No ratings">–</td>';
      const c = meanColour(m, q.scale);
      return `<td class="c" style="background:${c.bg};color:${c.fg}" data-tip="<b>${fmt(m, 2)}</b> mean of ${n} ratings${nsSum(r) ? `<br>${nsSum(r)} non-substantive` : ""}">${fmt(m)}</td>`;
    };
    const aggs = Object.fromEntries(cols.map(g => [g, g === "all" ? agg(qid, have) : R.data.q[qid][g]]));
    const rows = q.rows.map(r => `<tr><td>${E(r.label)}</td>${cols.map(g => cell(aggs[g], r.code)).join("")}</tr>`).join("");
    const lo = q.scale.labels[q.scale.min], hi = q.scale.labels[q.scale.max];
    return panel(title, sub || E(q.label), `<div style="overflow:auto"><table class="fb-heat"><thead><tr><th></th>${cols.map(g => `<th>${g === "all" ? "All" : E(gLabel(g))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="fb-scalekey"><span>${q.scale.min} ${E(lo)}</span><span class="g" style="background:linear-gradient(90deg,${palFor(q.scale).join(",")})"></span><span>${q.scale.max} ${E(hi)}</span><span style="margin-left:auto">mean score</span></div>`, true);
  }
  function choiceMatrix(qid, gs, title){
    const have = gs.filter(g => (R.data.q[qid] || {})[g]); if (!have.length) return "";
    const all = agg(qid, have), cols = (have.length > 1 ? ["all"] : []).concat(have);
    const aggs = Object.fromEntries(cols.map(g => [g, g === "all" ? all : R.data.q[qid][g]]));
    const codes = Object.entries(all.c || {}).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const rows = codes.map(code => `<tr><td>${E(optLabel(qid, code))}</td>${cols.map(g => {
      const a = aggs[g], n = (a.c || {})[code] || 0, p = pct(n, a.a);
      return `<td class="c" style="background:rgba(15,157,138,${(0.08 + 0.85 * p / 100).toFixed(2)});color:${p > 55 ? "#fff" : "#1F2D3A"}" data-tip="<b>${E(gLabel(g))}</b><br>${n} of ${a.a} chose this (${p}%)">${p}%</td>`;
    }).join("")}</tr>`).join("");
    return panel(title, `% of each group choosing the option · ${all.a} respondents answered`,
      `<div style="overflow:auto"><table class="fb-heat"><thead><tr><th></th>${cols.map(g => `<th>${g === "all" ? "All" : E(gLabel(g))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`, true);
  }
  // Policies (Module C): perceived past contribution (C4) against fairness (C7)
  const itemQ = id => { const q = findQ("C_policies"); return q && q.items.find(i => i.id === id); };
  const polName = (key, x) => x.ref ? ((findQ("C_policies") || { refs: [] }).refs.find(r => r.code === key) || {}).title || key : x.name || key;
  function policyScatter(gs){
    const a = agg("C_policies", gs); if (!a || !a.p) return "";
    const pts0 = Object.entries(a.p).map(([key, x]) => {
      const e = meanOf(x.items.obs), f = meanOf(x.items.fair), ne = x.items.obs ? sum(x.items.obs.c) : 0, nf = x.items.fair ? sum(x.items.fair.c) : 0;
      return e != null && f != null && ne >= 2 && nf >= 2 ? { key, name: polName(key, x), n: x.n, e, f, ref: x.ref, p: polByName.get(x.name) || {} } : null;
    }).filter(Boolean);
    if (pts0.length < 2) return "";
    const W = 900, H = 400, L = 50, B = 46, T = 16, Rr = 16, lo = 1, hi = 5;
    const x = v => L + (v - lo) / (hi - lo) * (W - L - Rr), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const nMax = Math.max(...pts0.map(p => p.n)), rad = n => 5 + 11 * Math.sqrt(n / nMax);
    let svg = "";
    for (let v = lo; v <= hi; v++){
      svg += `<line x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}" stroke="#E3E8EE"/><line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="#E3E8EE"/>`;
      svg += `<text x="${x(v)}" y="${H - B + 16}" text-anchor="middle" class="ax">${v}</text><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`;
    }
    svg += `<line x1="${x(3)}" x2="${x(3)}" y1="${T}" y2="${H - B}" stroke="#AAB6C2" stroke-dasharray="4 4"/><line x1="${L}" x2="${W - Rr}" y1="${y(3)}" y2="${y(3)}" stroke="#AAB6C2" stroke-dasharray="4 4"/>`;
    svg += `<text x="${(L + W - Rr) / 2}" y="${H - 8}" text-anchor="middle" class="ax2">Perceived contribution so far (C4, mean 1–5) →</text>`;
    svg += `<text transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" class="ax2">Fairness (C7, mean 1–5) →</text>`;
    pts0.sort((p, q) => q.n - p.n).forEach((p, i) => {
      const col = p.ref ? "#244A6E" : p.p.color || "#5C6B7A";
      const t = `<b>${E(p.name)}</b>${p.ref ? "<br>Reference policy" : ""}<br>Contribution ${fmt(p.e, 2)} · Fairness ${fmt(p.f, 2)}<br>Assessed by ${p.n}`;
      svg += `<circle cx="${x(p.e)}" cy="${y(p.f)}" r="${rad(p.n)}" fill="${col}" fill-opacity=".72" stroke="#fff" stroke-width="2" data-tip="${t}"/>`;
      if (i < 8) svg += `<text x="${x(p.e) + rad(p.n) + 3}" y="${y(p.f) + 4}" class="pl">${E(p.name.length > 28 ? p.name.slice(0, 27) + "…" : p.name)}</text>`;
    });
    return panel("Policies: contribution and fairness", "Each bubble is a policy assessed by at least two people; bubble size = number of assessments; dark blue = reference policies. Hover for details.",
      `<svg class="fb-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of policies by perceived contribution and fairness">${svg}</svg>`, true);
  }
  const CRIT = [["obs", "C4 Contribution so far"], ["exp", "C5 Expected by 2030"], ["impl", "C6 Implementation"], ["fair", "C7 Fairness"], ["evid", "C8 Evidence"], ["cost", "C9 Value for cost"], ["grp", "C10 Group criterion"], ["conf", "C11 Confidence"]];
  function scorecard(gs){
    const a = agg("C_policies", gs);
    if (!a || !a.p || !Object.keys(a.p).length) return panel("Policy scorecard", "", '<p class="fb-empty" style="font-size:.8rem"><i class="bi bi-dash-circle"></i>No policies assessed yet.</p>', true);
    const crits = CRIT.filter(([c]) => (c !== "grp" || gs.length === 1) && Object.values(a.p).some(x => x.items[c]));
    let rows = Object.entries(a.p).map(([key, x]) => ({ name: polName(key, x), ref: x.ref, n: x.n,
      m: Object.fromEntries(crits.map(([c]) => [c, x.items[c] && sum(x.items[c].c) >= 2 ? meanOf(x.items[c]) : null])),
      cn: Object.fromEntries(crits.map(([c]) => [c, x.items[c] ? sum(x.items[c].c) : 0])) }));
    const { k, dir } = R.sort;
    rows.sort((p, q) => {
      if (p.ref !== q.ref) return p.ref ? -1 : 1;
      const a1 = k === "n" ? p.n : k === "name" ? p.name : p.m[k], b1 = k === "n" ? q.n : k === "name" ? q.name : q.m[k];
      if (a1 == null && b1 == null) return 0; if (a1 == null) return 1; if (b1 == null) return -1;
      return (a1 < b1 ? -1 : a1 > b1 ? 1 : 0) * dir;
    });
    const total = rows.length; if (!R.allPol) rows = rows.slice(0, 12);
    const th = (key, txt) => `<th><button type="button" data-sort="${key}"${R.sort.k === key ? ` aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${txt}${R.sort.k === key ? `<i class="bi bi-caret-${dir > 0 ? "up" : "down"}-fill"></i>` : ""}</button></th>`;
    const scaleOf = c => (itemQ(c) || {}).scale || { min: 1, max: 5 };
    const bodyH = rows.map(r => `<tr><td>${E(r.name)}<small>${r.ref ? "Reference policy" : "Own choice"}</small></td><td>${r.n}</td>${crits.map(([c, l]) => {
        if (r.m[c] == null) return `<td><span class="muted" data-tip="${r.cn[c] ? "Fewer than 2 ratings" : "Not rated"}">–</span></td>`;
        const col = meanColour(r.m[c], scaleOf(c));
        return `<td><span class="chip" style="background:${col.bg};color:${col.fg}" data-tip="<b>${E(l)}</b>: ${fmt(r.m[c], 2)}<br>${r.cn[c]} ratings">${fmt(r.m[c])}</span></td>`;
      }).join("")}</tr>`).join("");
    return panel("Policy scorecard", "Mean rating, 1 (least favourable) to 5 (most favourable); non-substantive answers excluded. Reference policies first. Click a column to sort.",
      `<div class="fb-score-wrap"><table class="fb-score"><thead><tr>${th("name", "Policy")}${th("n", "Assessed by")}${crits.map(([c, l]) => th(c, E(l))).join("")}</tr></thead><tbody>${bodyH}</tbody></table></div>
      ${total > 12 ? `<button type="button" class="fb-more" id="fbPolMore">${R.allPol ? "Show the top 12" : `Show all ${total} policies`}</button>` : ""}`, true);
  }
  function viewAll(){
    const gs = charted();
    let h = kpis(gs, `from ${gs.length} groups`);
    h += section("Who took part", whoPanel() + timelinePanel());
    const titles = { A2_eff_overall: "Overall effectiveness of climate policy (A2)", A5_target2030: "Likelihood of meeting the 2030 target (A5)", D10_useful_role: "Usefulness of this dashboard (D10)" };
    h += section("Group comparison", Object.keys(titles).map(qid => { const plot = dotPlot(qid, gs); return plot ? panel(titles[qid], "Mean score and 95% confidence interval by group", plot) : ""; }).join("") +
      `<div class="fb-panel"><h5>How to read the comparison</h5><p class="sub" style="margin:0;line-height:1.6">Each dot is a group's average answer and the line around it its 95% confidence interval. Where the lines of two groups do not overlap, their views differ clearly; with small groups the lines are wide. The dashed line marks the middle of the scale. Non-substantive answers (don't know, cannot judge) are excluded.</p>${groupLegend(gs, true)}</div>`);
    h += section("Headline judgements", byGroupLikert("A2_eff_overall", gs, "Overall effectiveness of climate policy") + byGroupLikert("A5_target2030", gs, "Will Ireland meet the 2030 target?") + paceByGroup(gs));
    h += section("Sectors", heatPanel("A7_eff_sector", gs, "Effectiveness of policy by sector (A7)", "Mean rating, 1 (very ineffective) to 5 (very effective)."));
    h += section("Barriers, coherence and fairness", choiceMatrix("A10_barrier", gs, "Main barriers to more effective climate policy (A10)") + byGroupLikert("A12_incoherence", gs, "Policies pulling in different directions (A12)") +
      byGroupLikert("A13_fair_overall", gs, "Costs and benefits shared fairly (A13)") + choiceMatrix("A17_strengthen", gs, "Measures to strengthen most (A17)"));
    h += section("Policy interactions", heatPanel("I1_int", gs, "Perceived policy interactions (I1)", "Median-free summary: mean score from −3 (cancelling) to +3 (indivisible), professional groups."));
    h += section("Policies", policyScatter(gs) + scorecard(gs));
    return h;
  }
  const SKIP = ["text", "consents", "group"];
  function viewGroup(g){
    const info = S.gmap[g], n = R.data.groups[g] || 0;
    if (!charted().includes(g)) return `<p class="fb-empty"><i class="bi bi-shield-lock"></i>${n} response${n === 1 ? "" : "s"} from ${E(info.plural.toLowerCase())} so far. Their answers are shown once at least ${R.data.min_cell} people from this group have responded, so that no individual can be recognised.</p>`;
    let h = kpis([g], `${info.plural} · ${pct(n, R.data.n)}% of all responses`);
    (S.schema.flows[g] || []).forEach(st => {
      const panels = st.questions.filter(q => !SKIP.includes(q.type)).map(q => {
        const a = (R.data.q[q.id] || {})[g]; if (!a) return "";
        const sub = `${a.a} answered`;
        if (q.type === "policies3") return policyScatter([g]) + scorecard([g]);
        if (q.type === "matrix"){
          const rows = q.rows.filter(r => a.rows[r.code]).map(r => likRow(E(r.label), a.rows[r.code], q.scale)).join("");
          return rows ? panel(E(q.label), sub, legendHtml(q.scale, q.na) + `<div class="fb-lik">${rows}</div>`, true) : "";
        }
        if (q.type === "pickgrid"){
          const rows = Object.entries(a.t || {}).map(([tc, x]) => q.rows.map(r => likRow(`${E(optLabel(q.id, tc))}: ${E(r.label.split(" (")[0])}`, x.rows[r.code], q.scale)).join("")).join("");
          return panel(E(q.label), sub, legendHtml(q.scale, q.na) + `<div class="fb-lik">${rows}</div>`, true);
        }
        if (q.type === "scale") return panel(E(q.label), sub, legendHtml(q.scale, q.na) + `<div class="fb-lik">${likRow(E(info.plural), a, q.scale, g)}</div>`);
        return panel(E(q.label), sub + (q.type === "multi" ? " · % choosing each option" : ""), choiceBars(q.id, a, 0, GCOL[g]));
      }).join("");
      h += section(E(st.title), panels);
    });
    return h;
  }
  function renderDash(){
    const d = R.data;
    $("fbHeroN").textContent = d.n.toLocaleString("en-IE"); $("fbHeroStat").hidden = false;
    const viewer = S.gmap[d.viewer] || {};
    const top = `<div class="fb-dash-top"><div><div class="fb-sec-h"><i class="bi bi-bar-chart-line"></i>Consultation results</div>
        <p class="fb-sec-sub">Aggregated results · updated ${new Date(d.updated_utc).toLocaleString("en-IE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · questionnaire ${E(d.version)} · viewing as ${E((viewer.label || "").toLowerCase())}</p></div>
      <div class="fb-dash-btns"><button type="button" id="fbResRefresh"><i class="bi bi-arrow-clockwise"></i>Refresh</button></div></div>`;
    if (!d.n){ resBody.innerHTML = top + '<p class="fb-empty"><i class="bi bi-hourglass-split"></i>No responses yet.</p>'; return; }
    const tabs = [["all", "All respondents", d.n, "bi-people-fill"]].concat(S.groups.map(g => [g.code, g.plural, d.groups[g.code] || 0, g.icon]));
    const tabBar = `<div class="fb-tabs" role="tablist" aria-label="Results by group">${tabs.map(([c, l, n, ic]) =>
      `<button type="button" role="tab" id="fbTab-${c}" aria-controls="fbTabPanel" aria-selected="${R.tab === c}" tabindex="${R.tab === c ? 0 : -1}" data-tab="${c}" style="--gc:${gCol(c)}"><i class="bi ${E(ic)}"></i>${E(l)}<small>${n}</small></button>`).join("")}</div>`;
    const bodyH = R.tab === "all" ? viewAll() : viewGroup(R.tab);
    resBody.innerHTML = top + tabBar + `<div id="fbTabPanel" role="tabpanel" aria-labelledby="fbTab-${R.tab}">${bodyH}</div>` +
      `<p class="fb-note"><i class="bi bi-info-circle me-1"></i>Respondents choose to take part, so the results describe them, not the population. Groups with fewer than ${d.min_cell} responses are counted but not charted, and a policy score needs at least two ratings. Answers record how participants see policies; they do not show that a policy caused a change in emissions. Free-text answers are not shown here.</p>`;
  }
  function renderLock(msg){
    $("fbHeroStat").hidden = true;
    resBody.innerHTML = `<p class="fb-empty"><i class="bi bi-lock"></i>${E(msg || "The aggregated results are shown to stakeholders, researchers, experts and policy makers who completed the questionnaire, once fieldwork has closed.")}</p>`;
  }
  function showResults(fresh){ $("fbResults").hidden = false; loadResults(fresh); }
  resBody.addEventListener("click", e => {
    const t = e.target;
    const tb = t.closest("[data-tab]"); if (tb){ R.tab = tb.dataset.tab; R.allPol = false; renderDash(); $("fbTab-" + R.tab)?.focus(); return; }
    const so = t.closest("[data-sort]");
    if (so){ const k = so.dataset.sort; R.sort = { k, dir: R.sort.k === k ? -R.sort.dir : (k === "name" ? 1 : -1) }; renderDash(); return; }
    if (t.closest("#fbPolMore")){ R.allPol = !R.allPol; renderDash(); return; }
    if (t.closest("#fbResRefresh")){ loadResults(true); return; }
  });
  resBody.addEventListener("keydown", e => {
    const tb = e.target.closest("[role=tab]"); if (!tb || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const all = [...resBody.querySelectorAll("[role=tab]")], i = all.indexOf(tb), nx = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    R.tab = nx.dataset.tab; renderDash(); $("fbTab-" + R.tab)?.focus();
  });
  resBody.addEventListener("mousemove", e => {
    const m = e.target.closest("[data-tip]");
    if (!m || !m.dataset.tip){ tip.classList.remove("on"); return; }
    tip.innerHTML = m.dataset.tip; tip.classList.add("on");
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, e.clientX + 14) + "px";
    tip.style.top = (e.clientY - h - 12 < 4 ? e.clientY + 16 : e.clientY - h - 12) + "px";
  });
  resBody.addEventListener("mouseleave", () => tip.classList.remove("on"));
  async function loadResults(fresh){
    if (!S.schema) return;
    if (!resultsOk()){ renderLock(); return; }
    if (!R.data) resBody.innerHTML = '<p class="fb-empty"><span class="spinner-border spinner-border-sm"></span>Loading the results&hellip;</p>';
    try {
      const resp = await fbFetch("/api/feedback/summary/" + (fresh ? "?t=" + Date.now() : ""), { headers: { "X-Feedback-Results": S.results.token }, cache: "no-store" });
      if (resp.status === 403){ S.results = null; store.del(KEY_RESULTS); renderLock("Your access to the results has expired. Complete the questionnaire again to see the results."); return; }
      const d = await resp.json();
      if (d.code === "closed"){ renderLock(d.detail); return; }
      if (!d.ok) throw new Error(d.detail);
      R.data = d;
      renderDash();
    } catch (e){
      resBody.innerHTML = '<p class="fb-empty"><i class="bi bi-wifi-off"></i>The results could not be loaded. Please try again later.</p>';
    }
  }

  // ---- Research-team download ----
  $("fbAdminForm").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("fbAdminMsg"), fd = new FormData();
    fd.append("key", $("fbAdminKey").value); fd.append("format", $("fbAdminFmt").value);
    setStatus("sending", '<span class="spinner-border spinner-border-sm"></span>Preparing the export&hellip;', msg);
    try {
      const resp = await fetch("/api/feedback/download/", { method: "POST", body: fd });
      if (!resp.ok) throw new Error(await resp.text());
      const blob = await resp.blob();
      const name = (/filename="([^"]+)"/.exec(resp.headers.get("Content-Disposition") || "") || [])[1] || "inpact_survey";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      setStatus("ok", `<i class="bi bi-check-circle-fill"></i>Downloaded ${E(name)}.`, msg);
    } catch (err){
      setStatus("err", `<i class="bi bi-exclamation-triangle-fill"></i>${E(err.message || "Download failed.")}`, msg);
    }
  });

  // ---- Start (only once the section code has been accepted) ----
  let started = false;
  function openSection(){
    $("fbGated").hidden = false;
    if (!started){ started = true; start(); }
  }
  window.fbGate = { ok: gateOk, ask: () => askKey() };
  gateDlg.addEventListener("close", () => {
    if (!gateOk() && $("tab-feedback").classList.contains("active") && typeof activateTab === "function") activateTab("explorer");
  });
  $("fbGateCancel").addEventListener("click", () => gateDlg.close());
  $("fbGateForm").addEventListener("submit", async e => {
    e.preventDefault();
    const inp = $("fbGateCode"), btn = $("fbGateBtn"), m = $("fbGateMsg"), code = inp.value.trim();
    if (!code){ m.className = "fb-keymsg err"; m.textContent = "Please enter the access code."; inp.focus(); return; }
    btn.disabled = true; m.className = "fb-keymsg"; m.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking&hellip;';
    try {
      const resp = await fetch("/api/feedback/gate/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok || !d.ok) throw new Error(d.detail || "The code could not be checked. Please try again.");
      gate = { token: d.token, exp: Date.now() + (d.hours || 12) * 3600 * 1000 };
      sess.set(KEY_GATE, gate);
      inp.value = ""; m.textContent = "";
      openSection();
      gateDlg.close();
      if (typeof activateTab === "function") activateTab("feedback");
    } catch (err){
      m.className = "fb-keymsg err"; m.textContent = err.message; inp.select();
    } finally { btn.disabled = false; }
  });
  if (gateOk()) openSection();
  else {
    lockSection();
    if ($("tab-feedback").classList.contains("active")) askKey();      // the page was opened on #feedback
  }

  function start(){
    fbFetch("/api/feedback/schema/").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(schema => {
      S.schema = schema;
      S.groups = schema.groups;
      S.gmap = Object.fromEntries(schema.groups.map(g => [g.code, g]));
      const d = store.get(KEY_DRAFT), done = store.get(KEY_DONE);
      if (d && d.v === schema.version && d.answers && Object.keys(d.answers).length){
        Object.assign(S, { answers: d.answers, step: d.step || 0, max: d.max || 0, started: d.started, form: d.form || null, orders: d.orders || {} });
        if (!S.gmap[S.answers.group]) delete S.answers.group;
        banner(`<i class="bi bi-clock-history"></i><span>Welcome back. Your unfinished answers from ${new Date(d.saved).toLocaleDateString("en-IE", { day: "numeric", month: "long" })} have been restored.</span>${resultsOk() ? '<button type="button" id="fbViewResults">View the results</button>' : ""}<button type="button" id="fbRestart">Start again</button>`);
      } else if (done && done.at){
        banner(`<i class="bi bi-check2-circle"></i><span>You already responded on ${new Date(done.at).toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" })}. You are welcome to answer again if you speak from a different perspective (for example as an expert and as a member of the public).</span>${resultsOk() ? '<button type="button" id="fbViewResults">View the results</button>' : ""}`);
      }
      buildSteps();
      const g = groupOf();
      if (g && g.keyed && !accessOk(g.code) && S.step > 0) S.step = 0;
      render(false);
    }).catch(() => {
      started = false;
      body.innerHTML = '<p class="fb-empty"><i class="bi bi-exclamation-triangle"></i>The survey could not be loaded. Please reload the page.</p>';
      resBody.innerHTML = "";
    });
  }
  $("fbBanner").addEventListener("click", e => {
    if (e.target.id === "fbViewResults"){ showResults(true); $("fbResults").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (e.target.id !== "fbRestart") return;
    clearDraft(); S.answers = {}; S.step = 0; S.max = 0; S.started = null; S.form = null; S.orders = {}; buildSteps(); banner(); render(true);
  });
})();
