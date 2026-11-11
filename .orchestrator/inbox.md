# Inbox — Hermes Vitals Light

Une ligne par item, dans l'ordre où l'orchestrateur les prend. États : `ready` (prêt à partir),
`in-flight` (un worker dessus), `blocked` (attend une info de l'utilisateur), `review` (preuve à
vérifier), `done` (mergé et vérifié). Un seul item actif par domaine ; le reste attend ici.

<!-- exemple, à supprimer à la première vraie ligne :
| VITALS-0 | Exemple : la puce affiche `CPU -` après un redémarrage du backend | desktop-chip | ready | — |
-->

| id | item | domaine | état | notes |
|---|---|---|---|---|
