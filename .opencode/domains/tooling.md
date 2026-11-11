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
- `npm test` ne contient pas `test/install.test.mjs` (écart connu, voir `gaps`) : le lancer
  explicitement quand l'installateur ou `homes.mjs` bouge.
- La CI actuelle est **Ubuntu uniquement**, alors que le README et le CHANGELOG annoncent trois
  systèmes. Ne pas s'appuyer sur macOS/Windows « déjà verts ».
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
- Trancher : CI sur trois systèmes (comme documenté) ou documentation alignée sur Ubuntu seul.
