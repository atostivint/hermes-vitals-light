# Domaine : shared-figures

## Possède
- `src/load.js` — fonctions pures partagées par la puce Desktop **et** la carte TUI : libellé de la
  puce, lignes d'infobulle, verdict couleur, formatage, cadence de sondage, liste des chiffres.
- `src/options.js` — grammaire `/vitals <option> [on|off]`, valeurs par défaut de la TUI.
- `test/load.test.mjs` — tests de ces fonctions, importées directement.

## Ne possède pas
- Le rendu (JSX, `statusBar`, widgets TUI) → `desktop-chip` / `tui`.
- Les seuils **serveur** (`25`/`10`/`1 GiB` de `waited_verdict`) → `backend`. Ici on ne fait que
  lire la valeur `verdict` que le serveur renvoie, ou la recalculer pour l'affichage.

## Invariants
- **Purement fonctionnel** : ni DOM, ni SDK, ni `react`, ni accès réseau. Les tests importent ces
  modules en direct, sans build.
- Constantes de cadence, à ne pas dupliquer ailleurs :
  - `POLL_MS = 3000`, `DEFAULT_INTERVAL = 3`
  - `MAX_BACKOFF_MS = 30_000`
  - `REQUEST_TIMEOUT_MS = 8000`
  - `SLOW_REQUEST_MS = 1500` (seuil de l'icône « lent », fixe, pas un réglage)
  - `INTERVALS = [1, 3, 5, 10, 30, 60]`
- `CHIP_FIGURES` est **la** liste de vérité des chiffres : elle pilote les interrupteurs du
  Desktop, le `?skip=` envoyé au backend et les options de la TUI (`tui: false` retire un chiffre
  de la carte). Un nouveau chiffre s'ajoute là, pas dans trois fichiers.
- `options.js` dérive ses options de `CHIP_FIGURES` : ne pas réécrire une liste en dur.
- Aucune dépendance : uniquement du JavaScript standard.

## Pièges connus
- `src/load.js` est inliné dans **les deux** moitiés : une modification impose `npm run build`,
  `git diff --exit-code` sur les deux fichiers générés, **et** les deux suites de câblage
  (`test/plugin.test.mjs`, `test/tui.test.mjs`). C'est le point de sérialisation du dépôt.
- `src/options.js` n'est inliné que dans la TUI, mais `test/tui.test.mjs` l'importe en direct : les
  deux chemins doivent rester d'accord.
- Les libellés vivent ici (anglais, glyphes `·` et flèches inclus) : les changer change les
  captures de `docs/images/` → prévenir `docs`.

## Preuve attendue
- `node --test test/load.test.mjs`
- Si `load.js` a bougé : `npm run build`, `git diff --exit-code -- desktop/plugin.js
  tui/hermes-vitals-light.mjs`, `npm test` complet, et les tests de câblage nommés.

## Fils ouverts
- Aucun.
