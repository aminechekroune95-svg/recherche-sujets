// Recherche de sujets BNS — interface de recherche (Pagefind)
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const PAGE = 20;
const FILTER_KEYS = ["matiere", "niveau", "voie", "theme", "annee", "langue", "corrige", "calculatrice", "banque"];
const MORE_KEYS = ["theme", "annee", "langue", "corrige", "calculatrice", "banque"];
const ORDER = {
  niveau: ["Première", "Terminale", "Cycle terminal"],
  voie: ["Générale", "Technologique"],
  corrige: ["Corrigé disponible", "Corrigé d'une autre version", "Sans corrigé"],
  calculatrice: ["Autorisée", "Interdite"],
};
const DESC = new Set(["annee", "banque"]);
const BASKET_KEY = "recherche-sujets:selection:v1";

const state = { q: "", filters: {}, sort: "", results: [], shown: 0, token: 0, exact: new Set() };
let pf = null;
let allFilters = {};

const ui = {
  q: $("#q"), form: $("#search-form"), results: $("#results"), total: $("#total"),
  more: $("#load-more"), sort: $("#sort"), stats: $("#stats"), moreCount: $("#more-count"),
  moreBox: $("#more"), basket: $("#basket"), basketN: $("#basket-n"), dialog: $("#basket-dialog"),
  basketList: $("#basket-list"), basketNote: $("#basket-note"),
};

const nf = new Intl.NumberFormat("fr-FR");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- état <-> URL
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get("q") || "";
  state.filters = {};
  for (const k of FILTER_KEYS) if (p.get(k)) state.filters[k] = p.get(k);
  state.sort = p.get("tri") || "";
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  for (const k of FILTER_KEYS) if (state.filters[k]) p.set(k, state.filters[k]);
  if (state.sort) p.set("tri", state.sort);
  const h = p.toString();
  const url = h ? `#${h}` : location.pathname + location.search;
  if (url !== location.hash) history.replaceState(null, "", url);
}
function syncUIFromState() {
  ui.q.value = state.q;
  ui.sort.value = state.sort;
  for (const sel of $$("select[data-filter]")) {
    const v = state.filters[sel.dataset.filter] || "";
    if (v && ![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v));
    sel.value = v;
    sel.classList.toggle("is-set", !!v);
  }
  const n = MORE_KEYS.filter((k) => state.filters[k]).length;
  ui.moreCount.textContent = n ? String(n) : "";
  if (n) ui.moreBox.open = true;
}

// ---------------------------------------------------------------- filtres
function sortValues(key, entries) {
  const order = ORDER[key];
  const rank = (v) => (order.indexOf(v) < 0 ? 99 : order.indexOf(v));
  return entries.sort(([a], [b]) => {
    if (order) return rank(a) - rank(b) || a.localeCompare(b, "fr");
    const c = a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" });
    return DESC.has(key) ? -c : c;
  });
}
function fillSelects(counts, totals) {
  const searching = !!(state.q.trim() || Object.keys(activeFilters()).length);
  for (const sel of $$("select[data-filter]")) {
    const key = sel.dataset.filter;
    const values = allFilters[key] || {};
    const current = state.filters[key] || "";
    const source = counts && searching ? (current && totals ? totals[key] : counts[key]) || {} : values;
    const first = sel.options[0];
    const opts = [first];
    for (const [v] of sortValues(key, Object.entries(values))) {
      const n = source[v] ?? 0;
      if (key === "theme" && searching && n === 0 && v !== current) continue;
      opts.push(new Option(`${v} (${nf.format(n)})`, v));
    }
    sel.replaceChildren(...opts);
    sel.value = current;
    const field = sel.closest(".field");
    if (key === "langue" || key === "calculatrice") field.hidden = Object.keys(values).length === 0;
  }
}
function activeFilters() {
  const f = {};
  for (const [k, v] of Object.entries(state.filters)) if (v) f[k] = [v];
  return f;
}

