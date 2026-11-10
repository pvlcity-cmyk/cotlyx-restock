# cotlyx-restock

Relevé de stock des fiches suivies pour les alertes restock de [Cotlyx](https://cotlyx.fr).

## Fonctionnement

1. Cotlyx lance le workflow `check` selon le créneau horaire.
2. Le script demande à Cotlyx la liste des fiches à lire. Il s'authentifie avec le jeton OIDC
   de GitHub Actions : ce dépôt ne contient aucun secret.
3. Il lit chaque fiche poliment, enseigne par enseigne :
   - il respecte `robots.txt` ;
   - il s'identifie (`CotlyxBot/1.0 (+https://cotlyx.fr)`) ;
   - il attend entre deux requêtes vers la même enseigne ;
   - il s'arrête au premier signe de blocage de cette enseigne, sans jamais le contourner.
   Play-In est lu par `checker/playin.mjs`. Ultrajeux (microdonnées) et les enseignes
   JSON-LD (Smartoys, BCD, PokéMaël, TZP, Gentlemen) ont leurs propres lecteurs.
4. Il renvoie à Cotlyx l'état utile de chaque fiche : en stock, en rupture, inconnu, ou fiche
   disparue. Cotlyx décide et envoie les alertes ; ce dépôt n'envoie rien.

Le journal ne contient que des compteurs.

## Tests

```sh
npm test
```

## Licence

MIT
