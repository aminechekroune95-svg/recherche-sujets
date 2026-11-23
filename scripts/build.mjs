#!/usr/bin/env node
// Construit le site statique : fusionne les données collectées (branche « data »)
// et génère l'index de recherche Pagefind.
//   node scripts/build.mjs --data data --out dist [--site site]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as pagefind from "pagefind";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DATA = arg("data", "data");
const OUT = arg("out", "dist");
const SITE = arg("site", "site");
const CCBAC = "https://ccbac.fr/";

// ---------------------------------------------------------------- référentiels
const MAT_BY_CODE = {
  1: "Mathématiques", 2: "Histoire-géographie", 3: "Langues vivantes", 6: "Enseignement scientifique",
  13: "HGGSP", 14: "HLP", 15: "LLCER", 23: "LLCA", 26: "NSI", 27: "SVT",
  28: "Sciences de l'ingénieur", 29: "SES", 30: "Physique-chimie",
};
const MAT_CODE_BY_LABEL = { HG: 2, "LVA/B": 3, Science: 6, HGGSP: 13, HLP: 14, LLCER: 15, LLCA: 23,
  Maths: 1, NSI: 26, SVT: 27, SI: 28, SES: 29, PC: 30 };
const LANG_CODES = new Set([3, 15, 23]);
const MAT_CANON = [
  [/^histoire.?g[ée]ographie$/i, "Histoire-géographie"],
  [/g[ée]opolitique|hggsp/i, "HGGSP"],
  [/humanit[ée]s|hlp/i, "HLP"],
  [/^math/i, "Mathématiques"],
  [/physique/i, "Physique-chimie"],
  [/vie et de la terre|^svt/i, "SVT"],
  [/enseignement scientifique/i, "Enseignement scientifique"],
  [/[ée]conomiques et sociales|^ses$/i, "SES"],
  [/num[ée]rique et sciences|^nsi$/i, "NSI"],
  [/sciences de l.ing[ée]nieur|^si$/i, "Sciences de l'ingénieur"],
  [/litt[ée]ratures? et langues et cultures de l.antiquit|llca/i, "LLCA"],
  [/langues?,? litt[ée]ratures? et cultures [ée]trang|llcer/i, "LLCER"],
  [/langue/i, "Langues vivantes"],
];
const VOIE = { 1: "Générale", 2: "Technologique" };
const NIVEAU = { 2: "Première", 3: "Terminale", 4: "Cycle terminal" };
const AXES = {
  1: "Identités et échanges", 2: "Espace privé et espace public", 3: "Art et pouvoir",
  4: "Citoyenneté et mondes virtuels", 5: "Fictions et réalités",
  6: "Innovations scientifiques et responsabilité", 7: "Diversité et inclusion", 8: "Territoire et mémoire",
};

// Pagefind ne coupe pas les mots à l'apostrophe : « l’agriculture » serait un seul mot.
const splitElisions = (s) => String(s ?? "").replace(/([A-Za-zÀ-ÿ])['’](?=[A-Za-zÀ-ÿ])/g, "$1’ ");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (s) => String(s ?? "").replace(/[‐‑  ]/g, (c) => (c === "‐" || c === "‑" ? "-" : " ")).replace(/\s+/g, " ").trim();
const uniq = (arr) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = String(x).toLowerCase();
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
function canonMat(name) {
  const n = clean(name);
  for (const [re, label] of MAT_CANON) if (re.test(n)) return label;
  return n ? n[0].toUpperCase() + n.slice(1) : "";
}
function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
function* walk(dir, ext) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ext);
    else if (p.endsWith(ext)) yield p;
  }
}

// ---------------------------------------------------------------- listes
function columnLabels(headers, ncols) {
  // ccbac : une ligne d'en-tête vide, puis (N°, Màj, Corrigé… en rowspan=2 + groupes Exo1/Question…),
  // puis la dernière ligne (Thème, Titre…) alignée sur les dernières colonnes.
  const rows = (headers || []).filter((r) => r.some(([t]) => t && t.trim()));
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  if (rows.length === 1) return last.length === ncols ? last.map(([t]) => t) : [];
  const prev = rows[rows.length - 2];
  const lead = prev.filter(([, , rs]) => rs >= 2).map(([t]) => t);
  const groups = prev.filter(([, , rs]) => !(rs >= 2)).map(([t]) => t);
  const trail = ncols - last.length;
  if (trail < 0) return [];
  const labels = Array(ncols).fill("");
  lead.slice(0, trail).forEach((t, i) => { labels[i] = t; });
  last.forEach(([t], j) => {
    const g = groups.length === last.length ? groups[j] : "";
    labels[trail + j] = [g, t].filter(Boolean).join(" ");
  });
  return labels;
}

