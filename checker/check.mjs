#!/usr/bin/env node
// Relevé Play-in pour les alertes restock de Cotlyx.
//  1. Demande à Cotlyx les fiches à lire (GET /api/restock/lot), authentifié par le jeton
//     OIDC de GitHub Actions : aucun secret dans ce dépôt.
//  2. Lit les fiches poliment : robots.txt, User-Agent identifiable, pause entre deux
//     requêtes, arrêt au premier signe de blocage (aucun contournement).
//  3. Renvoie l'état utile de chaque fiche (POST /api/restock/releves). Cotlyx décide et
//     envoie les alertes ; ce dépôt n'envoie rien.
// Journal : compteurs seulement (pas d'identifiant de produit, pas de prix, pas d'URL).
import { USER_AGENT, PLAYIN_ORIGIN, parseRobots, robotsAllows, detectChallenge, isPlayinProductUrl, redirectGone, readProduct } from "./playin.mjs";

const ORIGIN = "https://cotlyx.fr";
const AUDIENCE = "https://cotlyx.fr/restock";
const CLIENT_UA = "CotlyxRestock/1.0 (+https://github.com/pvlcity-cmyk/cotlyx-restock)";
const MAX_ITEMS = 30;
const DELAY_MIN_MS = 1500;
const BUDGET_MAX_MS = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[restock] ${m}`);

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("jeton OIDC indisponible (permission id-token: write ?)");
  const r = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`jeton OIDC : HTTP ${r.status}`);
  const j = await r.json();
  if (typeof j?.value !== "string") throw new Error("jeton OIDC illisible");
  return j.value;
}

async function cotlyx(path, init = {}) {
  const token = await oidcToken();
  return fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "user-agent": CLIENT_UA, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
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
  const items = (Array.isArray(lot?.items) ? lot.items : [])
    .filter((x) => x && /^\d{1,12}$/.test(String(x.id)) && isPlayinProductUrl(x.url))
    .slice(0, MAX_ITEMS);
  const delay = Math.max(DELAY_MIN_MS, Number(lot?.delayMs) || 3000);
  const budget = Math.min(BUDGET_MAX_MS, Number(lot?.budgetMs) || 150_000);
  const n = { lus: 0, ok: 0, disparues: 0, reseau: 0, http: 0, robots: 0, jsonld: 0, defi: 0, temps: 0 };
  const releves = [];
  if (!items.length) {
    log("lot vide");
    return 0;
  }

  const headers = { "user-agent": USER_AGENT, "accept-language": "fr-FR,fr;q=0.9", accept: "text/html,application/xhtml+xml" };
  let groups = null;
  let stop = null;
  try {
    const r = await fetch(`${PLAYIN_ORIGIN}/robots.txt`, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const txt = await r.text();
    if (detectChallenge(r.status, r.headers, txt)) stop = "defi";
    else if (!r.ok) stop = "robots";
    else groups = parseRobots(txt);
  } catch {
    stop = "robots";
  }

  for (const it of items) {
    if (stop) break;
    if (Date.now() - t0 > budget) {
      n.temps += 1;
      continue;
    }
    const u = new URL(it.url);
    if (!robotsAllows(groups, u.pathname + u.search)) {
      n.robots += 1;
      releves.push({ id: String(it.id), erreur: "robots" });
      continue;
    }
    await sleep(delay);
    n.lus += 1;
    let res;
    let html = "";
    try {
      res = await fetch(it.url, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      html = await res.text();
    } catch {
      n.reseau += 1;
      releves.push({ id: String(it.id), erreur: "reseau" });
      continue;
    }
    const ch = detectChallenge(res.status, res.headers, html);
    if (ch) {
      // Blocage ou défi : on arrête tout le passage, sans nouvelle tentative.
      n.defi += 1;
      stop = "defi";
      releves.push({ id: String(it.id), erreur: "defi" });
      break;
    }
    if (res.ok && redirectGone(it.id, res.redirected, res.url)) {
      n.disparues += 1;
      releves.push({ id: String(it.id), disparue: true });
      continue;
    }
    if (!res.ok) {
      n.http += 1;
      releves.push({ id: String(it.id), erreur: `http_${res.status === 404 || res.status === 410 ? "absente" : "autre"}` });
      continue;
    }
    const p = readProduct(html);
    if (!p) {
      n.jsonld += 1;
      releves.push({ id: String(it.id), erreur: "jsonld" });
      continue;
    }
    n.ok += 1;
    releves.push({ id: String(it.id), etat: p.etat, prix: p.prix, vendeur: p.vendeur, entrepot: p.entrepot, image: p.image, gtin: p.gtin });
  }

  const duree = Date.now() - t0;
  const body = {
    lot: typeof lot?.lot === "string" ? lot.lot.slice(0, 64) : null,
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    arret: stop,
    duree_ms: duree,
    releves,
  };
  const post = await cotlyx("/api/restock/releves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  log(`bilan ${JSON.stringify({ demandees: items.length, ...n, arret: stop, duree_s: Math.round(duree / 100) / 10, envoi: post.status })}`);
  return post.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Message court, sans détail de réponse.
    console.log(`[restock] échec : ${String(err?.message ?? err).slice(0, 120)}`);
    process.exit(1);
  });
