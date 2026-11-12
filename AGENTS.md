# Hermes Vitals Light — règles du projet pour tout agent (Claude Code, OpenCode, DeepSeek, humains)

Plugin Hermes **Desktop + TUI** qui affiche dans la barre d'état les chiffres du serveur auquel le
Desktop est connecté : CPU, load average, RAM libre, pression CPU (PSI Linux), RTT, sessions
actives, process Hermes. Trois moitiés, un seul paquet :

| Moitié | Où elle tourne | Fichier |
|---|---|---|
| Desktop | Hermes Desktop (renderer), puce `statusBar.right` | `src/plugin.src.js` → `desktop/plugin.js` (généré) |
| Backend | dans le `hermes serve` connecté, route `GET /stats` en lecture seule | `dashboard/plugin_api.py` |
| TUI | `hermes --tui`, carte `/vitals` amarrée au-dessus du prompt | `src/tui.src.mjs` → `tui/hermes-vitals-light.mjs` (généré) |

Les fonctions pures partagées (formatage, couleurs, cadence, liste des chiffres) sont dans
`src/load.js` et `src/options.js`. L'orchestration (briefs, preuves) est dans
`.orchestrator/POLICY.md` ; les contraintes de la machine dans `MACHINE-AGENTS.md`.

## Manière de travailler

- **Répondre en français**, court et factuel. Le code, les libellés d'interface, les infobulles, les
  commentaires et le README restent en **anglais**.
- L'utilisateur est le QA : dire ce qui a été vérifié, et surtout **ce qui ne l'a pas été** (vrai
  Desktop, vrai `hermes serve`, vrai `hermes --tui`, CI macOS/Windows).
- Pas de remplissage « IA » : pas de conclusion décorative, pas d'emoji hors des glyphes de la puce.
- Plusieurs agents peuvent travailler en même temps : voir « Travail en parallèle ».

## Build et test (Windows, machine partagée)

Node ≥ 20, Python 3 pour la moitié backend. Aucune dépendance npm : pas de `node_modules/`.

```powershell
npm run build      # node scripts/build.mjs + node --check sur les deux moitiés
npm test           # 4 suites Node : dashboard, load, plugin, tui
node --test test/install.test.mjs   # pas encore listé dans `npm test`
python -m unittest discover -s test -p "test_*.py" -v
```

- **Un seul `npm run build` à la fois.** Il réécrit deux fichiers **suivis par git**
  (`desktop/plugin.js`, `tui/hermes-vitals-light.mjs`) ; deux builds concurrents, ou un build pendant
  qu'un autre agent édite `src/`, produisent un diff incohérent.
- Avant de rendre un lot : `npm run build` puis
  `git diff --exit-code -- desktop/plugin.js tui/hermes-vitals-light.mjs`. C'est exactement ce que
  fait la CI ; un écart signifie que les moitiés committées ne viennent pas de `src/`.
- Tests backend : les 3 tests de route sont **ignorés** sans `psutil`, `fastapi`, `httpx`
  (`pip install psutil fastapi httpx` pour les couvrir). Le reste tourne sans dépendance.
- La CI (`.github/workflows/ci.yml`) fait : build, contrôle des moitiés, tests Node, installation des
  dépendances Python, tests backend. Elle tourne sur **ubuntu-latest** uniquement, même si le README
  annonce trois systèmes.
- Pas de build Rust dans ce dépôt : `MACHINE-AGENTS.md` décrit les règles `cargo` de la machine,
  elles ne s'appliquent qu'à un autre projet.

## Règles de modification

- **Éditer la source, jamais la moitié générée.** `desktop/plugin.js` et
  `tui/hermes-vitals-light.mjs` sortent de `node scripts/build.mjs` ; une modification manuelle est
  perdue au build suivant et fait échouer la CI.
- `src/load.js` est inliné dans **les deux** moitiés : y toucher impose de reconstruire et de lancer
  `test/plugin.test.mjs` **et** `test/tui.test.mjs`.
- `dashboard/plugin_api.py` est recopié tel quel dans la moitié TUI : toute modification backend
  exige un rebuild.
- Une seule version dans `package.json`, `plugin.yaml` et `dashboard/manifest.json`
  (`test/dashboard.test.mjs` le vérifie), et une entrée correspondante dans `CHANGELOG.md`.
- `GET /stats` reste **en lecture seule et minimal** : chiffres de charge, hostname, total de
  sessions, compteurs par commande. Jamais d'identifiant de session, de liste de process, de chemin
  ni d'environnement. Un seul appel réseau autorisé : `/api/status` en boucle locale.
- Le backend est **fail-open** : sans `psutil` il répond `{"ok": false}`, un chiffre illisible est
  omis, les autres répondent.
- Pas de dépendance nouvelle sans raison. Côté Node : builtins `node:` seulement. Côté Python :
  `psutil` et FastAPI sont déjà fournis par Hermes.
- Fins de ligne **LF** dans `src/` (le build normalise, mais un CRLF committé salit le diff).
- Petits changements testés et lisibles ; un test nommé pour tout comportement nouveau.

## Interdits

- **Commit ou push sans demande explicite.** Pas de release, pas de tag, pas de PR non demandée.
- **`node scripts/install.mjs` contre le vrai home Hermes** (`%LOCALAPPDATA%\hermes`, `~/.hermes`) :
  ça remplace le plugin que l'utilisateur utilise. Demander avant ; les tests couvrent les chemins.
- Modifier ou supprimer des données utilisateur (`vitals.json`, réglages du Desktop).
- Ajouter de la télémétrie, un auto-updater, ou un appel réseau hors boucle locale.

## Travail en parallèle (humains et agents)

- **Un agent par fichier.** Points de sérialisation, un seul actif à la fois :
  `src/load.js`, `src/options.js`, `dashboard/plugin_api.py`, `scripts/build.mjs`,
  `package.json` / `plugin.yaml` / `dashboard/manifest.json`, `README.md`.
- Deux tâches qui se touchent de près : worktrees séparés (`git worktree add`, ce dépôt en a déjà
  plusieurs) et fichiers disjoints. Vérifier `git worktree list` et `git status` avant de commencer :
  le travail existe peut-être déjà sur une branche.
- Fusion par branche, jamais par copie de fichiers.
- Un seul `npm run build` à la fois sur la machine (voir plus haut).

## Preuves obligatoires

Tout lot rendu contient :

1. `git status --porcelain` et `git diff --stat`.
2. Les commandes exécutées, avec code de sortie et sortie pertinente : `npm run build`,
   `git diff --exit-code -- desktop/plugin.js tui/hermes-vitals-light.mjs`, `npm test`, et
   `python -m unittest discover -s test -p "test_*.py" -v` si le backend bouge.
3. Les tests touchés, **nommés**.
4. `gaps` : ce qui n'a pas pu être vérifié, et pourquoi.

Un rapport sans diff ni commande est refusé, même s'il semble complet.

## Orchestration

Le travail passe par un orchestrateur qui **ne modifie aucun fichier** : il trie, écrit des briefs
GOAL / SCOPE / ACCEPTANCE / PROOF / STOP et vérifie les preuves. Voir `.orchestrator/README.md`
(ordre de démarrage, boucle) et `.opencode/domains/` (propriété des fichiers par domaine :
`backend`, `desktop-chip`, `tui`, `shared-figures`, `tooling`, `docs`).