// ---------------------------------------------------------------- recherche
const fold = (s) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const existsCache = new Map();
// Pagefind ne renvoie rien de vide pour un mot inconnu : il le rapproche d'un mot court (« R », « x »…).
// On vérifie donc chaque mot seul : s'il ne surligne rien qui lui ressemble, il est absent.
async function termExists(term, filters) {
  const t = fold(term);
  if (term.startsWith('"') || t.length < 3) return true;
  const key = `${t}|${JSON.stringify(filters)}`;
  if (existsCache.has(key)) return existsCache.get(key);
  const s = await pf.search(term, { filters });
  let ok = false;
  for (const r of s.results.slice(0, 2)) {
    const d = await r.data();
    const marks = [...d.excerpt.matchAll(/<mark>(.*?)<\/mark>/g)].map((m) => fold(m[1]));
    const k = Math.min(t.length, Math.max(4, t.length - 2)); // « titrage » ne doit pas valider « titre »
    if (marks.some((w) => w.slice(0, k) === t.slice(0, k))) { ok = true; break; }
  }
  existsCache.set(key, ok);
  return ok;
}

async function run() {
  if (!pf) return;
  const token = ++state.token;
  const q = state.q.trim();
  const filters = activeFilters();
  writeHash();
  if (!q && !Object.keys(filters).length) {
    showWelcome();
    fillSelects(null, null);
    return;
  }
  const terms = q.match(/"[^"]+"|\S+/g) || [];
  const found = await Promise.all(terms.map((t) => termExists(t, filters)));
  if (token !== state.token) return;
  const missing = terms.filter((_, i) => !found[i]);
  const effective = terms.filter((_, i) => found[i]).join(" ");
  const opts = { filters };
  if (state.sort) {
    const [k, dir] = state.sort.split(":");
    opts.sort = { [k]: dir };
  } else if (!effective) opts.sort = { annee: "desc" };
  // Plusieurs mots : les sujets qui contiennent l'expression exacte (« suite géométrique ») passent devant
  // ceux qui contiennent seulement les mots séparés (« géométrie plane », « suites numériques »).
  const kept = terms.filter((_, i) => found[i]);
  const plain = kept.filter((t) => !t.startsWith('"'));
  const doPhrase = !state.sort && plain.length >= 2 && plain.length === kept.length;
  const [search, phrase] = await Promise.all([
    terms.length && !effective ? { results: [], filters: null, totalFilters: null } : pf.search(effective || null, opts),
    doPhrase ? pf.search(`"${plain.join(" ")}"`, opts) : null,
  ]);
  if (token !== state.token) return;
  const exact = phrase?.results || [];
  state.exact = new Set(exact.map((r) => r.id));
  state.results = [...exact, ...search.results.filter((r) => !state.exact.has(r.id))];
  state.shown = 0;
  ui.results.replaceChildren();
  const n = state.results.length;
  ui.total.textContent = n
    ? `${nf.format(n)} sujet${n > 1 ? "s" : ""}${exact.length ? `, dont ${nf.format(exact.length)} avec l'expression exacte` : ""}`
    : "Aucun sujet";
  if (missing.length) {
    const where = Object.keys(filters).length ? " avec ces filtres" : "";
    const list = missing.map((m) => `« ${esc(m)} »`).join(", ");
    const note = document.createElement("p");
    note.className = "notice";
    note.innerHTML = `Aucun sujet${where} ne contient ${list}${effective ? ` : résultats pour « ${esc(effective)} ».` : "."}`;
    ui.results.append(note);
  }
  if (!n) showEmpty(q, !!missing.length);
  else await renderMore();
  if (search.filters) fillSelects(search.filters, search.totalFilters);
}
let typingTimer = 0;
function runSoon() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(run, 250);
}

function showWelcome() {
  state.results = [];
  ui.total.textContent = "";
  ui.more.hidden = true;
  const mats = sortValues("matiere", Object.entries(allFilters.matiere || {}));
  const box = document.createElement("div");
  box.className = "empty";
  box.innerHTML = `<h2>Tape une notion, ou parcours une matière</h2>
    <p>Chaque sujet est cherché dans son texte complet, pas seulement dans son titre.</p>
    <div class="examples">${mats.map(([m, c]) => `<button type="button" data-mat="${esc(m)}">${esc(m)} (${nf.format(c)})</button>`).join("")}</div>`;
  ui.results.replaceChildren(box);
}

