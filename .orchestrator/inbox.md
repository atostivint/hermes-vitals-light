# Inbox — Hermes Vitals Light

Une ligne par item, dans l'ordre où l'orchestrateur les prend. États : `ready` (prêt à partir),
`in-flight` (un worker dessus), `blocked` (attend une info de l'utilisateur), `review` (preuve à
vérifier), `done` (mergé et vérifié). Un seul item actif par domaine ; le reste attend ici.

<!-- exemple, à supprimer à la première vraie ligne :
| VITALS-0 | Exemple : la puce affiche `CPU -` après un redémarrage du backend | desktop-chip | ready | — |
-->

| id | item | domaine | état | notes |
|---|---|---|---|---|
| VITALS-1 | Mesurer l'empreinte mémoire réelle des trois moitiés (`scripts/footprint.mjs`) | tooling | done | sampler corrigé (le python du venv est un trampoline uv : il mesurait le lanceur, 6,4 Mo au lieu de 32) ; cross-check externe/interne à 0,1 Mo |
| VITALS-2 | Audit lecture-seule des gaspillages mémoire/CPU | review | done | a trouvé le vrai coût : `ppid_map` à 98 % du premier scan, et le `process_iter` par process |
| VITALS-3 | Release 0.1.2 (version + CHANGELOG + README + CI) | tooling | done | PR **#15** mergée (`e7fa13a`), CI verte sur 3 OS, tag **`0.1.2`** poussé sur `c641caf` |
| VITALS-7 | PR catalogue `NousResearch/hermes-agent` pour 0.1.2 | tooling | blocked | branche `chore/catalog-hermes-vitals-light-0.1.2` poussée sur le fork (`7c99481`), YAML validé (`validate_plugin_catalog.py` OK) et 5 captures en 200 ; `gh pr create` refusé par GitHub (`CreatePullRequest` / 404) alors que `compare` voit la branche → à ouvrir depuis `https://github.com/atostivint/hermes-agent/pull/new/chore/catalog-hermes-vitals-light-0.1.2` |
| VITALS-4 | FastAPI et `urllib.request` sortis du child TUI | backend | review | 56,8 → 32,2 Mo WS (43,2 → 22,5 privé), 7,0 → 0,6 s de CPU par run |
| VITALS-5 | Scan de process : `ppid` paresseux, un seul instantané | backend | review | 5,4 s → 22 ms à froid, comptage identique à `HEAD` |
| VITALS-6 | Maquette de l'interface réelle (barre d'état + infobulle + carte TUI) | docs | done | 53/53 sondes, toutes les couleurs relevées dans `docs/images/` |
| VITALS-4 | Sortir FastAPI (~25 Mo) et `urllib.request` (~4,6 Mo) du child TUI | backend | review | session `ses_e3363ab75ffeg5Z81vtdUCasg9` ; **vérifié par l'orchestrateur** : diff sain, 57 tests Python OK, `npm test` 67 OK, `-X importtime` sans fastapi/urllib.request |
| VITALS-5 | Scan de process : `ppid` seulement pour les candidats (1er scan 5,8–8,3 s → cible ≤ 100 ms) | backend | in-flight | session `ses_e3356f995ffefEBYrOkeLjrlGz` ; mesuré : 98 % du coût dans `psutil_windows.ppid_map`, GIL tenu par tranches de 16–37 ms |
| VITALS-6 | Maquette catalogue sombre en HTML/CSS rendue par Chromium + sondes pixel | docs | in-flight | session `ses_e3356f996ffeXVTAs6CV58ToWY` ; `assets/mockups/` (html + png 3200×1800 + `probe.mjs`) |
