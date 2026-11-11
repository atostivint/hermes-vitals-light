# Domaine : desktop-chip

## Possède
- `src/plugin.src.js` — la puce `statusBar.right` du Hermes Desktop : rendu, réglages, cadence,
  RTT, infobulle.
- `desktop/plugin.js` — **généré** par `scripts/build.mjs` (`plugin.src.js` + `load.js` inliné),
  versionné, jamais édité à la main.
- `test/plugin.test.mjs` — test de câblage : exécute la moitié **construite** contre un faux
  SDK/React et un faux `ctx`.

## Ne possède pas
- Les fonctions pures de formatage et de seuils → `shared-figures` (`src/load.js`).
- Le widget TUI → `tui`.
- La route qui produit les chiffres → `backend`.

## Invariants
- **Un seul fichier à l'exécution.** Le loader du Desktop ne réécrit que les spécificateurs du SDK :
  aucun import relatif ne peut se résoudre. Tout ce qui est partagé doit être inliné par le build.
- Cadence par défaut **3 s** (`POLL_MS`), périodes proposées 1/3/5/10/30/60 s (`INTERVALS`),
  backoff jusqu'à **30 s** en cas d'échec, aucun tir pendant que la fenêtre est masquée
  (`document.hidden`), re-tir immédiat au retour de visibilité et au changement de connexion/profil.
- Un échec de `poll` **conserve** les derniers chiffres, atténués, avec leur âge et la raison dans
  l'infobulle. `CPU -` n'apparaît que si aucune lecture n'est jamais arrivée pour le serveur courant.
- Les chiffres éteints ne sont pas mesurés : la requête porte `?skip=clients,processes`.
- RTT = aller-retour d'un `ping` sur la socket de passerelle (`host.request('ping')`), mesuré dans
  cette moitié. Il n'affecte ni la couleur ni l'icône de santé, et disparaît si la socket ne répond
  pas.
- La couleur vient du verdict `waited` et de la RAM libre, jamais du CPU ni du load.
- Réglages persistés avec `ctx.storage` (clés `chip` et `interval`), un interrupteur par chiffre.
- Textes d'interface et d'infobulle en **anglais**.

## Pièges connus
- Éditer `desktop/plugin.js` est perdu au build suivant : le source est `src/plugin.src.js`.
- `test/plugin.test.mjs` lit le fichier **construit** : sans `npm run build`, un test vert valide
  l'ancien code. Toujours construire avant de conclure.
- Une modification de `src/load.js` change cette moitié **et** la TUI : reconstruire et lancer les
  deux suites de câblage (`plugin.test.mjs` + `tui.test.mjs`).
- La puce est jugée à l'œil dans le vrai Desktop : aucun test ne prouve le rendu.

## Preuve attendue
- `npm run build`
- `git diff --exit-code -- desktop/plugin.js`
- `node --test test/plugin.test.mjs` (et `test/load.test.mjs` si `src/load.js` a bougé)
- `npm test` complet avant de rendre
- `gaps` : ce qui n'a pas été vu dans le vrai Hermes Desktop.

## Fils ouverts
- Aucun. Voir `.orchestrator/inbox.md` pour les items en cours.
