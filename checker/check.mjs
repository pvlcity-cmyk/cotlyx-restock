#!/usr/bin/env node
// Relevé des fiches suivies pour les alertes restock de Cotlyx.
//  1. Demande à Cotlyx les fiches à lire (GET /api/restock/lot?shops=…), authentifié par le jeton
//     OIDC de GitHub Actions : aucun secret dans ce dépôt. Le jeton est obtenu une fois
//     (durée typique 5 min, supérieure au budget de 240 s) et réutilisé pour le POST.
//  2. Lit les fiches poliment, enseigne par enseigne : robots.txt, User-Agent identifiable,
//     pause entre deux requêtes de la même enseigne, arrêt au premier signe de blocage
//     (aucun contournement). Play-In passe par playin.mjs, sans changement de comportement.
//  3. Renvoie l'état utile de chaque fiche (POST /api/restock/releves). Cotlyx décide et
//     envoie les alertes ; ce dépôt n'envoie rien.
// Journal : compteurs seulement (pas d'identifiant de produit, pas de prix, pas d'URL).
import { lotPath, runPassage, BUDGET_MAX_MS } from "./passage.mjs";
import { createCotlyx } from "./cotlyx.mjs";
import { GET_LOT_TIMEOUT_MS, POST_TIMEOUT_MS } from "./budget.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[restock] ${m}`);

async function main() {
  const t0 = Date.now();
  let deadline = t0 + BUDGET_MAX_MS;
  const client = createCotlyx({
    fetchImpl: fetch,
    now: Date.now,
    sleep,
    timeoutFn: (ms) => AbortSignal.timeout(ms),
    env: process.env,
    getDeadline: () => deadline,
    log,
  });
  return runPassage({
    t0,
    now: Date.now,
    sleep,
    log,
    setDeadline: (d) => {
      deadline = d;
    },
    prefetchOidc: () => client.oidcToken(),
    getLot: (path) => client.cotlyx(path, {}, GET_LOT_TIMEOUT_MS),
    postReleves: (body) =>
      client.cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, POST_TIMEOUT_MS),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Message court, sans détail de réponse.
    console.log(`[restock] échec : ${String(err?.message ?? err).slice(0, 120)}`);
    process.exit(1);
  });
