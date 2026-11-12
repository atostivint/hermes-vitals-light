# Domaine : backend

## Possède
- `dashboard/plugin_api.py` — la moitié backend : une route `GET /stats` en lecture seule, montée
  sous `/api/plugins/hermes-vitals-light/`, qui tourne **dans** le `hermes serve` connecté.
- `test/test_plugin_api.py` — tests unitaires Python de ce fichier (fonctions pures + route montée
  sur un vrai routeur FastAPI).

## Ne possède pas
- `dashboard/manifest.json`, `plugin.yaml`, `package.json` → `tooling` (versions, packaging).
- La copie du fichier dans la moitié TUI : `tui/hermes-vitals-light.mjs` est **généré** par
  `scripts/build.mjs` (→ `tooling`), pas édité ici.
- Tout ce qui affiche les chiffres → `desktop-chip` / `tui` / `shared-figures`.

## Invariants
- **Lecture seule et minimal.** La réponse ne contient que : `ok`, `hostname`, `cpu_count`,
  `cpu_percent`, `memory{total,used,percent}`, `free`, `load_avg`, `waited{seconds,verdict}`,
  `clients{total}`, `processes{total,by_command}`. Jamais d'identifiant de session, de liste de
  process, de chemin, d'environnement, de configuration.
- **Fail-open.** Sans `psutil`, `{"ok": false}`. Chaque chiffre est mesuré indépendamment : un
  fichier `/proc` illisible ou une table de process inaccessible n'enlève que son chiffre.
- **Aucune requête n'attend un compteur.** `clients` (TTL 15 s, `VITALS_STATUS_TTL`) et
  `processes` (TTL 5 s, `VITALS_PROCESS_TTL`) viennent de caches rafraîchis par un thread daemon ;
  la première réponse après un démarrage peut simplement les omettre.
- **Un seul appel réseau** : `GET /api/status` en boucle locale, sur l'adresse de socket de la
  requête (`request.scope["server"]`, pas l'en-tête `Host`), via un opener sans proxy. Rien d'autre,
  jamais de télémétrie.
- **Linux sans psutil pour `waited`/`free`** : une lecture de deux fichiers, `/proc/pressure/cpu`
  (`some avg60` → `round(avg60 * 0.6)` secondes) et `/proc/meminfo` (`MemAvailable`, KiB → octets).
  Ailleurs, `free` retombe sur la RAM disponible de psutil et `waited` est omis.
- **Seuils** : `WAITED_STUCK_SECONDS = 25`, `WAITED_BUSY_SECONDS = 10`, `LOW_FREE_BYTES = 1 GiB`.
  Ce sont les seuls endroits où ces valeurs vivent côté serveur.
- **Le fichier reste autonome** : il est importé comme module de premier niveau par le loader du
  dashboard **et** recopié tel quel dans la moitié TUI. Pas d'import interne au dépôt.
- **`?skip=clients,processes`** est le seul paramètre : un chiffre éteint côté Desktop n'est pas
  mesuré du tout.

## Pièges connus
- **Le premier scan est le seul poste coûteux** (2026-11-11) : `psutil.process_iter` avec l'attribut
  `ppid` reconstruit `ppid_map()` de toute la table — mesuré 5,8–6,3 s de CPU sur 535 process
  Windows, 98 % du temps dans `psutil_windows.ppid_map`, GIL tenu par tranches de 16–37 ms (donc la
  boucle asyncio de `hermes serve` est hachée). **Ne jamais remettre `ppid` dans la première passe.**
  Après correction : ~20–30 ms à froid avec 2+ Hermes, 3 ms à chaud.
- **Le repliement ne franchit pas un parent non-Hermes** (décision 2026-11-11) : un `hermes serve`
  lancé depuis le terminal d'un agent compte **séparément**. Franchir les intermédiaires faisait
  disparaître `serve` de la puce ; c'est rejeté.
- **`fastapi` et `urllib.request` ne sont jamais importés dans l'entrée de flux** (`__name__ ==
  "__main__"`, le child TUI) : mesuré +25 Mo pour FastAPI et +4,6 Mo pour `urllib.request` dans le
  venv Hermes, pour du code que le child n'atteint pas. Toute réintroduction en import de module
  annule le gain — c'est ce que surveille `StreamEntryPoint.test_stream_entry_does_not_import_fastapi`.
- Toute modification ici **doit** être suivie de `npm run build` : le texte du fichier est inliné
  dans `tui/hermes-vitals-light.mjs`, et la CI échoue si les deux copies divergent.
  (`desktop/plugin.js` n'inline **pas** ce fichier : il ne doit pas changer.)
- **Ne rien écrire sur stdout** en dehors de `stream()` : ce stdout est le tuyau JSON du widget TUI.
  Le log passe par `logger.debug`, jamais par `print`.
- Un Hermes lancé par un autre Hermes compte sous son ancêtre de plus haut niveau ; l'Electron
  `Hermes` (majuscule) n'est pas compté — la casse est volontaire.
- Le module est chargé même sans FastAPI (le routeur vaut alors `None`) : garder les imports
  protégés par `try/except ImportError`.

## Preuve attendue
- `python -m unittest discover -s test -p "test_*.py" -v` (sur cette machine, 3 tests de route sont
  ignorés si `psutil`/`fastapi`/`httpx` ne sont pas installés ; l'installer pour les couvrir :
  `pip install psutil fastapi httpx`).
- `npm run build` puis `git diff --exit-code -- tui/hermes-vitals-light.mjs`.
- Les noms des tests ajoutés, et ce qui n'a pas été vérifié (un vrai `hermes serve`).

## Fils ouverts
- Vérifier le comptage contre un `hermes serve` réel : les tests utilisent un faux `/api/status`.
- Vérifier que le chargeur du dashboard importe bien le fichier avec `__name__ != "__main__"` (les
  tests le simulent avec `spec_from_file_location`), sinon `router` resterait `None`.
- Non mesuré : le coût de `/api/status` lui-même, et les nouveaux chemins sous Linux/macOS
  (`_parent_resolver` y fait un `ppid()` par pid, gratuit sur `/proc`).
