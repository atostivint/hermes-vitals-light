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

## 2026-11-11 — optimisation avant release

- **Le chiffre affiché l'emporte sur l'élégance du code.** Le scan `ppid` paresseux a d'abord franchi
  les parents non-Hermes, ce qui faisait disparaître un `hermes serve` lancé depuis le terminal d'un
  agent (`serve 1` → absent) : rejeté. Règle retenue : **replier seulement une chaîne contiguë de
  process Hermes**, s'arrêter au premier parent non-Hermes. — Un release de performance ne doit
  changer aucun chiffre visible ; l'utilisateur lit ce compteur pour savoir ce qui tourne. —
  `dashboard/plugin_api.py` (`under_another_hermes`), tests `TwoPassScan`.
- **Pas d'API privée non gardée.** `psutil._pswindows.ppid_map()` (un instantané, ~14 ms, au lieu de
  ~12 ms par pid) est utilisé **sous `try/except`** avec repli par pid, uniquement sur Windows. —
  Un snapshot qui disparaît à la montée de version de psutil doit coûter du temps, pas la justesse.
  — `dashboard/plugin_api.py` (`_windows_ppid_map`, `_parent_resolver`).
- **La mémoire est traitée avant la release, et mesurée.** `scripts/footprint.mjs` reste dans le
  dépôt : aucune optimisation n'est acceptée sans avant/après chiffré. — L'utilisateur est le QA ;
  « ça a l'air plus léger » n'est pas une preuve. — `scripts/footprint.mjs`, `README.md` (à venir).
- **Les illustrations passent par du rendu réel + sondes pixel.** HTML/CSS rendu par Edge headless,
  jamais d'image générée ni de vectoriel, et le PNG est relu (dimensions, coins, bordures, marges).
  — Un rendu « joli » n'est pas vérifiable ; les sondes ont trouvé trois défauts réels. —
  `assets/mockups/` (`vitals-light.html`, `vitals-light.png`, `probe.mjs`).
