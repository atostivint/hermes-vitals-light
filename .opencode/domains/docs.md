# Domaine : docs

## Possède
- `README.md` — la description publique : ce que montre la puce, ce que lit le backend, les commandes
  `/vitals`, l'installation, l'empreinte, les limites connues.
- `CHANGELOG.md` — Keep a Changelog + SemVer.
- `docs/images/*.png` — captures de la puce, de l'infobulle, du mode hors ligne et de la carte TUI.
- `assets/logo.svg` — le logo.

## Ne possède pas
- Les chiffres eux-mêmes, les seuils et les libellés → `shared-figures` / `backend`.
- Les versions et le packaging → `tooling`.
- `plugin.yaml` (déjà chez `tooling`).

## Invariants
- **Chaque chiffre affirmé doit exister dans le code.** Le README décrit des valeurs précises :
  3 s par défaut, périodes 1/3/5/10/30/60 s, backoff 30 s, seuil « lent » 1,5 s, caches 15 s
  (`/api/status`) et 5 s (process), verdicts `stuck` à 25 s ou moins de 1 GiB, `busy` à 10 s,
  sondage client jamais sous 0,5 s. Si le code change, le README change dans le même lot.
- **Anglais**, factuel, sans remplissage : pas de superlatifs, pas de promesse de télémétrie.
  La phrase « what it reads, and where it goes » doit rester vraie.
- Une entrée `CHANGELOG.md` par version, datée, avec les sections `Added` / `Changed` / `Fixed`.
  La version du CHANGELOG suit `package.json` / `plugin.yaml` / `dashboard/manifest.json`.
- Les captures doivent montrer l'état courant de la puce ; si un libellé ou un glyphe change
  (`·`, `⚙`, `👥`), les images sont refaites dans le même lot.

## Pièges connus
- Le README affirme que la CI tourne sur Linux, macOS et Windows ; `.github/workflows/ci.yml` n'a
  qu'un job **ubuntu-latest**. Ne pas répéter cette affirmation sans vérifier le workflow.
- Les glyphes sont dans `src/load.js`, pas dans le README : recopier à la main ce que la puce
  affiche est une source d'écart.
- Le README documente l'installation dans le home Hermes : ne pas l'exécuter pour « vérifier ».
  La preuve passe par les tests, pas par une installation réelle.

## Preuve attendue
- `npm test` reste vert (le README n'est pas lu par les tests, mais aucune affirmation ne doit
  contredire `test/dashboard.test.mjs` ni les domaines voisins).
- Lister explicitement les affirmations **non vérifiées** (rendu réel, CI macOS/Windows, `hermes`).

## Fils ouverts
- Aligner l'affirmation « CI trois systèmes » sur le workflow réel.