function pageContext(page) {
  const p = page.params || {};
  const crumbs = (page.crumbs || []).map(clean);
  let code = null;
  let matIdx = -1;
  crumbs.forEach((c, i) => {
    if (MAT_CODE_BY_LABEL[c] !== undefined && matIdx < 0) {
      matIdx = i;
      code = MAT_CODE_BY_LABEL[c];
    }
  });
  if (code === null && p.mat && /^\d+$/.test(p.mat)) code = Number(p.mat);
  const banque = crumbs.find((c) => /^(É|E)val\s*\d{4}|^EC\s*\d{4}|^E3C\s*\d{4}/i.test(c)) || (p.an ? `Éval ${p.an}` : "");
  const vc = crumbs.find((c) => /^Voie /i.test(c)) || "";
  const voie = /techno/i.test(vc) ? "Technologique" : /g[ée]n[ée]rale/i.test(vc) ? "Générale" : VOIE[p.voie] || "";
  const niveau = NIVEAU[p.session] || crumbs.find((c) => /^(Première|Terminale|Cycle terminal)$/i.test(c)) || "";
  const option = matIdx >= 0 ? crumbs.slice(matIdx + 1).filter((c) => !/^(Sujets?|Autre)$/i.test(c))[0] || "" : "";
  return { code, banque: banque.replace(/^Eval/i, "Éval"), voie, niveau, option };
}

function interpretRow(cells, labels) {
  const out = { num: "", maj: "", corr: [], titles: [], themes: [], types: [], misc: [], cols: [] };
  const known = labels.length === cells.length && labels.some(Boolean);
  cells.forEach((lines, i) => {
    const vals = [];
    for (const l of (lines || []).map(clean).filter(Boolean)) {
      if (vals.length && /^[A-Z]$/.test(vals[vals.length - 1]) && /^[a-zé]/.test(l)) vals[vals.length - 1] += l;
      else vals.push(l);
    }
    if (!vals.length) return;
    const label = known ? labels[i] : "";
    if (i > 0) {
      const badges = vals.filter((v) => /^(Correction|Autre)$/i.test(v));
      if (badges.length && badges.length < vals.length) {
        out.corr.push(...badges.map((b) => (/^c/i.test(b) ? "Oui" : "Autre")));
        for (let k = vals.length - 1; k >= 0; k--) if (/^(Correction|Autre|calculatrice)$/i.test(vals[k])) vals.splice(k, 1);
      }
    }
    const txt = vals.join(" ");
    if (i === 0 || /^N°|^N\b|^Num/i.test(label)) {
      if (!out.num) {
        out.num = vals[0].replace(/(Oui|Non|Autre)$/i, "").trim();
        const flag = vals.slice(1).join(" ").match(/^(Autre|Correction)$/i);
        if (flag) out.corr.push(/^c/i.test(flag[1]) ? "Oui" : "Autre");
        return;
      }
    }
    if (/Màj|Maj|Mise/i.test(label) || (!known && /^(19|20)\d\d$/.test(txt) && !out.maj)) {
      out.maj = txt;
      return;
    }
    if (/Corrig/i.test(label) || /^(Oui|Non|Autre|Correction)$/i.test(txt)) {
      out.corr.push(txt);
      return;
    }
    // valeurs : les numéros isolés sont rattachés à la ligne suivante (« 1 » + « Identité échange »)
    const merged = [];
    for (let k = 0; k < vals.length; k++) {
      if (/^\d{1,2}$/.test(vals[k]) && vals[k + 1]) {
        merged.push(`${vals[k]} ${vals[k + 1]}`);
        k++;
      } else merged.push(vals[k]);
    }
    out.cols.push({ label, vals: merged });
    if (/Titre/i.test(label)) out.titles.push(txt);
    else if (/Th[èe]me|Exo|Partie|Axe/i.test(label)) out.themes.push(...merged);
    else if (/Type|[ÉE]preuve/i.test(label)) out.types.push(txt);
    else out.misc.push(...merged);
  });
  return out;
}

