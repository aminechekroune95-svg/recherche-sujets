#!/usr/bin/env python3
"""
Pipeline de collecte pour « Recherche de sujets ».

Source : ccbac.fr, miroir de la Banque nationale de sujets (BNS) du ministère
de l'Éducation nationale (licence CC BY-NC-SA 3.0 FR).

Étapes
  1. listes  : parcours de toutes les pages list.php (liens de filtres),
               chaque ligne de tableau est gardée telle quelle (cellules brutes).
  2. sujets  : pour chaque sujet, par ordre de priorité de matière :
               - fiche voir.php?id=N (une fois, mise en cache)
               - PDF du sujet -> texte (pdftotext, OCR si le PDF est une image)

Tout est écrit dans --data (branche « data » du dépôt) :
  lists.json                 pages de listes + lignes par sujet
  details/<k>/<id>.json      fiche brute d'un sujet (k = id // 1000)
  texts/<k>/<id>.txt         texte extrait du PDF
  texts/<k>/<id>.err         échec (réessayé après --retry-days jours)
  samples/                   pages HTML brutes pour contrôle
  state.json                 avancement (lu par le workflow)

Le script s'arrête proprement quand le budget de temps est épuisé ;
le workflow relance alors une exécution qui reprend où on en était.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://ccbac.fr/"
UA = ("recherche-sujets/1.0 (+https://github.com/aminechekroune95-svg/recherche-sujets; "
      "index de recherche non commercial, 1 requete a la fois ou presque)")
LIST_PARAMS = ("an", "voie", "session", "mat", "opt", "epr")
MAT_LABELS = {"HG": 2, "LVA/B": 3, "Science": 6, "HGGSP": 13, "HLP": 14, "LLCER": 15,
              "LLCA": 23, "Maths": 1, "NSI": 26, "SVT": 27, "SI": 28, "SES": 29, "PC": 30}
# Ordre de traitement : les matières où la recherche par notion compte le plus d'abord.
PRIORITY = [1, 30, 28, 6, 27, 26, 29, 2, 13, 14, 23, 15, 3]
VOIR_RE = re.compile(r"voir\.php\?id=(\d+)")
DL_RE = re.compile(r"dl\.php\?path=([^&#\"']+)")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- HTTP
class RateLimiter:
    def __init__(self, per_second: float):
        self.interval = 1.0 / per_second
        self.lock = threading.Lock()
        self.next = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            start = max(self.next, now)
            self.next = start + self.interval
        if start > now:
            time.sleep(start - now)


class Fetcher:
    def __init__(self, rate: float, timeout: int = 90):
        self.rate = RateLimiter(rate)
        self.timeout = timeout
        self.local = threading.local()
        self.stats = Counter()
        self.blocked = 0

    def session(self) -> requests.Session:
        s = getattr(self.local, "s", None)
        if s is None:
            s = requests.Session()
            s.headers.update({"User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9"})
            self.local.s = s
        return s

    def get(self, url: str, binary: bool = False, tries: int = 5):
        delay = 5
        for attempt in range(tries):
            self.rate.wait()
            try:
                r = self.session().get(url, timeout=self.timeout, allow_redirects=True)
            except requests.RequestException as e:
                self.stats["neterr"] += 1
                log(f"  réseau ({attempt + 1}/{tries}) {url}: {e.__class__.__name__}")
                time.sleep(delay)
                delay = min(delay * 2, 120)
                continue
            self.stats[r.status_code] += 1
            if r.status_code == 200:
                return r.content if binary else r
            if r.status_code in (404, 410):
                return None
            if r.status_code in (403, 429, 500, 502, 503, 504):
                if r.status_code in (403, 429):
                    self.blocked += 1
                wait = r.headers.get("Retry-After")
                pause = int(wait) if wait and wait.isdigit() else delay
                log(f"  HTTP {r.status_code} ({attempt + 1}/{tries}) {url} -> pause {pause}s")
                time.sleep(min(pause, 300))
                delay = min(delay * 2, 300)
                continue
            log(f"  HTTP {r.status_code} {url}")
            return None
        return None


# --------------------------------------------------------------------------- listes
def norm_list_url(href: str, base: str = BASE) -> str | None:
    u = urlparse(urljoin(base, href))
    if u.netloc not in ("ccbac.fr", "www.ccbac.fr") or not u.path.endswith("/list.php"):
        return None
    q = dict(parse_qsl(u.query))
    # opt=0 / epr=0 = valeur par défaut : même page que sans le paramètre
    params = [(k, q[k]) for k in LIST_PARAMS if q.get(k, "") not in ("",) and not (k in ("opt", "epr") and q[k] == "0")]
    return BASE + "list.php" + ("?" + urlencode(params) if params else "")


def cell_lines(td) -> list[str]:
    return [l.strip() for l in td.get_text("\n").split("\n") if l.strip()]


def parse_list(html: bytes, url: str):
    soup = BeautifulSoup(html, "lxml")
    links = set()
    for a in soup.find_all("a", href=True):
        n = norm_list_url(a["href"], url)
        if n:
            links.add(n)
    crumbs = []
    bc = soup.select_one(".breadcrumb")
    if bc:
        items = bc.find_all("li") or bc.find_all("a")
        for it in items:
            t = it.get_text(" ", strip=True)
            if t and t not in crumbs:
                crumbs.append(t)
    heading = ""
    node = soup.find(string=re.compile(r"Liste des sujets"))
    if node is not None:
        heading = re.sub(r"\s+", " ", node.parent.get_text(" ", strip=True))[:300]
    headers, rows = [], []
    for table in soup.find_all("table"):
        if table.find("a", href=VOIR_RE) is None:
            continue
        if not headers:  # en-tête du premier tableau de sujets (thead seulement, pas tfoot)
            head_rows = table.thead.find_all("tr") if table.thead else []
            if not head_rows:
                for tr in table.find_all("tr"):
                    if tr.find("a", href=VOIR_RE):
                        break
                    if tr.find("th"):
                        head_rows.append(tr)
            for tr in head_rows:
                ths = tr.find_all(["th", "td"], recursive=False)
                headers.append([[th.get_text(" ", strip=True), int(th.get("colspan") or 1),
                                 int(th.get("rowspan") or 1)] for th in ths])
        for tr in table.find_all("tr"):
            if tr.find_parent("table") is not table:
                continue
            a = tr.find("a", href=VOIR_RE)
            if a is None:
                continue
            sid = int(VOIR_RE.search(a["href"]).group(1))
            cells = tr.find_all(["td", "th"], recursive=False)
            rows.append({"id": sid, "cells": [cell_lines(td) for td in cells]})
    params = dict(parse_qsl(urlparse(url).query))
    return {"url": url, "params": params, "crumbs": crumbs, "heading": heading,
            "headers": headers[:4]}, rows, links


def mat_code_of(page: dict) -> int | None:
    # le fil d'Ariane prime : ccbac affiche HG quand la combinaison demandée n'existe pas
    for c in page.get("crumbs", []):
        if c in MAT_LABELS:
            return MAT_LABELS[c]
    m = page["params"].get("mat")
    return int(m) if m and m.isdigit() else None


def crawl_lists(f: Fetcher, data: Path, max_pages: int, workers: int, max_minutes: float = 90,
                years: set[str] | None = None):
    """Parcours des pages de listes. Avec `years`, seules les banques de ces années sont visitées
    (mise à jour hebdomadaire : les nouveaux sujets arrivent dans la banque de l'année)."""
    all_years = range(2020, dt.date.today().year + 2)
    seeds = ([] if years else [BASE + "list.php"]) + [
        BASE + "list.php?" + urlencode({"an": y}) for y in all_years if not years or str(y) in years]
    seen, queue = set(), deque()
    for s in seeds:
        n = norm_list_url(s)
        if n not in seen:
            seen.add(n)
            queue.append(n)
    pages, rows_by_id = [], {}
    samples = data / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    sampled = set()
    lock = threading.Lock()

    def work(url):
        r = f.get(url)
        if r is None:
            return url, None
        return url, r.content

    t_end = time.monotonic() + max_minutes * 60
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {}
        while queue or futures:
            if time.monotonic() > t_end and queue:
                log(f"listes : temps dépassé, {len(queue)} pages non visitées (on garde l'ancienne liste pour elles)")
                queue.clear()
            while queue and len(futures) < workers * 2 and len(seen) <= max_pages:
                u = queue.popleft()
                futures[ex.submit(work, u)] = u
            if not futures:
                break
            done = next(as_completed(list(futures)))
            futures.pop(done)
            url, html = done.result()
            if html is None:
                continue
            page, rows, links = parse_list(html, url)
            with lock:
                idx = len(pages)
                page["n"] = len(rows)
                pages.append(page)
                for row in rows:
                    entry = rows_by_id.get(str(row["id"]))
                    if entry is None:  # cellules gardées une fois, pages où le sujet apparaît
                        rows_by_id[str(row["id"])] = {"c": row["cells"], "p": [idx]}
                    elif idx not in entry["p"]:
                        entry["p"].append(idx)
                mc = mat_code_of(page)
                key = f"{mc}-{page['params'].get('voie', '')}-{page['params'].get('session', '')}"
                if rows and key not in sampled and len(sampled) < 60:
                    sampled.add(key)
                    (samples / f"list_{key}.html").write_bytes(html)
                for l in links:
                    if years:
                        an = dict(parse_qsl(urlparse(l).query)).get("an")
                        if an not in years:
                            continue
                    if l not in seen and len(seen) < max_pages:
                        seen.add(l)
                        queue.append(l)
            if len(pages) % 100 == 0:
                log(f"listes : {len(pages)} pages, {len(rows_by_id)} sujets, file {len(queue)}")
    log(f"listes terminées : {len(pages)} pages, {len(rows_by_id)} sujets distincts")
    return {"generated": now_iso(), "pages": pages, "rows": rows_by_id}


# --------------------------------------------------------------------------- fiches
def decode_path(raw: str) -> str | None:
    raw = unquote(raw)
    for dec in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            return dec(raw + "=" * (-len(raw) % 4)).decode("utf-8", "replace")
        except Exception:
            continue
    return None


def parse_detail(html: bytes, sid: int) -> dict:
    soup = BeautifulSoup(html, "lxml")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    title = re.sub(r"\s*\|\s*CCBac\.fr\s*$", "", title).strip(" -")
    files = []
    for a in soup.find_all("a", href=True):
        m = DL_RE.search(a["href"])
        if not m:
            continue
        path = decode_path(m.group(1))
        ctx = a.find_parent(["li", "tr", "p", "div"])
        files.append({
            "href": urljoin(BASE, a["href"]),
            "path": path,
            "text": a.get_text(" ", strip=True)[:200],
            "ctx": re.sub(r"\s+", " ", ctx.get_text(" ", strip=True))[:300] if ctx else "",
        })
    for t in soup(["script", "style", "noscript", "footer"]):
        t.decompose()
    for t in soup.select("nav, .navbar"):
        t.decompose()
    body = soup.body or soup
    lines = [l.strip() for l in body.get_text("\n").split("\n") if l.strip()]
    return {"id": sid, "title": title, "lines": lines[:400], "files": files,
            "fetched": now_iso()}


def subject_pdf(detail: dict) -> dict | None:
    files = [x for x in detail.get("files", []) if x.get("path")]
    pdfs = [x for x in files if "sujets/" in x["path"] and x["path"].lower().endswith(".pdf")]
    if not pdfs:  # repli : premier PDF qui n'est pas une correction
        pdfs = [x for x in files if x["path"].lower().endswith(".pdf")
                and "corrig" not in x["path"].lower() and "correction" not in x["ctx"].lower()]
    return pdfs[0] if pdfs else None


# --------------------------------------------------------------------------- texte
LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
             "­": "", "‐": "-", "‑": "-", " ": " ", " ": " "}


