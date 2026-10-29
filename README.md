# Diagnostic applis TV (module TizenBrew)

Module de test pour TV Samsung (Tizen) avec [TizenBrew](https://github.com/reisxd/TizenBrew). Il répond à une seule question : **un module TizenBrew peut-il lister et lancer les applis installées sur cette TV ?** Il mesure aussi les délais. À supprimer après usage.

## Ce qu'il fait

- **La page** (`app/index.html`) affiche toutes les applis de la TV : nom, identifiant Tizen, icône. OK sur une ligne lance l'appli et affiche le résultat (« Appel accepté en … ms » ou l'erreur de la TV). En haut : nombre d'applis, temps de lecture de la liste, délai d'ouverture de TizenBrew jusqu'au module, état de l'accès depuis un PC.
- **Le service** (`service/service.js`) fait le travail, car la page d'un module TizenBrew n'a pas accès à l'API `tizen` alors que le service, lui, la reçoit de TizenBrew. Il appelle `tizen.application.getAppsInfo()` et `tizen.application.launch()`.

## Sécurité

- Le service écoute sur **127.0.0.1:8097** (la TV elle-même) et ne répond qu'à la page de TizenBrew (origine `http://127.0.0.1:8081`). Lancer une appli exige un jeton tiré au hasard à chaque démarrage, et seulement une appli présente dans la liste de la TV.
- Pour lire le rapport depuis un PC, un second port, **8099**, s'ouvre pour **30 minutes** au démarrage du service. Il est **en lecture seule** et n'accepte que des adresses du réseau local. Il se ferme :
  - tout seul au bout de 30 minutes ;
  - avec le bouton « Fermer l'accès PC » de la page ;
  - depuis le PC : `curl -X POST http://<adresse-de-la-TV>:8099/fermer` ;
  - et de toute façon au redémarrage de la TV.
- Le module n'utilise ni l'API REST de la TV, ni sa télécommande virtuelle, et n'écrit rien sur la TV : tout reste en mémoire.

## Installation

1. TizenBrew doit déjà fonctionner (Host PC IP du mode développeur = `127.0.0.1`).
2. Dans TizenBrew, ouvrir le gestionnaire de modules, choisir « Ajouter un Module GitHub » et saisir `<compte>/<dépôt>@<commit>`. Le `@<commit>` fige la version servie par jsDelivr.
3. Revenir à l'accueil de TizenBrew et ouvrir « Diagnostic applis TV ».

## Utilisation

| Touche | Action |
|---|---|
| Haut, Bas | Choisir une ligne ; Haut depuis la première ligne mène à la barre d'outils |
| Gauche, Droite | Six lignes plus haut ou plus bas (dans la barre : bouton précédent ou suivant) |
| OK | Lancer l'appli, ou activer le bouton |
| Retour | Revenir à TizenBrew |

Barre d'outils : « Afficher : toutes les entrées » (y compris les entrées cachées des menus), « Relire la liste », « Fermer l'accès PC » ou « Rouvrir l'accès PC (30 min) ».

Pour mesurer le délai d'ouverture de TizenBrew : régler ce module en AutoLaunch dans TizenBrew, redémarrer la TV, puis ouvrir TizenBrew. Si TizenBrew tournait déjà, la page l'indique et ne donne pas de chiffre.

## Rapport depuis un PC

- `http://<adresse-de-la-TV>:8099/` : résumé lisible.
- `http://<adresse-de-la-TV>:8099/rapport` : tout en JSON (applis, délais, lancements, état des ports).

## Désinstallation

Gestionnaire de modules de TizenBrew, carte « Diagnostic applis TV », OK, puis confirmer. Redémarrer ensuite la TV : le service continue de tourner jusque-là.

## Tests

```bash
npm test
```

Node 22 ou plus récent. Le test de la page lance Edge ou Chrome sans fenêtre (chemin forçable par la variable `DIAG_BROWSER`) ; il est sauté si aucun n'est trouvé. Les tests chargent le service exactement comme TizenBrew (bac à sable `vm`, `require`, `tizen` et `module` fournis), avec une fausse API `tizen`.
