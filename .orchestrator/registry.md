# Registry — Hermes Vitals Light

Une ligne par domaine. `session` est le `sessionID` renvoyé par l'outil subagent : le passer à
nouveau continue ce domaine au lieu de repartir de zéro. `fichiers en jeu` est la surface de
conflit actuelle. `statut` : `idle`, `in-flight`, `review`, `done`, `blocked`.

| domain | session | last item | files in play | status |
|---|---|---|---|---|
| tooling | ses_e336ce050ffe5vqHeS8xOG0nao | VITALS-1 mesure d'empreinte | `scripts/footprint.mjs`, `package.json` (script npm seulement) | in-flight |
| review | ses_e336c718cffe8zafdG68t8kcCJ | VITALS-2 audit mémoire (lecture seule) | aucun | in-flight |
| backend | ses_e334b4d24ffelsGgu5W5kH1pCe | VITALS-5 scan `ppid` paresseux + repliement contigu | `dashboard/plugin_api.py`, `test/test_plugin_api.py` | review |
| desktop-chip | — | — | `src/plugin.src.js` (libre) | idle |
| tui | — | — | `src/tui.src.mjs` (libre) | idle |
| shared-figures | — | — | `src/load.js`, `src/options.js` (libres) | idle |
| docs | ses_e3356f996ffeXVTAs6CV58ToWY | VITALS-6 maquette catalogue (43/43 sondes) | `assets/mockups/` | done |
| release | ses_e33443ef0ffeoyNiHeweHyX2w3 | rebuild + preuves manquantes | `desktop/plugin.js`, `tui/hermes-vitals-light.mjs` (générés) | in-flight |