// ---------------------------------------------------------------- fiches
const FIELD_KEYS = {
  calculatrice: "calc", "référence": "ref", reference: "ref", "matière": "matiere", matiere: "matiere",
  session: "session", "epreuves de": "epreuves", "épreuves de": "epreuves", "epreuve de": "epreuves",
  source: "source", parties: "nparts", titre: "titre", "thème(s)": "themes", "thèmes": "themes",
  "thème": "themes", theme: "themes",
};
const STOP = /^(Cette partie|Des corrections|Aucune correction|Correction|Une correction|Attention|Tu souhaites|Clique|Titre|Th[èe]me|Exercice\s*\d|Partie\s*\d|Question|[ÉE]tude|Confirmation)/i;
function parseDetail(d) {
  const f = {};
  const parts = [];
  let cur = null;
  let prev = "";
  const lines = (d.lines || []).map(clean).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-zÀ-ÿ()' ]{3,25}?)\s*:\s*(.*)$/);
    const key = m ? FIELD_KEYS[m[1].trim().toLowerCase()] : null;
    if (key) {
      let val = m[2].trim();
      if (key === "themes") {
        const th = val ? [val] : [];
        while (i + 1 < lines.length && !STOP.test(lines[i + 1]) && !/:$/.test(lines[i + 1]) && lines[i + 1].length < 140) th.push(lines[++i]);
        if (!cur || (cur.n !== prev && cur.t !== prev)) {
          cur = { n: prev, t: "", th: [] };
          parts.push(cur);
        }
        cur.th.push(...th);
        continue;
      }
      if (!val && i + 1 < lines.length && !/:$/.test(lines[i + 1])) val = lines[++i];
      if (key === "titre") {
        cur = { n: prev, t: val, th: [] };
        parts.push(cur);
      } else if (!(key in f)) f[key] = val;
      continue;
    }
    if (!f.pages) {
      const pm = line.match(/^(\d+)\s*pages?$/i);
      if (pm) f.pages = pm[1];
    }
    prev = line;
  }
  const t = clean(d.title);
  const tm = t.match(/n°\s*([\w\-‑]+)\s*(?:\[\s*([\w\-]+)\s*\])?(?:\s*-\s*(.+))?$/i);
  const corrections = [];
  for (const x of d.files || []) {
    const ctx = clean(x.ctx);
    const cm = ctx.match(/^Correction\s+(intégrale|integrale)\b(.*)$/i);
    if (!cm) continue;
    const src = cm[2].replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, "").replace(/[()]/g, "").trim() || "corrigé";
    if (!corrections.some((c) => c.href === x.href)) corrections.push({ src: src.slice(0, 40), href: x.href });
  }
  return { f, parts, num: tm?.[1] || "", ref: f.ref || tm?.[2] || "", banque: tm?.[3] || "", corrections };
}

function subjectPdf(d) {
  const files = (d?.files || []).filter((x) => x.path);
  let pdfs = files.filter((x) => x.path.includes("sujets/") && /\.pdf$/i.test(x.path));
  if (!pdfs.length) pdfs = files.filter((x) => /\.pdf$/i.test(x.path) && !/corrig/i.test(x.path) && !/correction/i.test(x.ctx || ""));
  return pdfs[0] || null;
}

