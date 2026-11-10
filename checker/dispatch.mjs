// Dispatcher : chaque item du lot est lu selon son champ `shop`.
// Play-In passe par checker/playin.mjs, sans en modifier le comportement.
// Les autres enseignes : Ultrajeux (microdonnées), Smartoys / BCD / PokéMaël /
// TZP / Gentlemen (JSON-LD). La Grande Récré n'est pas lue (pause).
// Politesse : UA CotlyxBot/1.0, robots.txt, 3 à 4 s entre deux requêtes de la
// même enseigne, arrêt au premier défi de cette enseigne, aucun contournement.
// Gentlemen : arrêt aussi au premier 503.
import {
  USER_AGENT,
  PLAYIN_ORIGIN,
  parseRobots,
  robotsAllows,
  detectChallenge,
  isPlayinProductUrl,
  redirectGone,
  readProduct,
  softGone,
} from "./playin.mjs";
import { withRetry } from "./retry.mjs";
import { ULTRAJEUX_ORIGIN, isUltrajeuxProductUrl, readUltrajeux } from "./ultrajeux.mjs";
import { JSONLD_SHOPS, isJsonLdShopProductUrl, readJsonLdShop } from "./jsonld-shop.mjs";
import { buildReleve } from "./releve.mjs";

export { buildReleve, buildRelevesBody } from "./releve.mjs";

/** Délai plancher entre deux fiches d'une même enseigne hors Play-In (4 s, ticket). */
export const SHOP_DELAY_MS = 4000;

export const SHOP_ORIGINS = {
  playin: PLAYIN_ORIGIN,
  ultrajeux: ULTRAJEUX_ORIGIN,
  ...Object.fromEntries(Object.entries(JSONLD_SHOPS).map(([k, v]) => [k, v.origin])),
};

const JSONLD_NAMES = new Set(Object.keys(JSONLD_SHOPS));

export function isKnownShop(shop) {
  return shop === "playin" || shop === "ultrajeux" || JSONLD_NAMES.has(shop);
}

/** shop absent ou vide → playin (contrat actuel du GET /api/restock/lot). */
export function shopOf(item) {
  const s = typeof item?.shop === "string" ? item.shop.trim().toLowerCase() : "";
  if (!s) return "playin";
  return isKnownShop(s) ? s : null;
}

export function isProductUrl(shop, url) {
  if (shop === "playin") return isPlayinProductUrl(url);
  if (shop === "ultrajeux") return isUltrajeuxProductUrl(url);
  if (JSONLD_NAMES.has(shop)) return isJsonLdShopProductUrl(shop, url);
  return false;
}

/** Identifiant de fiche : chiffres, 1 à 20 (EAN / id Shopify inclus). Play-In reste sur 1–12. */
export function isItemId(id) {
  return /^\d{1,20}$/.test(String(id));
}

/**
 * Filtre et normalise les items du lot. Les enseignes inconnues, LGR, Vinticards
 * et les URL hors motif sont écartées, comme aujourd'hui pour une URL non Play-In.
 */
export function preparerItems(raw, max = 40) {
  const out = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || !isItemId(x.id)) continue;
    const shop = shopOf(x);
    if (!shop) continue;
    if (!isProductUrl(shop, x.url)) continue;
    out.push({ id: String(x.id), url: x.url, shop });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Défi qui arrête l'enseigne. Play-In : comportement actuel (403 / 429 / 503 + pages de défi).
 * Gentlemen : 503 inclus. Autres enseignes : pages de défi, 403 et 429 ; un 503 sans page
 * de défi est une erreur HTTP (le ticket réserve l'arrêt 503 à Gentlemen).
 * Aucun contournement.
 */
export function shopChallenge(shop, status, headers, html) {
  if (shop === "playin") return detectChallenge(status, headers, html);
  if (shop === "gentlemen" && status === 503) return "http";
  if (status === 503) return detectChallenge(200, headers, html);
  return detectChallenge(status, headers, html);
}

function readPage(shop, html) {
  if (shop === "playin") return readProduct(html);
  if (shop === "ultrajeux") return readUltrajeux(html);
  return readJsonLdShop(shop, html);
}

/** Redirection vers une autre page (catégorie, accueil) : fiche disparue, pas une rupture. */
function redirectGoneShop(shop, item, redirected, finalUrl) {
  if (shop === "playin") return redirectGone(item.id, redirected, finalUrl);
  if (!redirected || !finalUrl) return false;
  try {
    const a = new URL(item.url);
    const b = new URL(finalUrl);
    return !(a.host === b.host && a.pathname === b.pathname);
  } catch {
    return false;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupByShop(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.shop)) map.set(it.shop, []);
    map.get(it.shop).push(it);
  }
  const order = [];
  if (map.has("playin")) order.push("playin");
  for (const k of map.keys()) if (k !== "playin") order.push(k);
  return { map, order };
}

