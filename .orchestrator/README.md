# Espace de travail de l'orchestrateur — Hermes Vitals Light

Ce dossier est la mémoire de l'orchestrateur. Il est versionné : il survit aux sessions, aux
compactions et aux worktrees.

| Fichier | Rôle |
|---|---|
| `POLICY.md` | Règles dures, contrat de preuve, périmètre, routage, format de réponse. Lu au triage. |
| `registry.md` | Domaine → session worker, fichiers en jeu, statut. Mémoire à long terme. |
| `inbox.md` | Items à trier et leur état. |
| `decisions.md` | Arbitrages datés, une ligne par décision. |
| `README.md` | Ce fichier : la boucle de travail. |

Les notes de domaine vivent dans `.opencode/domains/` (un fichier par surface du dépôt).

## Ordre de démarrage d'une session

1. `AGENTS.md` — les règles du projet (ce que le dépôt attend de tout agent).
2. `MACHINE-AGENTS.md` — les contraintes de la machine (builds, mémoire, priorité).
3. `.orchestrator/POLICY.md` — le contrat d'orchestration.
4. `.orchestrator/registry.md` — où en est chaque domaine, quelle session reprendre.
5. `.orchestrator/inbox.md` — quel item prendre ensuite.
6. La (les) note(s) de domaine concernée(s) avant d'écrire un brief.

Ne pas sauter l'étape 4 : après une compaction, le tableau du registry **est** la mémoire.

## La boucle

1. `/triage <item>` ou « prends le prochain item de `.orchestrator/inbox.md` ».
2. L'orchestrateur classe l'item contre `.opencode/domains/`, lit `git status` et
   `git worktree list`, puis écrit un brief GOAL / SCOPE / ACCEPTANCE / PROOF / STOP.
3. Un `worker` par tâche indépendante, en arrière-plan quand c'est parallélisable. Fichiers
   disjoints obligatoires ; worktree séparé dès que deux tâches se touchent de près.
4. Pas de bloc PROOF (diff + commandes + sorties) → renvoi une fois → sinon échec.
5. Une passe de revue avec `reviewer` sur le diff courant.
6. L'orchestrateur met à jour `registry.md`, la note de domaine et le statut dans `inbox.md`.

## Ce qu'il ne faut pas faire

- Laisser l'orchestrateur éditer du code : son périmètre d'écriture est `.orchestrator/` et
  `.opencode/domains/`.
- Lancer deux `npm run build` en même temps : ils réécrivent les mêmes fichiers suivis.
- Éditer `desktop/plugin.js` ou `tui/hermes-vitals-light.mjs` à la main : ce sont des sorties de
  build.
- Commit, push, release ou installation dans le home Hermes de l'utilisateur sans demande.

## Repasser en travail direct

Le sélecteur d'agent d'OpenCode (Tab) rend la main à un agent de code normal. L'orchestrateur
reste configuré pour le triage suivant.
