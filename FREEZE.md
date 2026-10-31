# Gel du relevé restock (31/10/2026, décision de Marc : « Gèle le Discord »)

État : workflow `check` désactivé (`gh workflow disable`) + garde `if: vars.RESTOCK_ENABLED == '1'` dans `.github/workflows/check.yml`.
Côté estim : workflows `restock-check` et `restock-ombre` désactivés. Rien n'a été supprimé (fichiers, serveur Discord, webhooks, secrets, variables).

## Réactivation (sur décision de Marc uniquement)
1. `gh variable set RESTOCK_ENABLED --body 1 -R pvlcity-cmyk/cotlyx-restock`
2. `gh workflow enable check.yml -R pvlcity-cmyk/cotlyx-restock`
3. `gh workflow enable restock-check.yml -R pvlcity-cmyk/estim` (la variable estim `RESTOCK_ENABLED=true` est restée en place)
4. Optionnel : `gh workflow enable restock-ombre.yml -R pvlcity-cmyk/estim`
5. Vérifier le prochain créneau lancé par le cron Vercel `/api/cron/restock-dispatch` (Actions > runs) et un message sur Discord.
