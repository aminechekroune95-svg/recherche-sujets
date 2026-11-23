# Recherche de sujets BNS

Moteur de recherche **dans le texte** des sujets de la Banque nationale de sujets (BNS), toutes matières, pour composer un bac blanc ou un DST.

**Site : https://aminechekroune95-svg.github.io/recherche-sujets/**

Les sites existants (education.gouv.fr, ccbac.fr) ne permettent de filtrer que par matière, année ou titre. Ici on peut chercher une notion qui apparaît *dans* le sujet : `suite récurrente`, `graphe`, `loi binomiale`, `titrage`, `guerre froide`…

## Chercher

- Tous les mots doivent apparaître : `suite graphe`.
- Accents, majuscules et pluriels ignorés : `recurrence` trouve « récurrence ».
- Début de mot : `géom` trouve « géométrique ».
- Expression exacte entre guillemets : `"graphe probabiliste"`.
- Filtres : matière, niveau, voie, thème/exercice/axe, année, langue, corrigé, calculatrice.
- « Ajouter à ma sélection » puis « Copier la liste » pour préparer un devoir (liens des PDF inclus).
- L'adresse de la page garde la recherche : on peut la partager ou la mettre en favori.

## Fonctionnement

```
GitHub Actions (chaque lundi + à la demande)
├─ scraper/crawl.py     listes et fiches de ccbac.fr, PDF → texte (pdftotext, OCR si besoin)
│                       → branche « data » (reprise automatique si le temps manque)
└─ scripts/build.mjs    index de recherche Pagefind → GitHub Pages
site/                   interface (HTML/CSS/JS, sans dépendance)
```

Mettre à jour à la main : onglet **Actions** → « Collecte des sujets et publication » → **Run workflow**.

## Sources et licence

Sujets : ministère de l'Éducation nationale, Banque nationale de sujets, licence [CC BY-NC-SA 3.0 FR](https://creativecommons.org/licenses/by-nc-sa/3.0/fr/). Les PDF et les fiches restent hébergés par [ccbac.fr](https://ccbac.fr/) : le site renvoie vers eux. Le texte extrait sert uniquement à l'index de recherche (même licence, usage non commercial). Site non officiel.

Code : MIT.