// ---------------------------------------------------------------- textes
// En-tête standard des sujets BNS (classe, voie, durée, cases à cocher…) : identique partout, donc
// inutile pour chercher et gênant pour les extraits. On coupe jusqu'à « Nombre total de pages : N ».
const BOILERPLATE = /Nombre total de pages\s*:\s*\d+\s*/i;
function readText(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  const nl = raw.indexOf("\n");
  const head = readJSON2(raw.slice(0, nl));
  // NFKC : 𝑢𝑛 → un, 𝒞 → C, ligatures → lettres (formules Word/MathType)
  let text = raw.slice(nl + 1).normalize("NFKC");
  const m = text.slice(0, 5000).match(BOILERPLATE);
  if (m) text = text.slice(m.index + m[0].length);
  text = text.replace(/[☐☒■□]/g, " ");
  return { info: head || {}, text };
}
function readJSON2(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(splitElisions(p))}</p>`)
    .join("\n");
}

// ---------------------------------------------------------------- assemblage
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const t = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, t);
    else fs.copyFileSync(s, t);
  }
}

async function main() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(SITE, OUT);

  let lists = { pages: [], rows: {} };
  const gz = path.join(DATA, "lists.json.gz");
  if (fs.existsSync(gz)) lists = JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8"));
  else lists = readJSON(path.join(DATA, "lists.json"), lists);
  const state = readJSON(path.join(DATA, "state.json"), {});
  const pages = lists.pages || [];
  const ctxCache = pages.map(pageContext);
  const labelCache = new Map();

  const details = new Map();
  for (const p of walk(path.join(DATA, "details"), ".json")) {
    const d = readJSON(p, null);
    if (d?.id) details.set(String(d.id), d);
  }

  const ids = new Set([...Object.keys(lists.rows || {}), ...details.keys()]);
  console.log(`${ids.size} sujets, ${details.size} fiches`);

  const { index } = await pagefind.createIndex({ forceLanguage: "fr" });
  const stats = { subjects: 0, with_text: 0, matieres: {} };
  let errors = 0;

  for (const id of [...ids].sort((a, b) => Number(b) - Number(a))) {
    let entry = lists.rows?.[id] || { c: [], p: [] };
    if (Array.isArray(entry)) entry = { c: entry[0]?.cells || [], p: entry.map((e) => e.p) }; // ancien format
    const rows = entry.p.map((p, i) => ({ p, cells: i === 0 ? entry.c : null }));
    const det = details.get(id);
    const dp = det ? parseDetail(det) : { f: {}, parts: [], num: "", ref: "", banque: "", corrections: [] };
    const banques = new Set();
    let code = null, voie = "", niveau = "", option = "";
    const listInfo = { num: "", maj: "", corr: [], titles: [], themes: [], types: [], cols: [] };
    for (const r of rows) {
      const ctx = ctxCache[r.p] || {};
      if (ctx.banque) banques.add(ctx.banque);
      code ??= ctx.code;
      voie ||= ctx.voie;
      if (!niveau || niveau === "Cycle terminal") niveau = ctx.niveau || niveau;
      option ||= ctx.option;
      if (!r.cells) continue;
      const page = pages[r.p] || {};
      const key = `${r.p}:${r.cells.length}`;
      if (!labelCache.has(key)) labelCache.set(key, columnLabels(page.headers || [], r.cells.length));
      const info = interpretRow(r.cells, labelCache.get(key));
      if (!listInfo.num) Object.assign(listInfo, info);
      else listInfo.corr.push(...info.corr);
    }

    const matiere = dp.f.matiere ? canonMat(dp.f.matiere) : (MAT_BY_CODE[code] || "Autre");
    const ep = clean(dp.f.epreuves);
    if (/premi/i.test(ep)) niveau = "Première";
    else if (/termin/i.test(ep)) niveau = "Terminale";
    if (!voie && dp.ref) voie = dp.ref.startsWith("T") ? "Technologique" : dp.ref.startsWith("G") ? "Générale" : "";
    const annee = (dp.f.session || "").match(/(19|20)\d\d/)?.[0] || listInfo.maj || (dp.banque.match(/\d{4}/)?.[0] ?? "");
    const num = clean(listInfo.num || dp.num).replace(/‑/g, "-");
    const ref = clean(dp.ref);

    // parties / exercices et thèmes
    let parts = dp.parts.map((p) => ({ n: clean(p.n), t: clean(p.t), th: uniq(p.th.map(clean)) }));
    let themes = uniq(parts.flatMap((p) => p.th));
    if (!themes.length) themes = uniq(listInfo.themes);
    if (!parts.length) {
      const byExo = new Map();
      for (const c of listInfo.cols) {
        const m = c.label.match(/^Exo\s*(\d+)/i);
        if (!m) continue;
        const p = byExo.get(m[1]) || { n: `Exercice ${m[1]}`, t: "", th: [] };
        if (/Titre/i.test(c.label)) p.t = c.vals.join(" ");
        else if (!/Corrig/i.test(c.label)) p.th.push(...c.vals);
        byExo.set(m[1], p);
      }
      parts = [...byExo.values()];
    }
    if (LANG_CODES.has(code) || matiere === "Langues vivantes") {
      themes = themes.map((t) => {
        const m = t.match(/^(\d)\s+(.+)$/);
        return m && AXES[m[1]] ? `Axe ${m[1]} : ${AXES[m[1]]}` : t;
      });
    }
    const filterThemes = themes.filter((t) => t.length <= 120).slice(0, 12);
    const titles = uniq([...parts.map((p) => p.t), ...listInfo.titles]);

    const corrStatus = [...listInfo.corr].map((c) => c.toLowerCase());
    const pdf = subjectPdf(det);
    const corrFiles = (det?.files || []).filter((x) => x !== pdf && x.path && !x.path.includes("sujets/")).length;
    const corrections = dp.corrections || [];
    const corrige = corrStatus.includes("oui") || corrections.length ? "Oui" : corrStatus.includes("autre") || corrFiles ? "Autre version" : "Non";
    const calc = /autoris/i.test(dp.f.calc || "") ? "Autorisée" : /interdi/i.test(dp.f.calc || "") ? "Interdite" : "";

    const k = String(Math.floor(Number(id) / 1000)).padStart(3, "0");
    const txt = readText(path.join(DATA, "texts", k, `${id}.txt`));
    const hasText = !!(txt && txt.text.trim().length > 40);

    stats.subjects++;
    if (hasText) stats.with_text++;
    const ms = (stats.matieres[matiere] ||= { total: 0, text: 0 });
    ms.total++;
    if (hasText) ms.text++;

    const langue = LANG_CODES.has(code) || ["Langues vivantes", "LLCER", "LLCA"].includes(matiere) ? option : "";
    const meta = {
      title: num ? `Sujet n° ${num}` : `Sujet ${id}`,
      mat: matiere, niv: niveau, voie, annee, langue, num, ref,
      parts: JSON.stringify(parts.slice(0, 8)),
      titre: parts.some((p) => p.t) ? "" : uniq(listInfo.titles).join(" / "),
      themes: JSON.stringify(themes.slice(0, 8)),
      pdf: pdf?.href || "",
      fiche: `${CCBAC}voir.php?id=${id}`,
      corrige, calc,
      pages: String(txt?.info?.pages || dp.f.pages || ""),
      corrections: JSON.stringify(corrections.slice(0, 4)),
      texte: hasText ? "1" : "0",
      id,
    };
    const filters = {
      matiere: [matiere], niveau: niveau ? [niveau] : [], voie: voie ? [voie] : [],
      annee: annee ? [annee] : [], theme: filterThemes, langue: langue ? [langue] : [],
      corrige: [corrige === "Oui" ? "Corrigé disponible" : corrige === "Autre version" ? "Corrigé d'une autre version" : "Sans corrigé"],
      calculatrice: calc ? [calc] : [], banque: [...banques].sort().reverse(),
    };
    const metaHtml = Object.entries(meta).map(([key, v]) => `<span data-pagefind-meta="${key}">${esc(v)}</span>`).join("");
    const filterHtml = Object.entries(filters)
      .flatMap(([key, vs]) => vs.filter(Boolean).map((v) => `<span data-pagefind-filter="${key}">${esc(v)}</span>`))
      .join("");
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(meta.title)}</title></head><body>
<main data-pagefind-body>
${hasText ? textToHtml(txt.text) : ""}
<p data-pagefind-weight="6">${esc(splitElisions([...themes, ...titles].join(" ; ")))}.</p>
<p data-pagefind-weight="2">${esc([...parts.map((p) => p.n), matiere, niveau, voie, annee, langue, meta.title, ref].filter(Boolean).join(" ; "))}.</p>
</main>
<div hidden>${metaHtml}${filterHtml}<span data-pagefind-sort="annee">${esc(annee || "0")}</span><span data-pagefind-sort="id">${esc(id.padStart(6, "0"))}</span></div>
</body></html>`;
    const res = await index.addHTMLFile({ url: `/s/${id}/`, content: html });
    if (res.errors?.length) {
      errors++;
      if (errors < 10) console.warn(id, res.errors);
    }
  }

  const w = await index.writeFiles({ outputPath: path.join(OUT, "pagefind") });
  if (w.errors?.length) throw new Error(w.errors.join("\n"));
  await pagefind.close();

  fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
  const out = {
    updated: state.last_run || new Date().toISOString(),
    built: new Date().toISOString(),
    remaining: state.remaining ?? null,
    ...stats,
  };
  fs.writeFileSync(path.join(OUT, "data", "stats.json"), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  console.log(`index : ${stats.subjects} sujets (${stats.with_text} avec texte), ${errors} erreurs, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(JSON.stringify(stats.matieres));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
