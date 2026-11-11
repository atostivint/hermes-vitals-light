# Décisions de l'utilisateur — Hermes Vitals Light

Une ligne par arbitrage. C'est la mémoire qui survit aux compactions, aux redémarrages et aux
agents qui relisent le dépôt. Quand une décision change, on ne l'efface pas : on la barre et on
ajoute la nouvelle, avec sa date.

Format : `date — décision — pourquoi — où c'est appliqué`.

## 2026-11-11 — installation de l'orchestration

- Le dépôt est piloté par un **orchestrateur + workers** : l'orchestrateur trie, écrit des briefs,
  vérifie les preuves ; il ne modifie aucun fichier de code. — Le travail concurrent sur ce petit
  dépôt (trois moitiés, deux fichiers générés) se perd dès que deux agents écrivent sans contrat. —
  `.orchestrator/POLICY.md`, `AGENTS.md`.
- **Pas de `tools/*.ps1` ni de `.cargo/config.toml`** : le projet n'est pas Rust. La contrainte
  « un seul build à la fois » est portée par la commande `npm run build` et par `POLICY.md`. —
  Copier des scripts de build Rust n'aurait rien protégé ici. — `POLICY.md`, `AGENTS.md`.
- `MACHINE-AGENTS.md` est copié tel quel : c'est la même machine (Windows, i5-13500). — Les règles
  de mémoire et de priorité valent pour n'importe quel build lancé ici. — `MACHINE-AGENTS.md`.
