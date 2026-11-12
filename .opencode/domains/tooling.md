# Domaine : tooling

## Possède
- `scripts/build.mjs` — assemble les deux moitiés à partir de `src/` et de
  `dashboard/plugin_api.py`.
- `scripts/homes.mjs` — résolution du home Hermes (`HERMES_HOME`, `LOCALAPPDATA` sur Windows,
  `~/.hermes` ailleurs, `HERMES_DATA_DIR_SUFFIX`).
- `scripts/install.mjs` — copie les moitiés construites dans le home Hermes.
- `package.json`, `plugin.yaml`, `dashboard/manifest.json`, `dashboard/dist/index.js` — packaging,
  version, scripts npm.
- `.github/workflows/ci.yml` — la CI.
- `test/dashboard.test.mjs` (manifest, bundle), `test/install.test.mjs` (chemins d'installation).

## Ne possède pas
- Le contenu des moitiés : `src/`, `dashboard/plugin_api.py`, `desktop/`, `tui/`.
- `README.md` et `CHANGELOG.md` → `docs`.

## Invariants
- **Le build est reproductible et versionné.** `npm run build` réécrit `desktop/plugin.js` et
  `tui/hermes-vitals-light.mjs`, qui sont **suivis par git**. La CI échoue si les fichiers committés
  diffèrent de `src/` après build.
- Le build normalise les fins de ligne en **LF** avant d'inliner : un checkout CRLF ne doit pas
  produire un diff. Ne pas introduire de CRLF dans `src/`.
- **Une seule version** dans `package.json`, `plugin.yaml` et `dashboard/manifest.json` ;
  `test/dashboard.test.mjs` compare les trois (et `requires_hermes: ">=0.22"`).
- **Zéro dépendance** : pas de `node_modules/`, uniquement des builtins `node:` (Node ≥ 20).
  Côté Python, `psutil`, FastAPI et `httpx` sont fournis par Hermes ou par la CI.
- Le script `test` de `package.json` doit lister **tous** les fichiers `test/*.test.mjs`.
- `install.mjs` ne doit jamais être lancé contre le home réel de l'utilisateur sans accord
  explicite : il écrase le plugin installé.

## Pièges connus
- Deux `npm run build` simultanés écrivent les mêmes fichiers suivis : un seul build à la fois sur
  la machine, surtout quand un autre agent édite `src/`.
- `npm test` lance **bien** les cinq fichiers, `test/install.test.mjs` inclus (vérifié 2026-11-12 :
  la note « écart connu » était périmée). `suites 0` dans la sortie est le compteur de `describe`,
  pas le nombre de fichiers.
- La CI (`.github/workflows/ci.yml`) tourne sur **trois systèmes** — `ubuntu-latest`,
  `macos-latest`, `windows-latest` — et vérifie à chaque push/PR : build, moitiés committées
  identiques à `src/`, `npm test`, puis `pip install psutil fastapi httpx` et la suite Python
  complète. (Corrigé 2026-11-11 : l'ancienne note disait Ubuntu seul, c'était faux.)
- `dashboard/dist/index.js` est le bundle chargé par le dashboard : il doit enregistrer
  `manifest.name` exactement une fois (test dédié).

## Preuve attendue
- `npm run build`
- `git diff --exit-code -- desktop/plugin.js tui/hermes-vitals-light.mjs`
- `node --test test/dashboard.test.mjs test/install.test.mjs`
- `npm test`
- `gaps` : ce que la CI n'a pas tourné (macOS, Windows), et tout ce qui dépend d'un vrai home.

## Fils ouverts
- Ajouter `test/install.test.mjs` au script `test` de `package.json` (ou expliquer pourquoi non).
- ~~Trancher : CI sur trois systèmes ou documentation alignée sur Ubuntu seul~~ — tranché
  (2026-11-11) : la CI couvre bien les trois systèmes, la note de domaine était périmée.
- Release suivante : version + `CHANGELOG.md` + vérifier que la CI est verte sur les trois OS
  avant de publier (rien n'est taggé pour l'instant : `git tag` est vide dans ce dépôt).
