# Politique d'orchestration — Hermes Vitals Light

L'orchestrateur lit ce fichier au triage. Les workers ne reçoivent que ce que le brief cite.

## Règle n° 1 : l'orchestrateur ne modifie aucun fichier

Il ne touche ni `src/`, ni `dashboard/`, ni `desktop/`, ni `tui/`, ni `test/`, ni `scripts/`, ni
`README.md`. Son périmètre d'écriture est `.orchestrator/` et `.opencode/domains/`, rien d'autre.
Tout travail de code passe par un brief confié à un worker.

## Règles dures (aussi dans `AGENTS.md`, répétées car non négociables)

- Ne jamais commit ni push sans demande explicite. Ne jamais publier de release.
- Ne jamais lancer `node scripts/install.mjs` contre le vrai home Hermes
  (`%LOCALAPPDATA%\hermes`, `~/.hermes`) sans accord : ça remplace le plugin de l'utilisateur.
- Répondre en **français**, court. Le code, les libellés d'interface, les infobulles et les
  commentaires restent en **anglais**.
- `GET /stats` est **en lecture seule** et minimal : chiffres de charge, hostname, total de
  sessions, compteurs de process. Jamais d'identifiant de session, de liste de process, de chemin
  ou d'environnement. Aucun appel réseau hors la boucle locale `/api/status`.
- Aucune dépendance nouvelle : côté Node, uniquement les modules `node:` ; côté Python, `psutil` et
  FastAPI sont déjà fournis par Hermes. Pas de `node_modules/`.
- Ne jamais éditer à la main `desktop/plugin.js` ni `tui/hermes-vitals-light.mjs` : ce sont des
  fichiers **générés** par `node scripts/build.mjs` (et versionnés).

## Contrat de preuve

Une tâche n'est acceptée que si son bloc PROOF contient :
1. `git status --porcelain` et `git diff --stat` (fichiers réellement modifiés).
2. Chaque commande exécutée, avec son code de sortie et la sortie pertinente. Minimum :
   - `npm run build`
   - `git diff --exit-code -- desktop/plugin.js tui/hermes-vitals-light.mjs` (moitiés régénérées)
   - `npm test`
   - `python -m unittest discover -s test -p "test_*.py" -v` si la moitié backend bouge
3. Les tests exécutés, **nommés**, pour tout comportement nouveau.
4. `gaps` : ce qui n'a pas pu être vérifié (Desktop réel, `hermes serve` réel, `hermes --tui` réel,
   CI Linux/macOS, dépendances Python absentes de la machine).

Un résumé sans diff ni commande est rejeté une fois. La deuxième fois, la tâche est clôturée en échec.

## Pas de mort silencieuse

- Un worker écrit le **code d'abord**, dans ses premiers appels d'outils, puis construit, puis
  rapporte. Un rapport sans fichier modifié est une tâche échouée, même poli.
- Chaque brief finit par : « si tu manques d'étapes, laisse le fichier dans un état qui construit et
  dis exactement ce qui manque ; ne termine jamais par un simple plan ».
- L'orchestrateur vérifie l'arbre (`git status`, `git diff --stat`) après **chaque** retour de
  worker, avant de lire le rapport. Un « c'est vert » sans diff ne vaut rien.
- Un worker qui échoue deux fois sur la même tâche la voit découpée, pas relancée à l'identique.

## Règles de périmètre

- Le brief liste des fichiers exacts. Aucun fichier hors liste ne peut être touché.
- **Points de sérialisation** (un seul worker actif à la fois sur chacun) :
  - `src/load.js` — inliné dans **les deux** moitiés (`desktop/plugin.js` et
    `tui/hermes-vitals-light.mjs`) : une modification oblige à reconstruire et tester les deux.
  - `src/options.js` — inliné dans la moitié TUI seulement, mais lu par `test/tui.test.mjs`.
  - `dashboard/plugin_api.py` — recopié tel quel dans `tui/hermes-vitals-light.mjs`.
  - `package.json`, `plugin.yaml`, `dashboard/manifest.json` — la version doit y être identique
    (`test/dashboard.test.mjs` le vérifie).
  - `scripts/build.mjs` — réécrit les deux fichiers générés.
- Un seul `npm run build` à la fois sur la machine : il réécrit deux fichiers **suivis par git** ;
  deux builds concurrents avec un worker en train d'éditer produisent un diff incohérent.
- Deux tâches en parallèle : worktrees séparés (`git worktree list` d'abord — ce dépôt en a
  plusieurs) et fichiers disjoints. Jamais deux workers sur le même fichier, jamais deux sur
  `README.md`.
- Avant de créer une tâche, lire `git worktree list` et `git status` : le travail peut déjà exister
  sur une branche `perf/*`, `feat/*` ou dans un worktree Paseo. Ne pas le dupliquer.

## Routage

| Le sujet est | Domaine |
|---|---|
| route `/stats`, psutil, PSI/`/proc`, comptage sessions/process, cache, fail-open | `backend` |
| puce de la barre d'état Desktop, infobulle, réglages Desktop, RTT, cadence | `desktop-chip` |
| widget TUI, `/vitals`, `vitals.json`, enfant `python -c` | `tui` |
| formatage, seuils, couleurs, cadence pure, options partagées | `shared-figures` |
| build, installateur, manifest, CI, packaging, versions | `tooling` |
| README, CHANGELOG, captures, description publique, limites connues | `docs` |

## Format de réponse (triage)

Huit lignes maximum :

```
#ID (reformulation en une ligne) — lié à : #AUTRE.
Domaine : <domaine> (session : <id ou nouvelle>).
Couvre : <ce que le correctif change>.
Non vérifié : <Desktop réel / serveur réel / CI / dépendances>.
```

## Après chaque tâche

- Mettre à jour `.orchestrator/registry.md` (ligne du domaine).
- Mettre à jour les « Open threads » de la note de domaine si ça a bougé.
- Mettre à jour le statut dans `.orchestrator/inbox.md`.
- Consigner un arbitrage dans `.orchestrator/decisions.md` seulement s'il y en a eu un.
