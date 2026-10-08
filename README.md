# cotlyx-restock

Relevé de stock des fiches Play-in pour les alertes restock de [Cotlyx](https://cotlyx.fr).

## Fonctionnement

1. Cotlyx lance le workflow `check` selon le créneau horaire.
2. Le script demande à Cotlyx la liste des fiches à lire. Il s'authentifie avec le jeton OIDC
   de GitHub Actions : ce dépôt ne contient aucun secret.
3. Il lit chaque fiche poliment :
   - il respecte `robots.txt` ;
   - il s'identifie (`CotlyxBot/1.0 (+https://cotlyx.fr)`) ;
   - il attend entre deux requêtes ;
   - il s'arrête au premier signe de blocage, sans jamais le contourner.
4. Il renvoie à Cotlyx l'état utile de chaque fiche : en stock, en rupture, inconnu, ou fiche
   disparue. Cotlyx décide et envoie les alertes ; ce dépôt n'envoie rien.

Le journal ne contient que des compteurs.

## Tests

```sh
npm test
```

## Licence

MIT