def clean_text(raw: str) -> str:
    for k, v in LIGATURES.items():
        raw = raw.replace(k, v)
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", raw)
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in raw.split("\n")]
    counts = Counter(l for l in lines if l)
    out = []
    for l in lines:
        if not l:
            if out and out[-1] != "":
                out.append("")
            continue
        # en-têtes/pieds de page répétés et numéros de page
        if counts[l] >= 3 and len(l) < 80:
            continue
        if re.fullmatch(r"(page\s*)?\d{1,2}\s*(/|sur)\s*\d{1,2}", l, re.I) or re.fullmatch(r"\d{1,3}", l):
            continue
        out.append(l)
    text = "\n".join(out)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)     # mots coupés en fin de ligne
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def pdf_to_text(pdf: Path, allow_ocr: bool) -> tuple[str, dict]:
    info = {}
    try:
        meta = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"^Pages:\s+(\d+)", meta, re.M)
        info["pages"] = int(m.group(1)) if m else None
    except Exception:
        info["pages"] = None
    try:
        raw = subprocess.run(["pdftotext", "-enc", "UTF-8", "-nopgbrk", str(pdf), "-"],
                             capture_output=True, timeout=180).stdout.decode("utf-8", "replace")
    except Exception:
        raw = ""
    text = clean_text(raw)
    info["method"] = "pdftotext"
    letters = len(re.findall(r"[A-Za-zÀ-ÿ]", text))
    if letters < 250 and allow_ocr and shutil.which("tesseract"):
        with tempfile.TemporaryDirectory() as td:
            last = min(info.get("pages") or 4, 6)
            subprocess.run(["pdftoppm", "-r", "200", "-gray", "-png", "-f", "1", "-l", str(last),
                            str(pdf), f"{td}/p"], capture_output=True, timeout=600)
            parts = []
            for img in sorted(Path(td).glob("p*.png")):
                r = subprocess.run(["tesseract", str(img), "-", "-l", "fra+eng"],
                                   capture_output=True, timeout=300)
                parts.append(r.stdout.decode("utf-8", "replace"))
            ocr = clean_text("\n".join(parts))
            if len(ocr) > len(text):
                text, info["method"] = ocr, "ocr"
    return text[:60000], info


