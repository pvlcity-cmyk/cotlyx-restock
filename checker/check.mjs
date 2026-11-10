#!/usr/bin/env node
// Relevé des fiches suivies pour les alertes restock de Cotlyx.
//  1. Demande à Cotlyx les fiches à lire (GET /api/restock/lot), authentifié par le jeton
//     OIDC de GitHub Actions : aucun secret dans ce dépôt.
//  2. Lit les fiches poliment, enseigne par enseigne : robots.txt, User-Agent identifiable,
//     pause entre deux requêtes de la même enseigne, arrêt au premier signe de blocage
//     (aucun contournement). Play-In passe par playin.mjs, sans changement de comportement.
//  3. Renvoie l'état utile de chaque fiche (POST /api/restock/releves). Cotlyx décide et
//     envoie les alertes ; ce dépôt n'envoie rien.
// Journal : compteurs seulement (pas d'identifiant de produit, pas de prix, pas d'URL).
// GET /api/restock/lot : pas de shops= pour l'instant (ajouté seulement après le merge du contrat).
import { withRetry } from "./retry.mjs";
import { preparerItems, lireLot, buildRelevesBody } from "./dispatch.mjs";

const ORIGIN = "https://cotlyx.fr";
const AUDIENCE = "https://cotlyx.fr/restock";
const CLIENT_UA = "CotlyxRestock/1.0 (+https://github.com/pvlcity-cmyk/cotlyx-restock)";
const DELAY_MIN_MS = 1500;
const BUDGET_MAX_MS = 240_000;

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
async function cotlyx(path, init = {}) {
  const token = await oidcToken();
  let essais = 0;
  const res = await withRetry(
    () => {
      essais += 1;
      return fetch(`${ORIGIN}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "user-agent": CLIENT_UA, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    },
    { retryStatus: true, onRetry: retryLog(path) },
  );
  return Object.assign(res, { essais });
}

async function main() {
  const t0 = Date.now();
  const lotRes = await cotlyx("/api/restock/lot");
  if (lotRes.status === 204) {
    log("rien à lire pour ce créneau");
    return 0;
  }
  if (!lotRes.ok) {
    log(`lot indisponible (HTTP ${lotRes.status})`);
    return lotRes.status === 409 ? 0 : 1;
  }
  const lot = await lotRes.json().catch(() => null);
  const items = preparerItems(lot?.items);
  const delay = Math.max(DELAY_MIN_MS, Number(lot?.delayMs) || 3000);
  const budget = Math.min(BUDGET_MAX_MS, Number(lot?.budgetMs) || 150_000);
  if (!items.length) {
    log("lot vide");
    return 0;
  }

  const { releves, n, arret, arrets } = await lireLot(items, {
    delayPlayinMs: delay,
    budgetMs: budget,
    t0,
    sleep,
    log,
  });

  const duree = Date.now() - t0;
  const body = buildRelevesBody({
    lot: typeof lot?.lot === "string" ? lot.lot.slice(0, 64) : null,
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    arret,
    arrets,
    duree_ms: duree,
    releves,
  });
  const post = await cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const recu = post.ok || (post.status === 409 && post.essais > 1);
  log(`bilan ${JSON.stringify({ demandees: items.length, ...n, arret, duree_s: Math.round(duree / 100) / 10, envoi: post.status, essais: post.essais })}`);
  return recu ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Message court, sans détail de réponse.
    console.log(`[restock] échec : ${String(err?.message ?? err).slice(0, 120)}`);
    process.exit(1);
  });