/**
 * Lit les fiches du lot, enseigne par enseigne.
 * Un défi n'arrête que cette enseigne. Play-In d'abord, même délai et mêmes règles qu'aujourd'hui.
 */
export async function lireLot(items, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const t0 = opts.t0 ?? now();
  const budget = opts.budgetMs ?? 150_000;
  const delayPlayin = opts.delayPlayinMs ?? 3000;
  const delayShop = Math.max(SHOP_DELAY_MS, opts.delayShopMs ?? opts.delayPlayinMs ?? SHOP_DELAY_MS);
  const log = opts.log ?? (() => {});
  const retryLog = (quoi) => (k, why) => log(`${quoi} : nouvelle tentative ${k}/2 (${why})`);

  const n = { lus: 0, ok: 0, disparues: 0, reseau: 0, http: 0, robots: 0, jsonld: 0, defi: 0, temps: 0 };
  const releves = [];
  const arrets = {};
  const headers = { "user-agent": USER_AGENT, "accept-language": "fr-FR,fr;q=0.9", accept: "text/html,application/xhtml+xml" };

  const { map, order } = groupByShop(items);

  for (const shop of order) {
    const group = map.get(shop);
    const origin = SHOP_ORIGINS[shop];
    const delay = shop === "playin" ? delayPlayin : delayShop;
    let groups = null;
    let stop = null;

    try {
      const r = await withRetry(() => fetchImpl(`${origin}/robots.txt`, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) }), {
        canRetry: () => now() - t0 < budget,
        onRetry: retryLog("robots.txt"),
      });
      const txt = await r.text();
      if (shopChallenge(shop, r.status, r.headers, txt)) stop = "defi";
      else if (!r.ok) stop = "robots";
      else groups = parseRobots(txt, new URL(origin).host);
    } catch {
      stop = "robots";
    }

    if (stop) {
      arrets[shop] = stop;
      if (stop === "defi") n.defi += 1;
      continue;
    }

    for (const it of group) {
      if (now() - t0 > budget) {
        n.temps += 1;
        continue;
      }
      const u = new URL(it.url);
      if (!robotsAllows(groups, u.pathname + u.search)) {
        n.robots += 1;
        releves.push(buildReleve(it, { erreur: "robots" }));
        continue;
      }
      await sleep(delay);
      n.lus += 1;
      let res;
      let html = "";
      try {
        ({ res, html } = await withRetry(
          async () => {
            const r = await fetchImpl(it.url, { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
            return { res: r, html: await r.text() };
          },
          { canRetry: () => now() - t0 < budget, onRetry: retryLog("fiche") },
        ));
      } catch {
        n.reseau += 1;
        releves.push(buildReleve(it, { erreur: "reseau" }));
        continue;
      }
      const ch = shopChallenge(shop, res.status, res.headers, html);
      if (ch) {
        n.defi += 1;
        stop = "defi";
        arrets[shop] = "defi";
        releves.push(buildReleve(it, { erreur: "defi" }));
        break;
      }
      if (res.ok && redirectGoneShop(shop, it, res.redirected, res.url)) {
        n.disparues += 1;
        releves.push(buildReleve(it, { disparue: true }));
        continue;
      }
      if (!res.ok) {
        n.http += 1;
        releves.push(buildReleve(it, { erreur: `http_${res.status === 404 || res.status === 410 ? "absente" : "autre"}` }));
        continue;
      }
      const p = readPage(shop, html);
      if (shop === "playin" && !p && softGone(html)) {
        n.disparues += 1;
        releves.push(buildReleve(it, { disparue: true }));
        continue;
      }
      if (!p) {
        n.jsonld += 1;
        releves.push(buildReleve(it, { erreur: "jsonld" }));
        continue;
      }
      n.ok += 1;
      releves.push(buildReleve(it, { etat: p.etat, prix: p.prix, vendeur: p.vendeur, entrepot: p.entrepot, image: p.image, gtin: p.gtin }));
    }
  }

  return { releves, n, arret: arrets.playin ?? null, arrets };
}