function showEmpty(q, noted = false) {
  ui.more.hidden = true;
  if (noted && !Object.keys(activeFilters()).length) return;
  const box = document.createElement("div");
  box.className = "empty";
  const nf_ = Object.keys(activeFilters()).length;
  box.innerHTML = `<h2>Aucun sujet ne correspond</h2>
    <p>${q ? "Tous les mots doivent apparaître dans le sujet : retire un mot ou essaie un synonyme." : ""}</p>
    ${nf_ ? `<p>${nf_} filtre${nf_ > 1 ? "s" : ""} actif${nf_ > 1 ? "s" : ""} : <button type="button" class="linkish" data-reset>effacer les filtres</button>.</p>` : ""}`;
  ui.results.append(box);
}

async function renderMore() {
  const token = state.token;
  const slice = state.results.slice(state.shown, state.shown + PAGE);
  const datas = await Promise.all(slice.map((r) => r.data()));
  if (token !== state.token) return;
  const frag = document.createDocumentFragment();
  datas.forEach((d, i) => frag.append(card(d, state.exact?.has(slice[i].id))));
  ui.results.append(frag);
  state.shown += slice.length;
  const left = state.results.length - state.shown;
  ui.more.hidden = left <= 0;
  ui.more.textContent = `Afficher ${Math.min(PAGE, left)} sujets de plus`;
}

function levelLabel(m) {
  const voie = (m.voie || "").toLowerCase();
  if (m.niv === "Première" || m.niv === "Terminale") return voie ? `${m.niv} ${voie}` : m.niv;
  return [m.niv, voie && `voie ${voie}`].filter(Boolean).join(", ");
}
function contextLine(m) {
  return [m.mat, levelLabel(m), m.langue, m.annee && m.annee !== "0" ? `session ${m.annee}` : ""].filter(Boolean).join(", ");
}
function parseParts(m) {
  try { return JSON.parse(m.parts || "[]"); } catch { return []; }
}

function card(d, exact = false) {
  const m = d.meta;
  const art = document.createElement("article");
  art.className = "res";
  const parts = parseParts(m);
  let themes = [];
  try { themes = JSON.parse(m.themes || "[]"); } catch { /* ignoré */ }
  if (!parts.length && themes.length) parts.push(...themes.map((t) => ({ n: "", t })));
  const partsHtml = parts.length
    ? `<ul class="parts">${parts.map((p) => {
        let body = p.t || (p.th || []).join(", ");
        if (body.length > 150) body = `${body.slice(0, 147).replace(/\s+\S*$/, "")}…`;
        const tip = p.t && p.th?.length ? ` title="${esc(p.th.join(" ; "))}"` : "";
        return `<li${tip}>${p.n ? `<b>${esc(p.n)}</b> ` : ""}${esc(body)}</li>`;
      }).join("")}</ul>`
    : "";
  const notes = [];
  if (exact) notes.push(`<li class="ok">Expression exacte</li>`);
  if (m.corrige === "Oui") notes.push(`<li class="ok">Corrigé disponible</li>`);
  else if (m.corrige === "Autre version") notes.push(`<li>Corrigé d'une autre version</li>`);
  if (m.calc) notes.push(`<li>Calculatrice ${esc(m.calc.toLowerCase())}</li>`);
  if (m.pages) notes.push(`<li>${esc(m.pages)} page${m.pages === "1" ? "" : "s"}</li>`);
  if (m.texte !== "1") notes.push(`<li class="warn">Texte du PDF pas encore indexé</li>`);
  let corr = [];
  try { corr = JSON.parse(m.corrections || "[]"); } catch { /* ignoré */ }
  const corrHtml = corr.length
    ? `<p class="res__corr">Corrigés : ${corr.map((c) => `<a href="${esc(c.href)}" target="_blank" rel="noopener">${esc(c.src)}</a>`).join(", ")}</p>`
    : "";
  const inBasket = getBasket().some((b) => b.id === m.id);
  art.innerHTML = `
    <p class="res__ctx">${esc(contextLine(m))}</p>
    <h3 class="res__title">${esc(m.title)}${m.ref ? `<span class="res__ref">${esc(m.ref)}</span>` : ""}</h3>
    ${m.titre ? `<p class="res__titre">${esc(m.titre)}</p>` : ""}
    ${partsHtml}
    ${d.excerpt && m.texte === "1" ? `<p class="excerpt">${d.excerpt.replace(/’ (?=<mark>|[A-Za-zÀ-ÿ])/g, "’")}</p>` : ""}
    ${notes.length ? `<ul class="res__notes">${notes.join("")}</ul>` : ""}
    ${corrHtml}
    <div class="res__actions">
      ${m.pdf ? `<a class="btn btn--primary" href="${esc(m.pdf)}" target="_blank" rel="noopener">Ouvrir le PDF</a>` : ""}
      <a class="btn" href="${esc(m.fiche)}" target="_blank" rel="noopener">Voir la fiche</a>
      <button type="button" class="btn" data-add="${esc(m.id)}" aria-pressed="${inBasket}">${inBasket ? "Dans ma sélection" : "Ajouter à ma sélection"}</button>
    </div>`;
  art._data = { id: m.id, title: m.title + (m.titre ? ` « ${m.titre} »` : ""), ref: m.ref, ctx: contextLine(m), parts: parts.map((p) => [p.n, p.t || (p.th || []).join(", ")].filter(Boolean).join(" : ")), pdf: m.pdf, fiche: m.fiche, corr: corr.map((c) => c.href) };
  return art;
}

