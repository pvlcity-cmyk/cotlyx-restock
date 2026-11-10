#!/usr/bin/env node
// Relevé des fiches suivies pour les alertes restock de Cotlyx.
//  1. Demande à Cotlyx les fiches à lire (GET /api/restock/lot?shops=…), authentifié par le jeton
//     OIDC de GitHub Actions : aucun secret dans ce dépôt.
//  2. Lit les fiches poliment, enseigne par enseigne : robots.txt, User-Agent identifiable,
//     pause entre deux requêtes de la même enseigne, arrêt au premier signe de blocage
//     (aucun contournement). Play-In passe par playin.mjs, sans changement de comportement.
//  3. Renvoie l'état utile de chaque fiche (POST /api/restock/releves). Cotlyx décide et
//     envoie les alertes ; ce dépôt n'envoie rien.
// Journal : compteurs seulement (pas d'identifiant de produit, pas de prix, pas d'URL).
import { withRetry } from "./retry.mjs";
import { lotPath, runPassage, POST_RESERVE_MS } from "./passage.mjs";

const ORIGIN = "https://cotlyx.fr";
const AUDIENCE = "https://cotlyx.fr/restock";
const CLIENT_UA = "CotlyxRestock/1.0 (+https://github.com/pvlcity-cmyk/cotlyx-restock)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[restock] ${m}`);
const retryLog = (quoi) => (k, why) => log(`${quoi} : nouvelle tentative ${k}/2 (${why})`);

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("jeton OIDC indisponible (permission id-token: write ?)");
  const r = await withRetry(
    () => fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10_000) }),
    { retryStatus: true, onRetry: retryLog("jeton OIDC") },
  );
  if (!r.ok) throw new Error(`jeton OIDC : HTTP ${r.status}`);
  const j = await r.json();
  if (typeof j?.value !== "string") throw new Error("jeton OIDC illisible");
  return j.value;
}

// Appel à Cotlyx avec 2 nouvelles tentatives (délai dépassé, réseau, 5xx, 429). Le 16:35 du
// 09/10 a échoué sur un délai dépassé ici. Un nouvel envoi des relevés est sans risque : Cotlyx
// répond 409 « déjà rendu » s'il a reçu le premier ; après une nouvelle tentative, 409 = reçu.
async function cotlyx(path, init = {}, timeoutMs = 20_000) {
  const token = await oidcToken();
  let essais = 0;
  const res = await withRetry(
    () => {
      essais += 1;
      return fetch(`${ORIGIN}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "user-agent": CLIENT_UA, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    },
    { retryStatus: true, onRetry: retryLog(path) },
  );
  return Object.assign(res, { essais });
}

async function main() {
  return runPassage({
    getLot: () => cotlyx(lotPath()),
    postReleves: (body) => cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, POST_RESERVE_MS),
    sleep,
    log,
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