# --------------------------------------------------------------------------- pipeline
def shard(sid: int) -> str:
    return f"{sid // 1000:03d}"


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return default


def load_lists(data: Path) -> dict:
    gz = data / "lists.json.gz"
    if gz.exists():
        try:
            with gzip.open(gz, "rt", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def save_lists(data: Path, lists: dict):
    with gzip.open(data / "lists.json.gz", "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump(lists, fh, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--skip-lists", action="store_true", help="réutiliser lists.json")
    ap.add_argument("--max-minutes", type=float, default=300, help="budget total")
    ap.add_argument("--rate", type=float, default=4.0, help="requêtes par seconde max")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=8000)
    ap.add_argument("--lists-max-minutes", type=float, default=75, help="durée max du parcours des listes")
    ap.add_argument("--years", default="", help="banques à parcourir, ex. 2026,2027 (vide = toutes)")
    ap.add_argument("--only", default="", help="codes matière à traiter, ex. 1,30")
    ap.add_argument("--limit", type=int, default=0, help="nombre max de sujets (test)")
    ap.add_argument("--ocr-max", type=int, default=400, help="OCR max par exécution")
    ap.add_argument("--retry-days", type=int, default=30)
    ap.add_argument("--refresh-days", type=int, default=120, help="re-télécharger les fiches plus vieilles")
    args = ap.parse_args()

    t0 = time.monotonic()
    deadline = t0 + args.max_minutes * 60
    data = Path(args.data)
    (data / "samples").mkdir(parents=True, exist_ok=True)
    f = Fetcher(rate=args.rate)

    previous = load_lists(data)
    if args.skip_lists and previous.get("rows"):
        lists = previous
        log(f"listes réutilisées : {len(lists.get('rows', {}))} sujets")
    else:
        years = {y.strip() for y in args.years.split(",") if y.strip()} or None
        lists = crawl_lists(f, data, args.max_pages, args.workers, args.lists_max_minutes, years)
        old = previous
        if not lists["rows"] and not old.get("rows"):
            log(f"ÉCHEC : aucune page de liste exploitable (HTTP : {dict(f.stats)})")
            sys.exit(1)
        # un sujet absent de ce parcours (liste incomplète, panne) garde ses anciennes lignes
        if old.get("rows"):
            remap = {}
            kept = 0
            for sid, entry in old["rows"].items():
                if sid in lists["rows"]:
                    continue
                ps = []
                for p_old in entry["p"]:
                    if p_old not in remap:
                        remap[p_old] = len(lists["pages"])
                        lists["pages"].append(old["pages"][p_old])
                    ps.append(remap[p_old])
                lists["rows"][sid] = {"c": entry["c"], "p": ps}
                kept += 1
            if kept:
                log(f"{kept} sujets repris de l'ancienne liste")
        save_lists(data, lists)
        log(f"lists.json.gz : {(data / 'lists.json.gz').stat().st_size / 1e6:.1f} Mo")

    pages = lists["pages"]
    only = {int(x) for x in args.only.split(",") if x.strip().isdigit()}
    order = {m: i for i, m in enumerate(PRIORITY)}
    subjects = []
    for sid, entry in lists["rows"].items():
        mats = {mat_code_of(pages[p]) for p in entry["p"]}
        mats.discard(None)
        if only and not (mats & only):
            continue
        rank = min((order.get(m, 99) for m in mats), default=99)
        subjects.append((rank, -int(sid), int(sid)))
    subjects.sort()
    if args.limit:
        subjects = subjects[: args.limit]
    log(f"{len(subjects)} sujets à vérifier")

    ocr_budget = [args.ocr_max]
    lock = threading.Lock()
    counters = Counter()
    sample_count = Counter()
    today = time.time()

    def process(sid: int, rank: int):
        k = shard(sid)
        dpath = data / "details" / k / f"{sid}.json"
        detail = load_json(dpath, None)
        stale = detail is None
        if detail and args.refresh_days:
            try:
                fetched = dt.datetime.fromisoformat(detail["fetched"]).timestamp()
                stale = today - fetched > args.refresh_days * 86400
            except Exception:
                stale = True
        if stale:
            r = f.get(f"{BASE}voir.php?id={sid}")
            if r is None:
                with lock:
                    counters["fiche_absente"] += 1
                return
            detail = parse_detail(r.content, sid)
            dpath.parent.mkdir(parents=True, exist_ok=True)
            dpath.write_text(json.dumps(detail, ensure_ascii=False, separators=(",", ":")), "utf-8")
            with lock:
                counters["fiches"] += 1
                if sample_count[rank] < 2:
                    sample_count[rank] += 1
                    (data / "samples" / f"voir_{PRIORITY[rank] if rank < len(PRIORITY) else 'x'}_{sid}.html").write_bytes(r.content)
        tpath = data / "texts" / k / f"{sid}.txt"
        epath = tpath.with_suffix(".err")
        if tpath.exists():
            return
        if epath.exists() and today - epath.stat().st_mtime < args.retry_days * 86400:
            err = load_json(epath, {})
            if err.get("reason") != "réseau":
                return
        pdf = subject_pdf(detail)
        tpath.parent.mkdir(parents=True, exist_ok=True)
        if pdf is None:
            epath.write_text(json.dumps({"reason": "pas de PDF", "at": now_iso()}), "utf-8")
            with lock:
                counters["sans_pdf"] += 1
            return
        content = f.get(pdf["href"], binary=True)
        if not content or not content[:5].startswith(b"%PDF"):
            epath.write_text(json.dumps({"reason": "réseau" if content is None else "pas un PDF",
                                         "at": now_iso()}), "utf-8")
            with lock:
                counters["pdf_echec"] += 1
            return
        with lock:
            allow_ocr = ocr_budget[0] > 0
        with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
            tmp.write(content)
            tmp.flush()
            text, info = pdf_to_text(Path(tmp.name), allow_ocr)
        with lock:
            if info.get("method") == "ocr":
                ocr_budget[0] -= 1
                counters["ocr"] += 1
            counters["textes"] += 1
            counters["octets"] += len(content)
        header = json.dumps({"pages": info.get("pages"), "method": info.get("method"),
                             "bytes": len(content), "at": now_iso()}, ensure_ascii=False)
        tpath.write_text(header + "\n" + text, "utf-8")
        if epath.exists():
            epath.unlink()

    stopped = False
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        pending = set()
        it = iter(subjects)
        done_n = 0
        while True:
            while len(pending) < args.workers * 2 and not stopped:
                if time.monotonic() > deadline:
                    stopped = True
                    log("budget de temps atteint, arrêt propre")
                    break
                if f.blocked > 50:
                    stopped = True
                    log("trop de refus (403/429) : on s'arrête pour ne pas insister")
                    break
                nxt = next(it, None)
                if nxt is None:
                    break
                rank, _, sid = nxt
                pending.add(ex.submit(process, sid, rank))
            if not pending:
                break
            done = next(as_completed(list(pending)))
            pending.discard(done)
            try:
                done.result()
            except Exception as e:  # un sujet ne doit pas faire tomber le reste
                with lock:
                    counters["erreur"] += 1
                log("  erreur :", repr(e)[:200])
            done_n += 1
            if done_n % 200 == 0:
                el = (time.monotonic() - t0) / 60
                log(f"{done_n}/{len(subjects)} sujets vus en {el:.0f} min — {dict(counters)}")

    # état global
    all_ids = [int(s) for s in lists["rows"]]
    remaining = 0
    with_text = 0
    for sid in all_ids:
        k = shard(sid)
        if (data / "texts" / k / f"{sid}.txt").exists():
            with_text += 1
        elif not (data / "texts" / k / f"{sid}.err").exists():
            remaining += 1
    state = {
        "last_run": now_iso(),
        "list_pages": len(pages),
        "subjects": len(all_ids),
        "with_text": with_text,
        "remaining": remaining if not only and not args.limit else remaining,
        "run": dict(counters),
        "http": {str(k): v for k, v in f.stats.items()},
        "minutes": round((time.monotonic() - t0) / 60, 1),
    }
    (data / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), "utf-8")
    log("état :", json.dumps(state, ensure_ascii=False))
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as fh:
            fh.write(f"remaining={remaining}\n")


if __name__ == "__main__":
    main()
