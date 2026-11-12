# Domaine : tui

## Possède
- `src/tui.src.mjs` — le widget ambiant de `hermes --tui`, commande `/vitals`.
- `tui/hermes-vitals-light.mjs` — **généré** par `scripts/build.mjs` (source + `load.js` +
  `options.js` + le texte intégral de `dashboard/plugin_api.py`), versionné, jamais édité à la main.
- `test/tui.test.mjs` — grammaire des options puis widget construit, avec un `HERMES_HOME`
  temporaire et un faux enfant `python`.

## Ne possède pas
- La grammaire des options (`applyOptions`, `TUI_DEFAULTS`) → `shared-figures` (`src/options.js`).
- Le code du backend → `backend` ; il est seulement **recopié** ici par le build.
- L'installateur et le choix du home → `tooling`.

## Invariants
- La carte mesure **la machine où tourne la TUI** : pas de serveur à interroger, donc pas de total
  de sessions ni de RTT. Ces deux chiffres n'existent pas ici.
- Le widget lance `plugin_api.py` en enfant (`python -c`, texte inliné dans `const STATS_PY`), qui
  imprime une ligne JSON par période ; l'enfant vit tant que la carte est amarrée et meurt avec le
  parent.
- Python résolu dans cet ordre : `HERMES_PYTHON`, puis `PYTHON`, puis `python` (Windows) /
  `python3`. Environnement passé à l'enfant : `PYTHONUNBUFFERED=1`, `VITALS_INTERVAL`,
  `VITALS_SKIP`.
- Options persistées dans `<HERMES_HOME>/vitals.json`, partagées par toutes les TUI de ce home ;
  la carte du Desktop garde les siennes séparément.
- Le module importe **uniquement des builtins `node:`** : il est copié dans
  `<HERMES_HOME>/tui-widgets/` et chargé tel quel.
- La carte ne se redimensionne pas : sa largeur est celle de ses chiffres les plus larges.

## Pièges connus
- `scripts/build.mjs` **échoue** si le placeholder exact `const STATS_PY = ''` disparaît de
  `src/tui.src.mjs`. Ne pas le reformater, ne pas y mettre d'espace en trop.
- Le build inline le texte de `dashboard/plugin_api.py` : une modification backend sans rebuild
  laisse la TUI sur l'ancien code (et la CI le signale).
- `stdout` de l'enfant = tuyau JSON : un `print` de debug côté backend casse le flux. Les lignes
  non-JSON sont ignorées, mais elles ne doivent pas exister.
- Sur Windows, le premier scan de process prend ~13 s : `⚙ N` arrive en retard, les autres chiffres
  non. Ne pas « corriger » ça en bloquant la première ligne.
- `/vitals every 10` n'accepte que les périodes proposées (`INTERVALS`) ; toute autre valeur refuse
  la commande entière.

## Preuve attendue
- `npm run build`
- `git diff --exit-code -- tui/hermes-vitals-light.mjs`
- `node --test test/tui.test.mjs`
- `npm test` complet avant de rendre
- `gaps` : ce qui n'a pas été vu dans un vrai `hermes --tui`.

## Fils ouverts
- Aucun. Voir `.orchestrator/inbox.md`.