// ---------------------------------------------------------------- sélection
function getBasket() {
  try { return JSON.parse(localStorage.getItem(BASKET_KEY) || "[]"); } catch { return memBasket; }
}
let memBasket = [];
function setBasket(list) {
  memBasket = list;
  try { localStorage.setItem(BASKET_KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
  renderBasket();
}
function toggleBasket(item) {
  const list = getBasket();
  const i = list.findIndex((b) => b.id === item.id);
  if (i >= 0) list.splice(i, 1);
  else list.push(item);
  setBasket(list);
}
function renderBasket() {
  const list = getBasket();
  ui.basket.hidden = list.length === 0;
  ui.basketN.textContent = String(list.length);
  ui.basketList.innerHTML = list.map((b) => `
    <li>
      <div class="b-title">${esc(b.title)}${b.ref ? ` <span class="res__ref">${esc(b.ref)}</span>` : ""}</div>
      <div class="b-ctx">${esc(b.ctx)}</div>
      ${b.parts?.length ? `<div class="b-ctx">${esc(b.parts.join(" ; "))}</div>` : ""}
      <div class="b-links">${b.pdf ? `<a href="${esc(b.pdf)}" target="_blank" rel="noopener">PDF</a>` : ""}<a href="${esc(b.fiche)}" target="_blank" rel="noopener">Fiche</a><button type="button" class="linkish danger" data-remove="${esc(b.id)}">Retirer</button></div>
    </li>`).join("");
  if (!list.length && ui.dialog.open) ui.dialog.close();
  for (const btn of $$("[data-add]")) {
    const on = list.some((b) => b.id === btn.dataset.add);
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "Dans ma sélection" : "Ajouter à ma sélection";
  }
}
function basketText() {
  const list = getBasket();
  const lines = [`Ma sélection : ${list.length} sujet${list.length > 1 ? "s" : ""} (Banque nationale de sujets)`, ""];
  list.forEach((b, i) => {
    lines.push(`${i + 1}. ${b.ctx}, ${b.title}${b.ref ? ` (${b.ref})` : ""}`);
    if (b.parts?.length) lines.push(`   ${b.parts.join(" ; ")}`);
    if (b.pdf) lines.push(`   PDF : ${b.pdf}`);
    if (b.corr?.length) lines.push(`   Corrigé : ${b.corr[0]}`);
    lines.push(`   Fiche : ${b.fiche}`, "");
  });
  return lines.join("\n");
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- stats
async function loadStats() {
  try {
    const s = await (await fetch("data/stats.json", { cache: "no-cache" })).json();
    if (!s.subjects) return;
    const d = new Date(s.updated);
    const date = isNaN(d) ? "" : ` Mis à jour le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}.`;
    let txt = `Cherche une notion dans le texte de ${nf.format(s.subjects)} sujets de la Banque nationale de sujets, toutes matières.`;
    if (s.with_text < s.subjects) txt += ` Texte complet lu pour ${nf.format(s.with_text)} d'entre eux${s.remaining ? ", la lecture des autres PDF est en cours" : ""}.`;
    ui.stats.innerHTML = `<span>${esc(txt + date)}</span>`;
  } catch { /* stats facultatives */ }
}

// ---------------------------------------------------------------- événements
function bindUI() {
  ui.form.addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = ui.q.value;
    ui.q.blur();
    run();
  });
  ui.q.addEventListener("input", () => {
    state.q = ui.q.value;
    runSoon();
  });
  $("#examples").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]");
    if (!b) return;
    state.q = b.dataset.q;
    ui.q.value = state.q;
    run();
  });
  for (const sel of $$("select[data-filter]")) {
    sel.addEventListener("change", () => {
      const k = sel.dataset.filter;
      if (sel.value) state.filters[k] = sel.value;
      else delete state.filters[k];
      if (k === "matiere") delete state.filters.theme;
      syncUIFromState();
      run();
    });
  }
  ui.sort.addEventListener("change", () => {
    state.sort = ui.sort.value;
    run();
  });
  $("#reset").addEventListener("click", () => {
    state.filters = {};
    syncUIFromState();
    run();
  });
  ui.more.addEventListener("click", () => renderMore());
  ui.results.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) {
      toggleBasket(add.closest(".res")._data);
      return;
    }
    const mat = e.target.closest("[data-mat]");
    if (mat) {
      state.filters = { matiere: mat.dataset.mat };
      syncUIFromState();
      run();
      return;
    }
    if (e.target.closest("[data-reset]")) {
      state.filters = {};
      syncUIFromState();
      run();
    }
  });
  $("#basket-open").addEventListener("click", () => {
    ui.basketNote.textContent = "";
    ui.dialog.showModal();
  });
  ui.basketList.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) setBasket(getBasket().filter((b) => b.id !== rm.dataset.remove));
  });
  $("#basket-copy").addEventListener("click", async () => {
    ui.basketNote.textContent = (await copyText(basketText())) ? "Liste copiée." : "Copie impossible : utilise « Télécharger ».";
  });
  $("#basket-download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([basketText()], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "selection-sujets.txt" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ui.basketNote.textContent = "Fichier téléchargé.";
  });
  $("#basket-clear").addEventListener("click", () => setBasket([]));
  ui.dialog.addEventListener("click", (e) => {
    if (e.target === ui.dialog) ui.dialog.close();
  });
  window.addEventListener("hashchange", () => {
    readHash();
    syncUIFromState();
    run();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === BASKET_KEY) renderBasket();
  });
}

async function init() {
  readHash();
  bindUI();
  renderBasket();
  loadStats();
  try {
    pf = await import("./pagefind/pagefind.js");
    await pf.options({ excerptLength: 34 });
    await pf.init();
    allFilters = await pf.filters();
  } catch (e) {
    console.error(e);
    ui.results.innerHTML = `<div class="empty"><h2>L'index de recherche n'est pas encore prêt</h2><p>Il est en cours de construction. Recharge la page dans quelques minutes.</p></div>`;
    return;
  }
  if (!Object.keys(allFilters.matiere || {}).length) {
    ui.results.innerHTML = `<div class="empty"><h2>La collecte des sujets est en cours</h2><p>Les premiers sujets arrivent dans quelques minutes : recharge la page un peu plus tard.</p></div>`;
    return;
  }
  syncUIFromState();
  fillSelects(null, null);
  syncUIFromState();
  run();
}

init();
